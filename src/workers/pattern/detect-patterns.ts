import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText, cosineSimilarity } from '../../services/embedding';
import { PATTERN_SYNTHESIS_PROMPT, PATTERN_DECISION_PROMPT } from '../../prompts';
import { PatternOutcome, InterpretationWithEmbedding } from './schema';
import {
    clusterInterpretations,
    findSimilarPatterns,
    DEFAULT_CLUSTERING_CONFIG,
    ClusteringConfig,
} from './similarity';
import {
    selectRepresentativeEvidence,
    DEFAULT_EVIDENCE_CONFIG,
    EvidenceSelectionConfig,
    ScoredInterpretation,
} from './evidence-selection';

// ============================================================================
// JSON Schema for Structured Output
// ============================================================================

// OpenAI Structured Output guarantees this schema - no Zod validation needed
const PATTERN_OUTPUT_JSON_SCHEMA = {
    name: 'pattern_output',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'The pattern description in markdown format',
            },
        },
        required: ['pattern'],
        additionalProperties: false,
    },
} as const;

// ============================================================================
// Configuration
// ============================================================================

// Minimum similarity to include a pattern as a candidate for LLM consideration
// Embeddings find candidates; LLM makes final decisions
const CANDIDATE_SIMILARITY_THRESHOLD = 0.30;

// Maximum number of candidate patterns to send to LLM
const MAX_CANDIDATE_PATTERNS = 5;

// ============================================================================
// Types
// ============================================================================

export interface DetectPatternsInput {
    userId: string;
    lookbackDays?: number; // default: 30 (kept for backward compat, but now uses full timeline)
    clusteringConfig?: ClusteringConfig;
}

export interface DetectPatternsForEventInput {
    userId: string;
    triggerEventId: string;
    interpretationId?: string;
    evidenceConfig?: EvidenceSelectionConfig;
}

export interface DetectPatternsResult {
    success: boolean;
    outcome: PatternOutcome;
    patternId: string;
    patternsCreated: number;
    patternsReinforced: number;
    patternsEvolved: number;
    clustersFound: number;
}

export class PatternDetectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'PatternDetectionError';
    }
}

// ============================================================================
// Event-Triggered Pattern Detection (NEW - Pipeline Mode)
// ============================================================================

/**
 * Detects patterns triggered by a specific event.
 *
 * This is the pipeline-mode pattern detection that:
 * 1. Gets the new interpretation's embedding
 * 2. Computes similarity with ALL active patterns to find CANDIDATES
 * 3. ALWAYS calls LLM with candidate patterns to make the final decision
 *
 * Core Principle: Embeddings find candidates, LLM makes decisions.
 * - Similarity scores are for FINDING candidates, not for making decisions
 * - Even high similarity (0.95) doesn't mean semantic relevance
 * - Only the LLM can determine if an event actually relates to a pattern
 *
 * Outcome Contract (LLM decides):
 * - REINFORCE: Event clearly adds to an existing pattern
 * - CREATE: Event represents a genuinely new behavioral pattern
 * - NONE: Event is isolated, doesn't warrant any pattern action
 *
 * Note: EVOLVED_PATTERN is deprecated and no longer produced.
 */
export async function detectPatternsForEvent(
    input: DetectPatternsForEventInput
): Promise<DetectPatternsResult> {
    const { userId, triggerEventId, evidenceConfig = DEFAULT_EVIDENCE_CONFIG } = input;

    console.log(`[PatternDetection] Processing for user ${userId}, triggered by event ${triggerEventId}`);

    // 1. Get the triggering interpretation's embedding
    const triggerInterpretation = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT id, "eventId", content, embedding::text, "createdAt"
        FROM "Interpretation"
        WHERE "eventId" = ${triggerEventId}
          AND embedding IS NOT NULL
        LIMIT 1
    `;

    // FALLBACK 1: No interpretation found → reinforce most recent or create singleton
    if (triggerInterpretation.length === 0) {
        console.log(`[PatternDetection] No interpretation found for event ${triggerEventId}, using fallback`);

        const mostRecent = await getMostRecentActivePattern(userId);
        if (mostRecent) {
            // Fetch existing description for restatement in fallback
            const existingPattern = await prisma.pattern.findUnique({
                where: { id: mostRecent.id },
                select: { description: true },
            });
            const newPatternId = await reinforcePattern(
                mostRecent.id,
                [triggerEventId],
                existingPattern?.description || '## Pattern reinforced (fallback — no interpretation available)'
            );
            console.log(`[PatternDetection] REINFORCED_PATTERN ${mostRecent.id} → ${newPatternId} (fallback - no interpretation)`);
            return {
                success: true,
                outcome: PatternOutcome.REINFORCED_PATTERN,
                patternId: newPatternId,
                patternsCreated: 0,
                patternsReinforced: 1,
                patternsEvolved: 0,
                clustersFound: 0,
            };
        }

        // No patterns exist → create singleton
        const patternId = await createSingletonPattern(userId, triggerEventId);
        console.log(`[PatternDetection] CREATED_NEW_PATTERN ${patternId} (singleton - no interpretation)`);
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId,
            patternsCreated: 1,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: 0,
        };
    }

    const trigger = triggerInterpretation[0];
    const triggerEmbedding = parseEmbedding(trigger.embedding);

    // 1b. Get the RAW event content (not the interpretation which may be biased)
    const triggerEvent = await prisma.event.findUnique({
        where: { id: triggerEventId },
        select: { content: true, occurredAt: true, trackedType: true },
    });
    const rawEventContent = triggerEvent?.content || trigger.content;
    const triggerTrackedType = triggerEvent?.trackedType || null;
    const triggerOccurredAt = triggerEvent?.occurredAt || new Date();

    // 2a. Fetch ALL events from the same day (all track types) for holistic context
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

    // 2b. Fetch same-track-type events from last 30 days for progression
    const thirtyDaysAgo = new Date(triggerOccurredAt);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trackTypeHistory = triggerTrackedType ? await prisma.event.findMany({
        where: {
            userId,
            trackedType: triggerTrackedType,
            occurredAt: { gte: thirtyDaysAgo, lt: dayStart },
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'desc' },
        take: 15,
    }) : [];

    // 2c. Fetch events from 3 days before for causal chain detection
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

    // 3. Get existing patterns with similarity scores
    const patternsWithSimilarity = await getExistingPatternsWithSimilarity(userId, triggerEmbedding);

    // 3. Select representative evidence
    console.log(`[PatternDetection] Selecting representative evidence (full timeline)`);
    const evidence = await selectRepresentativeEvidence(userId, triggerEmbedding, evidenceConfig);
    console.log(`[PatternDetection] Retrieved ${evidence.length} representative interpretations`);

    const eventIds = [triggerEventId, ...evidence.map((e) => e.interpretation.eventId)];
    const uniqueEventIds = [...new Set(eventIds)];

    // 4. Filter candidates by similarity threshold
    const candidatePatterns = patternsWithSimilarity
        .filter(p => p.similarity >= CANDIDATE_SIMILARITY_THRESHOLD)
        .slice(0, MAX_CANDIDATE_PATTERNS);

    // 5. ALWAYS consult LLM for pattern decision (even with high similarity)
    // Embeddings find candidates; LLM decides semantic relevance
    // CRITICAL: Pass RAW event content, not the interpretation (which may be biased toward baseline)
    console.log(`[PatternDetection] Found ${candidatePatterns.length} candidate patterns, consulting LLM`);
    console.log(`[PatternDetection] Raw event: "${rawEventContent}"`);

    // 2d. Fetch interpretations for all context events
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

    // Build holistic context for LLM
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

    const llmDecision = await askLLMAboutPattern(
        userId,
        rawEventContent,
        trigger.content,
        candidatePatterns,
        precedingEventsContext,
        dayEventsContext,
        trackTypeHistoryContext,
        triggerTrackedType
    );

    console.log(`[PatternDetection] LLM decision: ${llmDecision.action} - ${llmDecision.reasoning}`);

    // Handle LLM decisions
    if (llmDecision.action === 'reinforce' && llmDecision.patternId) {
        const newPatternId = await reinforcePattern(
            llmDecision.patternId,
            uniqueEventIds,
            llmDecision.description!  // Full restated description
        );
        console.log(`[PatternDetection] REINFORCED_PATTERN ${llmDecision.patternId} → new entry ${newPatternId}`);
        return {
            success: true,
            outcome: PatternOutcome.REINFORCED_PATTERN,
            patternId: newPatternId,
            patternsCreated: 0,
            patternsReinforced: 1,
            patternsEvolved: 0,
            clustersFound: candidatePatterns.length,
        };
    }

    if (llmDecision.action === 'create' && llmDecision.description && llmDecision.description !== null) {
        const patternId = await createPatternFromLLMDecision(userId, llmDecision.description, uniqueEventIds);
        console.log(`[PatternDetection] CREATED_NEW_PATTERN ${patternId}`);
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId,
            patternsCreated: 1,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: candidatePatterns.length,
        };
    }

    // Fallback: If we reach here, create a new pattern from the trigger
    // This ensures every event contributes to pattern understanding
    console.log(`[PatternDetection] Fallback: creating pattern from trigger content`);
    const fallbackPatternId = await createPatternFromLLMDecision(
        userId,
        `## EMERGING PATTERN\n\n## OBSERVATION\n${trigger.content}\n\n## INTERPRETATION\nEmerging pattern based on recent observation.`,
        uniqueEventIds
    );
    return {
        success: true,
        outcome: PatternOutcome.CREATED_NEW_PATTERN,
        patternId: fallbackPatternId,
        patternsCreated: 1,
        patternsReinforced: 0,
        patternsEvolved: 0,
        clustersFound: candidatePatterns.length,
    };

}

// ============================================================================
// Batch Pattern Detection (Legacy - kept for backward compatibility)
// ============================================================================

/**
 * Detects patterns from recent interpretations via embedding clustering.
 *
 * This is the batch/periodic pattern detection that:
 * 1. Fetches recent interpretations with embeddings
 * 2. Clusters semantically similar interpretations
 * 3. For each significant cluster:
 *    - Check if it matches an existing pattern (reinforce)
 *    - Or create a new pattern via LLM synthesis
 * 4. Links PatternEvents for audit trail
 *
 * @deprecated Use detectPatternsForEvent for pipeline mode.
 * This function is kept for backfills, debugging, and recovery only.
 * It should never be auto-scheduled.
 */
export async function detectPatterns(
    input: DetectPatternsInput
): Promise<DetectPatternsResult> {
    const { userId, lookbackDays = 30, clusteringConfig = DEFAULT_CLUSTERING_CONFIG } = input;

    // 1. Calculate lookback date
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

    // 2. Fetch recent interpretations with embeddings
    const rawInterpretations = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            userId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT
            id,
            "eventId",
            "userId",
            content,
            embedding::text,
            "createdAt"
        FROM "Interpretation"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${lookbackDate}
          AND embedding IS NOT NULL
        ORDER BY "createdAt" DESC
    `;

    // Parse embeddings from string to number[]
    const interpretations: InterpretationWithEmbedding[] = rawInterpretations.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        userId: row.userId,
        content: row.content,
        embedding: parseEmbedding(row.embedding),
        createdAt: row.createdAt,
    }));

    if (interpretations.length < clusteringConfig.minClusterSize) {
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId: '',
            patternsCreated: 0,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: 0,
        };
    }

    // 3. Cluster interpretations
    const clusters = clusterInterpretations(interpretations, clusteringConfig);

    // 4. Fetch existing patterns for matching
    const existingPatterns = await prisma.$queryRaw<
        Array<{ id: string; embedding: string }>
    >`
        SELECT id, embedding::text
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND status = 'ACTIVE'
          AND embedding IS NOT NULL
    `;

    const patternEmbeddings = existingPatterns.map((p) => ({
        id: p.id,
        embedding: parseEmbedding(p.embedding),
    }));

    // 5. Process each cluster
    let patternsCreated = 0;
    let patternsReinforced = 0;
    let lastPatternId = '';

    for (const cluster of clusters) {
        // Check for matching existing patterns
        const matchingPatternIds = findSimilarPatterns(
            cluster.centroid,
            patternEmbeddings,
            0.8
        );

        const eventIds = cluster.interpretations.map((i) => i.eventId);

        if (matchingPatternIds.length > 0) {
            // Reinforce existing pattern (batch legacy — use existing description)
            const patternId = matchingPatternIds[0];
            const existingPattern = await prisma.pattern.findUnique({
                where: { id: patternId },
                select: { description: true },
            });
            const newId = await reinforcePattern(
                patternId,
                eventIds,
                existingPattern?.description || '## Pattern reinforced (batch mode)'
            );
            patternsReinforced++;
            lastPatternId = newId;
        } else {
            // Create new pattern
            const newPatternId = await createNewPattern(userId, cluster, eventIds);
            patternsCreated++;
            lastPatternId = newPatternId;
        }
    }

    // Determine primary outcome for batch mode
    const outcome = patternsCreated > 0
        ? PatternOutcome.CREATED_NEW_PATTERN
        : PatternOutcome.REINFORCED_PATTERN;

    return {
        success: true,
        outcome,
        patternId: lastPatternId,
        patternsCreated,
        patternsReinforced,
        patternsEvolved: 0,
        clustersFound: clusters.length,
    };
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseEmbedding(embeddingStr: string): number[] {
    // Format: "[0.1,0.2,0.3,...]"
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

interface PatternWithSimilarity {
    id: string;
    description: string;
    embedding: number[];
    similarity: number;
}

/**
 * Gets the most recent active pattern for a user.
 * Used as fallback when no interpretation exists.
 */
async function getMostRecentActivePattern(userId: string): Promise<{ id: string } | null> {
    const pattern = await prisma.pattern.findFirst({
        where: {
            userId,
            status: 'ACTIVE',
        },
        orderBy: { lastReinforcedAt: 'desc' },
        select: { id: true },
    });
    return pattern;
}

/**
 * Creates a singleton "emerging" pattern from just the event content.
 * Used when no interpretation is available.
 */
async function createSingletonPattern(userId: string, eventId: string): Promise<string> {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { content: true },
    });

    const description = `## EMERGING PATTERN\n\n## OBSERVATION\nSingle event observed. Pattern emerging.\n\n## SUPPORTING EVIDENCE\n- ${event?.content || 'Event content unavailable'}\n\n## INTERPRETATION\nThis is an emerging pattern based on a single observation. As more similar events occur, this pattern will evolve and develop clearer characteristics.\n\n## TEMPORAL CHARACTERISTICS\nInsufficient data for temporal analysis.\n\n## POTENTIAL IMPLICATIONS\nTo be determined as pattern develops.`;

    const embeddingResult = await embedText({ text: description });

    const pattern = await prisma.$transaction(async (tx) => {
        const created = await tx.pattern.create({
            data: {
                userId,
                description,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        await tx.patternEvent.create({
            data: {
                patternId: created.id,
                eventId,
            },
        });

        return created;
    });

    return pattern.id;
}

/**
 * Creates a singleton pattern from an interpretation.
 * Used when we have interpretation but insufficient similar evidence.
 */
async function createSingletonPatternFromInterpretation(
    userId: string,
    interpretation: { id: string; content: string; embedding: string },
    eventId: string
): Promise<string> {
    const description = `## EMERGING PATTERN\n\n## OBSERVATION\nSingle event observed. Pattern emerging.\n\n## SUPPORTING EVIDENCE\n${interpretation.content}\n\n## INTERPRETATION\nThis is an emerging pattern based on a single observation. As more similar events occur, this pattern will evolve and develop clearer characteristics.\n\n## TEMPORAL CHARACTERISTICS\nInsufficient data for temporal analysis.\n\n## POTENTIAL IMPLICATIONS\nTo be determined as pattern develops.`;

    const embeddingResult = await embedText({ text: description });

    const pattern = await prisma.$transaction(async (tx) => {
        const created = await tx.pattern.create({
            data: {
                userId,
                description,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        await tx.patternEvent.create({
            data: {
                patternId: created.id,
                eventId,
            },
        });

        return created;
    });

    return pattern.id;
}

/**
 * Gets all existing patterns for a user with similarity scores.
 * Returns sorted by similarity (highest first).
 */
async function getExistingPatternsWithSimilarity(
    userId: string,
    targetEmbedding: number[]
): Promise<PatternWithSimilarity[]> {
    const patterns = await prisma.$queryRaw<
        Array<{ id: string; description: string; embedding: string }>
    >`
        SELECT id, description, embedding::text
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND status = 'ACTIVE'
          AND embedding IS NOT NULL
    `;

    const withSimilarity: PatternWithSimilarity[] = patterns.map((p) => {
        const embedding = parseEmbedding(p.embedding);
        const similarity = cosineSimilarity(targetEmbedding, embedding);
        return {
            id: p.id,
            description: p.description,
            embedding,
            similarity,
        };
    });

    // Sort by similarity descending
    withSimilarity.sort((a, b) => b.similarity - a.similarity);

    return withSimilarity;
}

/**
 * Fetches user context (name and baseline) for personalization.
 */
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

/**
 * Asks the LLM whether a new observation should reinforce an existing pattern
 * or create a genuinely new pattern.
 *
 * Core Principle: Embeddings find candidates, LLM verifies semantic relevance.
 * High similarity score ≠ semantic relevance. "YouTube" ≠ "Dietary Discipline".
 *
 * CRITICAL: We pass BOTH the raw event content AND the interpretation.
 * The LLM should match based on the RAW EVENT, not the interpretation
 * (which may be biased toward the user's baseline).
 *
 * If no existing pattern is ACTUALLY relevant to this event, LLM must CREATE
 * a new pattern that properly captures what this event represents.
 */
async function askLLMAboutPattern(
    userId: string,
    rawEventContent: string,
    interpretationContent: string,
    existingPatterns: PatternWithSimilarity[],
    precedingEvents: Array<{ content: string; trackedType: string; occurredAt: string; interpretation?: string | null }> = [],
    dayEvents: Array<{ content: string; trackedType: string; occurredAt: string; interpretation?: string | null }> = [],
    trackTypeHistory: Array<{ content: string; occurredAt: string; interpretation?: string | null }> = [],
    trackedType: string | null = null
): Promise<{ action: 'reinforce' | 'create'; patternId?: string; description?: string; reasoning: string }> {
    const { userName, userBaseline } = await getUserContext(userId);

    const patternsContext = existingPatterns.map((p, i) => ({
        index: i + 1,
        id: p.id,
        description: p.description,
        similarity: p.similarity.toFixed(3),
    }));

    // CRITICAL: Structure the message to emphasize the raw event
    // The interpretation is context but the RAW EVENT is what matters for pattern matching
    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        rawEvent: rawEventContent,
        trackedType: trackedType || 'GENERAL',
        interpretation: interpretationContent,
        existingPatterns: patternsContext,
        // All events from the same day (cross-domain context)
        dayEvents,
        // Events from last 3 days (causal chain detection)
        precedingEvents,
        // Same track type events from last 30 days (progression)
        trackTypeHistory,
    });

    const { modelConfig, systemPrompt } = PATTERN_DECISION_PROMPT;

    // Use OpenAI structured outputs to enforce schema - description MUST be a string
    // Note: strict mode requires ALL properties in 'required' array
    const patternDecisionJsonSchema = {
        name: 'pattern_decision',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['reinforce', 'create'] },
                patternId: { type: ['string', 'null'], description: 'Required if action=reinforce' },
                description: { type: ['string', 'null'], description: 'FULL pattern markdown. Required for BOTH create AND reinforce.' },
                reasoning: { type: 'string' },
            },
            required: ['action', 'patternId', 'description', 'reasoning'],
            additionalProperties: false,
        },
    };

    const completion = await openai.chat.completions.create({
        model: modelConfig.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: modelConfig.temperature,
        max_tokens: modelConfig.maxTokens,
        response_format: { type: 'json_schema', json_schema: patternDecisionJsonSchema },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        // Fallback: create new pattern based on the observation
        return {
            action: 'create',
            description: `## EMERGING PATTERN\n\n## OBSERVATION\n${rawEventContent}\n\n## INTERPRETATION\nEmerging pattern based on recent observation. Created due to LLM empty response.`,
            reasoning: 'LLM returned empty response, creating new pattern from observation',
        };
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let parsed: { action: 'reinforce' | 'create'; patternId: string | null; description: string | null; reasoning: string };
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        return {
            action: 'create',
            description: `## EMERGING PATTERN\n\n## OBSERVATION\n${rawEventContent}\n\n## INTERPRETATION\nEmerging pattern based on recent observation. Created due to LLM parse error.`,
            reasoning: 'LLM returned invalid JSON, creating new pattern from observation',
        };
    }

    const { action, patternId, description, reasoning } = parsed;
    return {
        action,
        patternId: patternId ?? undefined,
        description: description ?? undefined,
        reasoning,
    };
}

/**
 * Creates a new pattern from LLM-generated description.
 * Used when LLM decides the observation is genuinely new.
 */
async function createPatternFromLLMDecision(
    userId: string,
    description: string,
    eventIds: string[]
): Promise<string> {
    const embeddingResult = await embedText({ text: description });

    const patternId = await prisma.$transaction(async (tx) => {
        const pattern = await tx.pattern.create({
            data: {
                userId,
                description,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            pattern.id
        );

        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: pattern.id,
                eventId,
            })),
            skipDuplicates: true,
        });

        return pattern.id;
    }, { timeout: 15000 });

    return patternId;
}

async function reinforcePattern(
    patternId: string,
    eventIds: string[],
    newDescription: string  // Always required now — full standalone description
): Promise<string> {
    // 1. Get old pattern's event links
    const oldPatternEvents = await prisma.patternEvent.findMany({
        where: { patternId },
        select: { eventId: true },
    });
    const allEventIds = [...new Set([
        ...oldPatternEvents.map(pe => pe.eventId),
        ...eventIds,
    ])];

    // 2. Embed new description
    const embeddingResult = await embedText({ text: newDescription });
    const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;

    // 3. Transaction: create new, supersede old
    const newPatternId = await prisma.$transaction(async (tx) => {
        // Get old pattern metadata
        const oldPattern = await tx.pattern.findUnique({
            where: { id: patternId },
            select: { reinforcementCount: true, userId: true },
        });

        // Mark old pattern as SUPERSEDED
        await tx.pattern.update({
            where: { id: patternId },
            data: { status: 'SUPERSEDED' },
        });

        // Create new pattern
        const newPattern = await tx.pattern.create({
            data: {
                userId: oldPattern!.userId,
                description: newDescription,
                status: 'ACTIVE',
                reinforcementCount: (oldPattern!.reinforcementCount || 1) + 1,
            },
            select: { id: true },
        });

        // Set embedding
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            newPattern.id
        );

        // Link all events to new pattern
        await tx.patternEvent.createMany({
            data: allEventIds.map(eventId => ({
                patternId: newPattern.id,
                eventId,
            })),
            skipDuplicates: true,
        });

        return newPattern.id;
    }, { timeout: 15000 });

    return newPatternId;
}

/**
 * Creates a new pattern from scored evidence.
 * Used by event-triggered detection.
 */
async function createPatternFromEvidence(
    userId: string,
    evidence: ScoredInterpretation[],
    eventIds: string[]
): Promise<string> {
    // Fetch user context for personalization
    const { userName, userBaseline } = await getUserContext(userId);

    // Build LLM input from evidence
    const evidenceSummary = evidence.map((e) => ({
        content: e.interpretation.content,
        createdAt: e.interpretation.createdAt.toISOString(),
        isFromExistingPattern: !!e.fromPatternId,
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        mode: 'CREATE',
        eventCount: evidence.length,
        interpretations: evidenceSummary,
    });

    // Call LLM for pattern synthesis with Structured Output
    // JSON schema guarantees valid response - no Zod validation needed
    const { modelConfig: synthConfig, systemPrompt: synthPrompt } = PATTERN_SYNTHESIS_PROMPT;
    const completion = await openai.chat.completions.create({
        model: synthConfig.model,
        messages: [
            { role: 'system', content: synthPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: synthConfig.temperature,
        response_format: {
            type: 'json_schema',
            json_schema: PATTERN_OUTPUT_JSON_SCHEMA,
        },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new PatternDetectionError('LLM returned empty response for pattern synthesis');
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let parsed: { pattern: string };
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new PatternDetectionError('LLM returned invalid JSON for pattern', e);
    }

    const patternDescription = parsed.pattern;

    // Embed the pattern
    const embeddingResult = await embedText({ text: patternDescription });

    // Store pattern with embedding
    const patternId = await prisma.$transaction(async (tx) => {
        const pattern = await tx.pattern.create({
            data: {
                userId,
                description: patternDescription,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Update with embedding
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            pattern.id
        );

        // Create PatternEvents
        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: pattern.id,
                eventId,
            })),
            skipDuplicates: true,
        });

        return pattern.id;
    }, { timeout: 15000 });

    return patternId;
}

/**
 * Creates a new pattern from a cluster.
 * Used by batch detection (legacy).
 */
async function createNewPattern(
    userId: string,
    cluster: { interpretations: InterpretationWithEmbedding[]; centroid: number[] },
    eventIds: string[]
): Promise<string> {
    // Fetch user context for personalization
    const { userName, userBaseline } = await getUserContext(userId);

    // Build LLM input from cluster interpretations
    const clusterSummary = cluster.interpretations.map((i) => ({
        content: i.content,
        createdAt: i.createdAt.toISOString(),
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        mode: 'CREATE',
        eventCount: cluster.interpretations.length,
        interpretations: clusterSummary,
    });

    // Call LLM for pattern synthesis with Structured Output
    // JSON schema guarantees valid response - no Zod validation needed
    const { modelConfig: synthConfig, systemPrompt: synthPrompt } = PATTERN_SYNTHESIS_PROMPT;
    const completion = await openai.chat.completions.create({
        model: synthConfig.model,
        messages: [
            { role: 'system', content: synthPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: synthConfig.temperature,
        response_format: {
            type: 'json_schema',
            json_schema: PATTERN_OUTPUT_JSON_SCHEMA,
        },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new PatternDetectionError('LLM returned empty response for pattern synthesis');
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let parsed: { pattern: string };
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new PatternDetectionError('LLM returned invalid JSON for pattern', e);
    }

    const patternDescription = parsed.pattern;

    // Embed the pattern
    const embeddingResult = await embedText({ text: patternDescription });

    // Store pattern with embedding
    const patternId = await prisma.$transaction(async (tx) => {
        const pattern = await tx.pattern.create({
            data: {
                userId,
                description: patternDescription,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Update with embedding
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            pattern.id
        );

        // Create PatternEvents
        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: pattern.id,
                eventId,
            })),
        });

        return pattern.id;
    });

    return patternId;
}
