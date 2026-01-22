# Phase 1: Queue Infrastructure

## Overview

This phase implements a Postgres-backed job queue using `FOR UPDATE SKIP LOCKED` for safe concurrent access. This replaces the current `setImmediate()` fire-and-forget approach with a durable, retryable queue.

---

## Already Completed

### ✅ Prisma Schema (`/prisma/schema.prisma`)

The following has been added to the schema:

```prisma
enum JobStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  DEAD_LETTER
}

enum JobType {
  INTERPRET_EVENT
  DETECT_PATTERNS
  GENERATE_INSIGHTS
  GENERATE_REVIEW
  GENERATE_TOMORROW_PLAN
  SUGGEST_UOM_UPDATE
}

model WorkerJob {
  id             String    @id @default(cuid())
  type           JobType
  payload        Json
  status         JobStatus @default(PENDING)
  priority       Int       @default(0)
  availableAt    DateTime  @default(now())
  attempts       Int       @default(0)
  maxAttempts    Int       @default(3)
  lastError      String?   @db.Text
  lockedAt       DateTime?
  lockedBy       String?
  idempotencyKey String?   @unique
  userId         String?
  createdAt      DateTime  @default(now())
  startedAt      DateTime?
  completedAt    DateTime?

  user           User?     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([status, availableAt, priority])
  @@index([type, status])
  @@index([userId, type])
  @@index([lockedAt])
}
```

### ✅ Type Definitions (`/src/queue/types.ts`)

All TypeScript types have been created:
- `InterpretEventPayload`
- `DetectPatternsPayload`
- `GenerateInsightsPayload`
- `GenerateReviewPayload`
- `GenerateTomorrowPlanPayload`
- `SuggestUOMUpdatePayload`
- `EnqueueOptions`
- `JobResult`
- `JobHandler`
- `WorkerConfig`
- `QueueStats`

---

## Files to Create

### 1. `/src/queue/queue.service.ts`

**Purpose:** Core queue operations - enqueue, dequeue, status updates

**Full Implementation:**

```typescript
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

  // If idempotencyKey provided, check for existing job
  if (idempotencyKey) {
    const existing = await prisma.workerJob.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });

    if (existing) {
      console.log(`[Queue] Duplicate job with key ${idempotencyKey}, returning existing: ${existing.id}`);
      return existing.id;
    }
  }

  const job = await prisma.workerJob.create({
    data: {
      type,
      payload: payload as Prisma.InputJsonValue,
      status: JobStatus.PENDING,
      priority,
      availableAt,
      maxAttempts,
      idempotencyKey,
      userId,
    },
    select: { id: true },
  });

  console.log(`[Queue] Enqueued ${type} job: ${job.id}${idempotencyKey ? ` (key: ${idempotencyKey})` : ''}`);
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
```

---

### 2. `/src/queue/worker.ts`

**Purpose:** Polling loop with adaptive interval

**Full Implementation:**

```typescript
import { v4 as uuidv4 } from 'uuid';
import { dequeue, completeJob, failJob, recoverStuckJobs } from './queue.service';
import { getHandler } from './handlers';
import { WorkerConfig, JobResult } from './types';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<WorkerConfig> = {
  workerId: `worker-${uuidv4().slice(0, 8)}`,
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
let currentConfig: Required<WorkerConfig> = DEFAULT_CONFIG;
let pollInterval: number = DEFAULT_CONFIG.pollIntervalMin;
let stuckJobRecoveryInterval: NodeJS.Timeout | null = null;

// ============================================================================
// Main Worker Loop
// ============================================================================

/**
 * Start the queue worker polling loop
 */
export function startWorker(config: WorkerConfig = {}): void {
  if (isRunning) {
    console.log('[Worker] Already running');
    return;
  }

  currentConfig = { ...DEFAULT_CONFIG, ...config };
  pollInterval = currentConfig.pollIntervalMin;
  isRunning = true;

  console.log(`[Worker] Starting with ID: ${currentConfig.workerId}`);
  console.log(`[Worker] Poll interval: ${currentConfig.pollIntervalMin}ms - ${currentConfig.pollIntervalMax}ms`);

  // Start stuck job recovery (every 5 minutes)
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
 */
export function stopWorker(): void {
  if (!isRunning) {
    console.log('[Worker] Not running');
    return;
  }

  isRunning = false;

  if (stuckJobRecoveryInterval) {
    clearInterval(stuckJobRecoveryInterval);
    stuckJobRecoveryInterval = null;
  }

  console.log(`[Worker] Stopped: ${currentConfig.workerId}`);
}

/**
 * Check if worker is running
 */
export function isWorkerRunning(): boolean {
  return isRunning;
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
  }
}

// ============================================================================
// Exports
// ============================================================================

export { currentConfig as workerConfig };
```

---

### 3. `/src/queue/handlers.ts`

**Purpose:** Map job types to handler functions

**Full Implementation:**

```typescript
import { JobType } from '@prisma/client';
import {
  JobHandler,
  JobResult,
  InterpretEventPayload,
  DetectPatternsPayload,
  GenerateInsightsPayload,
  GenerateReviewPayload,
  GenerateTomorrowPlanPayload,
  SuggestUOMUpdatePayload,
} from './types';

// Import workers
import { interpretEvent } from '../workers/interpretation';
import { detectPatternsForEvent, PatternOutcome } from '../workers/pattern';
import { generateInsights, TriggerContext } from '../workers/insight';
import { generateReview } from '../workers/review';
// These will be implemented in Phase 3 and 4:
// import { generateTomorrowPlan } from '../workers/tomorrow-plan';
// import { suggestUOMUpdate } from '../workers/uom-suggestion';

// Import queue service for chaining
import {
  enqueueDetectPatterns,
  enqueueGenerateInsights,
  enqueueGenerateTomorrowPlan,
  enqueueSuggestUOMUpdate,
} from './queue.service';

import prisma from '../prisma';

// ============================================================================
// Handler Registry
// ============================================================================

const handlers: Partial<Record<JobType, JobHandler>> = {};

/**
 * Register a handler for a job type
 */
export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers[type] = handler;
  console.log(`[Handlers] Registered handler for ${type}`);
}

/**
 * Get handler for a job type
 */
export function getHandler(type: string): JobHandler | undefined {
  return handlers[type as JobType];
}

// ============================================================================
// INTERPRET_EVENT Handler
// ============================================================================

const handleInterpretEvent: JobHandler<InterpretEventPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { eventId } = payload;

  try {
    const result = await interpretEvent({ eventId });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Interpretation failed',
        shouldRetry: true,
      };
    }

    // Chain: enqueue pattern detection
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { userId: true },
    });

    if (event) {
      await enqueueDetectPatterns({
        userId: event.userId,
        triggerEventId: eventId,
        interpretationId: result.interpretationId,
      });
    }

    return {
      success: true,
      data: { interpretationId: result.interpretationId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// DETECT_PATTERNS Handler
// ============================================================================

const handleDetectPatterns: JobHandler<DetectPatternsPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, triggerEventId, interpretationId } = payload;

  try {
    const result = await detectPatternsForEvent({
      userId,
      triggerEventId,
      interpretationId,
    });

    // Chain: enqueue insight generation if pattern created/evolved
    const shouldGenerateInsights =
      result.outcome === PatternOutcome.CREATED_NEW_PATTERN ||
      result.outcome === PatternOutcome.EVOLVED_PATTERN;

    if (shouldGenerateInsights) {
      let triggerType: TriggerContext['type'] = 'new_event';

      if (result.outcome === PatternOutcome.CREATED_NEW_PATTERN) {
        triggerType = 'pattern_created';
      } else if (result.outcome === PatternOutcome.EVOLVED_PATTERN) {
        triggerType = 'pattern_evolved';
      }

      await enqueueGenerateInsights({
        userId,
        triggerType,
        eventId: triggerEventId,
        interpretationId,
        patternId: result.patternId,
      });
    }

    return {
      success: true,
      data: {
        outcome: result.outcome,
        patternId: result.patternId,
        patternsCreated: result.patternsCreated,
        patternsReinforced: result.patternsReinforced,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// GENERATE_INSIGHTS Handler
// ============================================================================

const handleGenerateInsights: JobHandler<GenerateInsightsPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, triggerType, eventId, interpretationId, patternId } = payload;

  try {
    const trigger: TriggerContext = {
      type: triggerType,
      eventId,
      interpretationId,
      patternId,
    };

    const result = await generateInsights({ userId, trigger });

    return {
      success: true,
      data: {
        insightsCreated: result.insightsCreated,
        questionsExplored: result.questionsExplored,
        questionsAnswerable: result.questionsAnswerable,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// GENERATE_REVIEW Handler
// ============================================================================

const handleGenerateReview: JobHandler<GenerateReviewPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, type, periodKey, timezone } = payload;

  try {
    const result = await generateReview({
      userId,
      type: type as 'DAILY' | 'WEEKLY' | 'MONTHLY',
      periodKey,
      timezone,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Review generation failed',
        shouldRetry: true,
      };
    }

    // Chain: if DAILY review, enqueue tomorrow planner
    if (type === 'DAILY' && result.reviewId) {
      // Calculate target date (tomorrow)
      const today = new Date(periodKey);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const targetDate = tomorrow.toISOString().split('T')[0];

      await enqueueGenerateTomorrowPlan({
        userId,
        reviewId: result.reviewId,
        targetDate,
      });
    }

    return {
      success: true,
      data: { reviewId: result.reviewId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// GENERATE_TOMORROW_PLAN Handler (Phase 3 - Placeholder)
// ============================================================================

const handleGenerateTomorrowPlan: JobHandler<GenerateTomorrowPlanPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, reviewId, targetDate } = payload;

  // TODO: Implement in Phase 3
  // const result = await generateTomorrowPlan({ userId, reviewId, targetDate });

  console.log(`[Handler] GENERATE_TOMORROW_PLAN not yet implemented`);

  // For now, return success to allow chain to continue
  // Remove this placeholder when implementing Phase 3
  return {
    success: true,
    data: { message: 'Tomorrow plan handler not yet implemented' },
  };

  /*
  // After Phase 3 implementation:
  try {
    const result = await generateTomorrowPlan({ userId, reviewId, targetDate });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Tomorrow plan generation failed',
        shouldRetry: true,
      };
    }

    // Chain: enqueue UOM suggestion
    if (result.dailyPlanId) {
      await enqueueSuggestUOMUpdate({
        userId,
        dailyPlanId: result.dailyPlanId,
      });
    }

    return {
      success: true,
      data: { dailyPlanId: result.dailyPlanId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
  */
};

// ============================================================================
// SUGGEST_UOM_UPDATE Handler (Phase 4 - Placeholder)
// ============================================================================

const handleSuggestUOMUpdate: JobHandler<SuggestUOMUpdatePayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, dailyPlanId } = payload;

  // TODO: Implement in Phase 4
  // const result = await suggestUOMUpdate({ userId, dailyPlanId });

  console.log(`[Handler] SUGGEST_UOM_UPDATE not yet implemented`);

  // For now, return success
  // Remove this placeholder when implementing Phase 4
  return {
    success: true,
    data: { message: 'UOM suggestion handler not yet implemented' },
  };

  /*
  // After Phase 4 implementation:
  try {
    const result = await suggestUOMUpdate({ userId, dailyPlanId });

    return {
      success: true,
      data: {
        suggestionId: result.suggestionId,
        suggestionGenerated: result.suggestionGenerated,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
  */
};

// ============================================================================
// Register All Handlers
// ============================================================================

export function registerAllHandlers(): void {
  registerHandler(JobType.INTERPRET_EVENT, handleInterpretEvent);
  registerHandler(JobType.DETECT_PATTERNS, handleDetectPatterns);
  registerHandler(JobType.GENERATE_INSIGHTS, handleGenerateInsights);
  registerHandler(JobType.GENERATE_REVIEW, handleGenerateReview);
  registerHandler(JobType.GENERATE_TOMORROW_PLAN, handleGenerateTomorrowPlan);
  registerHandler(JobType.SUGGEST_UOM_UPDATE, handleSuggestUOMUpdate);

  console.log('[Handlers] All handlers registered');
}
```

---

### 4. `/src/queue/index.ts`

**Purpose:** Public exports

**Full Implementation:**

```typescript
// Types
export * from './types';

// Queue Service
export {
  enqueue,
  enqueueInterpretEvent,
  enqueueDetectPatterns,
  enqueueGenerateInsights,
  enqueueGenerateReview,
  enqueueGenerateTomorrowPlan,
  enqueueSuggestUOMUpdate,
  dequeue,
  completeJob,
  failJob,
  recoverStuckJobs,
  getQueueStats,
  cleanupOldJobs,
} from './queue.service';

// Worker
export {
  startWorker,
  stopWorker,
  isWorkerRunning,
} from './worker';

// Handlers
export {
  registerHandler,
  getHandler,
  registerAllHandlers,
} from './handlers';
```

---

## Pre-Implementation Steps

Before creating the files above:

### 1. Run Prisma Migration

```bash
cd /Users/abhiraajverma/Desktop/brainLM/server
npx prisma generate
npx prisma migrate dev --name add_queue_and_planning_tables
```

### 2. Install uuid (if not already installed)

```bash
npm install uuid
npm install -D @types/uuid
```

---

## Post-Implementation Verification

### 1. Type Check

```bash
npx tsc --noEmit
```

### 2. Test Queue Service

Create a temporary test file or use REPL:

```typescript
import { enqueueInterpretEvent, getQueueStats } from './src/queue';

// Test enqueue
const jobId = await enqueueInterpretEvent({ eventId: 'test-event-id' });
console.log('Created job:', jobId);

// Test stats
const stats = await getQueueStats();
console.log('Queue stats:', stats);
```

### 3. Test Worker

```typescript
import { startWorker, stopWorker, registerAllHandlers } from './src/queue';

registerAllHandlers();
startWorker();

// Wait a few seconds, then stop
setTimeout(() => {
  stopWorker();
}, 5000);
```

---

## Key Design Decisions

### 1. FOR UPDATE SKIP LOCKED

**Why:** Provides safe concurrent access without external dependencies. Multiple workers can poll simultaneously without processing the same job.

**Alternative Considered:** `pg-boss` library
**Why Rejected:** Requires dedicated Postgres connection, conflicts with Supabase connection pooling

### 2. Adaptive Polling

**Why:** Reduces database load when queue is empty while maintaining responsiveness when jobs exist.

**Behavior:**
- Starts at 100ms
- Increases by 100ms per empty poll
- Caps at 2000ms
- Resets to 100ms when job found

### 3. Exponential Backoff

**Why:** Prevents retry storms and gives transient issues time to resolve.

**Formula:** `2^attempts * 5 seconds`
- Attempt 1: 5 seconds
- Attempt 2: 10 seconds
- Attempt 3: 20 seconds
- Attempt 4: 40 seconds

### 4. Idempotency Keys

**Why:** Prevents duplicate job creation when same event is processed multiple times.

**Format:** `{type}:{identifier}` (e.g., `interpret:event123`)

### 5. Stuck Job Recovery

**Why:** Handles worker crashes gracefully by detecting jobs locked for >10 minutes.

**Mechanism:** Periodic check (every 5 minutes) resets stuck jobs to PENDING.

---

## Next Phase

After completing Phase 1, proceed to **Phase 2: Daily Flow Integration** (`02-daily-flow-integration.md`) to connect existing workers to the queue system.
