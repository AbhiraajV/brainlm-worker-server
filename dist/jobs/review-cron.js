"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startReviewCron = startReviewCron;
exports.isValidCronExpression = isValidCronExpression;
const node_cron_1 = __importDefault(require("node-cron"));
const p_limit_1 = __importDefault(require("p-limit"));
const prisma_1 = __importDefault(require("../prisma"));
const review_jobs_1 = require("./review-jobs");
const review_1 = require("../workers/review");
const REVIEW_CONCURRENCY = parseInt(process.env.REVIEW_CONCURRENCY || '5', 10);
// Run every hour at minute 0
const CRON_SCHEDULE = '0 * * * *';
/**
 * Starts the review cron scheduler.
 * Runs every hour and checks for due reviews for users whose timezone just hit midnight.
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
 * 1. Database constraint: @@unique([userId, type, periodKey])
 * 2. reviewExists() check in the worker
 * 3. Multiple cron ticks won't create duplicates
 */
function startReviewCron() {
    node_cron_1.default.schedule(CRON_SCHEDULE, async () => {
        const startTime = Date.now();
        const now = new Date();
        // Get timezone schedule info
        const scheduleInfo = (0, review_1.getTimezoneScheduleInfo)(now);
        if (scheduleInfo.timezonesAtMidnight.length === 0) {
            console.log('[ReviewCron] Tick - no timezones at midnight');
            return;
        }
        console.log(`[ReviewCron] Tick - ${scheduleInfo.timezonesAtMidnight.length} timezone(s) at midnight: ` +
            `${scheduleInfo.timezonesAtMidnight.slice(0, 3).join(', ')}${scheduleInfo.timezonesAtMidnight.length > 3 ? '...' : ''}`);
        if (scheduleInfo.weeklyDue.length > 0) {
            console.log(`[ReviewCron] Weekly reviews due for: ${scheduleInfo.weeklyDue.join(', ')}`);
        }
        if (scheduleInfo.monthlyDue.length > 0) {
            console.log(`[ReviewCron] Monthly reviews due for: ${scheduleInfo.monthlyDue.join(', ')}`);
        }
        try {
            // Query only users whose timezone is at midnight
            const users = await prisma_1.default.user.findMany({
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
            const limit = (0, p_limit_1.default)(REVIEW_CONCURRENCY);
            const results = await Promise.allSettled(users.map(user => limit(() => (0, review_jobs_1.generateReviewsForUser)(user.id, user.timezone))));
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            const duration = Date.now() - startTime;
            console.log(`[ReviewCron] Completed in ${duration}ms: ${succeeded} succeeded, ${failed} failed`);
        }
        catch (error) {
            console.error('[ReviewCron] Error during cron execution:', error);
        }
    });
    console.log('[ReviewCron] Scheduled: running every hour at minute 0');
}
/**
 * Validates if a cron expression is valid.
 */
function isValidCronExpression(expression) {
    return node_cron_1.default.validate(expression);
}
