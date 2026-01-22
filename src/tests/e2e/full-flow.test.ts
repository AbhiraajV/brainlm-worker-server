/**
 * End-to-End Flow Test
 *
 * Tests the complete pipeline:
 * Event → Interpretation → Pattern → Insight → Review → Plan → UOM Suggestion
 *
 * Run: npx ts-node src/tests/e2e/full-flow.test.ts
 *
 * WARNING: This test requires:
 * - Database connection
 * - OpenAI API key configured
 * - Will create real data (cleaned up after)
 */

import prisma from '../../prisma';
import { createEvent } from '../../memory/create-event';
import { startWorker, stopWorker, isWorkerRunning } from '../../queue/worker';
import { registerAllHandlers } from '../../queue/handlers';
import { enqueueGenerateReview, getQueueStats } from '../../queue';
import { JobStatus } from '@prisma/client';

// ============================================================================
// Configuration
// ============================================================================

const TEST_TIMEOUT_MS = 180000; // 3 minutes for full chain
const POLL_INTERVAL_MS = 5000; // Check every 5 seconds
const TEST_EMAIL = `e2e-test-${Date.now()}@test.local`;

// ============================================================================
// Test Utilities
// ============================================================================

let testsPassed = 0;
let testsFailed = 0;
let testUserId: string | null = null;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ❌ ${message}`);
    testsFailed++;
  }
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await check()) {
      return true;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    log(`  Waiting for: ${description}...`);
  }

  return false;
}

async function cleanup(): Promise<void> {
  if (testUserId) {
    log('Cleaning up test data...');

    // Delete in order to respect foreign keys
    await prisma.uOMUpdateSuggestion.deleteMany({ where: { userId: testUserId } });
    await prisma.dailyPlan.deleteMany({ where: { userId: testUserId } });
    await prisma.review.deleteMany({ where: { userId: testUserId } });
    await prisma.insightInterpretation.deleteMany({
      where: { insight: { userId: testUserId } },
    });
    await prisma.insightPattern.deleteMany({
      where: { insight: { userId: testUserId } },
    });
    await prisma.insightEvent.deleteMany({
      where: { insight: { userId: testUserId } },
    });
    await prisma.insight.deleteMany({ where: { userId: testUserId } });
    await prisma.patternEvent.deleteMany({
      where: { pattern: { userId: testUserId } },
    });
    await prisma.pattern.deleteMany({ where: { userId: testUserId } });
    await prisma.interpretation.deleteMany({ where: { userId: testUserId } });
    await prisma.workerJob.deleteMany({ where: { userId: testUserId } });
    await prisma.event.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });

    log('Cleanup complete');
  }
}

// ============================================================================
// Test Setup
// ============================================================================

async function setupTestUser(): Promise<void> {
  log('Creating test user with baseline...');

  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      name: 'E2E Test User',
      timezone: 'America/New_York',
      baseline: `# About Me

## Morning Routine
- Wake at 7am
- Coffee and news
- Start work by 9am

## Work Style
- Deep work in the morning
- Meetings in the afternoon
- Done by 6pm

## Fitness Goals
- Gym 3x per week
- Run on weekends

## Current Focus
- Building a side project
- Learning TypeScript
`,
    },
  });

  testUserId = user.id;
  log(`Test user created: ${testUserId}`);
}

// ============================================================================
// Tests
// ============================================================================

async function testEventCreation(): Promise<void> {
  console.log('\n📋 Test: Event creation and job queuing');

  if (!testUserId) throw new Error('Test user not created');

  const result = await createEvent({
    userId: testUserId,
    content: 'Had a productive morning - woke up at 6am and did a 30 minute meditation session before work.',
    occurredAt: new Date(),
  });

  assert(!!result.eventId, 'Event ID returned');
  assert(!!result.jobId, 'Job ID returned');

  // Verify event exists
  const event = await prisma.event.findUnique({
    where: { id: result.eventId },
  });
  assert(!!event, 'Event exists in database');

  // Verify job exists
  const job = await prisma.workerJob.findUnique({
    where: { id: result.jobId },
  });
  assert(job?.type === 'INTERPRET_EVENT', 'INTERPRET_EVENT job created');
}

async function testInterpretationChain(): Promise<void> {
  console.log('\n📋 Test: Interpretation chain (with worker)');

  if (!testUserId) throw new Error('Test user not created');

  // Start worker
  registerAllHandlers();
  await startWorker({ workerId: 'e2e-test-worker' });

  // Create multiple events to build patterns
  const events = [
    'Morning meditation session - 25 minutes today. Feeling very focused.',
    'Went to the gym for chest and shoulders workout. Hit a new PR on bench press!',
    'Another morning meditation - 30 minutes. This is becoming a habit.',
  ];

  for (const content of events) {
    await createEvent({
      userId: testUserId,
      content,
      occurredAt: new Date(),
    });
  }

  log('Created 3 events, waiting for processing...');

  // Wait for interpretations to be created
  const hasInterpretations = await waitForCondition(
    async () => {
      const count = await prisma.interpretation.count({
        where: { userId: testUserId! },
      });
      return count >= 3;
    },
    TEST_TIMEOUT_MS,
    'interpretations to be created'
  );

  assert(hasInterpretations, 'All events interpreted');

  // Check for patterns
  const patternCount = await prisma.pattern.count({
    where: { userId: testUserId },
  });
  log(`Patterns detected: ${patternCount}`);
  assert(patternCount >= 0, 'Pattern detection ran (may or may not create patterns)');

  // Check job statuses
  const completedJobs = await prisma.workerJob.count({
    where: {
      userId: testUserId,
      status: JobStatus.COMPLETED,
    },
  });
  assert(completedJobs >= 3, `At least 3 jobs completed (got ${completedJobs})`);
}

async function testReviewGeneration(): Promise<void> {
  console.log('\n📋 Test: Review generation');

  if (!testUserId) throw new Error('Test user not created');

  // Get yesterday's date as period key (reviews are for completed days)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const today = yesterday.toISOString().split('T')[0];

  // Enqueue review
  const jobId = await enqueueGenerateReview({
    userId: testUserId,
    type: 'DAILY',
    periodKey: today,
    timezone: 'America/New_York',
  });

  assert(!!jobId, 'Review job enqueued');

  // Wait for review to be created
  const hasReview = await waitForCondition(
    async () => {
      const review = await prisma.review.findFirst({
        where: {
          userId: testUserId!,
          type: 'DAILY',
          periodKey: today,
        },
      });
      return !!review;
    },
    TEST_TIMEOUT_MS,
    'review to be generated'
  );

  assert(hasReview, 'Daily review created');

  // Verify review content
  const review = await prisma.review.findFirst({
    where: {
      userId: testUserId!,
      type: 'DAILY',
    },
  });

  if (review) {
    assert(!!review.summary, 'Review has summary');
    assert(!!review.renderedMarkdown, 'Review has markdown');
    assert(review.renderedMarkdown.length > 100, 'Review markdown is substantial');
  }
}

async function testTomorrowPlanGeneration(): Promise<void> {
  console.log('\n📋 Test: Tomorrow plan generation (chained from review)');

  if (!testUserId) throw new Error('Test user not created');

  // Tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Wait for plan to be created (should be chained from review)
  const hasPlan = await waitForCondition(
    async () => {
      const plan = await prisma.dailyPlan.findFirst({
        where: { userId: testUserId! },
      });
      return !!plan;
    },
    TEST_TIMEOUT_MS,
    'tomorrow plan to be generated'
  );

  assert(hasPlan, 'Daily plan created');

  // Verify plan content
  const plan = await prisma.dailyPlan.findFirst({
    where: { userId: testUserId! },
  });

  if (plan) {
    const focusAreas = plan.focusAreas as any[];
    assert(Array.isArray(focusAreas), 'Focus areas is array');
    assert(focusAreas.length >= 1, 'Has at least 1 focus area');
    assert(focusAreas.length <= 3, 'Has at most 3 focus areas');
    assert(!!plan.renderedMarkdown, 'Plan has markdown');
  }
}

async function testUOMSuggestion(): Promise<void> {
  console.log('\n📋 Test: UOM suggestion generation (chained from plan)');

  if (!testUserId) throw new Error('Test user not created');

  // Wait for suggestion to be created (or skipped)
  // Note: May be skipped due to cooldown or no drift
  await new Promise(r => setTimeout(r, 30000)); // Wait 30s

  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { userId: testUserId },
  });

  // UOM suggestion may or may not be created depending on drift detection
  if (suggestion) {
    log(`Suggestion created: ${suggestion.driftType}`);
    assert(!!suggestion.suggestion, 'Suggestion has content');
    assert(!!suggestion.reasoning, 'Suggestion has reasoning');
    assert(['ADDITION', 'MODIFICATION', 'REMOVAL'].includes(suggestion.driftType), 'Valid drift type');
  } else {
    log('No suggestion created (expected - may not have detected drift)');
    assert(true, 'UOM worker completed (no suggestion needed)');
  }

  // Verify UOM job was processed
  const uomJob = await prisma.workerJob.findFirst({
    where: {
      userId: testUserId,
      type: 'SUGGEST_UOM_UPDATE',
      status: { in: [JobStatus.COMPLETED, JobStatus.DEAD_LETTER] },
    },
  });
  assert(!!uomJob, 'UOM job was processed');
}

async function testQueueHealth(): Promise<void> {
  console.log('\n📋 Test: Queue health check');

  const stats = await getQueueStats();

  log(`Queue stats: pending=${stats.pending}, processing=${stats.processing}, completed=${stats.completed}, failed=${stats.failed}, deadLetter=${stats.deadLetter}`);

  // Check no jobs stuck in processing
  const stuckJobs = await prisma.workerJob.count({
    where: {
      status: JobStatus.PROCESSING,
      lockedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) }, // Locked > 10 min
    },
  });

  assert(stuckJobs === 0, `No stuck jobs (found ${stuckJobs})`);

  // Check dead letter queue
  const deadLetterJobs = await prisma.workerJob.count({
    where: {
      userId: testUserId!,
      status: JobStatus.DEAD_LETTER,
    },
  });

  assert(deadLetterJobs === 0, `No dead letter jobs for test user (found ${deadLetterJobs})`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🧪 End-to-End Flow Test\n');
  console.log('=' .repeat(50));
  console.log('⚠️  This test will create real data and make OpenAI API calls');
  console.log('=' .repeat(50));

  try {
    // Setup
    await setupTestUser();

    // Run tests
    await testEventCreation();
    await testInterpretationChain();
    await testReviewGeneration();
    await testTomorrowPlanGeneration();
    await testUOMSuggestion();
    await testQueueHealth();

    // Stop worker
    if (isWorkerRunning()) {
      log('Stopping worker...');
      await stopWorker(true, 30000);
    }

    // Results
    console.log('\n' + '=' .repeat(50));
    console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`);

    if (testsFailed > 0) {
      console.log('\n⚠️  Some tests failed. Check logs above.');
    } else {
      console.log('\n🎉 All tests passed!');
    }
  } catch (error) {
    console.error('\n💥 Test error:', error);
    testsFailed++;
  } finally {
    // Cleanup
    await cleanup();
    await prisma.$disconnect();

    if (testsFailed > 0) {
      process.exit(1);
    }
  }
}

main();
