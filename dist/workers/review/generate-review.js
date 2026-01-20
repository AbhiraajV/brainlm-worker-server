"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewGenerationError = void 0;
exports.generateReview = generateReview;
exports.generateAllReviewsForDate = generateAllReviewsForDate;
const prisma_1 = __importDefault(require("../../prisma"));
const openai_1 = require("../../services/openai");
const embedding_1 = require("../../services/embedding");
const schema_1 = require("./schema");
const data_retrieval_1 = require("./data-retrieval");
const prompt_1 = require("./prompt");
const temporal_utils_1 = require("./temporal-utils");
const prompts_1 = require("../../prompts");
// ============================================================================
// Prompt Selection Helper
// ============================================================================
function getReviewPromptConfig(reviewType) {
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            return prompts_1.DAILY_REVIEW_PROMPT;
        case schema_1.ReviewType.WEEKLY:
            return prompts_1.WEEKLY_REVIEW_PROMPT;
        case schema_1.ReviewType.MONTHLY:
            return prompts_1.MONTHLY_REVIEW_PROMPT;
    }
}
// Configuration is now centralized in src/prompts.ts via *_REVIEW_PROMPT configs
// ============================================================================
// Error Classes
// ============================================================================
class ReviewGenerationError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'ReviewGenerationError';
    }
}
exports.ReviewGenerationError = ReviewGenerationError;
// ============================================================================
// Structured Content Validation
// ============================================================================
function validateStructuredContent(reviewType, content) {
    try {
        switch (reviewType) {
            case schema_1.ReviewType.DAILY:
                schema_1.DailyStructuredContentSchema.parse(content);
                return true;
            case schema_1.ReviewType.WEEKLY:
                schema_1.WeeklyStructuredContentSchema.parse(content);
                return true;
            case schema_1.ReviewType.MONTHLY:
                schema_1.MonthlyStructuredContentSchema.parse(content);
                return true;
        }
    }
    catch {
        return false;
    }
}
function collectReferencedIds(reviewType, data) {
    const eventIds = [];
    const interpretationIds = [];
    const patternIds = [];
    const insightIds = [];
    const priorReviewIds = [];
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
        case schema_1.ReviewType.DAILY:
            if ('priorDailyReviews' in data) {
                for (const review of data.priorDailyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            break;
        case schema_1.ReviewType.WEEKLY:
            if ('dailyReviews' in data) {
                for (const review of data.dailyReviews) {
                    priorReviewIds.push(review.id);
                }
            }
            if ('previousWeeklyReview' in data && data.previousWeeklyReview) {
                priorReviewIds.push(data.previousWeeklyReview.id);
            }
            break;
        case schema_1.ReviewType.MONTHLY:
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
async function generateReview(input, retrievalConfig = data_retrieval_1.DEFAULT_RETRIEVAL_CONFIG) {
    const { userId, reviewType, targetDate, force = false } = input;
    const periodKey = (0, temporal_utils_1.getPeriodKey)(reviewType, targetDate);
    const { start: periodStart, end: periodEnd } = (0, temporal_utils_1.getPeriodBounds)(reviewType, targetDate);
    console.log(`[ReviewGeneration] Starting ${reviewType} review for user ${userId}, period: ${periodKey}`);
    try {
        // ====================================================================
        // Step 1: Validate and check for existing review
        // ====================================================================
        // Check if the period has ended (can't review future/ongoing periods)
        if (!(0, temporal_utils_1.canGenerateReview)(reviewType, targetDate)) {
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
            const exists = await (0, data_retrieval_1.reviewExists)(userId, reviewType, periodKey);
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
        const data = await (0, data_retrieval_1.retrieveReviewData)(userId, reviewType, targetDate, retrievalConfig);
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
        // Step 3: Format context for LLM
        // ====================================================================
        const promptConfig = getReviewPromptConfig(reviewType);
        const userMessage = (0, prompt_1.formatReviewUserMessage)(reviewType, data, periodStart, periodEnd);
        console.log(`[ReviewGeneration] Formatted context (${userMessage.length} chars)`);
        // ====================================================================
        // Step 4: Call LLM
        // ====================================================================
        const { modelConfig, systemPrompt } = promptConfig;
        console.log(`[ReviewGeneration] Calling LLM (${modelConfig.model})`);
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
            throw new ReviewGenerationError('LLM returned empty response');
        }
        console.log(`[ReviewGeneration] LLM response received (${rawResponse.length} chars)`);
        // ====================================================================
        // Step 5: Parse and validate with Zod
        // ====================================================================
        let parsed;
        try {
            parsed = JSON.parse(rawResponse);
        }
        catch (e) {
            throw new ReviewGenerationError('LLM returned invalid JSON', e);
        }
        const validated = schema_1.ReviewOutputSchema.safeParse(parsed);
        if (!validated.success) {
            console.error(`[ReviewGeneration] Validation errors:`, validated.error.issues);
            throw new ReviewGenerationError(`Review output validation failed: ${validated.error.message}`);
        }
        const output = validated.data;
        // Validate type-specific structured content
        if (!validateStructuredContent(reviewType, output.structuredContent)) {
            console.warn(`[ReviewGeneration] Structured content doesn't match expected schema for ${reviewType}`);
            // Continue anyway - the overall schema passed
        }
        console.log(`[ReviewGeneration] Output validated: summary=${output.summary.length} chars, ` +
            `markdown=${output.renderedMarkdown.length} chars, ` +
            `dataQuality=${output.dataQuality.confidenceLevel}`);
        // ====================================================================
        // Step 6: Generate embedding
        // ====================================================================
        const embeddingText = `${output.summary}\n\n${output.renderedMarkdown.substring(0, 2000)}`;
        const embeddingResult = await (0, embedding_1.embedText)({ text: embeddingText });
        console.log(`[ReviewGeneration] Generated embedding (dim=${embeddingResult.embedding.length})`);
        // ====================================================================
        // Step 7: Persist review
        // ====================================================================
        const collectedIds = collectReferencedIds(reviewType, data);
        const review = await prisma_1.default.$transaction(async (tx) => {
            // Create the review
            const created = await tx.review.create({
                data: {
                    userId,
                    type: reviewType,
                    periodKey,
                    periodStart,
                    periodEnd,
                    structuredContent: output.structuredContent,
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
            await tx.$executeRawUnsafe(`UPDATE "Review" SET embedding = $1::vector WHERE id = $2`, embeddingStr, created.id);
            return created;
        });
        console.log(`[ReviewGeneration] Persisted review: ${review.id}`);
        return {
            success: true,
            reviewId: review.id,
            periodKey,
        };
    }
    catch (error) {
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
async function generateAllReviewsForDate(userId, targetDate) {
    const results = [];
    console.log(`[ReviewGeneration] Generating all reviews for ${targetDate.toISOString().split('T')[0]}`);
    // Always try daily
    const dailyResult = await generateReview({
        userId,
        reviewType: schema_1.ReviewType.DAILY,
        targetDate,
    });
    results.push(dailyResult);
    // Weekly: only on Sundays (end of ISO week)
    const dayOfWeek = targetDate.getUTCDay();
    if (dayOfWeek === 0) { // Sunday
        const weeklyResult = await generateReview({
            userId,
            reviewType: schema_1.ReviewType.WEEKLY,
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
            reviewType: schema_1.ReviewType.MONTHLY,
            targetDate,
        });
        results.push(monthlyResult);
    }
    const successful = results.filter((r) => r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    console.log(`[ReviewGeneration] Completed: ${successful} generated, ${skipped} skipped, ${failed} failed`);
    return results;
}
