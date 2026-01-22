# BrainLM Backend Documentation

## Overview

This backend is a **worker-based processing system** - there are no REST APIs. All data operations are done via **Prisma directly from the Next.js client**. The server runs background workers that process jobs from a Postgres queue.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         NEXT.JS CLIENT                               │
│                                                                      │
│  Uses Prisma directly for:                                          │
│  - Creating events (triggers processing chain)                       │
│  - Reading reviews, plans, suggestions                               │
│  - Accepting/rejecting UOM suggestions                               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      POSTGRES DATABASE                               │
│                                                                      │
│  WorkerJob table (queue)  ←──────  Workers poll and process         │
│  User, Event, Pattern, Insight, Review, DailyPlan, UOMSuggestion    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      WORKER SERVER                                   │
│                                                                      │
│  - Queue Worker (polls WorkerJob table)                             │
│  - Review Cron (schedules daily/weekly/monthly reviews)             │
│  - Handlers for each job type                                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Starting the Backend

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

This starts:
1. **Queue Worker** - Polls for jobs and processes them
2. **Review Cron** - Schedules reviews at midnight in each user's timezone

---

## Entry Points (How to Trigger Things)

### 1. Create an Event (Primary Entry Point)

**From Next.js client**, use the helper function:

```typescript
// In your Next.js app
import { PrismaClient } from '@prisma/client';
import { createEventWithProcessing } from 'brainlm-server/lib/queue-client';

const prisma = new PrismaClient();

// When user logs something
const result = await createEventWithProcessing(prisma, {
  userId: 'user-cuid-here',
  content: 'Had a great workout at the gym this morning at 6am',
  occurredAt: new Date(),
});

console.log(result.eventId);  // The created event
console.log(result.jobId);    // The processing job ID
```

**What happens:**
```
Event Created
    ↓
INTERPRET_EVENT job queued
    ↓
Worker processes → Creates Interpretation
    ↓
DETECT_PATTERNS job queued (chained automatically)
    ↓
Worker processes → Creates/reinforces Patterns
    ↓
GENERATE_INSIGHTS job queued (if pattern created/evolved)
    ↓
Worker processes → Creates Insights
```

### 2. Trigger a Review Manually

Reviews are normally triggered by cron at midnight, but you can trigger manually:

```typescript
import { PrismaClient, JobType, JobStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Enqueue a daily review
await prisma.workerJob.create({
  data: {
    type: JobType.GENERATE_REVIEW,
    payload: {
      userId: 'user-cuid-here',
      type: 'DAILY',           // or 'WEEKLY' or 'MONTHLY'
      periodKey: '2024-01-15', // YYYY-MM-DD for daily
      timezone: 'America/New_York',
    },
    status: JobStatus.PENDING,
    userId: 'user-cuid-here',
    idempotencyKey: `review:user-cuid-here:DAILY:2024-01-15`,
  },
});
```

Or use the client helper:

```typescript
import { enqueueReviewGeneration } from 'brainlm-server/lib/queue-client';

await enqueueReviewGeneration(
  prisma,
  'user-id',
  'DAILY',
  '2024-01-15',
  'America/New_York'
);
```

**What happens after DAILY review:**
```
GENERATE_REVIEW completes
    ↓
GENERATE_TOMORROW_PLAN job queued (automatic)
    ↓
Worker processes → Creates DailyPlan
    ↓
SUGGEST_UOM_UPDATE job queued (automatic)
    ↓
Worker processes → May create UOMUpdateSuggestion
```

### 3. Accept/Reject UOM Suggestions

```typescript
import {
  getPendingUOMSuggestions,
  acceptUOMSuggestion,
  rejectUOMSuggestion,
  ignoreUOMSuggestion,
} from 'brainlm-server/lib/queue-client';

// Get pending suggestions for user
const suggestions = await getPendingUOMSuggestions(prisma, userId);

// Accept one (updates user's baseline)
const result = await acceptUOMSuggestion(prisma, userId, suggestionId);
// result.success = true/false

// Reject one (with optional reason)
await rejectUOMSuggestion(prisma, userId, suggestionId, 'Not accurate for me');

// Ignore one (dismiss without feedback)
await ignoreUOMSuggestion(prisma, userId, suggestionId);
```

### 4. Check Job Status

```typescript
import { getJobStatus, isEventProcessed } from 'brainlm-server/lib/queue-client';

// Check specific job
const status = await getJobStatus(prisma, jobId);
// { status: 'COMPLETED', attempts: 1, lastError: null, completedAt: Date }

// Check if event is fully processed
const done = await isEventProcessed(prisma, eventId);
// true if INTERPRET_EVENT job completed
```

---

## Job Types and Their Payloads

| Job Type | Payload | Triggered By | Chains To |
|----------|---------|--------------|-----------|
| `INTERPRET_EVENT` | `{ eventId }` | Event creation | `DETECT_PATTERNS` |
| `DETECT_PATTERNS` | `{ userId, triggerEventId, interpretationId }` | Interpretation complete | `GENERATE_INSIGHTS` (if pattern created/evolved) |
| `GENERATE_INSIGHTS` | `{ userId, triggerType, eventId?, interpretationId?, patternId? }` | Pattern created/evolved | None |
| `GENERATE_REVIEW` | `{ userId, type, periodKey, timezone }` | Cron or manual | `GENERATE_TOMORROW_PLAN` (if DAILY) |
| `GENERATE_TOMORROW_PLAN` | `{ userId, reviewId, targetDate }` | Daily review complete | `SUGGEST_UOM_UPDATE` |
| `SUGGEST_UOM_UPDATE` | `{ userId, dailyPlanId }` | Tomorrow plan complete | None |

---

## Client Helper Functions

All functions in `/src/lib/queue-client.ts` are designed for use from Next.js:

### Event Creation

```typescript
createEventWithProcessing(prisma, {
  userId: string,
  content: string,
  occurredAt: Date,
}): Promise<{ eventId: string, jobId: string }>
```

### Review Enqueueing

```typescript
enqueueReviewGeneration(
  prisma,
  userId: string,
  type: 'DAILY' | 'WEEKLY' | 'MONTHLY',
  periodKey: string,  // 'YYYY-MM-DD' | 'YYYY-WXX' | 'YYYY-MM'
  timezone: string,
): Promise<string>  // Returns job ID
```

### Job Status

```typescript
getJobStatus(prisma, jobId: string): Promise<{
  status: JobStatus,
  attempts: number,
  lastError: string | null,
  completedAt: Date | null,
} | null>

isEventProcessed(prisma, eventId: string): Promise<boolean>
```

### UOM Suggestion Management

```typescript
getPendingUOMSuggestions(prisma, userId: string): Promise<UOMUpdateSuggestion[]>

acceptUOMSuggestion(prisma, userId: string, suggestionId: string): Promise<{
  success: boolean,
  error?: string,
}>

rejectUOMSuggestion(prisma, userId: string, suggestionId: string, reason?: string): Promise<{
  success: boolean,
  error?: string,
}>

ignoreUOMSuggestion(prisma, userId: string, suggestionId: string): Promise<{
  success: boolean,
  error?: string,
}>
```

---

## Reading Data (Direct Prisma)

The client reads data directly via Prisma. No special functions needed.

### Get User's Reviews

```typescript
const reviews = await prisma.review.findMany({
  where: { userId },
  orderBy: { createdAt: 'desc' },
});
```

### Get Tomorrow's Plan

```typescript
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const dateStr = tomorrow.toISOString().split('T')[0];

const plan = await prisma.dailyPlan.findFirst({
  where: {
    userId,
    targetDate: new Date(dateStr),
  },
});

// plan.focusAreas - JSON array of focus areas
// plan.sessions - JSON array of sessions
// plan.warnings - JSON array of warnings
// plan.ctas - JSON array of calls to action
// plan.renderedMarkdown - Full markdown for display
```

### Get User's Patterns

```typescript
const patterns = await prisma.pattern.findMany({
  where: { userId, status: 'ACTIVE' },
  orderBy: { lastReinforcedAt: 'desc' },
});
```

### Get User's Insights

```typescript
const insights = await prisma.insight.findMany({
  where: {
    userId,
    status: { in: ['CONFIRMED', 'LIKELY'] },
  },
  orderBy: { createdAt: 'desc' },
});
```

---

## Cron Setup

The cron is automatically started when you run the server. It:

1. **Runs every hour** at minute 0
2. **Checks all users** whose timezone is at midnight
3. **Enqueues GENERATE_REVIEW jobs** for each user

### How it works:

```typescript
// In /src/jobs.ts (started automatically)
import { startReviewCron } from './jobs/review-cron';

startReviewCron();  // Starts the hourly cron
```

### Period Key Formats:

| Review Type | Period Key Format | Example |
|-------------|-------------------|---------|
| DAILY | `YYYY-MM-DD` | `2024-01-15` |
| WEEKLY | `YYYY-WXX` | `2024-W03` |
| MONTHLY | `YYYY-MM` | `2024-01` |

### Manual Cron Trigger (for testing):

```typescript
import { triggerReviewsForTimezone } from './jobs/review-cron';

// Trigger for a specific timezone
await triggerReviewsForTimezone('America/New_York');
```

---

## User Setup Requirements

For the system to work properly, users need:

### Required Fields

```typescript
await prisma.user.create({
  data: {
    email: 'user@example.com',
    name: 'John Doe',
    timezone: 'America/New_York',  // IANA timezone
    baseline: `# About Me

## Routines
- Wake at 7am
- Gym 3x/week

## Goals
- Build side project
- Read more books
`,
  },
});
```

### Optional Fields

```typescript
// These are managed automatically:
lastBaselineUpdate: Date | null,  // Set when baseline is updated
nextDailyReviewDue: Date | null,  // For robust scheduling (future)
nextWeeklyReviewDue: Date | null,
nextMonthlyReviewDue: Date | null,
```

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER ACTION                                │
│                    "I went to the gym today"                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    createEventWithProcessing()                       │
│                                                                      │
│  1. Creates Event record                                            │
│  2. Creates WorkerJob (INTERPRET_EVENT)                             │
│  3. Returns { eventId, jobId }                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    QUEUE WORKER PROCESSES                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ INTERPRET     │    │ DETECT        │    │ GENERATE      │
│ EVENT         │───▶│ PATTERNS      │───▶│ INSIGHTS      │
│               │    │               │    │ (if needed)   │
│ Creates       │    │ Creates or    │    │               │
│ Interpretation│    │ reinforces    │    │ Creates       │
│               │    │ Pattern       │    │ Insight       │
└───────────────┘    └───────────────┘    └───────────────┘

                    ... events accumulate ...

┌─────────────────────────────────────────────────────────────────────┐
│                    MIDNIGHT (User's timezone)                        │
│                    Cron triggers GENERATE_REVIEW                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ GENERATE      │    │ GENERATE      │    │ SUGGEST       │
│ REVIEW        │───▶│ TOMORROW_PLAN │───▶│ UOM_UPDATE    │
│               │    │               │    │               │
│ Creates       │    │ Creates       │    │ May create    │
│ Review        │    │ DailyPlan     │    │ Suggestion    │
└───────────────┘    └───────────────┘    └───────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    USER SEES IN APP                                  │
│                                                                      │
│  - Daily Review (what happened yesterday)                           │
│  - Tomorrow Plan (focus areas, sessions, warnings)                  │
│  - UOM Suggestion (if behavior drifted from baseline)               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Environment Variables

```env
# Database
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."  # For Prisma migrations

# OpenAI
OPENAI_API_KEY="sk-..."

# Optional
NODE_ENV="development"  # or "production"
```

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `User` | User accounts with baseline and timezone |
| `Event` | Raw events logged by user |
| `Interpretation` | LLM interpretation of each event |
| `Pattern` | Recurring behaviors detected |
| `PatternEvent` | Links patterns to their evidence events |
| `Insight` | Synthesized conclusions from patterns |
| `InsightEvent` | Links insights to evidence events |
| `InsightPattern` | Links insights to evidence patterns |
| `InsightInterpretation` | Links insights to evidence interpretations |
| `Review` | Daily/weekly/monthly reviews |
| `DailyPlan` | Tomorrow planner output |
| `UOMUpdateSuggestion` | Suggested baseline updates |
| `WorkerJob` | Queue table for background jobs |

---

## Monitoring

### Check Queue Status

```typescript
import { getQueueStats } from './queue';

const stats = await getQueueStats();
console.log(stats);
// {
//   pending: 5,
//   processing: 1,
//   completed: 100,
//   failed: 2,
//   deadLetter: 0,
//   byType: { INTERPRET_EVENT: 3, DETECT_PATTERNS: 2 }
// }
```

### SQL Queries for Monitoring

```sql
-- Job status distribution
SELECT status, COUNT(*) FROM "WorkerJob" GROUP BY status;

-- Failed jobs in last 24h
SELECT type, "lastError", "createdAt"
FROM "WorkerJob"
WHERE status = 'DEAD_LETTER'
AND "createdAt" > NOW() - INTERVAL '24 hours';

-- Pending UOM suggestions
SELECT "userId", COUNT(*)
FROM "UOMUpdateSuggestion"
WHERE status = 'PENDING'
GROUP BY "userId";
```

---

## Testing

```bash
# Type check
npm run typecheck

# Queue integration tests (no API calls)
npm run test:queue

# Full E2E test (requires OpenAI API)
npm run test:e2e

# All tests
npm test
```

---

## Summary

| What You Want | How To Do It |
|---------------|--------------|
| Log an event | `createEventWithProcessing(prisma, { userId, content, occurredAt })` |
| Get job status | `getJobStatus(prisma, jobId)` |
| Check if event processed | `isEventProcessed(prisma, eventId)` |
| Trigger review manually | `enqueueReviewGeneration(prisma, userId, type, periodKey, timezone)` |
| Get pending suggestions | `getPendingUOMSuggestions(prisma, userId)` |
| Accept suggestion | `acceptUOMSuggestion(prisma, userId, suggestionId)` |
| Reject suggestion | `rejectUOMSuggestion(prisma, userId, suggestionId, reason)` |
| Read reviews | `prisma.review.findMany({ where: { userId } })` |
| Read tomorrow plan | `prisma.dailyPlan.findFirst({ where: { userId, targetDate } })` |
| Read patterns | `prisma.pattern.findMany({ where: { userId, status: 'ACTIVE' } })` |
| Read insights | `prisma.insight.findMany({ where: { userId } })` |
