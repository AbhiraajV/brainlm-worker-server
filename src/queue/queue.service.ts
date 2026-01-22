import prisma from '../prisma';
import { JobType, JobStatus, Prisma } from '@prisma/client';
import {
  EnqueueOptions,
  JobPayload,
  QueueStats,
  InterpretEventPayload,
  DetectPatternsPayload,
  GenerateInsightsPayload,
  GenerateReviewPayload,
  GenerateTomorrowPlanPayload,
  SuggestUOMUpdatePayload,
} from './types';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const STUCK_JOB_TIMEOUT_MINUTES = 10;

// Exponential backoff delays in seconds: 5s, 10s, 20s, 40s, 80s...
const getBackoffDelay = (attempts: number): number => {
  return Math.pow(2, attempts) * 5 * 1000; // Returns milliseconds
};

// ============================================================================
// Enqueue Functions
// ============================================================================

/**
 * Generic enqueue function for any job type
 */
export async function enqueue<T extends JobPayload>(
  type: JobType,
  payload: T,
  options: EnqueueOptions = {}
): Promise<string> {
  const {
    priority = 0,
    delayMs = 0,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    idempotencyKey,
    userId,
  } = options;

  const availableAt = delayMs > 0
    ? new Date(Date.now() + delayMs)
    : new Date();

  // If idempotencyKey provided, use upsert pattern to avoid race conditions
  if (idempotencyKey) {
    try {
      const job = await prisma.workerJob.create({
        data: {
          type,
          payload: payload as unknown as Prisma.InputJsonValue,
          status: JobStatus.PENDING,
          priority,
          availableAt,
          maxAttempts,
          idempotencyKey,
          userId,
        },
        select: { id: true },
      });

      console.log(`[Queue] Enqueued ${type} job: ${job.id} (key: ${idempotencyKey})`);
      return job.id;
    } catch (error) {
      // Handle unique constraint violation (concurrent insert with same idempotencyKey)
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await prisma.workerJob.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        });

        if (existing) {
          console.log(`[Queue] Duplicate job with key ${idempotencyKey}, returning existing: ${existing.id}`);
          return existing.id;
        }
      }
      throw error;
    }
  }

  const job = await prisma.workerJob.create({
    data: {
      type,
      payload: payload as unknown as Prisma.InputJsonValue,
      status: JobStatus.PENDING,
      priority,
      availableAt,
      maxAttempts,
      idempotencyKey,
      userId,
    },
    select: { id: true },
  });

  console.log(`[Queue] Enqueued ${type} job: ${job.id}`);
  return job.id;
}

// ============================================================================
// Type-Safe Enqueue Helpers
// ============================================================================

export async function enqueueInterpretEvent(
  payload: InterpretEventPayload,
  options?: EnqueueOptions
): Promise<string> {
  return enqueue(JobType.INTERPRET_EVENT, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? `interpret:${payload.eventId}`,
  });
}

export async function enqueueDetectPatterns(
  payload: DetectPatternsPayload,
  options?: EnqueueOptions
): Promise<string> {
  return enqueue(JobType.DETECT_PATTERNS, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? `patterns:${payload.triggerEventId}`,
    userId: payload.userId,
  });
}

export async function enqueueGenerateInsights(
  payload: GenerateInsightsPayload,
  options?: EnqueueOptions
): Promise<string> {
  const key = payload.eventId
    ? `insights:${payload.eventId}:${payload.triggerType}`
    : `insights:${payload.userId}:${Date.now()}`;

  return enqueue(JobType.GENERATE_INSIGHTS, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? key,
    userId: payload.userId,
  });
}

export async function enqueueGenerateReview(
  payload: GenerateReviewPayload,
  options?: EnqueueOptions
): Promise<string> {
  return enqueue(JobType.GENERATE_REVIEW, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? `review:${payload.userId}:${payload.type}:${payload.periodKey}`,
    userId: payload.userId,
  });
}

export async function enqueueGenerateTomorrowPlan(
  payload: GenerateTomorrowPlanPayload,
  options?: EnqueueOptions
): Promise<string> {
  return enqueue(JobType.GENERATE_TOMORROW_PLAN, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? `tomorrow:${payload.userId}:${payload.targetDate}`,
    userId: payload.userId,
  });
}

export async function enqueueSuggestUOMUpdate(
  payload: SuggestUOMUpdatePayload,
  options?: EnqueueOptions
): Promise<string> {
  return enqueue(JobType.SUGGEST_UOM_UPDATE, payload, {
    ...options,
    idempotencyKey: options?.idempotencyKey ?? `uom:${payload.dailyPlanId}`,
    userId: payload.userId,
  });
}

// ============================================================================
// Dequeue (FOR UPDATE SKIP LOCKED)
// ============================================================================

interface DequeuedJob {
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  userId: string | null;
}

/**
 * Dequeue a job using FOR UPDATE SKIP LOCKED for safe concurrency.
 * Returns null if no jobs available.
 */
export async function dequeue(workerId: string): Promise<DequeuedJob | null> {
  const now = new Date();

  // Use raw SQL for FOR UPDATE SKIP LOCKED
  // This atomically selects and locks a single available job
  const jobs = await prisma.$queryRaw<DequeuedJob[]>`
    UPDATE "WorkerJob"
    SET
      status = ${JobStatus.PROCESSING}::"JobStatus",
      "lockedAt" = ${now},
      "lockedBy" = ${workerId},
      "startedAt" = ${now},
      attempts = attempts + 1
    WHERE id = (
      SELECT id FROM "WorkerJob"
      WHERE status = ${JobStatus.PENDING}::"JobStatus"
        AND "availableAt" <= ${now}
      ORDER BY priority DESC, "availableAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, "maxAttempts", "userId"
  `;

  if (jobs.length === 0) {
    return null;
  }

  const job = jobs[0];
  console.log(`[Queue] Dequeued ${job.type} job: ${job.id} (attempt ${job.attempts}/${job.maxAttempts})`);
  return job;
}

// ============================================================================
// Job Completion
// ============================================================================

/**
 * Mark a job as completed successfully
 */
export async function completeJob(jobId: string): Promise<void> {
  await prisma.workerJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.COMPLETED,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    },
  });
  console.log(`[Queue] Completed job: ${jobId}`);
}

/**
 * Mark a job as failed, with optional retry
 */
export async function failJob(
  jobId: string,
  error: string,
  shouldRetry: boolean = true
): Promise<void> {
  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: { attempts: true, maxAttempts: true },
  });

  if (!job) {
    console.error(`[Queue] Job not found for failure: ${jobId}`);
    return;
  }

  const canRetry = shouldRetry && job.attempts < job.maxAttempts;

  if (canRetry) {
    // Schedule retry with exponential backoff
    const backoffMs = getBackoffDelay(job.attempts);
    const availableAt = new Date(Date.now() + backoffMs);

    await prisma.workerJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.PENDING,
        lastError: error,
        availableAt,
        lockedAt: null,
        lockedBy: null,
      },
    });
    console.log(`[Queue] Job ${jobId} scheduled for retry at ${availableAt.toISOString()} (attempt ${job.attempts}/${job.maxAttempts})`);
  } else {
    // Move to dead letter
    await prisma.workerJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.DEAD_LETTER,
        lastError: error,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });
    console.log(`[Queue] Job ${jobId} moved to dead letter after ${job.attempts} attempts`);
  }
}

// ============================================================================
// Stuck Job Recovery
// ============================================================================

/**
 * Reset jobs that have been locked for too long (worker crashed)
 */
export async function recoverStuckJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_JOB_TIMEOUT_MINUTES * 60 * 1000);

  const result = await prisma.workerJob.updateMany({
    where: {
      status: JobStatus.PROCESSING,
      lockedAt: { lt: cutoff },
    },
    data: {
      status: JobStatus.PENDING,
      lockedAt: null,
      lockedBy: null,
      lastError: `Recovered from stuck state (locked > ${STUCK_JOB_TIMEOUT_MINUTES} minutes)`,
    },
  });

  if (result.count > 0) {
    console.log(`[Queue] Recovered ${result.count} stuck jobs`);
  }

  return result.count;
}

// ============================================================================
// Queue Statistics
// ============================================================================

/**
 * Get queue statistics for monitoring
 */
export async function getQueueStats(): Promise<QueueStats> {
  const [statusCounts, typeCounts] = await Promise.all([
    prisma.workerJob.groupBy({
      by: ['status'],
      _count: true,
    }),
    prisma.workerJob.groupBy({
      by: ['type'],
      where: { status: JobStatus.PENDING },
      _count: true,
    }),
  ]);

  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    deadLetter: 0,
    byType: {} as Record<JobType, number>,
  };

  for (const { status, _count } of statusCounts) {
    switch (status) {
      case JobStatus.PENDING:
        stats.pending = _count;
        break;
      case JobStatus.PROCESSING:
        stats.processing = _count;
        break;
      case JobStatus.COMPLETED:
        stats.completed = _count;
        break;
      case JobStatus.FAILED:
        stats.failed = _count;
        break;
      case JobStatus.DEAD_LETTER:
        stats.deadLetter = _count;
        break;
    }
  }

  for (const { type, _count } of typeCounts) {
    stats.byType[type] = _count;
  }

  return stats;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Delete old completed jobs (retention policy)
 */
export async function cleanupOldJobs(olderThanDays: number = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const result = await prisma.workerJob.deleteMany({
    where: {
      status: { in: [JobStatus.COMPLETED, JobStatus.DEAD_LETTER] },
      completedAt: { lt: cutoff },
    },
  });

  if (result.count > 0) {
    console.log(`[Queue] Cleaned up ${result.count} old jobs`);
  }

  return result.count;
}
