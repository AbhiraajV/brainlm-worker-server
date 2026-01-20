import {
    generateReview,
    generateAllReviewsForDate,
    ReviewType,
    GenerateReviewResult,
    getUserYesterday,
    getUserLastCompletedWeek,
    getUserLastCompletedMonth,
    hasPeriodCompletedForUser,
} from '../workers/review';

// ============================================================================
// Review Job Functions
// ============================================================================

/**
 * Runs daily review generation for a user.
 * Should be called by a cron job (e.g., 2 AM UTC daily).
 *
 * This generates:
 * - Daily review for yesterday
 * - Weekly review if yesterday was Sunday
 * - Monthly review if yesterday was the last day of the month
 *
 * @param userId - The user ID to generate reviews for
 * @returns Array of generation results
 */
export async function runDailyReviewJob(userId: string): Promise<GenerateReviewResult[]> {
    // Generate reviews for yesterday
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(12, 0, 0, 0); // Set to noon to avoid timezone edge cases

    console.log(`[ReviewJob] Running daily review job for user ${userId}`);

    const results = await generateAllReviewsForDate(userId, yesterday);

    console.log(`[ReviewJob] Completed daily review job for user ${userId}`);

    return results;
}

/**
 * Forces generation of a specific review type for a user.
 * Useful for backfilling or manual generation.
 *
 * @param userId - The user ID
 * @param reviewType - DAILY, WEEKLY, or MONTHLY
 * @param targetDate - The date to generate the review for
 * @param force - If true, regenerate even if review exists
 * @returns Generation result
 */
export async function runReviewGeneration(
    userId: string,
    reviewType: ReviewType,
    targetDate: Date,
    force: boolean = false
): Promise<GenerateReviewResult> {
    console.log(
        `[ReviewJob] Running ${reviewType} review generation for user ${userId}, ` +
        `date: ${targetDate.toISOString().split('T')[0]}, force: ${force}`
    );

    const result = await generateReview({
        userId,
        reviewType,
        targetDate,
        force,
    });

    console.log(`[ReviewJob] Completed: success=${result.success}, skipped=${result.skipped}`);

    return result;
}

/**
 * Backfills reviews for a date range.
 * Useful for generating reviews for historical data.
 *
 * @param userId - The user ID
 * @param reviewType - DAILY, WEEKLY, or MONTHLY
 * @param startDate - Start of range (inclusive)
 * @param endDate - End of range (inclusive)
 * @returns Array of generation results
 */
export async function backfillReviews(
    userId: string,
    reviewType: ReviewType,
    startDate: Date,
    endDate: Date
): Promise<GenerateReviewResult[]> {
    const results: GenerateReviewResult[] = [];

    console.log(
        `[ReviewJob] Backfilling ${reviewType} reviews for user ${userId} ` +
        `from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`
    );

    const current = new Date(startDate);

    while (current <= endDate) {
        const result = await generateReview({
            userId,
            reviewType,
            targetDate: new Date(current),
        });

        results.push(result);

        // Advance to next period
        switch (reviewType) {
            case ReviewType.DAILY:
                current.setUTCDate(current.getUTCDate() + 1);
                break;
            case ReviewType.WEEKLY:
                current.setUTCDate(current.getUTCDate() + 7);
                break;
            case ReviewType.MONTHLY:
                current.setUTCMonth(current.getUTCMonth() + 1);
                break;
        }
    }

    const generated = results.filter((r) => r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(
        `[ReviewJob] Backfill completed: ${generated} generated, ${skipped} skipped, ${failed} failed`
    );

    return results;
}

/**
 * Generate all due reviews for a user based on their timezone.
 * Called by cron. Safe to call multiple times (idempotent).
 *
 * This checks:
 * - DAILY: Generate for user's yesterday (if not already generated)
 * - WEEKLY: Generate if user's local week has ended (Sunday passed)
 * - MONTHLY: Generate if user's local month has ended
 *
 * @param userId - The user ID to generate reviews for
 * @param timezone - IANA timezone string (e.g., "America/New_York")
 * @returns Array of generation results
 */
export async function generateReviewsForUser(
    userId: string,
    timezone: string = 'UTC'
): Promise<GenerateReviewResult[]> {
    const results: GenerateReviewResult[] = [];

    console.log(`[ReviewJob] Checking due reviews for user ${userId} (timezone: ${timezone})`);

    try {
        // 1. DAILY: Generate for user's yesterday
        const userYesterday = getUserYesterday(timezone);
        if (hasPeriodCompletedForUser(ReviewType.DAILY, userYesterday, timezone)) {
            console.log(`[ReviewJob] Generating daily review for ${userYesterday.toISOString().split('T')[0]}`);
            const dailyResult = await generateReview({
                userId,
                reviewType: ReviewType.DAILY,
                targetDate: userYesterday,
            });
            results.push(dailyResult);
        }

        // 2. WEEKLY: Generate if user's local week has ended (Sunday)
        const lastWeek = getUserLastCompletedWeek(timezone);
        if (lastWeek) {
            // Use a date within the week for period key generation (use start of week)
            const weekMidpoint = new Date(lastWeek.start);
            weekMidpoint.setUTCDate(weekMidpoint.getUTCDate() + 3); // Wednesday of that week

            console.log(`[ReviewJob] Generating weekly review for week ending ${lastWeek.end.toISOString().split('T')[0]}`);
            const weeklyResult = await generateReview({
                userId,
                reviewType: ReviewType.WEEKLY,
                targetDate: weekMidpoint,
            });
            results.push(weeklyResult);
        }

        // 3. MONTHLY: Generate if user's local month has ended
        const lastMonth = getUserLastCompletedMonth(timezone);
        if (lastMonth) {
            // Use mid-month date for period key generation
            const monthMidpoint = new Date(lastMonth.start);
            monthMidpoint.setUTCDate(15);

            console.log(`[ReviewJob] Generating monthly review for month ending ${lastMonth.end.toISOString().split('T')[0]}`);
            const monthlyResult = await generateReview({
                userId,
                reviewType: ReviewType.MONTHLY,
                targetDate: monthMidpoint,
            });
            results.push(monthlyResult);
        }

        const generated = results.filter((r) => r.success && !r.skipped).length;
        const skipped = results.filter((r) => r.skipped).length;
        const failed = results.filter((r) => !r.success).length;

        if (results.length > 0) {
            console.log(
                `[ReviewJob] User ${userId}: ${generated} generated, ${skipped} skipped, ${failed} failed`
            );
        }
    } catch (error) {
        console.error(`[ReviewJob] Error processing user ${userId}:`, error);
    }

    return results;
}
