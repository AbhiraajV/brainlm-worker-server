import { processMemoryPipeline } from './pipeline';
import { startReviewCron } from './jobs/review-cron';

// Re-export review job functions for easy access
export {
    runDailyReviewJob,
    runReviewGeneration,
    backfillReviews,
    generateReviewsForUser,
} from './jobs/review-jobs';

// Re-export cron functions
export { startReviewCron } from './jobs/review-cron';

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
export const startBackgroundJobs = () => {
    console.log('[Jobs] Background jobs initialized');
    console.log('[Jobs] Pattern detection is now event-triggered (no periodic job)');

    // Start review cron scheduler
    startReviewCron();
};

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
export async function processNewEvent(eventId: string): Promise<void> {
    try {
        const result = await processMemoryPipeline(eventId);
        console.log(
            `[Pipeline] outcome=${result.stages.patternDetect?.outcome}, ` +
            `patternId=${result.stages.patternDetect?.patternId}`
        );
    } catch (error) {
        console.error(`[Pipeline] Failed for event ${eventId}:`, error);
        // Don't throw - event creation should succeed even if pipeline fails
    }
}
