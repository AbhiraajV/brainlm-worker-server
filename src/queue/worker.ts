import { randomUUID } from 'crypto';
import { dequeue, completeJob, failJob, recoverStuckJobs } from './queue.service';
import { getHandler } from './handlers';
import { WorkerConfig, JobResult } from './types';
import { catchUpMissedReviews } from '../jobs/review-cron';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<WorkerConfig> = {
  workerId: `worker-${randomUUID().slice(0, 8)}`,
  pollIntervalMin: 100,
  pollIntervalMax: 2000,
  pollIntervalStep: 100,
  stuckJobTimeout: 10,
  batchSize: 1,
};

// ============================================================================
// Worker State
// ============================================================================

let isRunning = false;
let isProcessingJob = false; // Track if a job is currently being processed
let currentConfig: Required<WorkerConfig> = DEFAULT_CONFIG;
let pollInterval: number = DEFAULT_CONFIG.pollIntervalMin;
let stuckJobRecoveryInterval: NodeJS.Timeout | null = null;
let shutdownResolve: (() => void) | null = null; // For graceful shutdown

// ============================================================================
// Main Worker Loop
// ============================================================================

/**
 * Start the queue worker polling loop
 */
export async function startWorker(config: WorkerConfig = {}): Promise<void> {
  if (isRunning) {
    console.log('[Worker] Already running');
    return;
  }

  // Generate a fresh worker ID on each start
  const workerId = config.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  currentConfig = { ...DEFAULT_CONFIG, ...config, workerId };
  pollInterval = currentConfig.pollIntervalMin;
  isRunning = true;

  console.log(`[Worker] Starting with ID: ${currentConfig.workerId}`);
  console.log(`[Worker] Poll interval: ${currentConfig.pollIntervalMin}ms - ${currentConfig.pollIntervalMax}ms`);

  // Run immediate stuck job recovery on startup
  try {
    const recovered = await recoverStuckJobs();
    if (recovered > 0) {
      console.log(`[Worker] Recovered ${recovered} stuck jobs on startup`);
    }
  } catch (error) {
    console.error('[Worker] Initial stuck job recovery failed:', error);
  }

  // Catch up any missed daily reviews (handles server downtime at midnight)
  try {
    await catchUpMissedReviews();
  } catch (error) {
    console.error('[Worker] Review catch-up failed:', error);
  }

  // Start periodic stuck job recovery (every 5 minutes)
  stuckJobRecoveryInterval = setInterval(async () => {
    try {
      await recoverStuckJobs();
    } catch (error) {
      console.error('[Worker] Stuck job recovery failed:', error);
    }
  }, 5 * 60 * 1000);

  // Start polling loop
  poll();
}

/**
 * Stop the queue worker
 * @param graceful - If true, waits for current job to complete before stopping
 * @param timeoutMs - Maximum time to wait for graceful shutdown (default: 30000ms)
 */
export async function stopWorker(graceful: boolean = true, timeoutMs: number = 30000): Promise<void> {
  if (!isRunning) {
    console.log('[Worker] Not running');
    return;
  }

  console.log(`[Worker] Stopping ${graceful ? 'gracefully' : 'immediately'}: ${currentConfig.workerId}`);

  isRunning = false;

  if (stuckJobRecoveryInterval) {
    clearInterval(stuckJobRecoveryInterval);
    stuckJobRecoveryInterval = null;
  }

  // If graceful shutdown requested and a job is being processed, wait for it
  if (graceful && isProcessingJob) {
    console.log('[Worker] Waiting for current job to complete...');

    const shutdownPromise = new Promise<void>((resolve) => {
      shutdownResolve = resolve;
    });

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log('[Worker] Graceful shutdown timeout reached');
        resolve();
      }, timeoutMs);
    });

    await Promise.race([shutdownPromise, timeoutPromise]);
    shutdownResolve = null;
  }

  console.log(`[Worker] Stopped: ${currentConfig.workerId}`);
}

/**
 * Check if worker is running
 */
export function isWorkerRunning(): boolean {
  return isRunning;
}

/**
 * Check if worker is currently processing a job
 */
export function isWorkerProcessing(): boolean {
  return isProcessingJob;
}

// ============================================================================
// Polling Loop
// ============================================================================

async function poll(): Promise<void> {
  if (!isRunning) {
    return;
  }

  try {
    const job = await dequeue(currentConfig.workerId);

    if (job) {
      // Reset poll interval on job found
      pollInterval = currentConfig.pollIntervalMin;

      // Process the job
      await processJob(job.id, job.type, job.payload);
    } else {
      // Increase poll interval on empty poll (up to max)
      pollInterval = Math.min(
        pollInterval + currentConfig.pollIntervalStep,
        currentConfig.pollIntervalMax
      );
    }
  } catch (error) {
    console.error('[Worker] Poll error:', error);
    // On error, use max interval to avoid hammering
    pollInterval = currentConfig.pollIntervalMax;
  }

  // Schedule next poll
  if (isRunning) {
    setTimeout(poll, pollInterval);
  }
}

// ============================================================================
// Job Processing
// ============================================================================

async function processJob(
  jobId: string,
  jobType: string,
  payload: unknown
): Promise<void> {
  const startTime = Date.now();
  isProcessingJob = true;

  try {
    const handler = getHandler(jobType);

    if (!handler) {
      console.error(`[Worker] No handler for job type: ${jobType}`);
      await failJob(jobId, `No handler registered for job type: ${jobType}`, false);
      return;
    }

    console.log(`[Worker] Processing ${jobType} job: ${jobId}`);

    const result: JobResult = await handler(payload as any, jobId);

    const duration = Date.now() - startTime;

    if (result.success) {
      await completeJob(jobId);
      console.log(`[Worker] Completed ${jobType} job ${jobId} in ${duration}ms`);
    } else {
      const shouldRetry = result.shouldRetry !== false; // Default to retry
      await failJob(jobId, result.error || 'Unknown error', shouldRetry);
      console.log(`[Worker] Failed ${jobType} job ${jobId}: ${result.error} (retry: ${shouldRetry})`);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    console.error(`[Worker] Exception processing ${jobType} job ${jobId} after ${duration}ms:`, error);
    await failJob(jobId, errorMessage, true);
  } finally {
    isProcessingJob = false;

    // Signal graceful shutdown completion if waiting
    if (shutdownResolve) {
      shutdownResolve();
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export { currentConfig as workerConfig };
