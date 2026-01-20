"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InterpretationError = void 0;
exports.interpretEvent = interpretEvent;
const prisma_1 = __importDefault(require("../../prisma"));
const openai_1 = require("../../services/openai");
const embedding_1 = require("../../services/embedding");
const prompts_1 = require("../../prompts");
const schema_1 = require("./schema");
class InterpretationError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'InterpretationError';
    }
}
exports.InterpretationError = InterpretationError;
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
async function interpretEvent(input) {
    const { eventId } = input;
    // 1. Check idempotency - skip if already processed
    const existingInterpretation = await prisma_1.default.interpretation.findUnique({
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
    // 2. Fetch event
    const event = await prisma_1.default.event.findUnique({
        where: { id: eventId },
        select: {
            id: true,
            userId: true,
            content: true,
            occurredAt: true,
        },
    });
    if (!event) {
        throw new InterpretationError(`Event not found: ${eventId}`);
    }
    // 3. Build LLM input
    const userMessage = JSON.stringify({
        event: {
            content: event.content,
            occurredAt: event.occurredAt.toISOString(),
        },
    });
    // 4. Call OpenAI for rich interpretation
    const { modelConfig, systemPrompt } = prompts_1.INTERPRETATION_PROMPT;
    const completion = await openai_1.openai.chat.completions.create({
        model: modelConfig.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: modelConfig.temperature,
        response_format: { type: modelConfig.responseFormat ?? 'json_object' },
    });
    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new InterpretationError('LLM returned empty response');
    }
    // 5. Parse and validate LLM output
    let parsed;
    try {
        parsed = JSON.parse(rawResponse);
    }
    catch (e) {
        throw new InterpretationError('LLM returned invalid JSON', e);
    }
    const validated = schema_1.InterpretationOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new InterpretationError(`LLM output validation failed: ${validated.error.message}`);
    }
    const interpretationContent = validated.data.interpretation;
    // 6. Generate embedding for the interpretation
    const embeddingResult = await (0, embedding_1.embedText)({ text: interpretationContent });
    // 7. Store interpretation with embedding
    // Note: Prisma doesn't directly support vector types in create operations,
    // so we use a raw query to insert the embedding
    const interpretation = await prisma_1.default.$transaction(async (tx) => {
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
        await tx.$executeRawUnsafe(`UPDATE "Interpretation" SET embedding = $1::vector WHERE id = $2`, embeddingStr, created.id);
        return created;
    });
    return {
        success: true,
        interpretationId: interpretation.id,
    };
}
