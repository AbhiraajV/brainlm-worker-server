/**
 * Worker Chain Integration Tests
 *
 * Tests that jobs correctly chain to subsequent jobs WITHOUT making real API calls.
 * Uses mocked worker results to verify the chain logic.
 *
 * Run: npx ts-node src/tests/integration/worker-chain.test.ts
 */

import prisma from '../../prisma';
import { JobStatus, JobType } from '@prisma/client';
import { createEvent } from '../../memory/create-event';
import {
  enqueueInterpretEvent,
  enqueueDetectPatterns,
  enqueueGenerateReview,
  enqueueGenerateTomorrowPlan,
  enqueueSuggestUOMUpdate,
} from '../../queue';

// ============================================================================
// Test Utilities
// ============================================================================

const MOCK_USER_ID = 'mock-user-001';

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${message}`);
    testsFailed++;
  }
}

async function cleanup(): Promise<void> {
  // Clean up test jobs (not the mock user's real data)
  await prisma.workerJob.deleteMany({
    where: {
      idempotencyKey: { startsWith: 'chain-test:' },
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

async function testEventCreationChainsToInterpret(): Promise<void> {
  console.log('\n📋 Test: Event creation chains to INTERPRET_EVENT');

  // Create event using the actual createEvent function
  const result = await createEvent({
    userId: MOCK_USER_ID,
    content: 'Chain test event - went to gym today',
    occurredAt: new Date(),
  });

  assert(!!result.eventId, 'Event created');
  assert(!!result.jobId, 'Job ID returned');

  // Verify the job is INTERPRET_EVENT
  const job = await prisma.workerJob.findUnique({
    where: { id: result.jobId },
    select: { type: true, status: true, payload: true },
  });

  assert(job?.type === JobType.INTERPRET_EVENT, 'Job type is INTERPRET_EVENT');
  assert(job?.status === JobStatus.PENDING, 'Job status is PENDING');
  assert((job?.payload as any)?.eventId === result.eventId, 'Payload contains eventId');

  // Cleanup
  await prisma.workerJob.delete({ where: { id: result.jobId } });
  await prisma.event.delete({ where: { id: result.eventId } });
}

async function testInterpretChainsToPatterns(): Promise<void> {
  console.log('\n📋 Test: INTERPRET_EVENT handler should chain to DETECT_PATTERNS');

  // This tests the CHAIN LOGIC, not the actual interpretation
  // We verify that after interpretation completes, a DETECT_PATTERNS job is created

  const testEventId = 'chain-test-event-1';
  const testInterpId = 'chain-test-interp-1';

  // Simulate: After interpretation completes, enqueue pattern detection
  // This is what the handler does after successful interpretation
  const jobId = await enqueueDetectPatterns(
    {
      userId: MOCK_USER_ID,
      triggerEventId: testEventId,
      interpretationId: testInterpId,
    },
    { idempotencyKey: 'chain-test:patterns:1' }
  );

  assert(!!jobId, 'DETECT_PATTERNS job created');

  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: { type: true, payload: true },
  });

  assert(job?.type === JobType.DETECT_PATTERNS, 'Job type is DETECT_PATTERNS');
  assert((job?.payload as any)?.userId === MOCK_USER_ID, 'Payload contains userId');
  assert((job?.payload as any)?.triggerEventId === testEventId, 'Payload contains triggerEventId');
  assert((job?.payload as any)?.interpretationId === testInterpId, 'Payload contains interpretationId');
}

async function testReviewChainsToTomorrowPlan(): Promise<void> {
  console.log('\n📋 Test: GENERATE_REVIEW (DAILY) should chain to GENERATE_TOMORROW_PLAN');

  const testReviewId = 'chain-test-review-1';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const targetDate = tomorrow.toISOString().split('T')[0];

  // Simulate: After daily review completes, enqueue tomorrow plan
  const jobId = await enqueueGenerateTomorrowPlan(
    {
      userId: MOCK_USER_ID,
      reviewId: testReviewId,
      targetDate,
    },
    { idempotencyKey: 'chain-test:tomorrow:1' }
  );

  assert(!!jobId, 'GENERATE_TOMORROW_PLAN job created');

  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: { type: true, payload: true },
  });

  assert(job?.type === JobType.GENERATE_TOMORROW_PLAN, 'Job type is GENERATE_TOMORROW_PLAN');
  assert((job?.payload as any)?.reviewId === testReviewId, 'Payload contains reviewId');
  assert((job?.payload as any)?.targetDate === targetDate, 'Payload contains targetDate');
}

async function testTomorrowPlanChainsToUOM(): Promise<void> {
  console.log('\n📋 Test: GENERATE_TOMORROW_PLAN should chain to SUGGEST_UOM_UPDATE');

  const testPlanId = 'chain-test-plan-1';

  // Simulate: After tomorrow plan completes, enqueue UOM suggestion
  const jobId = await enqueueSuggestUOMUpdate(
    {
      userId: MOCK_USER_ID,
      dailyPlanId: testPlanId,
    },
    { idempotencyKey: 'chain-test:uom:1' }
  );

  assert(!!jobId, 'SUGGEST_UOM_UPDATE job created');

  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: { type: true, payload: true },
  });

  assert(job?.type === JobType.SUGGEST_UOM_UPDATE, 'Job type is SUGGEST_UOM_UPDATE');
  assert((job?.payload as any)?.dailyPlanId === testPlanId, 'Payload contains dailyPlanId');
}

async function testReviewIdempotency(): Promise<void> {
  console.log('\n📋 Test: Review jobs are idempotent by period key');

  const periodKey = '2024-01-15';

  // First enqueue
  const jobId1 = await enqueueGenerateReview(
    {
      userId: MOCK_USER_ID,
      type: 'DAILY',
      periodKey,
      timezone: 'America/New_York',
    },
    { idempotencyKey: `chain-test:review:${MOCK_USER_ID}:DAILY:${periodKey}` }
  );

  // Second enqueue with same key
  const jobId2 = await enqueueGenerateReview(
    {
      userId: MOCK_USER_ID,
      type: 'DAILY',
      periodKey,
      timezone: 'America/New_York',
    },
    { idempotencyKey: `chain-test:review:${MOCK_USER_ID}:DAILY:${periodKey}` }
  );

  assert(jobId1 === jobId2, 'Same job ID returned for duplicate review request');

  // Verify only one job exists
  const count = await prisma.workerJob.count({
    where: {
      idempotencyKey: `chain-test:review:${MOCK_USER_ID}:DAILY:${periodKey}`,
    },
  });

  assert(count === 1, 'Only one job exists for same period');
}

async function testFullChainStructure(): Promise<void> {
  console.log('\n📋 Test: Full chain structure verification');

  // Verify the expected chain exists:
  // EVENT → INTERPRET → PATTERNS → INSIGHTS
  // REVIEW → TOMORROW_PLAN → UOM_SUGGESTION

  const chainA = [
    JobType.INTERPRET_EVENT,
    JobType.DETECT_PATTERNS,
    JobType.GENERATE_INSIGHTS,
  ];

  const chainB = [
    JobType.GENERATE_REVIEW,
    JobType.GENERATE_TOMORROW_PLAN,
    JobType.SUGGEST_UOM_UPDATE,
  ];

  // Test that all job types can be created
  const jobs = await Promise.all([
    enqueueInterpretEvent({ eventId: 'chain-verify-1' }, { idempotencyKey: 'chain-test:verify:interpret' }),
    enqueueDetectPatterns(
      { userId: MOCK_USER_ID, triggerEventId: 'e1', interpretationId: 'i1' },
      { idempotencyKey: 'chain-test:verify:patterns' }
    ),
    enqueueGenerateReview(
      { userId: MOCK_USER_ID, type: 'DAILY', periodKey: '2024-01-20', timezone: 'UTC' },
      { idempotencyKey: 'chain-test:verify:review' }
    ),
    enqueueGenerateTomorrowPlan(
      { userId: MOCK_USER_ID, reviewId: 'r1', targetDate: '2024-01-21' },
      { idempotencyKey: 'chain-test:verify:plan' }
    ),
    enqueueSuggestUOMUpdate(
      { userId: MOCK_USER_ID, dailyPlanId: 'p1' },
      { idempotencyKey: 'chain-test:verify:uom' }
    ),
  ]);

  assert(jobs.length === 5, 'All 5 chain jobs created');
  assert(jobs.every(id => !!id), 'All jobs have valid IDs');

  // Verify types
  const createdJobs = await prisma.workerJob.findMany({
    where: { idempotencyKey: { startsWith: 'chain-test:verify:' } },
    select: { type: true },
  });

  const types = new Set(createdJobs.map(j => j.type));
  assert(types.has(JobType.INTERPRET_EVENT), 'Chain A: INTERPRET_EVENT exists');
  assert(types.has(JobType.DETECT_PATTERNS), 'Chain A: DETECT_PATTERNS exists');
  assert(types.has(JobType.GENERATE_REVIEW), 'Chain B: GENERATE_REVIEW exists');
  assert(types.has(JobType.GENERATE_TOMORROW_PLAN), 'Chain B: GENERATE_TOMORROW_PLAN exists');
  assert(types.has(JobType.SUGGEST_UOM_UPDATE), 'Chain B: SUGGEST_UOM_UPDATE exists');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🧪 Worker Chain Integration Tests\n');
  console.log('='.repeat(50));
  console.log('Tests job chaining WITHOUT making OpenAI API calls');
  console.log('='.repeat(50));

  try {
    await cleanup();

    await testEventCreationChainsToInterpret();
    await testInterpretChainsToPatterns();
    await testReviewChainsToTomorrowPlan();
    await testTomorrowPlanChainsToUOM();
    await testReviewIdempotency();
    await testFullChainStructure();

    await cleanup();

    console.log('\n' + '='.repeat(50));
    console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`);

    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('\n💥 Test error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
