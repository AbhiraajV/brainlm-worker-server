# BrainLM MVP Implementation Plan - Overview

## Executive Summary

This document series provides a comprehensive, step-by-step implementation guide for completing the BrainLM MVP. The work is divided into **5 ordered phases** that must be implemented sequentially due to dependencies.

> **IMPORTANT: No REST APIs Required**
>
> All data manipulation is done via Prisma directly from the Next.js client. The server only runs background workers. There are no REST API endpoints to implement.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS CLIENT                               │
│                                                                     │
│  - Uses Prisma directly for all data operations                     │
│  - Creates events via Prisma + enqueues jobs                        │
│  - Reads reviews, plans, suggestions directly from DB               │
│  - Accepts/rejects UOM suggestions via direct Prisma calls          │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ Prisma (shared database)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        POSTGRESQL DATABASE                          │
│                                                                     │
│  Tables: User, Event, Interpretation, Pattern, Insight,             │
│          Review, DailyPlan, UOMUpdateSuggestion, WorkerJob          │
└─────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ Prisma (polling WorkerJob table)
                                │
┌─────────────────────────────────────────────────────────────────────┐
│                        WORKER SERVER                                │
│                                                                     │
│  - Polls WorkerJob table for pending jobs                           │
│  - Processes jobs (LLM calls, embeddings, etc.)                     │
│  - Chains jobs by creating new WorkerJob records                    │
│  - Runs review cron (schedules daily/weekly/monthly reviews)        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Current State (Already Working)

| Component | Location | Status |
|-----------|----------|--------|
| Interpretation Worker | `/src/workers/interpretation/` | ✅ Working |
| Pattern Detection Worker | `/src/workers/pattern/` | ✅ Working |
| Insight Generation Worker | `/src/workers/insight/` | ✅ Working |
| Review Generation (Daily/Weekly/Monthly) | `/src/workers/review/` | ✅ Working |
| Pipeline Orchestration | `/src/pipeline/pipeline.ts` | ✅ Working (uses `setImmediate`) |
| Review Cron | `/src/jobs/review-cron.ts` | ⚠️ **NEEDS OVERHAUL** (see Phase 2) |

---

## What's Been Started (Partial Implementation)

### ✅ COMPLETED: Prisma Schema Updates

**File:** `/prisma/schema.prisma`

The following has been added:

1. **New Enums:**
   - `JobStatus` (PENDING, PROCESSING, COMPLETED, FAILED, DEAD_LETTER)
   - `JobType` (INTERPRET_EVENT, DETECT_PATTERNS, GENERATE_INSIGHTS, GENERATE_REVIEW, GENERATE_TOMORROW_PLAN, SUGGEST_UOM_UPDATE)
   - `UOMSuggestionStatus` (PENDING, ACCEPTED, REJECTED, IGNORED, EXPIRED)
   - `UOMDriftType` (ADDITION, MODIFICATION, REMOVAL)

2. **Updated User Model:**
   - Added `lastBaselineUpdate DateTime?`
   - Added `nextDailyReviewDue DateTime?` (for robust scheduling)
   - Added `nextWeeklyReviewDue DateTime?` (for robust scheduling)
   - Added `nextMonthlyReviewDue DateTime?` (for robust scheduling)
   - Added relations: `dailyPlans`, `uomSuggestions`, `workerJobs`
   - Added indexes on `nextDailyReviewDue`, `nextWeeklyReviewDue`, `nextMonthlyReviewDue`

3. **New Models:**
   - `WorkerJob` - Full job queue model with all fields
   - `DailyPlan` - Tomorrow planner output storage
   - `UOMUpdateSuggestion` - UOM drift suggestions

4. **Updated Review Model:**
   - Added `dailyPlan DailyPlan?` relation

### ✅ COMPLETED: Queue Types

**File:** `/src/queue/types.ts`

Contains all TypeScript type definitions for the queue system:
- Job payload types for each job type
- `EnqueueOptions` interface
- `JobResult` interface
- `JobHandler` type
- `WorkerConfig` interface
- `QueueStats` interface

---

## Missing Components (To Be Implemented)

| Phase | Component | Document |
|-------|-----------|----------|
| 1 | Queue Infrastructure | `01-queue-infrastructure.md` |
| 2 | Daily Flow Integration | `02-daily-flow-integration.md` |
| 3 | Tomorrow Planner Worker | `03-tomorrow-planner-worker.md` |
| 4 | UOM Suggestion Worker | `04-uom-suggestion-worker.md` |
| 5 | Verification & Testing | `05-verification-checklist.md` |

> **Note:** Phase 5 (UOM Management API) has been removed. All UOM operations are performed directly via Prisma from the Next.js client.

---

## Dependency Graph

```
Phase 1: Queue Infrastructure
    │
    ├── Required by ALL subsequent phases
    │
    ▼
Phase 2: Daily Flow Integration
    │
    ├── Connects existing workers to queue
    ├── Enables event-triggered job chaining
    │
    ▼
Phase 3: Tomorrow Planner Worker
    │
    ├── Depends on: Review Worker (existing)
    ├── Triggers: UOM Suggestion Worker
    │
    ▼
Phase 4: UOM Suggestion Worker
    │
    ├── Depends on: Tomorrow Planner
    ├── Produces: UOMUpdateSuggestion records
    │
    ▼
Phase 5: Verification
    │
    └── End-to-end testing of complete flow
```

---

## How Next.js Client Triggers Flows

The Next.js client interacts with the system by:

1. **Creating events** → Inserts `Event` record + `WorkerJob` record
2. **Reading results** → Queries `Review`, `DailyPlan`, `UOMUpdateSuggestion` tables
3. **Managing UOM suggestions** → Updates `UOMUpdateSuggestion.status` and `User.baseline` directly

### Client-Side Queue Helpers

The client will import queue helper functions to create jobs. See `02-daily-flow-integration.md` for the complete client interface.

```typescript
// Example: Client creates an event and triggers the processing chain
import { createEventWithProcessing } from '@/lib/queue-client';

const { eventId, jobId } = await createEventWithProcessing({
  userId: user.id,
  content: 'Had a productive morning...',
  occurredAt: new Date(),
});
```

---

## Data Flow After Implementation

```
┌─────────────────┐
│  NEXT.JS CLIENT │
│  creates Event  │
│  + WorkerJob    │
└────────┬────────┘
         │ (Prisma insert)
         ▼
┌─────────────────┐
│  WorkerJob      │
│  INTERPRET_EVENT│
│  status=PENDING │
└────────┬────────┘
         │ (Worker polls & processes)
         ▼
┌─────────────────┐
│  Interpretation │
│  Worker         │
│  → creates new  │
│    WorkerJob    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  WorkerJob      │
│  DETECT_PATTERNS│
└────────┬────────┘
         │
         ▼
    ... continues through chain ...
         │
         ▼
┌─────────────────┐
│  UOMUpdateSuggestion │
│  (stored in DB)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  NEXT.JS CLIENT │
│  reads & manages│
│  suggestions    │
└─────────────────┘
```

---

## File Structure After Implementation

```
/src/
├── queue/                          # Phase 1
│   ├── index.ts                    # Public exports
│   ├── types.ts                    # ✅ DONE - Type definitions
│   ├── queue.service.ts            # Core enqueue/dequeue
│   ├── worker.ts                   # Polling loop
│   └── handlers.ts                 # Job type → handler mapping
│
├── workers/
│   ├── interpretation/             # ✅ EXISTS
│   ├── pattern/                    # ✅ EXISTS
│   ├── insight/                    # ✅ EXISTS
│   ├── review/                     # ✅ EXISTS
│   ├── tomorrow-plan/              # Phase 3
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   ├── data-retrieval.ts
│   │   ├── generate-plan.ts
│   │   └── prompt.ts
│   └── uom-suggestion/             # Phase 4
│       ├── index.ts
│       ├── schema.ts
│       ├── data-retrieval.ts
│       └── detect-drift.ts
│
├── memory/
│   └── create-event.ts             # Phase 2 - Modify (exports client helper)
│
├── pipeline/
│   └── pipeline.ts                 # Phase 2 - Keep for reference
│
└── jobs.ts                         # Phase 2 - Modify
```

---

## Technology Decisions

| Need | Decision | Rationale |
|------|----------|-----------|
| Job Queue | Hand-rolled Postgres | Low volume (<1 job/sec), Supabase pooling limits pg-boss, full control |
| Date Handling | `date-fns` or native | Already established in codebase |
| UUID Generation | `cuid()` via Prisma | Existing pattern |
| Validation | `zod` | Already used throughout |
| Concurrency Control | `p-limit` | Already installed |
| Polling | `FOR UPDATE SKIP LOCKED` | Safe concurrent access, no external deps |
| Client-Server | Shared Prisma schema | No REST APIs needed |

---

## Critical Implementation Patterns

### 1. Worker Pattern (Follow Existing)
Reference: `/src/workers/review/generate-review.ts`

```typescript
// Standard worker structure:
export async function workerFunction(input: InputType): Promise<OutputType> {
  // 1. Validate input
  // 2. Check idempotency (already done?)
  // 3. Fetch required data
  // 4. Build LLM message
  // 5. Call OpenAI with json_object response
  // 6. Validate with Zod
  // 7. Embed result if needed
  // 8. Store in transaction
  // 9. Return structured result
}
```

### 2. LLM Call Pattern
```typescript
const completion = await openai.chat.completions.create({
  model: modelConfig.model,
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(userData) }
  ],
  temperature: modelConfig.temperature,
  max_tokens: modelConfig.maxTokens,
  response_format: { type: 'json_object' }
});

const parsed = JSON.parse(completion.choices[0].message.content!);
const validated = OutputSchema.safeParse(parsed);
```

### 3. Client Enqueue Pattern
```typescript
// Client creates job via Prisma (no API call)
import prisma from '@/lib/prisma';

const job = await prisma.workerJob.create({
  data: {
    type: 'INTERPRET_EVENT',
    payload: { eventId },
    status: 'PENDING',
    userId,
    idempotencyKey: `interpret:${eventId}`,
  },
});
```

---

## Prompts to Add

All prompts go in `/src/prompts.ts` following the `PromptConfig` pattern:

| Phase | Prompt Name | Model | Temperature |
|-------|-------------|-------|-------------|
| 3 | `TOMORROW_PLAN_PROMPT` | gpt-4o-mini | 0.4 |
| 4 | `UOM_SUGGESTION_PROMPT` | gpt-4o | 0.2 |

---

## Pre-Implementation Checklist

Before starting any phase:

- [ ] Run `npx prisma generate` (schema is already updated)
- [ ] Run `npx prisma migrate dev --name add_queue_and_planning_tables`
- [ ] Verify migration succeeded
- [ ] Run existing tests to ensure no regressions

---

## Post-Implementation Checklist

After completing all phases:

- [ ] All existing tests pass
- [ ] New integration tests pass
- [ ] Manual E2E flow works
- [ ] Queue worker starts without errors
- [ ] Stuck job recovery works
- [ ] Idempotency prevents duplicates
- [ ] Client can create events and trigger flows
- [ ] Client can read and manage UOM suggestions

---

## Next Steps

1. **Read `01-queue-infrastructure.md`** for Phase 1 details
2. **Ask Claude to implement Phase 1** when ready
3. **Verify Phase 1** before moving to Phase 2
4. **Continue sequentially** through all phases
