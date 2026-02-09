import prisma from '../../prisma';
import { flexCompletion } from '../../services/openai';
import { embedText } from '../../services/embedding';
import { PATTERN_ANALYSIS_PROMPT } from '../../prompts';

// ============================================================================
// JSON Schema for Structured Output
// ============================================================================

const PATTERN_ANALYSIS_JSON_SCHEMA = {
    name: 'pattern_analysis_output',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            patterns: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        observation: { type: 'string', description: 'The structural finding' },
                        evidence: { type: 'string', description: 'Specific data points supporting it' },
                        timesObserved: { type: 'integer', description: 'Count of supporting data points' },
                    },
                    required: ['observation', 'evidence', 'timesObserved'],
                    additionalProperties: false,
                },
                minItems: 2,
                maxItems: 3,
            },
        },
        required: ['patterns'],
        additionalProperties: false,
    },
} as const;

// ============================================================================
// Types
// ============================================================================

export interface DetectPatternsForEventInput {
    userId: string;
    triggerEventId: string;
    interpretationId?: string;
}

export interface DetectPatternsResult {
    success: boolean;
    patternsCreated: number;
    patternIds: string[];
}

export class PatternDetectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'PatternDetectionError';
    }
}

// ============================================================================
// Event-Triggered Pattern Analysis
// ============================================================================

/**
 * Analyzes patterns triggered by a specific event.
 *
 * 1. Fetches context (day events, preceding events, track type history)
 * 2. Single LLM call → 2-3 pattern observations
 * 3. Stores each as a Pattern record with embedding + PatternEvent link
 */
export async function detectPatternsForEvent(
    input: DetectPatternsForEventInput
): Promise<DetectPatternsResult> {
    const { userId, triggerEventId } = input;

    console.log(`[PatternAnalysis] Processing for user ${userId}, triggered by event ${triggerEventId}`);

    // 1. Get the triggering interpretation
    const triggerInterpretation = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            createdAt: Date;
        }>
    >`
        SELECT id, "eventId", content, "createdAt"
        FROM "Interpretation"
        WHERE "eventId" = ${triggerEventId}
        LIMIT 1
    `;

    // No interpretation → return empty (no garbage fallback patterns)
    if (triggerInterpretation.length === 0) {
        console.log(`[PatternAnalysis] No interpretation found for event ${triggerEventId}, skipping`);
        return { success: true, patternsCreated: 0, patternIds: [] };
    }

    const trigger = triggerInterpretation[0];

    // 2. Get the raw event
    const triggerEvent = await prisma.event.findUnique({
        where: { id: triggerEventId },
        select: { content: true, occurredAt: true, trackedType: true, rawJson: true },
    });

    if (!triggerEvent) {
        console.log(`[PatternAnalysis] Event ${triggerEventId} not found`);
        return { success: true, patternsCreated: 0, patternIds: [] };
    }

    const triggerOccurredAt = triggerEvent.occurredAt;
    const triggerTrackedType = triggerEvent.trackedType || 'GENERAL';

    // 3a. Fetch all events from the same day (cross-domain context)
    const dayStart = new Date(triggerOccurredAt);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(triggerOccurredAt);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const dayEvents = await prisma.event.findMany({
        where: {
            userId,
            occurredAt: { gte: dayStart, lte: dayEnd },
            id: { not: triggerEventId },
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'asc' },
        take: 20,
    });

    // 3b. Fetch same-track-type events from last 30 days
    const thirtyDaysAgo = new Date(triggerOccurredAt);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trackTypeHistory = await prisma.event.findMany({
        where: {
            userId,
            trackedType: triggerTrackedType,
            occurredAt: { gte: thirtyDaysAgo, lt: dayStart },
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'desc' },
        take: 15,
    });

    // 3c. Fetch events from 3 days before (causal chain detection)
    const threeDaysBefore = new Date(triggerOccurredAt);
    threeDaysBefore.setDate(threeDaysBefore.getDate() - 3);

    const precedingEvents = await prisma.event.findMany({
        where: {
            userId,
            occurredAt: { gte: threeDaysBefore, lt: dayStart },
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'desc' },
        take: 15,
    });

    // 3d. Fetch interpretations for all context events
    const contextEventIds = [
        ...dayEvents.map(e => e.id),
        ...trackTypeHistory.map(e => e.id),
        ...precedingEvents.map(e => e.id),
    ];
    const contextInterpretations = contextEventIds.length > 0
        ? await prisma.interpretation.findMany({
              where: { eventId: { in: contextEventIds } },
              select: { eventId: true, content: true },
          })
        : [];
    const interpretationByEventId = new Map(
        contextInterpretations.map(i => [i.eventId, i.content])
    );

    // 4. Get user context
    const { userName, userBaseline } = await getUserContext(userId);

    // 5. Build LLM input
    const dayEventsContext = dayEvents.map(e => ({
        content: e.content.substring(0, 500),
        trackedType: e.trackedType || 'GENERAL',
        occurredAt: e.occurredAt.toISOString(),
        interpretation: interpretationByEventId.get(e.id)?.substring(0, 500) || null,
    }));

    const trackTypeHistoryContext = trackTypeHistory.map(e => ({
        content: e.content.substring(0, 500),
        occurredAt: e.occurredAt.toISOString(),
        interpretation: interpretationByEventId.get(e.id)?.substring(0, 500) || null,
    }));

    const precedingEventsContext = precedingEvents.map(e => ({
        content: e.content.substring(0, 500),
        trackedType: e.trackedType || 'GENERAL',
        occurredAt: e.occurredAt.toISOString(),
        interpretation: interpretationByEventId.get(e.id)?.substring(0, 500) || null,
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        rawEvent: triggerEvent.content,
        trackedType: triggerTrackedType,
        rawJson: triggerEvent.rawJson,
        interpretation: trigger.content,
        dayEvents: dayEventsContext,
        precedingEvents: precedingEventsContext,
        trackTypeHistory: trackTypeHistoryContext,
    });

    // 6. Single LLM call
    const { modelConfig, systemPrompt } = PATTERN_ANALYSIS_PROMPT;

    console.log(`[PatternAnalysis] Calling LLM for pattern analysis`);

    const completion = await flexCompletion({
        model: modelConfig.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: modelConfig.temperature,
        response_format: { type: 'json_schema', json_schema: PATTERN_ANALYSIS_JSON_SCHEMA },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        console.log(`[PatternAnalysis] LLM returned empty response`);
        return { success: true, patternsCreated: 0, patternIds: [] };
    }

    let parsed: { patterns: Array<{ observation: string; evidence: string; timesObserved: number }> };
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        console.error(`[PatternAnalysis] Failed to parse LLM response:`, e);
        return { success: true, patternsCreated: 0, patternIds: [] };
    }

    if (!parsed.patterns || parsed.patterns.length === 0) {
        console.log(`[PatternAnalysis] LLM returned no patterns`);
        return { success: true, patternsCreated: 0, patternIds: [] };
    }

    // 7. Store each pattern observation
    const patternIds: string[] = [];

    for (const item of parsed.patterns) {
        const description = `## ${item.observation}\n\n**Evidence:** ${item.evidence}\n\n**Times observed:** ${item.timesObserved}`;

        const embeddingResult = await embedText({ text: description });
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;

        const patternId = await prisma.$transaction(async (tx) => {
            const pattern = await tx.pattern.create({
                data: {
                    userId,
                    description,
                    status: 'ACTIVE',
                },
                select: { id: true },
            });

            await tx.$executeRawUnsafe(
                `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
                embeddingStr,
                pattern.id
            );

            await tx.patternEvent.create({
                data: {
                    patternId: pattern.id,
                    eventId: triggerEventId,
                },
            });

            return pattern.id;
        }, { timeout: 15000 });

        patternIds.push(patternId);
    }

    console.log(`[PatternAnalysis] Created ${patternIds.length} pattern observations: ${patternIds.join(', ')}`);

    return {
        success: true,
        patternsCreated: patternIds.length,
        patternIds,
    };
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseEmbedding(embeddingStr: string): number[] {
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

async function getUserContext(userId: string): Promise<{ userName: string; userBaseline: string }> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, baseline: true },
    });
    return {
        userName: user?.name || 'User',
        userBaseline: user?.baseline || 'No baseline available yet.',
    };
}
