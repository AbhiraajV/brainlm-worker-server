import cron from 'node-cron';
import pLimit from 'p-limit';
import prisma from '../prisma';
import { enqueueGenerateReview } from '../queue';
import {
    getTimezoneScheduleInfo,
    getUserYesterday,
    getUserLastCompletedWeek,
    getUserLastCompletedMonth,
    getPeriodKey,
    ReviewType,
} from '../workers/review';

const REVIEW_CONCURRENCY = parseInt(process.env.REVIEW_CONCURRENCY || '10', 10);

// Run every hour at minute 0
const CRON_SCHEDULE = '0 * * * *';

/**
 * Starts the review cron scheduler.
 * Runs every hour and enqueues review jobs for users whose timezone just hit midnight.
 *
 * Optimization: Instead of checking all users every hour, we only query users
 * whose timezone is currently at midnight (00:00-00:59 local time).
 *
 * This means:
 * - At 05:00 UTC, we process users in UTC-5 timezones (their midnight)
 * - At 00:00 UTC, we process users in UTC+0 timezones
 * - etc.
 *
 * Idempotency is guaranteed by:
 * 1. Queue idempotency key: review:{userId}:{type}:{periodKey}
 * 2. Database constraint: @@unique([userId, type, periodKey]) on Review model
 * 3. reviewExists() check in the worker
 */
export function startReviewCron(): void {
    cron.schedule(CRON_SCHEDULE, async () => {
        const startTime = Date.now();
        const now = new Date();

        // Get timezone schedule info
        const scheduleInfo = getTimezoneScheduleInfo(now);

        if (scheduleInfo.timezonesAtMidnight.length === 0) {
            console.log('[ReviewCron] Tick - no timezones at midnight');
            return;
        }

        console.log(
            `[ReviewCron] Tick - ${scheduleInfo.timezonesAtMidnight.length} timezone(s) at midnight: ` +
            `${scheduleInfo.timezonesAtMidnight.slice(0, 3).join(', ')}${scheduleInfo.timezonesAtMidnight.length > 3 ? '...' : ''}`
        );

        if (scheduleInfo.weeklyDue.length > 0) {
            console.log(`[ReviewCron] Weekly reviews due for: ${scheduleInfo.weeklyDue.join(', ')}`);
        }
        if (scheduleInfo.monthlyDue.length > 0) {
            console.log(`[ReviewCron] Monthly reviews due for: ${scheduleInfo.monthlyDue.join(', ')}`);
        }

        try {
            // Query only users whose timezone is at midnight
            const users = await prisma.user.findMany({
                where: {
                    timezone: { in: scheduleInfo.timezonesAtMidnight }
                },
                select: { id: true, timezone: true }
            });

            if (users.length === 0) {
                console.log('[ReviewCron] No users in midnight timezones');
                return;
            }

            console.log(`[ReviewCron] Processing ${users.length} user(s) with concurrency ${REVIEW_CONCURRENCY}`);

            // Process users in parallel with concurrency limit
            const limit = pLimit(REVIEW_CONCURRENCY);
            const results = await Promise.allSettled(
                users.map(user =>
                    limit(() => enqueueReviewsForUser(user.id, user.timezone, scheduleInfo))
                )
            );

            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;

            const duration = Date.now() - startTime;
            console.log(`[ReviewCron] Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);
        } catch (error) {
            console.error('[ReviewCron] Error during cron execution:', error);
        }
    });

    console.log('[ReviewCron] Scheduled: running every hour at minute 0');
}

/**
 * Enqueues review jobs for a user based on their timezone.
 * Called by cron. Safe to call multiple times (idempotent due to queue keys).
 *
 * This enqueues:
 * - DAILY: Always (for user's yesterday)
 * - WEEKLY: If it's Monday in user's timezone
 * - MONTHLY: If it's 1st of month in user's timezone
 */
async function enqueueReviewsForUser(
    userId: string,
    timezone: string,
    scheduleInfo: ReturnType<typeof getTimezoneScheduleInfo>
): Promise<void> {
    const jobsEnqueued: string[] = [];

    try {
        // 1. DAILY: Always enqueue for user's yesterday
        const userYesterday = getUserYesterday(timezone);
        const dailyPeriodKey = getPeriodKey(ReviewType.DAILY, userYesterday);

        await enqueueGenerateReview({
            userId,
            type: 'DAILY',
            periodKey: dailyPeriodKey,
            timezone,
        });
        jobsEnqueued.push(`DAILY:${dailyPeriodKey}`);

        // 2. WEEKLY: If it's Monday (week just ended)
        if (scheduleInfo.weeklyDue.includes(timezone)) {
            const lastWeek = getUserLastCompletedWeek(timezone);
            if (lastWeek) {
                // Use mid-week date for period key
                const weekMidpoint = new Date(lastWeek.start);
                weekMidpoint.setUTCDate(weekMidpoint.getUTCDate() + 3);
                const weeklyPeriodKey = getPeriodKey(ReviewType.WEEKLY, weekMidpoint);

                await enqueueGenerateReview({
                    userId,
                    type: 'WEEKLY',
                    periodKey: weeklyPeriodKey,
                    timezone,
                });
                jobsEnqueued.push(`WEEKLY:${weeklyPeriodKey}`);
            }
        }

        // 3. MONTHLY: If it's 1st of month (month just ended)
        if (scheduleInfo.monthlyDue.includes(timezone)) {
            const lastMonth = getUserLastCompletedMonth(timezone);
            if (lastMonth) {
                // Use mid-month date for period key
                const monthMidpoint = new Date(lastMonth.start);
                monthMidpoint.setUTCDate(15);
                const monthlyPeriodKey = getPeriodKey(ReviewType.MONTHLY, monthMidpoint);

                await enqueueGenerateReview({
                    userId,
                    type: 'MONTHLY',
                    periodKey: monthlyPeriodKey,
                    timezone,
                });
                jobsEnqueued.push(`MONTHLY:${monthlyPeriodKey}`);
            }
        }

        if (jobsEnqueued.length > 0) {
            console.log(`[ReviewCron] User ${userId}: enqueued ${jobsEnqueued.join(', ')}`);
        }
    } catch (error) {
        console.error(`[ReviewCron] Error enqueuing reviews for user ${userId}:`, error);
        throw error;
    }
}

/**
 * Validates if a cron expression is valid.
 */
export function isValidCronExpression(expression: string): boolean {
    return cron.validate(expression);
}

/**
 * Catch-up function to enqueue missed daily reviews on startup.
 * Checks all users and enqueues DAILY reviews for yesterday if missing.
 *
 * Call this on worker startup to handle cases where:
 * - Server was down at midnight
 * - DB connection dropped during cron execution
 * - Process crashed and restarted
 */
export async function catchUpMissedReviews(): Promise<void> {
    console.log('[ReviewCatchUp] Checking for missed daily reviews...');
    const startTime = Date.now();

    try {
        // Get all users with their timezones
        const users = await prisma.user.findMany({
            select: { id: true, timezone: true }
        });

        if (users.length === 0) {
            console.log('[ReviewCatchUp] No users found');
            return;
        }

        let enqueued = 0;
        let skipped = 0;

        const limit = pLimit(REVIEW_CONCURRENCY);
        await Promise.allSettled(
            users.map(user =>
                limit(async () => {
                    try {
                        const timezone = user.timezone || 'UTC';
                        const userYesterday = getUserYesterday(timezone);
                        const periodKey = getPeriodKey(ReviewType.DAILY, userYesterday);

                        // Check if review already exists
                        const existingReview = await prisma.review.findUnique({
                            where: {
                                userId_type_periodKey: {
                                    userId: user.id,
                                    type: 'DAILY',
                                    periodKey,
                                }
                            },
                            select: { id: true }
                        });

                        if (existingReview) {
                            skipped++;
                            return;
                        }

                        // Check if job already pending in queue
                        const existingJob = await prisma.workerJob.findFirst({
                            where: {
                                type: 'GENERATE_REVIEW',
                                status: { in: ['PENDING', 'PROCESSING'] },
                                idempotencyKey: `review:${user.id}:DAILY:${periodKey}`
                            },
                            select: { id: true }
                        });

                        if (existingJob) {
                            skipped++;
                            return;
                        }

                        // Enqueue the missed review
                        await enqueueGenerateReview({
                            userId: user.id,
                            type: 'DAILY',
                            periodKey,
                            timezone,
                        });
                        enqueued++;
                        console.log(`[ReviewCatchUp] Enqueued DAILY:${periodKey} for user ${user.id}`);
                    } catch (err) {
                        console.error(`[ReviewCatchUp] Error processing user ${user.id}:`, err);
                    }
                })
            )
        );

        const duration = Date.now() - startTime;
        console.log(`[ReviewCatchUp] Completed in ${duration}ms: ${enqueued} enqueued, ${skipped} skipped (already exist)`);
    } catch (error) {
        console.error('[ReviewCatchUp] Error:', error);
    }
}
