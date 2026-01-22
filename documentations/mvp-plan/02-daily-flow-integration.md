# Phase 2: Daily Flow Integration

## Overview

This phase connects the existing workers to the new queue system, replacing the synchronous `setImmediate()` approach with proper job queue orchestration. It also defines the **client interface** for how the Next.js application triggers processing flows.

> **IMPORTANT: No REST APIs**
>
> The Next.js client uses Prisma directly to create events and enqueue jobs. This document defines the helper functions that can be shared between client and server.

---

## Prerequisites

- **Phase 1 completed:** Queue infrastructure must be fully implemented and tested
- **Prisma migration applied:** `npx prisma migrate dev`
- **Queue worker tested:** Verify `startWorker()` runs without errors

---

## Client Interface (Next.js)

The Next.js client needs to be able to:

1. **Create events** and automatically trigger processing
2. **Check job status** (optional, for UI feedback)
3. **Manage UOM suggestions** directly via Prisma

### Client-Side Helper Functions

Create a shared library that can be used from Next.js:

**File:** `/src/lib/queue-client.ts` (or shared location accessible to Next.js)

```typescript
import { PrismaClient, JobType, JobStatus } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

export interface CreateEventWithProcessingInput {
  userId: string;
  content: string;
  occurredAt: Date;
}

export interface CreateEventWithProcessingResult {
  eventId: string;
  jobId: string;
}

export interface EnqueueJobOptions {
  priority?: number;
  delayMs?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
}

// ============================================================================
// Event Creation + Processing Trigger
// ============================================================================

/**
 * Creates an event and enqueues it for processing.
 * This is the PRIMARY way the client triggers the processing chain.
 *
 * Flow triggered:
 * 1. INTERPRET_EVENT → creates interpretation
 * 2. DETECT_PATTERNS → detects/reinforces patterns
 * 3. GENERATE_INSIGHTS → generates insights (if pattern created/evolved)
 *
 * @param prisma - Prisma client instance
 * @param input - Event data
 * @returns Event ID and Job ID
 */
export async function createEventWithProcessing(
  prisma: PrismaClient,
  input: CreateEventWithProcessingInput
): Promise<CreateEventWithProcessingResult> {
  const { userId, content, occurredAt } = input;

  // Use transaction to ensure both event and job are created
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the event
    const event = await tx.event.create({
      data: {
        userId,
        content,
        occurredAt,
      },
      select: { id: true },
    });

    // 2. Enqueue interpretation job
    const job = await tx.workerJob.create({
      data: {
        type: JobType.INTERPRET_EVENT,
        payload: { eventId: event.id },
        status: JobStatus.PENDING,
        priority: 0,
        maxAttempts: 3,
        userId,
        idempotencyKey: `interpret:${event.id}`,
      },
      select: { id: true },
    });

    return { eventId: event.id, jobId: job.id };
  });

  console.log(`[Client] Created event ${result.eventId}, job ${result.jobId}`);
  return result;
}

// ============================================================================
// Manual Job Enqueueing (Advanced)
// ============================================================================

/**
 * Manually enqueue a review generation job.
 * Typically the cron handles this, but client can trigger manually.
 *
 * @param prisma - Prisma client instance
 * @param userId - User ID
 * @param type - Review type (DAILY, WEEKLY, MONTHLY)
 * @param periodKey - Period key (e.g., "2024-01-15", "2024-W03", "2024-01")
 * @param timezone - User's timezone
 */
export async function enqueueReviewGeneration(
  prisma: PrismaClient,
  userId: string,
  type: 'DAILY' | 'WEEKLY' | 'MONTHLY',
  periodKey: string,
  timezone: string
): Promise<string> {
  const job = await prisma.workerJob.create({
    data: {
      type: JobType.GENERATE_REVIEW,
      payload: { userId, type, periodKey, timezone },
      status: JobStatus.PENDING,
      priority: 0,
      maxAttempts: 3,
      userId,
      idempotencyKey: `review:${userId}:${type}:${periodKey}`,
    },
    select: { id: true },
  });

  console.log(`[Client] Enqueued ${type} review job ${job.id}`);
  return job.id;
}

// ============================================================================
// Job Status Checking
// ============================================================================

/**
 * Check the status of a job.
 * Useful for showing processing status in UI.
 */
export async function getJobStatus(
  prisma: PrismaClient,
  jobId: string
): Promise<{
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  completedAt: Date | null;
} | null> {
  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      attempts: true,
      lastError: true,
      completedAt: true,
    },
  });

  return job;
}

/**
 * Check if processing is complete for an event.
 * Looks for completed INTERPRET_EVENT job for this event.
 */
export async function isEventProcessed(
  prisma: PrismaClient,
  eventId: string
): Promise<boolean> {
  const job = await prisma.workerJob.findFirst({
    where: {
      type: JobType.INTERPRET_EVENT,
      idempotencyKey: `interpret:${eventId}`,
      status: JobStatus.COMPLETED,
    },
    select: { id: true },
  });

  return job !== null;
}

// ============================================================================
// UOM Suggestion Management
// ============================================================================

/**
 * Get pending UOM suggestions for a user.
 */
export async function getPendingUOMSuggestions(
  prisma: PrismaClient,
  userId: string
) {
  return prisma.uOMUpdateSuggestion.findMany({
    where: {
      userId,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Accept a UOM suggestion and update the baseline.
 *
 * @param prisma - Prisma client instance
 * @param userId - User ID (for verification)
 * @param suggestionId - Suggestion ID to accept
 */
export async function acceptUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
    include: { user: { select: { baseline: true } } },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== 'PENDING') {
    return { success: false, error: `Cannot accept suggestion with status: ${suggestion.status}` };
  }

  const currentBaseline = suggestion.user.baseline || '';
  const timestamp = new Date().toISOString().split('T')[0];

  // Apply update based on drift type
  let newBaseline: string;
  switch (suggestion.driftType) {
    case 'ADDITION':
      newBaseline = currentBaseline
        ? `${currentBaseline.trimEnd()}\n\n---\n**Update (${timestamp}):**\n- ${suggestion.suggestion}`
        : `# User Baseline\n\n- ${suggestion.suggestion}\n\n*Added: ${timestamp}*`;
      break;
    case 'MODIFICATION':
      newBaseline = `${currentBaseline.trimEnd()}\n\n---\n**Modification (${timestamp}):**\n- ${suggestion.suggestion}`;
      break;
    case 'REMOVAL':
      newBaseline = `${currentBaseline.trimEnd()}\n\n---\n**Deprecated (${timestamp}):**\n- ~~${suggestion.suggestion}~~`;
      break;
    default:
      newBaseline = `${currentBaseline.trimEnd()}\n\n- ${suggestion.suggestion}`;
  }

  // Update in transaction
  await prisma.$transaction([
    prisma.uOMUpdateSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: 'ACCEPTED',
        statusChangedAt: new Date(),
      },
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        baseline: newBaseline,
        lastBaselineUpdate: new Date(),
      },
    }),
  ]);

  return { success: true };
}

/**
 * Reject a UOM suggestion.
 */
export async function rejectUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== 'PENDING') {
    return { success: false, error: `Cannot reject suggestion with status: ${suggestion.status}` };
  }

  await prisma.uOMUpdateSuggestion.update({
    where: { id: suggestionId },
    data: {
      status: 'REJECTED',
      statusChangedAt: new Date(),
      reasoning: reason
        ? `${suggestion.reasoning}\n\n---\n**Rejected:** ${reason}`
        : suggestion.reasoning,
    },
  });

  return { success: true };
}

/**
 * Ignore a UOM suggestion (dismiss without rejection).
 */
export async function ignoreUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== 'PENDING') {
    return { success: false, error: `Cannot ignore suggestion with status: ${suggestion.status}` };
  }

  await prisma.uOMUpdateSuggestion.update({
    where: { id: suggestionId },
    data: {
      status: 'IGNORED',
      statusChangedAt: new Date(),
    },
  });

  return { success: true };
}
```

---

## Usage Examples (Next.js Client)

### Creating an Event (Triggers Full Chain)

```typescript
// In a Next.js Server Action or API route
import prisma from '@/lib/prisma';
import { createEventWithProcessing } from '@/lib/queue-client';

export async function createUserEvent(userId: string, content: string) {
  const { eventId, jobId } = await createEventWithProcessing(prisma, {
    userId,
    content,
    occurredAt: new Date(),
  });

  return { eventId, jobId };
}
```

### Checking Processing Status

```typescript
import prisma from '@/lib/prisma';
import { getJobStatus, isEventProcessed } from '@/lib/queue-client';

// Check specific job
const status = await getJobStatus(prisma, jobId);
if (status?.status === 'COMPLETED') {
  console.log('Processing complete!');
}

// Check if event has been processed
const processed = await isEventProcessed(prisma, eventId);
```

### Managing UOM Suggestions

```typescript
import prisma from '@/lib/prisma';
import {
  getPendingUOMSuggestions,
  acceptUOMSuggestion,
  rejectUOMSuggestion,
} from '@/lib/queue-client';

// Get pending suggestions
const suggestions = await getPendingUOMSuggestions(prisma, userId);

// Accept a suggestion
const result = await acceptUOMSuggestion(prisma, userId, suggestionId);
if (!result.success) {
  console.error(result.error);
}

// Reject with reason
await rejectUOMSuggestion(prisma, userId, suggestionId, 'Not accurate');
```

---

## Server-Side Files to Modify

### 1. `/src/memory/create-event.ts`

**Current State:**
```typescript
import prisma from '../prisma';
import { processNewEvent } from '../jobs';

export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const event = await prisma.event.create({
    data: { userId: input.userId, content: input.content, occurredAt: input.occurredAt },
    select: { id: true },
  });

  setImmediate(() => {
    processNewEvent(event.id).catch((err) => {
      console.error(`[CreateEvent] Failed to process event ${event.id}:`, err);
    });
  });

  return { eventId: event.id };
}
```

**New State:**
```typescript
import prisma from '../prisma';
import { enqueueInterpretEvent } from '../queue';

export interface CreateEventInput {
  userId: string;
  content: string;
  occurredAt: Date;
}

export interface CreateEventResult {
  eventId: string;
  jobId: string;
}

/**
 * Creates an event and enqueues it for interpretation.
 *
 * This function is used by the server. For client usage, see:
 * /src/lib/queue-client.ts → createEventWithProcessing()
 *
 * Flow triggered:
 * 1. INTERPRET_EVENT → creates interpretation
 * 2. DETECT_PATTERNS → detects/reinforces patterns (chained by handler)
 * 3. GENERATE_INSIGHTS → generates insights if pattern created/evolved (chained by handler)
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const event = await prisma.event.create({
    data: {
      userId: input.userId,
      content: input.content,
      occurredAt: input.occurredAt,
    },
    select: { id: true },
  });

  // Enqueue interpretation job
  const jobId = await enqueueInterpretEvent(
    { eventId: event.id },
    { userId: input.userId }
  );

  console.log(`[CreateEvent] Created event ${event.id}, enqueued job ${jobId}`);

  return { eventId: event.id, jobId };
}
```

---

### 2. `/src/jobs.ts`

**Current State:**
```typescript
import { processMemoryPipeline } from './pipeline';
import { startReviewCron } from './jobs/review-cron';

export const startBackgroundJobs = () => {
    console.log('[Jobs] Background jobs initialized');
    startReviewCron();
};

export async function processNewEvent(eventId: string): Promise<void> {
    try {
        const result = await processMemoryPipeline(eventId);
        // ...
    } catch (error) {
        console.error(`[Pipeline] Failed for event ${eventId}:`, error);
    }
}
```

**New State:**
```typescript
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
export const startBackgroundJobs = () => {
    console.log('[Jobs] Initializing background jobs...');

    // Register all job handlers
    registerAllHandlers();

    // Start queue worker
    startWorker({
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
 * Gracefully stop all background jobs
 */
export const stopBackgroundJobs = () => {
    console.log('[Jobs] Stopping background jobs...');
    stopWorker();
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
```

---

### 3. `/src/jobs/review-cron.ts`

**Modification:** Update to enqueue review jobs instead of calling `generateReview` directly.

**Find and Replace Pattern:**

```typescript
// BEFORE: Direct call
await generateReview({ userId, type: 'DAILY', periodKey, timezone });

// AFTER: Enqueue via queue service
import { enqueueGenerateReview } from '../queue';

await enqueueGenerateReview({
  userId,
  type: 'DAILY',
  periodKey,
  timezone,
});
```

The idempotency key `review:{userId}:{type}:{periodKey}` prevents duplicate review jobs.

---

## Flow Diagrams

### Event Creation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS CLIENT                               │
│                                                                     │
│   const { eventId, jobId } = await createEventWithProcessing(      │
│     prisma,                                                         │
│     { userId, content: "Morning workout...", occurredAt: now }     │
│   );                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ $transaction
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        POSTGRESQL                                   │
│                                                                     │
│   INSERT INTO Event (...)  → eventId = "clx123..."                 │
│   INSERT INTO WorkerJob (type=INTERPRET_EVENT, ...) → jobId        │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ (Worker polls)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        WORKER SERVER                                │
│                                                                     │
│   handleInterpretEvent({ eventId })                                │
│   → interpretEvent()                                                │
│   → enqueueDetectPatterns()  ────────────────────────┐             │
└─────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│   handleDetectPatterns({ userId, triggerEventId, ... })            │
│   → detectPatternsForEvent()                                        │
│   → if CREATE/EVOLVE: enqueueGenerateInsights() ─────┐             │
└─────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│   handleGenerateInsights({ userId, trigger })                      │
│   → generateInsights()                                              │
│   (end of chain)                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Review Cron Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        REVIEW CRON                                  │
│                        (runs hourly)                                │
│                                                                     │
│   for each user where localTime === midnight:                       │
│     enqueueGenerateReview({ userId, type: 'DAILY', ... })          │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ (Worker polls)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│   handleGenerateReview({ userId, type: 'DAILY', periodKey })       │
│   → generateReview()                                                │
│   → if DAILY: enqueueGenerateTomorrowPlan() ─────────┐             │
└─────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│   handleGenerateTomorrowPlan({ userId, reviewId, targetDate })     │
│   → generateTomorrowPlan()                                          │
│   → enqueueSuggestUOMUpdate() ───────────────────────┐             │
└─────────────────────────────────────────────────────────────────────┘
                                                        │
                                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│   handleSuggestUOMUpdate({ userId, dailyPlanId })                  │
│   → suggestUOMUpdate()                                              │
│   → UOMUpdateSuggestion created (if conditions met)                │
│   (end of chain)                                                    │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS CLIENT                               │
│                                                                     │
│   // User sees suggestion in UI                                     │
│   const suggestions = await getPendingUOMSuggestions(prisma, id);  │
│                                                                     │
│   // User accepts                                                   │
│   await acceptUOMSuggestion(prisma, userId, suggestionId);         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Testing Phase 2

### 1. Test Event Creation from Client

```typescript
import { PrismaClient } from '@prisma/client';
import { createEventWithProcessing, getJobStatus } from './lib/queue-client';

const prisma = new PrismaClient();

// Create event
const { eventId, jobId } = await createEventWithProcessing(prisma, {
  userId: 'test-user-id',
  content: 'Test event content',
  occurredAt: new Date(),
});

console.log('Event ID:', eventId);
console.log('Job ID:', jobId);

// Check job was created
const status = await getJobStatus(prisma, jobId);
console.log('Job status:', status?.status); // Should be PENDING
```

### 2. Test Full Chain (Requires Worker Running)

```typescript
// Start worker on server
import { startBackgroundJobs } from './jobs';
startBackgroundJobs();

// Create event from client
const { eventId, jobId } = await createEventWithProcessing(prisma, {
  userId: 'real-user-id', // Must have baseline
  content: 'Had a productive morning workout at the gym at 6am',
  occurredAt: new Date(),
});

// Wait for processing
await new Promise(r => setTimeout(r, 60000));

// Verify chain completed
const interpretation = await prisma.interpretation.findUnique({
  where: { eventId },
});
console.log('Interpretation created:', !!interpretation);

const jobs = await prisma.workerJob.findMany({
  where: { userId: 'real-user-id' },
  orderBy: { createdAt: 'desc' },
  take: 5,
});
console.log('Jobs:', jobs.map(j => `${j.type}: ${j.status}`));
```

### 3. Test UOM Suggestion Management

```typescript
import {
  getPendingUOMSuggestions,
  acceptUOMSuggestion,
} from './lib/queue-client';

// Get suggestions
const suggestions = await getPendingUOMSuggestions(prisma, userId);
console.log('Pending suggestions:', suggestions.length);

if (suggestions.length > 0) {
  // Accept first suggestion
  const result = await acceptUOMSuggestion(prisma, userId, suggestions[0].id);
  console.log('Accept result:', result);

  // Verify baseline updated
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { baseline: true, lastBaselineUpdate: true },
  });
  console.log('Baseline updated:', user?.lastBaselineUpdate);
}
```

---

## Rollback Plan

If issues arise after Phase 2:

### 1. Revert `create-event.ts`

```typescript
// Revert to setImmediate approach
setImmediate(() => {
  processNewEvent(event.id).catch((err) => {
    console.error(`[CreateEvent] Failed:`, err);
  });
});
```

### 2. Revert `jobs.ts`

Remove queue worker startup, keep only review cron.

### 3. Keep Queue Infrastructure

The queue tables and types are harmless when unused.

---

## Next Phase

After completing Phase 2, proceed to **Phase 3: Tomorrow Planner Worker** (`03-tomorrow-planner-worker.md`) to implement the forward-looking daily planning feature.
