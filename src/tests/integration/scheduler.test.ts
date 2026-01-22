/**
 * Review Scheduler Tests
 *
 * Tests the cron/scheduler logic for review generation WITHOUT making API calls.
 * Verifies due time calculations, timezone handling, and scheduling logic.
 *
 * Run: npx ts-node src/tests/integration/scheduler.test.ts
 */

import prisma from '../../prisma';
import { JobStatus, JobType } from '@prisma/client';
import {
  startOfDay,
  addDays,
  subDays,
  startOfWeek,
  addWeeks,
  startOfMonth,
  addMonths,
  format,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

// ============================================================================
// Test Utilities
// ============================================================================

let testsPassed = 0;
let testsFailed = 0;
let testUserId: string | null = null;

const TEST_EMAIL = `scheduler-test-${Date.now()}@test.local`;

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
  if (testUserId) {
    await prisma.workerJob.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
  }
}

// ============================================================================
// Due Time Calculation Functions (copied from scheduler for testing)
// ============================================================================

function computeNextDailyReviewDue(userTimezone: string, fromDate: Date = new Date()): Date {
  // Get current time in user's timezone
  const userNow = toZonedTime(fromDate, userTimezone);

  // Next midnight in user's timezone = start of tomorrow
  const tomorrowStart = startOfDay(addDays(userNow, 1));

  // Convert back to UTC for storage
  return fromZonedTime(tomorrowStart, userTimezone);
}

function computeNextWeeklyReviewDue(userTimezone: string, fromDate: Date = new Date()): Date {
  const userNow = toZonedTime(fromDate, userTimezone);
  const nextMonday = startOfWeek(addWeeks(userNow, 1), { weekStartsOn: 1 });
  return fromZonedTime(nextMonday, userTimezone);
}

function computeNextMonthlyReviewDue(userTimezone: string, fromDate: Date = new Date()): Date {
  const userNow = toZonedTime(fromDate, userTimezone);
  const nextMonth = startOfMonth(addMonths(userNow, 1));
  return fromZonedTime(nextMonth, userTimezone);
}

function getPeriodKey(userLocalDate: Date, type: 'DAILY' | 'WEEKLY' | 'MONTHLY'): string {
  const yesterday = addDays(userLocalDate, -1);

  switch (type) {
    case 'DAILY':
      return format(yesterday, 'yyyy-MM-dd');
    case 'WEEKLY':
      const weekStart = startOfWeek(yesterday, { weekStartsOn: 1 });
      return format(weekStart, "yyyy-'W'ww");
    case 'MONTHLY':
      const monthStart = startOfMonth(yesterday);
      return format(monthStart, 'yyyy-MM');
    default:
      throw new Error(`Unknown review type: ${type}`);
  }
}

// ============================================================================
// Tests
// ============================================================================

async function testDailyDueTimeCalculation(): Promise<void> {
  console.log('\n📋 Test: Daily due time calculation');

  const timezone = 'America/New_York';

  // Create a reference time: Jan 15, 2024 at 10:00 AM in New York
  const referenceTime = new Date('2024-01-15T15:00:00.000Z'); // 10 AM EST

  const nextDue = computeNextDailyReviewDue(timezone, referenceTime);

  // Should be Jan 16, 2024 at midnight in NY = 05:00 UTC
  const expectedUTC = new Date('2024-01-16T05:00:00.000Z');

  assert(
    nextDue.getTime() === expectedUTC.getTime(),
    `Daily due time correct: ${nextDue.toISOString()} === ${expectedUTC.toISOString()}`
  );
}

async function testWeeklyDueTimeCalculation(): Promise<void> {
  console.log('\n📋 Test: Weekly due time calculation');

  const timezone = 'America/New_York';

  // Create a reference time: Wednesday Jan 17, 2024 at 10:00 AM in New York
  const referenceTime = new Date('2024-01-17T15:00:00.000Z'); // 10 AM EST on Wednesday

  const nextDue = computeNextWeeklyReviewDue(timezone, referenceTime);

  // Should be next Monday Jan 22, 2024 at midnight in NY = 05:00 UTC
  const expectedUTC = new Date('2024-01-22T05:00:00.000Z');

  assert(
    nextDue.getTime() === expectedUTC.getTime(),
    `Weekly due time correct: ${nextDue.toISOString()} === ${expectedUTC.toISOString()}`
  );
}

async function testMonthlyDueTimeCalculation(): Promise<void> {
  console.log('\n📋 Test: Monthly due time calculation');

  const timezone = 'America/New_York';

  // Create a reference time: Jan 15, 2024 at 10:00 AM in New York
  const referenceTime = new Date('2024-01-15T15:00:00.000Z');

  const nextDue = computeNextMonthlyReviewDue(timezone, referenceTime);

  // Should be Feb 1, 2024 at midnight in NY = 05:00 UTC
  const expectedUTC = new Date('2024-02-01T05:00:00.000Z');

  assert(
    nextDue.getTime() === expectedUTC.getTime(),
    `Monthly due time correct: ${nextDue.toISOString()} === ${expectedUTC.toISOString()}`
  );
}

async function testPeriodKeyGeneration(): Promise<void> {
  console.log('\n📋 Test: Period key generation');

  // Jan 16, 2024 at midnight local time
  const testDate = new Date('2024-01-16T00:00:00');

  const dailyKey = getPeriodKey(testDate, 'DAILY');
  assert(dailyKey === '2024-01-15', `Daily period key: ${dailyKey} === 2024-01-15`);

  const weeklyKey = getPeriodKey(testDate, 'WEEKLY');
  assert(weeklyKey.startsWith('2024-W'), `Weekly period key format: ${weeklyKey}`);

  const monthlyKey = getPeriodKey(testDate, 'MONTHLY');
  assert(monthlyKey === '2024-01', `Monthly period key: ${monthlyKey} === 2024-01`);
}

async function testUserWithPastDueTime(): Promise<void> {
  console.log('\n📋 Test: User with past due time should be picked up');

  // Create test user with past due time
  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      name: 'Scheduler Test User',
      timezone: 'America/New_York',
      baseline: 'Test baseline',
      nextDailyReviewDue: subDays(new Date(), 1), // Due yesterday
    },
  });
  testUserId = user.id;

  // Query users with past due time (like scheduler would)
  const usersDue = await prisma.user.findMany({
    where: {
      nextDailyReviewDue: {
        lte: new Date(),
        not: null,
      },
    },
    select: { id: true },
  });

  const found = usersDue.some(u => u.id === testUserId);
  assert(found, 'User with past due time is found by scheduler query');
}

async function testUserWithFutureDueTime(): Promise<void> {
  console.log('\n📋 Test: User with future due time should NOT be picked up');

  if (!testUserId) throw new Error('Test user not created');

  // Update user to have future due time
  await prisma.user.update({
    where: { id: testUserId },
    data: {
      nextDailyReviewDue: addDays(new Date(), 1), // Due tomorrow
    },
  });

  // Query users with past due time
  const usersDue = await prisma.user.findMany({
    where: {
      nextDailyReviewDue: {
        lte: new Date(),
        not: null,
      },
    },
    select: { id: true },
  });

  const found = usersDue.some(u => u.id === testUserId);
  assert(!found, 'User with future due time is NOT found by scheduler query');
}

async function testDueTimeUpdateAfterScheduling(): Promise<void> {
  console.log('\n📋 Test: Due time updates correctly after scheduling');

  if (!testUserId) throw new Error('Test user not created');

  const timezone = 'America/New_York';
  const now = new Date();

  // Simulate what scheduler does after enqueuing a review
  const newDueTime = computeNextDailyReviewDue(timezone, now);

  await prisma.user.update({
    where: { id: testUserId },
    data: { nextDailyReviewDue: newDueTime },
  });

  const user = await prisma.user.findUnique({
    where: { id: testUserId },
    select: { nextDailyReviewDue: true },
  });

  assert(!!user?.nextDailyReviewDue, 'Due time is set');
  assert(user?.nextDailyReviewDue ? user.nextDailyReviewDue > now : false, 'Due time is in the future');
}

async function testTimezoneEdgeCases(): Promise<void> {
  console.log('\n📋 Test: Timezone edge cases');

  // Test various timezones
  const timezones = [
    'America/New_York',    // UTC-5/4
    'America/Los_Angeles', // UTC-8/7
    'Europe/London',       // UTC+0/1
    'Asia/Tokyo',          // UTC+9
    'Pacific/Auckland',    // UTC+12/13
  ];

  const now = new Date();

  for (const tz of timezones) {
    const due = computeNextDailyReviewDue(tz, now);
    assert(due > now, `${tz}: Due time (${due.toISOString()}) is after now`);
  }
}

async function testSchedulerIdempotency(): Promise<void> {
  console.log('\n📋 Test: Scheduler creates idempotent jobs');

  if (!testUserId) throw new Error('Test user not created');

  const periodKey = format(subDays(new Date(), 1), 'yyyy-MM-dd');
  const idempotencyKey = `review:${testUserId}:DAILY:${periodKey}`;

  // First job creation
  const job1 = await prisma.workerJob.create({
    data: {
      type: JobType.GENERATE_REVIEW,
      payload: {
        userId: testUserId,
        type: 'DAILY',
        periodKey,
        timezone: 'America/New_York',
      },
      status: JobStatus.PENDING,
      userId: testUserId,
      idempotencyKey,
    },
  });

  assert(!!job1.id, 'First job created');

  // Try to create duplicate (should fail or return existing)
  try {
    await prisma.workerJob.create({
      data: {
        type: JobType.GENERATE_REVIEW,
        payload: {
          userId: testUserId,
          type: 'DAILY',
          periodKey,
          timezone: 'America/New_York',
        },
        status: JobStatus.PENDING,
        userId: testUserId,
        idempotencyKey, // Same key
      },
    });
    assert(false, 'Duplicate job should have been rejected');
  } catch (error: any) {
    assert(
      error.code === 'P2002', // Unique constraint violation
      'Duplicate job rejected with unique constraint violation'
    );
  }

  // Verify only one job exists
  const count = await prisma.workerJob.count({
    where: { idempotencyKey },
  });
  assert(count === 1, 'Only one job exists with this idempotency key');

  // Cleanup
  await prisma.workerJob.delete({ where: { id: job1.id } });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🧪 Review Scheduler Tests\n');
  console.log('='.repeat(50));
  console.log('Tests scheduling logic WITHOUT making OpenAI API calls');
  console.log('='.repeat(50));

  try {
    await cleanup();

    await testDailyDueTimeCalculation();
    await testWeeklyDueTimeCalculation();
    await testMonthlyDueTimeCalculation();
    await testPeriodKeyGeneration();
    await testUserWithPastDueTime();
    await testUserWithFutureDueTime();
    await testDueTimeUpdateAfterScheduling();
    await testTimezoneEdgeCases();
    await testSchedulerIdempotency();

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
