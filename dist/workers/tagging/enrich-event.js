"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnrichmentError = void 0;
exports.enrichEvent = enrichEvent;
const openai_1 = __importDefault(require("openai"));
const prisma_1 = __importDefault(require("../../prisma"));
const prompt_1 = require("./prompt");
const schema_1 = require("./schema");
class EnrichmentError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'EnrichmentError';
    }
}
exports.EnrichmentError = EnrichmentError;
// ============================================================================
// Helpers
// ============================================================================
function normalizeSlug(raw) {
    return raw
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\-\/]/g, '')
        .replace(/\/+/g, '/')
        .replace(/^\/|\/$/g, '')
        .replace(/-+/g, '-');
}
function calculateDepth(slug) {
    return slug.split('/').length;
}
// ============================================================================
// Main Function
// ============================================================================
async function enrichEvent(eventId) {
    // 1. Check idempotency - skip if already processed
    const existingEventTags = await prisma_1.default.eventTag.count({
        where: { eventId },
    });
    if (existingEventTags > 0) {
        return {
            success: true,
            tagsCreated: 0,
            tagsReused: 0,
            interpretationsCreated: 0,
            skipped: true,
            reason: 'Already processed',
        };
    }
    // 2. Fetch event and user's existing tags
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
        throw new EnrichmentError(`Event not found: ${eventId}`);
    }
    const existingTags = await prisma_1.default.tag.findMany({
        where: { userId: event.userId },
        select: {
            id: true,
            slug: true,
            description: true,
        },
    });
    // 3. Build LLM input
    const userMessage = JSON.stringify({
        event: {
            content: event.content,
            occurredAt: event.occurredAt.toISOString(),
        },
        existingTags: existingTags.map((t) => ({
            slug: t.slug,
            description: t.description,
        })),
    });
    // 4. Call OpenAI
    const openai = new openai_1.default({
        apiKey: process.env.OPENAI_API_KEY,
    });
    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: prompt_1.TAGGING_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
    });
    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new EnrichmentError('LLM returned empty response');
    }
    // 5. Parse and validate LLM output
    let parsed;
    try {
        parsed = JSON.parse(rawResponse);
    }
    catch (e) {
        throw new EnrichmentError('LLM returned invalid JSON', e);
    }
    const validated = schema_1.LLMOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new EnrichmentError(`LLM output validation failed: ${validated.error.message}`);
    }
    const llmOutput = validated.data;
    // 6. Process tags - determine which are new vs existing
    const existingTagMap = new Map(existingTags.map((t) => [t.slug, t.id]));
    const tagsToCreate = [];
    const tagIdsToLink = [];
    for (const tag of llmOutput.tags) {
        const normalizedSlug = normalizeSlug(tag.slug);
        const existingTagId = existingTagMap.get(normalizedSlug);
        if (existingTagId) {
            // Reuse existing tag
            tagIdsToLink.push({ tagId: existingTagId, confidence: tag.confidence });
        }
        else {
            // Mark for creation
            tagsToCreate.push({ ...tag, slug: normalizedSlug });
        }
    }
    // 7. Write to database in a transaction
    let tagsCreated = 0;
    let tagsReused = tagIdsToLink.length;
    await prisma_1.default.$transaction(async (tx) => {
        // Create new tags
        for (const tag of tagsToCreate) {
            const created = await tx.tag.create({
                data: {
                    userId: event.userId,
                    slug: tag.slug,
                    name: tag.name,
                    description: tag.description,
                    depth: calculateDepth(tag.slug),
                },
                select: { id: true },
            });
            tagIdsToLink.push({ tagId: created.id, confidence: tag.confidence });
            tagsCreated++;
        }
        // Create EventTags
        await tx.eventTag.createMany({
            data: tagIdsToLink.map((t) => ({
                eventId: event.id,
                tagId: t.tagId,
                confidence: t.confidence,
            })),
        });
        // Create Interpretations
        await tx.interpretation.createMany({
            data: llmOutput.interpretations.map((i) => ({
                userId: event.userId,
                eventId: event.id,
                content: i.content,
                confidence: i.confidence,
                source: 'AUTOMATIC',
            })),
        });
    });
    return {
        success: true,
        tagsCreated,
        tagsReused,
        interpretationsCreated: llmOutput.interpretations.length,
    };
}
