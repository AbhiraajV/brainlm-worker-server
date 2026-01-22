# Phase 5: Verification Checklist

## Overview

This document provides comprehensive testing and validation steps to verify the complete MVP implementation works correctly end-to-end.

> **Note:** No REST APIs to test. All data operations are via Prisma from the Next.js client.

---

## Prerequisites

- **Phases 1-4 completed:** All components implemented
- **Prisma migration applied:** All tables exist
- **Worker server running:** `npm run dev` or equivalent
- **Test user created:** User with baseline and some events/patterns

---

## 1. Queue Infrastructure Tests

### 1.1 Schema Verification

```bash
# Check tables exist
npx prisma db pull
npx prisma validate
```

```sql
-- Verify in database
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('WorkerJob', 'DailyPlan', 'UOMUpdateSuggestion');

-- Check WorkerJob indexes
SELECT indexname FROM pg_indexes WHERE tablename = 'WorkerJob';
```

### 1.2 Enqueue Test

```typescript
import { enqueueInterpretEvent, getQueueStats } from './queue';

// Create a test job
const jobId = await enqueueInterpretEvent({ eventId: 'test-event-123' });
console.log('Job ID:', jobId);

// Verify job exists
const stats = await getQueueStats();
console.log('Pending jobs:', stats.pending);
```

**Expected:**
- [ ] Job ID returned (cuid format)
- [ ] `stats.pending >= 1`

### 1.3 Idempotency Test

```typescript
// Enqueue same job twice
const jobId1 = await enqueueInterpretEvent({ eventId: 'same-event-id' });
const jobId2 = await enqueueInterpretEvent({ eventId: 'same-event-id' });

console.log('Job 1:', jobId1);
console.log('Job 2:', jobId2);
console.log('Same?', jobId1 === jobId2);
```

**Expected:**
- [ ] `jobId1 === jobId2` (same job returned)

### 1.4 Worker Polling Test

```typescript
import { startWorker, stopWorker, registerAllHandlers } from './queue';

registerAllHandlers();
startWorker({ workerId: 'test-worker' });

// Wait 5 seconds
await new Promise(r => setTimeout(r, 5000));

stopWorker();
console.log('Worker started and stopped without errors');
```

**Expected:**
- [ ] No errors in console
- [ ] Worker logs show polling activity

### 1.5 Stuck Job Recovery Test

```typescript
import prisma from './prisma';
import { recoverStuckJobs } from './queue';

// Manually create a stuck job
await prisma.workerJob.create({
  data: {
    type: 'INTERPRET_EVENT',
    payload: { eventId: 'stuck-test' },
    status: 'PROCESSING',
    lockedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago
    lockedBy: 'dead-worker',
  },
});

// Run recovery
const recovered = await recoverStuckJobs();
console.log('Recovered jobs:', recovered);
```

**Expected:**
- [ ] `recovered >= 1`
- [ ] Job status reset to PENDING

---

## 2. Client Integration Tests

### 2.1 Event Creation via Client Helper

```typescript
import { PrismaClient } from '@prisma/client';
import { createEventWithProcessing, getJobStatus } from './lib/queue-client';

const prisma = new PrismaClient();

const result = await createEventWithProcessing(prisma, {
  userId: 'test-user-id',
  content: 'Test event content',
  occurredAt: new Date(),
});

console.log('Event ID:', result.eventId);
console.log('Job ID:', result.jobId);

// Verify job exists
const status = await getJobStatus(prisma, result.jobId);
console.log('Job type:', status?.status);
```

**Expected:**
- [ ] `result.jobId` exists
- [ ] Job status is `PENDING`

### 2.2 Full Event Chain Test

```typescript
import { PrismaClient } from '@prisma/client';
import { createEventWithProcessing, isEventProcessed } from './lib/queue-client';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs';

const prisma = new PrismaClient();

// Start worker
startBackgroundJobs();

// Create event with real user
const result = await createEventWithProcessing(prisma, {
  userId: 'real-user-id', // Must have baseline
  content: 'Had a productive morning workout at the gym at 6am',
  occurredAt: new Date(),
});

// Wait for processing (interpretation + pattern detection)
console.log('Waiting for chain to complete...');
await new Promise(r => setTimeout(r, 60000)); // 60 seconds

// Verify interpretation created
const interpretation = await prisma.interpretation.findUnique({
  where: { eventId: result.eventId },
});
console.log('Interpretation exists:', !!interpretation);

// Check if fully processed
const processed = await isEventProcessed(prisma, result.eventId);
console.log('Event processed:', processed);

// Check completed jobs
const completedJobs = await prisma.workerJob.findMany({
  where: { status: 'COMPLETED' },
  orderBy: { completedAt: 'desc' },
  take: 5,
});
console.log('Completed jobs:', completedJobs.map(j => j.type));

stopBackgroundJobs();
```

**Expected:**
- [ ] Interpretation created for event
- [ ] INTERPRET_EVENT job completed
- [ ] DETECT_PATTERNS job completed
- [ ] GENERATE_INSIGHTS job completed (if pattern created/evolved)

---

## 3. Tomorrow Planner Worker Tests

### 3.1 Context Retrieval Test

```typescript
import { retrieveTomorrowPlanContext } from './workers/tomorrow-plan';

// Use a real user and review
const context = await retrieveTomorrowPlanContext(
  'real-user-id',
  'real-daily-review-id',
  '2024-01-16'
);

console.log('User name:', context?.user.name);
console.log('Baseline length:', context?.user.baseline?.length);
console.log('Patterns count:', context?.patterns.length);
console.log('Insights count:', context?.insights.length);
console.log('Day of week:', context?.dayOfWeek.name);
```

**Expected:**
- [ ] Context returned (not null)
- [ ] User baseline exists
- [ ] Patterns retrieved
- [ ] Day of week correct

### 3.2 Plan Generation Test

```typescript
import { generateTomorrowPlan } from './workers/tomorrow-plan';
import prisma from './prisma';

const result = await generateTomorrowPlan({
  userId: 'real-user-id',
  reviewId: 'real-daily-review-id',
  targetDate: '2024-01-16',
});

console.log('Success:', result.success);
console.log('Plan ID:', result.dailyPlanId);

// Verify plan in database
if (result.dailyPlanId) {
  const plan = await prisma.dailyPlan.findUnique({
    where: { id: result.dailyPlanId },
  });
  console.log('Focus areas:', JSON.stringify(plan?.focusAreas, null, 2));
  console.log('Warnings:', JSON.stringify(plan?.warnings, null, 2));
  console.log('Markdown length:', plan?.renderedMarkdown.length);
}
```

**Expected:**
- [ ] `result.success === true`
- [ ] Plan ID returned
- [ ] Focus areas array (1-3 items)
- [ ] Markdown rendered

### 3.3 Idempotency Test

```typescript
// Generate same plan twice
const result1 = await generateTomorrowPlan({
  userId: 'real-user-id',
  reviewId: 'real-daily-review-id',
  targetDate: '2024-01-16',
});

const result2 = await generateTomorrowPlan({
  userId: 'real-user-id',
  reviewId: 'real-daily-review-id',
  targetDate: '2024-01-16',
});

console.log('First call - skipped:', result1.skipped);
console.log('Second call - skipped:', result2.skipped);
console.log('Same plan ID:', result1.dailyPlanId === result2.dailyPlanId);
```

**Expected:**
- [ ] Second call returns `skipped: true`
- [ ] Same plan ID returned

---

## 4. UOM Suggestion Worker Tests

### 4.1 Context Retrieval Test

```typescript
import { retrieveUOMSuggestionContext } from './workers/uom-suggestion';

const context = await retrieveUOMSuggestionContext(
  'real-user-id',
  'real-daily-plan-id'
);

console.log('User baseline:', context?.user.baseline?.substring(0, 100));
console.log('Days since update:', context?.user.daysSinceUpdate);
console.log('Cooldown active:', context?.cooldownActive);
console.log('Patterns count:', context?.patterns.length);
console.log('Past suggestions:', context?.pastSuggestions.length);
```

**Expected:**
- [ ] Context returned
- [ ] Cooldown status correct
- [ ] Patterns with confidence levels

### 4.2 Suggestion Generation Test

```typescript
import { suggestUOMUpdate } from './workers/uom-suggestion';
import prisma from './prisma';

const result = await suggestUOMUpdate({
  userId: 'real-user-id',
  dailyPlanId: 'real-daily-plan-id',
});

console.log('Success:', result.success);
console.log('Suggestion generated:', result.suggestionGenerated);
console.log('Suggestion ID:', result.suggestionId);
console.log('Reason:', result.reason);

// If suggestion generated, verify in database
if (result.suggestionId) {
  const suggestion = await prisma.uOMUpdateSuggestion.findUnique({
    where: { id: result.suggestionId },
  });
  console.log('Suggestion text:', suggestion?.suggestion);
  console.log('Drift type:', suggestion?.driftType);
  console.log('Confidence:', suggestion?.confidence);
}
```

**Expected:**
- [ ] `result.success === true`
- [ ] Either suggestion generated OR valid skip reason

### 4.3 Cooldown Test

```typescript
import prisma from './prisma';
import { suggestUOMUpdate } from './workers/uom-suggestion';

// First, update baseline to trigger cooldown
await prisma.user.update({
  where: { id: 'real-user-id' },
  data: { lastBaselineUpdate: new Date() },
});

// Try to generate suggestion
const result = await suggestUOMUpdate({
  userId: 'real-user-id',
  dailyPlanId: 'real-daily-plan-id',
});

console.log('Skipped:', result.skipped);
console.log('Reason:', result.reason);
```

**Expected:**
- [ ] `result.skipped === true`
- [ ] Reason mentions cooldown

---

## 5. UOM Management via Client

### 5.1 Get Pending Suggestions

```typescript
import { PrismaClient } from '@prisma/client';
import { getPendingUOMSuggestions } from './lib/queue-client';

const prisma = new PrismaClient();

const suggestions = await getPendingUOMSuggestions(prisma, 'user-id');
console.log('Pending count:', suggestions.length);
suggestions.forEach(s => {
  console.log(`- ${s.driftType}: ${s.suggestion.substring(0, 50)}...`);
});
```

**Expected:**
- [ ] Returns array of pending suggestions

### 5.2 Accept Suggestion

```typescript
import { getPendingUOMSuggestions, acceptUOMSuggestion } from './lib/queue-client';

const suggestions = await getPendingUOMSuggestions(prisma, userId);
if (suggestions.length > 0) {
  const result = await acceptUOMSuggestion(prisma, userId, suggestions[0].id);
  console.log('Success:', result.success);

  // Verify baseline updated
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { baseline: true, lastBaselineUpdate: true },
  });
  console.log('Baseline updated:', user?.lastBaselineUpdate);
  console.log('Baseline contains suggestion:', user?.baseline?.includes(suggestions[0].suggestion));
}
```

**Expected:**
- [ ] `result.success === true`
- [ ] Suggestion status is ACCEPTED
- [ ] Baseline contains suggestion text
- [ ] `lastBaselineUpdate` is recent

### 5.3 Reject Suggestion

```typescript
import { rejectUOMSuggestion } from './lib/queue-client';

const result = await rejectUOMSuggestion(
  prisma,
  userId,
  suggestionId,
  'This is not accurate for me'
);

console.log('Success:', result.success);

// Verify status
const suggestion = await prisma.uOMUpdateSuggestion.findUnique({
  where: { id: suggestionId },
});
console.log('Status:', suggestion?.status); // Should be REJECTED
```

**Expected:**
- [ ] Status changed to REJECTED
- [ ] Reasoning includes rejection note

---

## 6. End-to-End Flow Test

This test validates the complete flow from event creation through UOM suggestion.

### 6.1 Setup

```typescript
import { PrismaClient } from '@prisma/client';
import { startBackgroundJobs, stopBackgroundJobs } from './jobs';
import { createEventWithProcessing } from './lib/queue-client';
import { enqueueGenerateReview } from './queue';

const prisma = new PrismaClient();

// Create a test user with baseline
const testUser = await prisma.user.create({
  data: {
    email: `e2e-test-${Date.now()}@test.com`,
    name: 'E2E Test User',
    timezone: 'America/New_York',
    baseline: `# User Baseline

## Morning Routine
- Wake at 7am
- Coffee and news
- Start work at 9am

## Exercise
- Gym 3x/week
- Usually Monday, Wednesday, Friday`,
  },
});

console.log('Created test user:', testUser.id);

// Start worker
startBackgroundJobs();
```

### 6.2 Create Events (Simulate Pattern)

```typescript
// Create events showing a new pattern
const events = [
  'Woke up at 6am today, did a 30 minute meditation session. Felt really focused after.',
  'Another early morning - started meditating at 6:15am. 20 minutes today.',
  'Morning meditation becoming a habit. 25 minutes at 6am.',
  'Skipped the gym but did my meditation. Feeling calm.',
  'Great meditation session this morning at 6am. 30 minutes.',
];

for (const content of events) {
  await createEventWithProcessing(prisma, {
    userId: testUser.id,
    content,
    occurredAt: new Date(),
  });

  // Wait for processing
  await new Promise(r => setTimeout(r, 30000));
}

console.log('Created', events.length, 'events');
```

### 6.3 Trigger Daily Review Chain

```typescript
// Calculate today's period key
const today = new Date().toISOString().split('T')[0];

// Enqueue daily review
const reviewJobId = await enqueueGenerateReview({
  userId: testUser.id,
  type: 'DAILY',
  periodKey: today,
  timezone: testUser.timezone,
});

console.log('Review job ID:', reviewJobId);

// Wait for full chain (review → tomorrow plan → UOM suggestion)
console.log('Waiting for full chain (3 minutes)...');
await new Promise(r => setTimeout(r, 180000));
```

### 6.4 Verify Results

```typescript
// Check review created
const review = await prisma.review.findFirst({
  where: {
    userId: testUser.id,
    type: 'DAILY',
    periodKey: today,
  },
});
console.log('Review created:', !!review);
console.log('Review ID:', review?.id);

// Check tomorrow plan created
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowDate = tomorrow.toISOString().split('T')[0];

const dailyPlan = await prisma.dailyPlan.findFirst({
  where: {
    userId: testUser.id,
    targetDate: new Date(tomorrowDate),
  },
});
console.log('Daily plan created:', !!dailyPlan);
console.log('Focus areas:', JSON.stringify(dailyPlan?.focusAreas, null, 2));

// Check UOM suggestion created
const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
  where: {
    userId: testUser.id,
    status: 'PENDING',
  },
  orderBy: { createdAt: 'desc' },
});
console.log('UOM suggestion created:', !!suggestion);
console.log('Suggestion:', suggestion?.suggestion);
console.log('Drift type:', suggestion?.driftType);

// Cleanup
stopBackgroundJobs();
```

**Expected:**
- [ ] Review created for today
- [ ] Daily plan created for tomorrow
- [ ] UOM suggestion generated (likely about meditation)
- [ ] Suggestion references morning meditation pattern

### 6.5 Accept Suggestion

```typescript
import { acceptUOMSuggestion } from './lib/queue-client';

if (suggestion) {
  const result = await acceptUOMSuggestion(prisma, testUser.id, suggestion.id);
  console.log('Accept result:', result.success);

  // Verify baseline updated
  const updatedUser = await prisma.user.findUnique({
    where: { id: testUser.id },
    select: { baseline: true, lastBaselineUpdate: true },
  });
  console.log('Baseline now includes meditation:', updatedUser?.baseline?.includes('meditation'));
}
```

**Expected:**
- [ ] Baseline now mentions meditation
- [ ] Cooldown active (7 days)

---

## 7. Error Handling Tests

### 7.1 Invalid Event ID

```typescript
import { startBackgroundJobs, stopBackgroundJobs } from './jobs';

startBackgroundJobs();

const jobId = await enqueueInterpretEvent({ eventId: 'non-existent-id' });

// Wait for processing
await new Promise(r => setTimeout(r, 30000));

// Check job status
const job = await prisma.workerJob.findUnique({ where: { id: jobId } });
console.log('Job status:', job?.status);
console.log('Last error:', job?.lastError);

stopBackgroundJobs();
```

**Expected:**
- [ ] Job eventually fails or goes to dead letter
- [ ] Error message captured

### 7.2 Missing Baseline

```typescript
// Create user without baseline
const userNoBaseline = await prisma.user.create({
  data: {
    email: 'no-baseline@test.com',
    name: 'No Baseline User',
    timezone: 'UTC',
  },
});

// Create event and process
const result = await createEventWithProcessing(prisma, {
  userId: userNoBaseline.id,
  content: 'Test event',
  occurredAt: new Date(),
});

// Workers should handle gracefully
```

**Expected:**
- [ ] Workers complete without crashing
- [ ] Interpretation still generated (with limited context)

### 7.3 Double Accept

```typescript
import { acceptUOMSuggestion } from './lib/queue-client';

// Accept once
const result1 = await acceptUOMSuggestion(prisma, userId, suggestionId);
console.log('First accept:', result1.success);

// Try to accept again
const result2 = await acceptUOMSuggestion(prisma, userId, suggestionId);
console.log('Second accept:', result2.success);
console.log('Error:', result2.error);
```

**Expected:**
- [ ] First accept succeeds
- [ ] Second accept fails with appropriate error

---

## 8. Performance Checks

### 8.1 Queue Processing Rate

```typescript
import { createEventWithProcessing } from './lib/queue-client';
import { getQueueStats } from './queue';

// Create multiple events
for (let i = 0; i < 10; i++) {
  await createEventWithProcessing(prisma, {
    userId: testUser.id,
    content: `Performance test event ${i}`,
    occurredAt: new Date(),
  });
}

// Monitor queue stats
const interval = setInterval(async () => {
  const stats = await getQueueStats();
  console.log('Pending:', stats.pending, 'Processing:', stats.processing);
}, 5000);

// Wait and cleanup
setTimeout(() => clearInterval(interval), 60000);
```

### 8.2 Memory Usage

```bash
# Monitor during heavy load
node --expose-gc -e "
  const used = process.memoryUsage();
  console.log('Heap used:', Math.round(used.heapUsed / 1024 / 1024), 'MB');
"
```

---

## 9. Monitoring Checklist

After deployment, monitor:

- [ ] WorkerJob table size (should cleanup old completed jobs)
- [ ] DEAD_LETTER count (should be low)
- [ ] Average job processing time
- [ ] Error rates in logs
- [ ] UOM suggestion acceptance rate

### Database Queries for Monitoring

```sql
-- Job status distribution
SELECT status, COUNT(*) FROM "WorkerJob" GROUP BY status;

-- Failed jobs in last 24h
SELECT type, "lastError", "createdAt"
FROM "WorkerJob"
WHERE status = 'DEAD_LETTER'
AND "createdAt" > NOW() - INTERVAL '24 hours';

-- Average processing time by type
SELECT type,
  AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt"))) as avg_seconds
FROM "WorkerJob"
WHERE status = 'COMPLETED'
AND "completedAt" IS NOT NULL
GROUP BY type;

-- Pending suggestions by user
SELECT "userId", COUNT(*) as pending_count
FROM "UOMUpdateSuggestion"
WHERE status = 'PENDING'
GROUP BY "userId";
```

---

## 10. Rollback Procedure

If critical issues are found:

### 10.1 Disable Queue Worker

```typescript
// In jobs.ts, comment out:
// startWorker();

// Or set environment variable:
// DISABLE_QUEUE_WORKER=true
```

### 10.2 Revert to setImmediate

```typescript
// In create-event.ts, revert to:
setImmediate(() => {
  processNewEvent(event.id).catch(console.error);
});
```

### 10.3 Keep Schema

The new tables/columns are harmless when unused. No need to revert migrations.

---

## Summary Checklist

### Phase 1: Queue Infrastructure
- [ ] WorkerJob table exists with indexes
- [ ] Enqueue creates jobs
- [ ] Idempotency prevents duplicates
- [ ] Worker polls and processes
- [ ] Stuck job recovery works

### Phase 2: Daily Flow Integration
- [ ] Client can create events via `createEventWithProcessing()`
- [ ] Handler chains to DETECT_PATTERNS
- [ ] Handler chains to GENERATE_INSIGHTS
- [ ] Review cron enqueues GENERATE_REVIEW

### Phase 3: Tomorrow Planner
- [ ] Context retrieval works
- [ ] Plan generation succeeds
- [ ] Focus areas reference patterns
- [ ] Idempotency works

### Phase 4: UOM Suggestion
- [ ] Context retrieval works
- [ ] Cooldown enforced
- [ ] Suggestion generated when appropriate
- [ ] Evidence references included

### Phase 5: Client Integration
- [ ] `createEventWithProcessing()` works
- [ ] `getJobStatus()` works
- [ ] `getPendingUOMSuggestions()` works
- [ ] `acceptUOMSuggestion()` updates baseline
- [ ] `rejectUOMSuggestion()` works
- [ ] `ignoreUOMSuggestion()` works

### E2E Flow
- [ ] Full chain event → UOM suggestion
- [ ] Client helper functions work
- [ ] Error handling correct
- [ ] Performance acceptable

---

## Sign-off

| Phase | Tester | Date | Status |
|-------|--------|------|--------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |

**MVP Ready:** [ ] Yes / [ ] No

**Notes:**
