import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText } from '../../services/embedding';
import {
    TriggerContext,
    InsightOutput,
    InsightItem,
} from './schema';
import {
    retrieveInsightContext,
    InsightRetrievalConfig,
    DEFAULT_RETRIEVAL_CONFIG,
} from './data-retrieval';
import { formatInsightUserMessage } from './prompt';
import { INSIGHT_GENERATION_PROMPT } from '../../prompts';

// ============================================================================
// Types
// ============================================================================

export interface GenerateInsightsInput {
    userId: string;
    trigger: TriggerContext;
    retrievalConfig?: InsightRetrievalConfig;
}

export interface GenerateInsightsResult {
    success: boolean;
    insightsCreated: number;
    insightsReinforced: number;
    insightsSuperseded: number;
    questionsExplored: number;
    questionsAnswerable: number;
    createdInsightIds: string[];
    error?: string;
}

export class InsightGenerationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'InsightGenerationError';
    }
}

// Configuration is now centralized in src/prompts.ts via INSIGHT_GENERATION_PROMPT

// ============================================================================
// Helper: Get Target Embedding from Trigger
// ============================================================================

async function getTargetEmbedding(trigger: TriggerContext, userId: string): Promise<number[]> {
    // Try to get embedding from trigger context
    if (trigger.interpretationId) {
        const interpretation = await prisma.$queryRaw<Array<{ embedding: string }>>`
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
        const pattern = await prisma.$queryRaw<Array<{ embedding: string }>>`
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
        const interpretation = await prisma.$queryRaw<Array<{ embedding: string }>>`
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
        const event = await prisma.$queryRaw<Array<{ embedding: string }>>`
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
    const recentPattern = await prisma.$queryRaw<Array<{ embedding: string }>>`
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
    const embeddingResult = await embedText({ text: 'General user insight synthesis' });
    return embeddingResult.embedding;
}

function parseEmbedding(embeddingStr: string): number[] {
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

// ============================================================================
// Helper: Map relevance string to Prisma enum value
// ============================================================================

function mapRelevance(relevance: string): 'PRIMARY' | 'SUPPORTING' | 'CONTEXTUAL' {
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

async function persistInsights(
    userId: string,
    insights: InsightItem[],
    trigger: TriggerContext
): Promise<{ created: string[]; reinforced: number; superseded: number }> {
    const createdIds: string[] = [];
    let reinforced = 0;
    let superseded = 0;

    for (const insight of insights) {
        // Generate embedding for the insight
        const embeddingText = `${insight.statement}\n\n${insight.explanation}`;
        const embeddingResult = await embedText({ text: embeddingText });

        // Handle supersession
        if (insight.supersedesInsightId) {
            await prisma.insight.update({
                where: { id: insight.supersedesInsightId },
                data: {
                    status: 'SUPERSEDED',
                    supersededById: '', // Will be updated after creating new insight
                },
            });
            superseded++;
        }

        // Create the insight and junction table records
        const created = await prisma.$transaction(async (tx) => {
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
            await tx.$executeRawUnsafe(
                `UPDATE "Insight" SET embedding = $1::vector WHERE id = $2`,
                embeddingStr,
                newInsight.id
            );

            // Auto-link to trigger context (no LLM-provided refs - they hallucinate IDs)
            if (trigger.eventId) {
                await tx.insightEvent.create({
                    data: {
                        insightId: newInsight.id,
                        eventId: trigger.eventId,
                        relevance: 'PRIMARY',
                    },
                });
            }

            if (trigger.patternId) {
                await tx.insightPattern.create({
                    data: {
                        insightId: newInsight.id,
                        patternId: trigger.patternId,
                        relevance: 'PRIMARY',
                    },
                });
            }

            if (trigger.interpretationId) {
                await tx.insightInterpretation.create({
                    data: {
                        insightId: newInsight.id,
                        interpretationId: trigger.interpretationId,
                        relevance: 'PRIMARY',
                    },
                });
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
export async function generateInsights(
    input: GenerateInsightsInput
): Promise<GenerateInsightsResult> {
    const {
        userId,
        trigger,
        retrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    } = input;

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
        const context = await retrieveInsightContext(
            userId,
            trigger,
            targetEmbedding,
            retrievalConfig
        );

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
        // Step 3: Fetch user context for personalization
        // ====================================================================
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, baseline: true },
        });
        const userName = user?.name || 'User';
        const userBaseline = user?.baseline || 'No baseline available yet.';

        // ====================================================================
        // Step 4: Format context for LLM (EVENT-CENTRIC)
        // ====================================================================
        // Extract quantitative projection from the formatted message for later injection
        const userMessage = formatInsightUserMessage({
            userName,
            userBaseline,
            triggerEvent: context.triggerEvent,
            triggerInterpretation: context.triggerInterpretation,
            trigger,
            patterns: context.patterns,
            interpretations: context.interpretations,
            existingInsights: context.existingInsights,
            facts: context.facts,
            dayEvents: context.dayEvents,
            trackTypeHistory: context.trackTypeHistory,
        });

        console.log(`[InsightGeneration] Formatted context (${userMessage.length} chars)`);

        // ====================================================================
        // Step 5: Call LLM with Structured Outputs (enforces schema at generation)
        // ====================================================================
        const { modelConfig, systemPrompt } = INSIGHT_GENERATION_PROMPT;
        console.log(`[InsightGeneration] Calling LLM (${modelConfig.model}) with structured outputs`);

        // JSON Schema for OpenAI Structured Outputs - enforces exact enum values
        const insightJsonSchema = {
            name: 'insight_output',
            strict: true,
            schema: {
                type: 'object',
                properties: {
                    questionsExplored: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 15,
                        items: {
                            type: 'object',
                            properties: {
                                question: { type: 'string' },
                                category: {
                                    type: 'string',
                                    enum: ['STRUCTURAL', 'BEHAVIORAL', 'PREFERENCE', 'EMOTIONAL', 'CROSS_DOMAIN', 'PROGRESS', 'META', 'SHALLOW_PATTERNS'],
                                },
                                answerable: { type: 'boolean' },
                                reasonIfUnanswerable: { type: ['string', 'null'] },
                            },
                            required: ['question', 'category', 'answerable', 'reasonIfUnanswerable'],
                            additionalProperties: false,
                        },
                    },
                    insights: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 3,
                        items: {
                            type: 'object',
                            properties: {
                                statement: { type: 'string' },
                                explanation: { type: 'string' },
                                confidence: {
                                    type: 'string',
                                    enum: ['HIGH', 'MEDIUM', 'EMERGING'],
                                },
                                status: {
                                    type: 'string',
                                    enum: ['CONFIRMED', 'LIKELY', 'SPECULATIVE', 'SUPERSEDED', 'WEAKENED'],
                                },
                                category: {
                                    type: 'string',
                                    enum: ['STRUCTURAL', 'BEHAVIORAL', 'PREFERENCE', 'EMOTIONAL', 'CROSS_DOMAIN', 'PROGRESS', 'META', 'SHALLOW_PATTERNS'],
                                },
                                temporalScope: { type: ['string', 'null'] },
                                derivedFromQuestion: { type: ['string', 'null'] },
                                supersedesInsightId: { type: ['string', 'null'] },
                                // Quantitative projection - LLM MUST fill this from currentEvent.quantitativeProjection
                                quantitativeProjection: { type: ['string', 'null'] },
                            },
                            required: ['statement', 'explanation', 'confidence', 'status', 'category', 'temporalScope', 'derivedFromQuestion', 'supersedesInsightId', 'quantitativeProjection'],
                            additionalProperties: false,
                        },
                    },
                    processingNotes: { type: ['string', 'null'] },
                },
                required: ['questionsExplored', 'insights', 'processingNotes'],
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
            response_format: {
                type: 'json_schema',
                json_schema: insightJsonSchema,
            },
        });

        const rawResponse = completion.choices[0]?.message?.content;
        if (!rawResponse) {
            throw new InsightGenerationError('LLM returned empty response');
        }

        console.log(`[InsightGeneration] LLM response received (${rawResponse.length} chars)`);

        // ====================================================================
        // Step 6: Parse LLM output - Structured Output guarantees schema compliance
        // ====================================================================
        let output: InsightOutput;
        try {
            output = JSON.parse(rawResponse);
        } catch (e) {
            throw new InsightGenerationError('LLM returned invalid JSON', e);
        }

        const questionsExplored = output.questionsExplored.length;
        const questionsAnswerable = output.questionsExplored.filter((q) => q.answerable).length;

        console.log(
            `[InsightGeneration] LLM explored ${questionsExplored} questions, ` +
            `${questionsAnswerable} answerable, generated ${output.insights.length} insights`
        );

        // ====================================================================
        // Step 7: Persist insights
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

        // Extract quantitative projection from user message and inject it directly
        // (bypassing LLM which unreliably returns null)
        let quantitativeProjection: string | null = null;
        try {
            const parsedMessage = JSON.parse(userMessage);
            quantitativeProjection = parsedMessage.currentEvent?.quantitativeProjection || null;
            console.log(`[InsightGeneration] Quantitative projection extracted: ${quantitativeProjection}`);
        } catch (e) {
            console.log(`[InsightGeneration] Failed to parse userMessage for projection:`, e);
        }

        // Append quantitative projection to FIRST insight if available
        const insightsWithProjections = output.insights.map((insight, index) => {
            // Only add to first insight, and only if not already present
            if (index === 0 && quantitativeProjection && !insight.explanation.includes(quantitativeProjection)) {
                return {
                    ...insight,
                    explanation: `${insight.explanation} Quantitative projection: ${quantitativeProjection}`,
                };
            }
            return insight;
        });

        const persistResult = await persistInsights(userId, insightsWithProjections, trigger);

        console.log(
            `[InsightGeneration] Persisted: ${persistResult.created.length} created, ` +
            `${persistResult.reinforced} reinforced, ${persistResult.superseded} superseded`
        );

        return {
            success: true,
            insightsCreated: persistResult.created.length,
            insightsReinforced: persistResult.reinforced,
            insightsSuperseded: persistResult.superseded,
            questionsExplored,
            questionsAnswerable,
            createdInsightIds: persistResult.created,
        };

    } catch (error) {
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
