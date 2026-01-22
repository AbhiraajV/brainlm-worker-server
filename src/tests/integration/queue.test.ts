/**
 * Queue Infrastructure Integration Tests
 *
 * Run: npx ts-node src/tests/integration/queue.test.ts
 */

import prisma from '../../prisma';
import {
  enqueueInterpretEvent,
  enqueueDetectPatterns,
  enqueueGenerateReview,
  enqueueGenerateTomorrowPlan,
  enqueueSuggestUOMUpdate,
  getQueueStats,
  recoverStuckJobs,
  cleanupOldJobs,
} from '../../queue';
import { JobStatus } from '@prisma/client';

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
  // Clean up test jobs
  await prisma.workerJob.deleteMany({
    where: {
      idempotencyKey: { startsWith: 'test:' },
    },
  });
}

// ============================================================================
// Tests
// ============================================================================

async function testEnqueue(): Promise<void> {
  console.log('\n📋 Test: Enqueue creates job');

  const jobId = await enqueueInterpretEvent(
    { eventId: 'test-event-123' },
    { idempotencyKey: 'test:enqueue:1' }
  );

  assert(!!jobId, 'Job ID returned');
  assert(jobId.length > 10, 'Job ID is valid cuid');

  // Verify job exists
  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
  });

  assert(!!job, 'Job exists in database');
  assert(job?.status === JobStatus.PENDING, 'Job status is PENDING');
  assert(job?.type === 'INTERPRET_EVENT', 'Job type is correct');
}

async function testIdempotency(): Promise<void> {
  console.log('\n📋 Test: Idempotency prevents duplicates');

  const jobId1 = await enqueueInterpretEvent(
    { eventId: 'test-same-event' },
    { idempotencyKey: 'test:idempotency:same' }
  );

  const jobId2 = await enqueueInterpretEvent(
    { eventId: 'test-same-event' },
    { idempotencyKey: 'test:idempotency:same' }
  );

  assert(jobId1 === jobId2, 'Same job ID returned for duplicate');

  // Verify only one job exists
  const count = await prisma.workerJob.count({
    where: { idempotencyKey: 'test:idempotency:same' },
  });

  assert(count === 1, 'Only one job in database');
}

async function testQueueStats(): Promise<void> {
  console.log('\n📋 Test: Queue stats');

  // Create some test jobs
  await enqueueInterpretEvent(
    { eventId: 'test-stats-1' },
    { idempotencyKey: 'test:stats:1' }
  );
  await enqueueInterpretEvent(
    { eventId: 'test-stats-2' },
    { idempotencyKey: 'test:stats:2' }
  );

  const stats = await getQueueStats();

  assert(stats.pending >= 2, `Pending jobs >= 2 (got ${stats.pending})`);
  assert(typeof stats.processing === 'number', 'Processing count is number');
  assert(typeof stats.completed === 'number', 'Completed count is number');
  assert(typeof stats.byType === 'object', 'byType is object');
}

async function testStuckJobRecovery(): Promise<void> {
  console.log('\n📋 Test: Stuck job recovery');

  // Create a "stuck" job (locked 15 minutes ago)
  const stuckJob = await prisma.workerJob.create({
    data: {
      type: 'INTERPRET_EVENT',
      payload: { eventId: 'stuck-test' },
      status: JobStatus.PROCESSING,
      lockedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago
      lockedBy: 'dead-worker-test',
      idempotencyKey: 'test:stuck:1',
    },
  });

  const recovered = await recoverStuckJobs();

  assert(recovered >= 1, `Recovered >= 1 job (got ${recovered})`);

  // Verify job status reset
  const job = await prisma.workerJob.findUnique({
    where: { id: stuckJob.id },
  });

  assert(job?.status === JobStatus.PENDING, 'Job status reset to PENDING');
  assert(job?.lockedAt === null, 'Lock cleared');
  assert(job?.lockedBy === null, 'Worker ID cleared');
}

async function testDelayedJob(): Promise<void> {
  console.log('\n📋 Test: Delayed job');

  const jobId = await enqueueInterpretEvent(
    { eventId: 'test-delayed' },
    {
      idempotencyKey: 'test:delayed:1',
      delayMs: 60000, // 1 minute delay
    }
  );

  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
  });

  const now = new Date();
  const availableAt = job?.availableAt;

  assert(!!availableAt, 'availableAt is set');
  assert(availableAt! > now, 'availableAt is in the future');
}

async function testAllJobTypes(): Promise<void> {
  console.log('\n📋 Test: All job types can be enqueued');

  const jobs = await Promise.all([
    enqueueInterpretEvent(
      { eventId: 'type-test' },
      { idempotencyKey: 'test:type:interpret' }
    ),
    enqueueDetectPatterns(
      { userId: MOCK_USER_ID, triggerEventId: 'test-event', interpretationId: 'test-interp' },
      { idempotencyKey: 'test:type:patterns' }
    ),
    enqueueGenerateReview(
      { userId: MOCK_USER_ID, type: 'DAILY', periodKey: '2024-01-15', timezone: 'UTC' },
      { idempotencyKey: 'test:type:review' }
    ),
    enqueueGenerateTomorrowPlan(
      { userId: MOCK_USER_ID, reviewId: 'test-review', targetDate: '2024-01-16' },
      { idempotencyKey: 'test:type:plan' }
    ),
    enqueueSuggestUOMUpdate(
      { userId: MOCK_USER_ID, dailyPlanId: 'test-plan' },
      { idempotencyKey: 'test:type:uom' }
    ),
  ]);

  assert(jobs.length === 5, 'All 5 job types created');
  assert(jobs.every(id => !!id), 'All jobs have IDs');

  // Verify types
  const createdJobs = await prisma.workerJob.findMany({
    where: { idempotencyKey: { startsWith: 'test:type:' } },
    select: { type: true },
  });

  const types = new Set(createdJobs.map(j => j.type));
  assert(types.has('INTERPRET_EVENT'), 'INTERPRET_EVENT job exists');
  assert(types.has('DETECT_PATTERNS'), 'DETECT_PATTERNS job exists');
  assert(types.has('GENERATE_REVIEW'), 'GENERATE_REVIEW job exists');
  assert(types.has('GENERATE_TOMORROW_PLAN'), 'GENERATE_TOMORROW_PLAN job exists');
  assert(types.has('SUGGEST_UOM_UPDATE'), 'SUGGEST_UOM_UPDATE job exists');
}

async function testJobCleanup(): Promise<void> {
  console.log('\n📋 Test: Old job cleanup');

  // Create an old completed job
  await prisma.workerJob.create({
    data: {
      type: 'INTERPRET_EVENT',
      payload: { eventId: 'old-test' },
      status: JobStatus.COMPLETED,
      completedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
      idempotencyKey: 'test:cleanup:old',
    },
  });

  const deleted = await cleanupOldJobs(7);

  assert(deleted >= 1, `Deleted >= 1 old job (got ${deleted})`);

  // Verify job deleted
  const job = await prisma.workerJob.findUnique({
    where: { idempotencyKey: 'test:cleanup:old' },
  });

  assert(!job, 'Old job was deleted');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🧪 Queue Infrastructure Integration Tests\n');
  console.log('=' .repeat(50));

  try {
    await cleanup();

    await testEnqueue();
    await testIdempotency();
    await testQueueStats();
    await testStuckJobRecovery();
    await testDelayedJob();
    await testAllJobTypes();
    await testJobCleanup();

    await cleanup();

    console.log('\n' + '=' .repeat(50));
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
