import { startReviewCron } from './jobs/review-cron';
import { startWorker, stopWorker, registerAllHandlers } from './queue';

// Re-export review job functions for easy access
export {
    runDailyReviewJob,
    runReviewGeneration,
    backfillReviews,
    generateReviewsForUser,
} from './jobs/review-jobs';

// Re-export cron functions
export { startReviewCron } from './jobs/review-cron';

// Re-export queue functions for server-side usage
export { startWorker, stopWorker } from './queue';

// ============================================================================
// Background Jobs
// ============================================================================

/**
 * Starts all background jobs:
 * 1. Queue worker (processes all job types)
 * 2. Review cron (schedules daily/weekly/monthly reviews)
 *
 * The queue worker handles:
 * - INTERPRET_EVENT → DETECT_PATTERNS → GENERATE_INSIGHTS (event flow)
 * - GENERATE_REVIEW → GENERATE_TOMORROW_PLAN → SUGGEST_UOM_UPDATE (review flow)
 */
export const startBackgroundJobs = async () => {
    console.log('[Jobs] Initializing background jobs...');

    // Register all job handlers
    registerAllHandlers();

    // Start queue worker
    await startWorker({
        workerId: `main-worker-${process.pid}`,
        pollIntervalMin: 100,
        pollIntervalMax: 2000,
    });
    console.log('[Jobs] Queue worker started');

    // Start review cron scheduler
    startReviewCron();
    console.log('[Jobs] Review cron started');

    console.log('[Jobs] Background jobs initialized');
};

/**
 * Gracefully stop all background jobs.
 * Waits for current job to complete before stopping.
 */
export const stopBackgroundJobs = async () => {
    console.log('[Jobs] Stopping background jobs...');
    await stopWorker(true, 30000); // graceful with 30s timeout
    console.log('[Jobs] Background jobs stopped');
};

// ============================================================================
// Legacy: processNewEvent (DEPRECATED)
// ============================================================================

/**
 * @deprecated Use createEventWithProcessing() from queue-client.ts instead.
 * This function is kept for backwards compatibility.
 */
export async function processNewEvent(eventId: string): Promise<void> {
    console.warn('[Jobs] processNewEvent is deprecated. Use queue-based flow instead.');
    const { enqueueInterpretEvent } = await import('./queue');
    await enqueueInterpretEvent({ eventId });
}
