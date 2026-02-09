import prisma from '../../prisma';
import { flexCompletion } from '../../services/openai';
import { embedText } from '../../services/embedding';
import { Prisma } from '@prisma/client';
import {
    ReviewType,
    GenerateReviewInput,
    GenerateReviewResult,
} from './schema';
import {
    retrieveReviewData,
    reviewExists,
    DEFAULT_RETRIEVAL_CONFIG,
    ReviewRetrievalConfig,
} from './data-retrieval';
import { formatReviewUserMessage } from './prompt';
import {
    getPeriodKey,
    getPeriodBounds,
    canGenerateReview,
} from './temporal-utils';
import {
    DAILY_REVIEW_PROMPT,
    WEEKLY_REVIEW_PROMPT,
    MONTHLY_REVIEW_PROMPT,
    PromptConfig,
} from '../../prompts';

// ============================================================================
// Prompt Selection Helper
// ============================================================================

function getReviewPromptConfig(reviewType: ReviewType): PromptConfig {
    switch (reviewType) {
        case ReviewType.DAILY:
            return DAILY_REVIEW_PROMPT;
        case ReviewType.WEEKLY:
            return WEEKLY_REVIEW_PROMPT;
        case ReviewType.MONTHLY:
            return MONTHLY_REVIEW_PROMPT;
    }
}

// ============================================================================
// OpenAI Structured Output JSON Schema
// ============================================================================

/**
 * JSON Schema for OpenAI Structured Outputs.
 * OpenAI GUARANTEES the response matches this schema - no validation needed.
 */
const REVIEW_JSON_SCHEMA = {
    name: 'review_output',
    strict: true,
    schema: {
        type: 'object' as const,
        properties: {
            summary: {
                type: 'string' as const,
                description: '1-3 sentence summary of the period',
            },
            renderedMarkdown: {
                type: 'string' as const,
                description: 'Full review as markdown for display',
            },
            structuredContent: {
                type: 'string' as const,
                description: 'Structured analysis data as a JSON string. Must be valid JSON.',
            },
            dataQuality: {
                type: 'object' as const,
                properties: {
                    hasAdequateData: { type: 'boolean' as const },
                    limitations: {
                        type: 'array' as const,
                        items: { type: 'string' as const },
                    },
                    confidenceLevel: {
                        type: 'string' as const,
                        enum: ['high', 'medium', 'low'],
                    },
                },
                required: ['hasAdequateData', 'limitations', 'confidenceLevel'],
                additionalProperties: false,
            },
        },
        required: ['summary', 'renderedMarkdown', 'structuredContent', 'dataQuality'],
        additionalProperties: false,
    },
};

// Type matching the schema (for TypeScript)
interface ReviewOutput {
    summary: string;
    renderedMarkdown: string;
    structuredContent: string;
    dataQuality: {
        hasAdequateData: boolean;
        limitations: string[];
        confidenceLevel: 'high' | 'medium' | 'low';
    };
}

// ============================================================================
// Helper: Collect Referenced IDs
// ============================================================================

interface CollectedIds {
    eventIds: string[];
    interpretationIds: string[];
    patternIds: string[];
    insightIds: string[];
    priorReviewIds: string[];
}

function collectReferencedIds(
    reviewType: ReviewType,
    data: Awaited<ReturnType<typeof retrieveReviewData>>
): CollectedIds {
    const eventIds: string[] = [];
    const interpretationIds: string[] = [];
    const patternIds: string[] = [];
    const insightIds: string[] = [];
    const priorReviewIds: string[] = [];

    // Common: events, patterns, insights
    if ('events' in data) {
        for (const event of data.events) {
            eventIds.push(event.id);
            if (event.interpretation) {
                interpretationIds.push(event.interpretation.id);
            }
        }
    }

    if ('patterns' in data) {
        for (const pattern of data.patterns) {
            patternIds.push(pattern.id);
        }
    }

    if ('insights' in data) {
        for (const insight of data.insights) {
            insightIds.push(insight.id);
        }
    }

    // Type-specific prior reviews
    switch (reviewType) {
        case ReviewType.DAILY:
            if ('priorDailyReviews' in data) {
                for (const review of data.priorDailyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            break;

        case ReviewType.WEEKLY:
            if ('dailyReviews' in data) {
                for (const review of data.dailyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            if ('previousWeeklyReview' in data && data.previousWeeklyReview) {
                priorReviewIds.push(data.previousWeeklyReview.id);
            }
            break;

        case ReviewType.MONTHLY:
            if ('weeklyReviews' in data) {
                for (const review of data.weeklyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            if ('previousMonthlyReview' in data && data.previousMonthlyReview) {
                priorReviewIds.push(data.previousMonthlyReview.id);
            }
            if ('earlierMonthlyReviews' in data) {
                for (const review of data.earlierMonthlyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            break;
    }

    return {
        eventIds,
        interpretationIds,
        patternIds,
        insightIds,
        priorReviewIds,
    };
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Generates a temporal review (daily/weekly/monthly).
 *
 * This is the main entry point for the Review Worker.
 * It follows the principle: "Patterns answer 'what tends to happen.' Reviews answer 'what actually happened in time.'"
 *
 * Flow:
 * 1. Validate inputs and check for existing review
 * 2. Retrieve all context data for the period
 * 3. Format context for LLM
 * 4. Call LLM to generate review
 * 5. Validate output with Zod
 * 6. Generate embedding for the review
 * 7. Persist review to database
 *
 * @param input - Generation input with userId, reviewType, targetDate
 * @returns Generation result with reviewId or skip/error info
 */
export async function generateReview(
    input: GenerateReviewInput,
    retrievalConfig: ReviewRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<GenerateReviewResult> {
    const { userId, reviewType, targetDate, force = false } = input;

    const periodKey = getPeriodKey(reviewType, targetDate);
    const { start: periodStart, end: periodEnd } = getPeriodBounds(reviewType, targetDate);

    console.log(
        `[ReviewGeneration] Starting ${reviewType} review for user ${userId}, period: ${periodKey}`
    );

    try {
        // ====================================================================
        // Step 1: Validate and check for existing review
        // ====================================================================

        // Check if the period has ended (can't review future/ongoing periods)
        if (!canGenerateReview(reviewType, targetDate)) {
            console.log(`[ReviewGeneration] Period ${periodKey} has not ended yet`);
            return {
                success: false,
                periodKey,
                skipped: true,
                skipReason: 'Period has not ended yet',
            };
        }

        // Check for existing review (unless force=true)
        if (!force) {
            const exists = await reviewExists(userId, reviewType, periodKey);
            if (exists) {
                console.log(`[ReviewGeneration] Review already exists for ${periodKey}`);
                return {
                    success: true,
                    periodKey,
                    skipped: true,
                    skipReason: 'Review already exists',
                };
            }
        }

        // ====================================================================
        // Step 2: Retrieve all context data
        // ====================================================================

        const data = await retrieveReviewData(userId, reviewType, targetDate, retrievalConfig);

        // Check if we have enough data
        const eventCount = 'events' in data ? data.events.length : 0;
        if (eventCount === 0) {
            console.log(`[ReviewGeneration] No events in period ${periodKey}`);
            return {
                success: true,
                periodKey,
                skipped: true,
                skipReason: 'No events in period',
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
        // Step 4: Format context for LLM
        // ====================================================================

        const promptConfig = getReviewPromptConfig(reviewType);
        const userMessage = formatReviewUserMessage(reviewType, data, periodStart, periodEnd, userName, userBaseline);

        console.log(`[ReviewGeneration] Formatted context (${userMessage.length} chars)`);

        // ====================================================================
        // Step 5: Call LLM with Structured Outputs (schema-guaranteed)
        // ====================================================================

        const { modelConfig, systemPrompt } = promptConfig;
        console.log(`[ReviewGeneration] Calling LLM (${modelConfig.model}) with JSON schema`);

        const completion = await flexCompletion({
            model: modelConfig.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            temperature: modelConfig.temperature,
            max_tokens: modelConfig.maxTokens,
            response_format: {
                type: 'json_schema',
                json_schema: REVIEW_JSON_SCHEMA,
            },
        });

        const rawResponse = completion.choices[0]?.message?.content;
        if (!rawResponse) {
            throw new Error('LLM returned empty response');
        }
        console.log(`[ReviewGeneration] LLM response received (${rawResponse.length} chars)`);

        // ====================================================================
        // Step 6: Parse response (OpenAI guarantees schema compliance)
        // ====================================================================

        const output: ReviewOutput = JSON.parse(rawResponse);
        const structuredContent = JSON.parse(output.structuredContent);

        console.log(
            `[ReviewGeneration] Output extracted: summary=${output.summary.length} chars, ` +
            `markdown=${output.renderedMarkdown.length} chars, ` +
            `dataQuality=${output.dataQuality.confidenceLevel}`
        );

        // ====================================================================
        // Step 7: Generate embedding
        // ====================================================================

        const embeddingText = `${output.summary}\n\n${output.renderedMarkdown.substring(0, 2000)}`;
        const embeddingResult = await embedText({ text: embeddingText });

        console.log(`[ReviewGeneration] Generated embedding (dim=${embeddingResult.embedding.length})`);

        // ====================================================================
        // Step 8: Persist review
        // ====================================================================

        const collectedIds = collectReferencedIds(reviewType, data);

        const review = await prisma.$transaction(async (tx) => {
            // Create the review
            const created = await tx.review.create({
                data: {
                    userId,
                    type: reviewType,
                    periodKey,
                    periodStart,
                    periodEnd,
                    structuredContent: structuredContent as Prisma.InputJsonValue,
                    renderedMarkdown: output.renderedMarkdown,
                    summary: output.summary,
                    eventIds: collectedIds.eventIds,
                    interpretationIds: collectedIds.interpretationIds,
                    patternIds: collectedIds.patternIds,
                    insightIds: collectedIds.insightIds,
                    priorReviewIds: collectedIds.priorReviewIds,
                },
                select: { id: true },
            });

            // Update with embedding
            const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
            await tx.$executeRawUnsafe(
                `UPDATE "Review" SET embedding = $1::vector WHERE id = $2`,
                embeddingStr,
                created.id
            );

            return created;
        });

        console.log(`[ReviewGeneration] Persisted review: ${review.id}`);

        return {
            success: true,
            reviewId: review.id,
            periodKey,
        };

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[ReviewGeneration] Error:`, error);

        return {
            success: false,
            periodKey,
            error: message,
        };
    }
}

// ============================================================================
// Batch Generation (for cron jobs)
// ============================================================================

/**
 * Generates all applicable reviews for a user based on a target date.
 * Used by daily cron jobs to trigger daily, weekly, and monthly reviews.
 *
 * @param userId - The user ID
 * @param targetDate - The date to generate reviews for (typically yesterday)
 * @returns Array of generation results
 */
export async function generateAllReviewsForDate(
    userId: string,
    targetDate: Date
): Promise<GenerateReviewResult[]> {
    const results: GenerateReviewResult[] = [];

    console.log(`[ReviewGeneration] Generating all reviews for ${targetDate.toISOString().split('T')[0]}`);

    // Always try daily
    const dailyResult = await generateReview({
        userId,
        reviewType: ReviewType.DAILY,
        targetDate,
    });
    results.push(dailyResult);

    // Weekly: only on Sundays (end of ISO week)
    const dayOfWeek = targetDate.getUTCDay();
    if (dayOfWeek === 0) { // Sunday
        const weeklyResult = await generateReview({
            userId,
            reviewType: ReviewType.WEEKLY,
            targetDate,
        });
        results.push(weeklyResult);
    }

    // Monthly: only on last day of month
    const nextDay = new Date(targetDate);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (nextDay.getUTCDate() === 1) { // Target was last day of month
        const monthlyResult = await generateReview({
            userId,
            reviewType: ReviewType.MONTHLY,
            targetDate,
        });
        results.push(monthlyResult);
    }

    const successful = results.filter((r) => r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;

    console.log(
        `[ReviewGeneration] Completed: ${successful} generated, ${skipped} skipped, ${failed} failed`
    );

    return results;
}
