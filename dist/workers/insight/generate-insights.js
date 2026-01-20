"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InsightGenerationError = void 0;
exports.generateInsights = generateInsights;
const prisma_1 = __importDefault(require("../../prisma"));
const openai_1 = require("../../services/openai");
const embedding_1 = require("../../services/embedding");
const schema_1 = require("./schema");
const data_retrieval_1 = require("./data-retrieval");
const prompt_1 = require("./prompt");
const prompts_1 = require("../../prompts");
class InsightGenerationError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'InsightGenerationError';
    }
}
exports.InsightGenerationError = InsightGenerationError;
// Configuration is now centralized in src/prompts.ts via INSIGHT_GENERATION_PROMPT
// ============================================================================
// Helper: Get Target Embedding from Trigger
// ============================================================================
async function getTargetEmbedding(trigger, userId) {
    // Try to get embedding from trigger context
    if (trigger.interpretationId) {
        const interpretation = await prisma_1.default.$queryRaw `
            SELECT embedding::text
            FROM "Interpretation"
            WHERE id = ${trigger.interpretationId}
              AND embedding IS NOT NULL
            LIMIT 1
        `;
        if (interpretation.length > 0) {
            return parseEmbedding(interpretation[0].embedding);
        }
    }
    if (trigger.patternId) {
        const pattern = await prisma_1.default.$queryRaw `
            SELECT embedding::text
            FROM "Pattern"
            WHERE id = ${trigger.patternId}
              AND embedding IS NOT NULL
            LIMIT 1
        `;
        if (pattern.length > 0) {
            return parseEmbedding(pattern[0].embedding);
        }
    }
    if (trigger.eventId) {
        // Try event's interpretation first
        const interpretation = await prisma_1.default.$queryRaw `
            SELECT embedding::text
            FROM "Interpretation"
            WHERE "eventId" = ${trigger.eventId}
              AND embedding IS NOT NULL
            LIMIT 1
        `;
        if (interpretation.length > 0) {
            return parseEmbedding(interpretation[0].embedding);
        }
        // Fall back to event embedding
        const event = await prisma_1.default.$queryRaw `
            SELECT embedding::text
            FROM "Event"
            WHERE id = ${trigger.eventId}
              AND embedding IS NOT NULL
            LIMIT 1
        `;
        if (event.length > 0) {
            return parseEmbedding(event[0].embedding);
        }
    }
    // Last resort: use most recent pattern's embedding
    const recentPattern = await prisma_1.default.$queryRaw `
        SELECT embedding::text
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND embedding IS NOT NULL
          AND status = 'ACTIVE'
        ORDER BY "lastReinforcedAt" DESC
        LIMIT 1
    `;
    if (recentPattern.length > 0) {
        return parseEmbedding(recentPattern[0].embedding);
    }
    // If no embedding found, generate a neutral one from user's total context
    // This shouldn't happen in practice, but provides a fallback
    const embeddingResult = await (0, embedding_1.embedText)({ text: 'General user insight synthesis' });
    return embeddingResult.embedding;
}
function parseEmbedding(embeddingStr) {
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}
// ============================================================================
// Helper: Map relevance string to Prisma enum value
// ============================================================================
function mapRelevance(relevance) {
    switch (relevance.toLowerCase()) {
        case 'primary':
            return 'PRIMARY';
        case 'supporting':
            return 'SUPPORTING';
        case 'contextual':
            return 'CONTEXTUAL';
        default:
            return 'SUPPORTING';
    }
}
// ============================================================================
// Helper: Persist Insights
// ============================================================================
async function persistInsights(userId, insights, trigger) {
    const createdIds = [];
    let reinforced = 0;
    let superseded = 0;
    for (const insight of insights) {
        // Generate embedding for the insight
        const embeddingText = `${insight.statement}\n\n${insight.explanation}`;
        const embeddingResult = await (0, embedding_1.embedText)({ text: embeddingText });
        // Handle supersession
        if (insight.supersedesInsightId) {
            await prisma_1.default.insight.update({
                where: { id: insight.supersedesInsightId },
                data: {
                    status: 'SUPERSEDED',
                    supersededById: '', // Will be updated after creating new insight
                },
            });
            superseded++;
        }
        // Create the insight and junction table records
        const created = await prisma_1.default.$transaction(async (tx) => {
            // Create the insight (without evidenceRefs - now using junction tables)
            const newInsight = await tx.insight.create({
                data: {
                    userId,
                    statement: insight.statement,
                    explanation: insight.explanation,
                    confidence: insight.confidence,
                    status: insight.status,
                    category: insight.category,
                    temporalScope: insight.temporalScope,
                    supersedes: insight.supersedesInsightId,
                    triggerType: trigger.type,
                    triggerEventId: trigger.eventId,
                },
                select: { id: true },
            });
            // Update with embedding
            const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
            await tx.$executeRawUnsafe(`UPDATE "Insight" SET embedding = $1::vector WHERE id = $2`, embeddingStr, newInsight.id);
            // Create junction table records for each evidence reference
            for (const ref of insight.evidenceRefs) {
                const relevance = mapRelevance(ref.relevance);
                switch (ref.type) {
                    case 'event':
                        await tx.insightEvent.create({
                            data: {
                                insightId: newInsight.id,
                                eventId: ref.id,
                                relevance,
                                excerpt: ref.excerpt,
                            },
                        });
                        break;
                    case 'pattern':
                        await tx.insightPattern.create({
                            data: {
                                insightId: newInsight.id,
                                patternId: ref.id,
                                relevance,
                                excerpt: ref.excerpt,
                            },
                        });
                        break;
                    case 'interpretation':
                        await tx.insightInterpretation.create({
                            data: {
                                insightId: newInsight.id,
                                interpretationId: ref.id,
                                relevance,
                                excerpt: ref.excerpt,
                            },
                        });
                        break;
                    case 'insight':
                        // For insight-to-insight references, we could add another junction table
                        // For now, we skip these as they're less common
                        console.log(`[InsightPersist] Skipping insight-to-insight reference: ${ref.id}`);
                        break;
                }
            }
            // Always link to triggering event if not already in evidenceRefs
            if (trigger.eventId) {
                const alreadyLinked = insight.evidenceRefs.some((ref) => ref.type === 'event' && ref.id === trigger.eventId);
                if (!alreadyLinked) {
                    await tx.insightEvent.create({
                        data: {
                            insightId: newInsight.id,
                            eventId: trigger.eventId,
                            relevance: 'PRIMARY',
                        },
                    });
                }
            }
            // Update superseded insight with reference to new one
            if (insight.supersedesInsightId) {
                await tx.insight.update({
                    where: { id: insight.supersedesInsightId },
                    data: { supersededById: newInsight.id },
                });
            }
            return newInsight;
        });
        createdIds.push(created.id);
    }
    return { created: createdIds, reinforced, superseded };
}
// ============================================================================
// Main Function
// ============================================================================
/**
 * Generates insights from patterns and interpretations.
 *
 * This is the main entry point for the Insight Worker (Worker 3).
 * It follows the principle: "LLMs reason. Databases measure."
 *
 * Flow:
 * 1. Get target embedding from trigger context
 * 2. Retrieve all context (patterns, interpretations, facts) via SQL
 * 3. Format context for LLM
 * 4. Call LLM to generate questions and insights
 * 5. Validate output with Zod
 * 6. Persist insights with embeddings
 *
 * @param input - Generation input with userId, trigger, and optional config
 * @returns Generation result with counts and created IDs
 */
async function generateInsights(input) {
    const { userId, trigger, retrievalConfig = data_retrieval_1.DEFAULT_RETRIEVAL_CONFIG, } = input;
    console.log(`[InsightGeneration] Starting for user ${userId}, trigger: ${trigger.type}`);
    try {
        // ====================================================================
        // Step 1: Get target embedding from trigger
        // ====================================================================
        const targetEmbedding = await getTargetEmbedding(trigger, userId);
        console.log(`[InsightGeneration] Retrieved target embedding (dim=${targetEmbedding.length})`);
        // ====================================================================
        // Step 2: Retrieve all context (BEFORE LLM call)
        // ====================================================================
        const context = await (0, data_retrieval_1.retrieveInsightContext)(userId, trigger, targetEmbedding, retrievalConfig);
        // Check if we have enough data to generate insights
        if (context.patterns.length === 0 && context.interpretations.length === 0) {
            console.log(`[InsightGeneration] Insufficient data for insight generation`);
            return {
                success: true,
                insightsCreated: 0,
                insightsReinforced: 0,
                insightsSuperseded: 0,
                questionsExplored: 0,
                questionsAnswerable: 0,
                createdInsightIds: [],
            };
        }
        // ====================================================================
        // Step 3: Format context for LLM
        // ====================================================================
        const userMessage = (0, prompt_1.formatInsightUserMessage)({
            trigger,
            patterns: context.patterns,
            interpretations: context.interpretations,
            existingInsights: context.existingInsights,
            facts: context.facts,
        });
        console.log(`[InsightGeneration] Formatted context (${userMessage.length} chars)`);
        // ====================================================================
        // Step 4: Call LLM
        // ====================================================================
        const { modelConfig, systemPrompt } = prompts_1.INSIGHT_GENERATION_PROMPT;
        console.log(`[InsightGeneration] Calling LLM (${modelConfig.model})`);
        const completion = await openai_1.openai.chat.completions.create({
            model: modelConfig.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            temperature: modelConfig.temperature,
            max_tokens: modelConfig.maxTokens,
            response_format: { type: modelConfig.responseFormat ?? 'json_object' },
        });
        const rawResponse = completion.choices[0]?.message?.content;
        if (!rawResponse) {
            throw new InsightGenerationError('LLM returned empty response');
        }
        console.log(`[InsightGeneration] LLM response received (${rawResponse.length} chars)`);
        // ====================================================================
        // Step 5: Parse and validate with Zod
        // ====================================================================
        let parsed;
        try {
            parsed = JSON.parse(rawResponse);
        }
        catch (e) {
            throw new InsightGenerationError('LLM returned invalid JSON', e);
        }
        const validated = schema_1.InsightOutputSchema.safeParse(parsed);
        if (!validated.success) {
            console.error(`[InsightGeneration] Validation errors:`, validated.error.issues);
            throw new InsightGenerationError(`Insight output validation failed: ${validated.error.message}`);
        }
        const output = validated.data;
        const questionsExplored = output.questionsExplored.length;
        const questionsAnswerable = output.questionsExplored.filter((q) => q.answerable).length;
        console.log(`[InsightGeneration] LLM explored ${questionsExplored} questions, ` +
            `${questionsAnswerable} answerable, generated ${output.insights.length} insights`);
        // ====================================================================
        // Step 6: Persist insights
        // ====================================================================
        if (output.insights.length === 0) {
            console.log(`[InsightGeneration] No insights to persist`);
            return {
                success: true,
                insightsCreated: 0,
                insightsReinforced: 0,
                insightsSuperseded: 0,
                questionsExplored,
                questionsAnswerable,
                createdInsightIds: [],
            };
        }
        const persistResult = await persistInsights(userId, output.insights, trigger);
        console.log(`[InsightGeneration] Persisted: ${persistResult.created.length} created, ` +
            `${persistResult.reinforced} reinforced, ${persistResult.superseded} superseded`);
        return {
            success: true,
            insightsCreated: persistResult.created.length,
            insightsReinforced: persistResult.reinforced,
            insightsSuperseded: persistResult.superseded,
            questionsExplored,
            questionsAnswerable,
            createdInsightIds: persistResult.created,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[InsightGeneration] Error:`, error);
        return {
            success: false,
            insightsCreated: 0,
            insightsReinforced: 0,
            insightsSuperseded: 0,
            questionsExplored: 0,
            questionsAnswerable: 0,
            createdInsightIds: [],
            error: message,
        };
    }
}
