"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBackgroundJobs = exports.startReviewCron = exports.generateReviewsForUser = exports.backfillReviews = exports.runReviewGeneration = exports.runDailyReviewJob = void 0;
exports.processNewEvent = processNewEvent;
const pipeline_1 = require("./pipeline");
const review_cron_1 = require("./jobs/review-cron");
// Re-export review job functions for easy access
var review_jobs_1 = require("./jobs/review-jobs");
Object.defineProperty(exports, "runDailyReviewJob", { enumerable: true, get: function () { return review_jobs_1.runDailyReviewJob; } });
Object.defineProperty(exports, "runReviewGeneration", { enumerable: true, get: function () { return review_jobs_1.runReviewGeneration; } });
Object.defineProperty(exports, "backfillReviews", { enumerable: true, get: function () { return review_jobs_1.backfillReviews; } });
Object.defineProperty(exports, "generateReviewsForUser", { enumerable: true, get: function () { return review_jobs_1.generateReviewsForUser; } });
// Re-export cron functions
var review_cron_2 = require("./jobs/review-cron");
Object.defineProperty(exports, "startReviewCron", { enumerable: true, get: function () { return review_cron_2.startReviewCron; } });
// ============================================================================
// Background Jobs
// ============================================================================
/**
 * Starts background jobs.
 * Note: Periodic pattern detection has been removed.
 * Pattern detection is now event-triggered via the pipeline.
 *
 * Review generation runs via cron every hour, checking each user's
 * timezone to determine if reviews are due.
 */
const startBackgroundJobs = () => {
    console.log('[Jobs] Background jobs initialized');
    console.log('[Jobs] Pattern detection is now event-triggered (no periodic job)');
    // Start review cron scheduler
    (0, review_cron_1.startReviewCron)();
};
exports.startBackgroundJobs = startBackgroundJobs;
// ============================================================================
// Event Processing
// ============================================================================
/**
 * Processes a new event through the full memory pipeline.
 * Called after event is stored in the database.
 *
 * Pipeline stages:
 * 1. Interpretation (Worker 1)
 * 2. Pattern Detection (Worker 2)
 * 3. Recommendation (Worker 3 - future)
 */
async function processNewEvent(eventId) {
    try {
        const result = await (0, pipeline_1.processMemoryPipeline)(eventId);
        console.log(`[Pipeline] outcome=${result.stages.patternDetect?.outcome}, ` +
            `patternId=${result.stages.patternDetect?.patternId}`);
    }
    catch (error) {
        console.error(`[Pipeline] Failed for event ${eventId}:`, error);
        // Don't throw - event creation should succeed even if pipeline fails
    }
}
