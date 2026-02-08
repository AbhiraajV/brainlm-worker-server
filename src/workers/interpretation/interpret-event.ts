import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText } from '../../services/embedding';
import { INTERPRETATION_PROMPT } from '../../prompts';

// ============================================================================
// JSON Schema for Structured Output
// ============================================================================

// OpenAI Structured Output guarantees this schema - no validation needed after
const INTERPRETATION_JSON_SCHEMA = {
    name: 'interpretation_output',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            interpretation: {
                type: 'string',
                description: 'The rich interpretation document in markdown format',
            },
        },
        required: ['interpretation'],
        additionalProperties: false,
    },
} as const;

// ============================================================================
// Types
// ============================================================================

export interface InterpretEventInput {
    eventId: string;
}

export interface InterpretEventResult {
    success: boolean;
    interpretationId?: string;
    skipped?: boolean;
    reason?: string;
}

export class InterpretationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'InterpretationError';
    }
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Generates a rich interpretation for a single event.
 * 
 * This is the core interpretation worker that:
 * 1. Fetches the event
 * 2. Generates a rich interpretation via LLM (500-2000 words)
 * 3. Embeds the interpretation
 * 4. Stores interpretation + embedding
 * 
 * Idempotent: skips if interpretation already exists for this event.
 */
export async function interpretEvent(
    input: InterpretEventInput
): Promise<InterpretEventResult> {
    const { eventId } = input;

    // 1. Check idempotency - skip if already processed
    const existingInterpretation = await prisma.interpretation.findUnique({
        where: { eventId },
        select: { id: true },
    });

    if (existingInterpretation) {
        return {
            success: true,
            interpretationId: existingInterpretation.id,
            skipped: true,
            reason: 'Interpretation already exists',
        };
    }

    // 2. Fetch event with user context
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: {
            id: true,
            userId: true,
            content: true,
            occurredAt: true,
            trackedType: true,
            rawJson: true,
            user: {
                select: {
                    name: true,
                    baseline: true,
                },
            },
        },
    });

    if (!event) {
        throw new InterpretationError(`Event not found: ${eventId}`);
    }

    // 2b. Fetch last 5 same-type events for comparison
    const recentSameTypeEvents = event.trackedType
        ? await prisma.event.findMany({
              where: {
                  userId: event.userId,
                  trackedType: event.trackedType,
                  id: { not: event.id },
                  occurredAt: { lt: event.occurredAt },
              },
              select: { content: true, occurredAt: true, rawJson: true },
              orderBy: { occurredAt: 'desc' },
              take: 5,
          })
        : [];

    // 3. Build LLM input with user context
    const userMessage = JSON.stringify({
        userName: event.user.name || 'User',
        userBaseline: event.user.baseline || 'No baseline available yet.',
        event: {
            content: event.content,
            occurredAt: event.occurredAt.toISOString(),
            trackedType: event.trackedType || 'GENERAL',
            rawJson: event.rawJson || null,
        },
        recentSameTypeEvents: recentSameTypeEvents.map(e => ({
            content: e.content,
            occurredAt: e.occurredAt.toISOString(),
            rawJson: e.rawJson || null,
        })),
    });

    // 4. Call OpenAI for rich interpretation with Structured Output
    // JSON schema guarantees valid response - no Zod validation needed
    const { modelConfig, systemPrompt } = INTERPRETATION_PROMPT;
    const completion = await openai.chat.completions.create({
        model: modelConfig.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: modelConfig.temperature,
        response_format: {
            type: 'json_schema',
            json_schema: INTERPRETATION_JSON_SCHEMA,
        },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new InterpretationError('LLM returned empty response');
    }

    // 5. Parse LLM output - Structured Output guarantees schema compliance
    let parsed: { interpretation: string };
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new InterpretationError('LLM returned invalid JSON', e);
    }

    const interpretationContent = parsed.interpretation;

    // 6. Generate embedding for the interpretation
    const embeddingResult = await embedText({ text: interpretationContent });

    // 7. Store interpretation with embedding
    // Note: Prisma doesn't directly support vector types in create operations,
    // so we use a raw query to insert the embedding
    const interpretation = await prisma.$transaction(async (tx) => {
        // First create without embedding
        const created = await tx.interpretation.create({
            data: {
                userId: event.userId,
                eventId: event.id,
                content: interpretationContent,
                source: 'AUTOMATIC',
            },
            select: { id: true },
        });

        // Then update with embedding using raw SQL
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Interpretation" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        return created;
    });

    return {
        success: true,
        interpretationId: interpretation.id,
    };
}
