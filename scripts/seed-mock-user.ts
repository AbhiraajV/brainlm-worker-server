/**
 * Seed Mock User Data
 *
 * Creates events and runs the full pipeline for mock-user-001 to seed the database
 * with real data in all tables.
 *
 * WARNING: This makes real OpenAI API calls!
 *
 * Run: npx ts-node scripts/seed-mock-user.ts
 */

import prisma from '../src/prisma';
import { createEvent } from '../src/memory/create-event';
import { startWorker, stopWorker, isWorkerRunning } from '../src/queue/worker';
import { registerAllHandlers } from '../src/queue/handlers';
import { enqueueGenerateReview } from '../src/queue';
import { JobStatus } from '@prisma/client';
import { subDays, format } from 'date-fns';

// ============================================================================
// Configuration
// ============================================================================

const MOCK_USER_ID = 'mock-user-001';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 300000; // 5 minutes max

// Sample events spanning a full week
// Persona: Tech guy, trying to build muscle and lose weight, has a girlfriend, lives with parents
const SAMPLE_EVENTS = [
  // Day 1 (7 days ago) - Monday
  { content: 'Woke up at 6:30am, mom made breakfast. Had eggs and toast, skipped the paratha to cut carbs.', daysAgo: 7 },
  { content: 'Morning gym session before work - chest day. Bench press 70kg x 8, incline dumbbell 22kg x 10. Feeling good about the progressive overload.', daysAgo: 7 },
  { content: 'Long day at work, sprint planning took forever. At least got the microservices PR approved.', daysAgo: 7 },
  { content: 'Called Priya after work, she\'s stressed about her project deadline. Tried to be supportive.', daysAgo: 7 },
  { content: 'Dinner with family - mom made dal and roti. Ate light, around 1800 calories today.', daysAgo: 7 },

  // Day 2 (6 days ago) - Tuesday
  { content: 'Slept poorly, only about 5 hours. Dad was watching TV late again.', daysAgo: 6 },
  { content: 'Skipped morning gym because of sleep, will go evening instead.', daysAgo: 6 },
  { content: 'Work from home today. Debugging that Redis caching issue took most of the day.', daysAgo: 6 },
  { content: 'Evening gym - back and biceps. Deadlift 100kg x 5, barbell rows 50kg x 10. Felt weaker due to poor sleep.', daysAgo: 6 },
  { content: 'Video call with Priya, watched a show together. She seems happier today.', daysAgo: 6 },

  // Day 3 (5 days ago) - Wednesday
  { content: 'Up at 6am, good 7 hours sleep. Morning walk around the colony for 20 mins.', daysAgo: 5 },
  { content: 'Leg day at gym - squats 80kg x 8, leg press 150kg x 12. Legs are going to be sore tomorrow.', daysAgo: 5 },
  { content: 'Had a good code review session, helped the new intern understand our auth flow.', daysAgo: 5 },
  { content: 'Mom asked when I\'m going to "settle down" at dinner. Avoided the conversation. Priya and I aren\'t ready for that.', daysAgo: 5 },
  { content: 'Weighed myself - 82kg. Down 1kg from last week. The deficit is working.', daysAgo: 5 },

  // Day 4 (4 days ago) - Thursday
  { content: 'Morning routine: 6:30am wake up, black coffee, 15 min stretching.', daysAgo: 4 },
  { content: 'Shoulder and arms at gym. OHP 40kg x 8, lateral raises 10kg x 12. Shoulders feeling stronger.', daysAgo: 4 },
  { content: 'Big meeting with the tech lead about the new feature. Got assigned as owner - excited but nervous.', daysAgo: 4 },
  { content: 'Priya came over for dinner. Parents were nice to her. Made it less awkward than last time.', daysAgo: 4 },
  { content: 'Tracked all my food today - hit 160g protein, 1900 calories. Pretty disciplined.', daysAgo: 4 },

  // Day 5 (3 days ago) - Friday
  { content: 'Woke up late, 8am. It\'s Friday so taking it easy on myself.', daysAgo: 3 },
  { content: 'Rest day from weights. Did 30 min on the treadmill, 5km. Trying to increase cardio for fat loss.', daysAgo: 3 },
  { content: 'Deployed the new API endpoint to staging. No major bugs, feels good.', daysAgo: 3 },
  { content: 'Friday night dinner out with Priya. Had butter chicken and naan - definitely over my calories but it\'s once a week.', daysAgo: 3 },
  { content: 'Parents weren\'t happy I came home late. Living at home has its challenges.', daysAgo: 3 },

  // Day 6 (2 days ago) - Saturday
  { content: 'Slept in until 9am. Needed the rest after the work week.', daysAgo: 2 },
  { content: 'Morning gym - push day. Bench 72.5kg x 6 (PR!), dips bodyweight x 12. Getting stronger.', daysAgo: 2 },
  { content: 'Helped dad with some stuff around the house. Nice to spend time with him.', daysAgo: 2 },
  { content: 'Priya and I went to the mall. Did a lot of walking, probably 8k steps.', daysAgo: 2 },
  { content: 'Had a cheat meal - pizza. Enjoyed it guilt-free, back to clean eating tomorrow.', daysAgo: 2 },
  { content: 'Talked to Priya about potentially moving out next year. She\'s supportive but it\'s a big decision.', daysAgo: 2 },

  // Day 7 (yesterday) - Sunday
  { content: 'Lazy Sunday morning. Had a protein shake and watched some YouTube tech videos.', daysAgo: 1 },
  { content: 'Light gym session - pull day. Pull-ups 3x10, lat pulldown 50kg x 12. Active recovery.', daysAgo: 1 },
  { content: 'Meal prepped for the week - grilled chicken, rice, and veggies. Takes 2 hours but saves so much time.', daysAgo: 1 },
  { content: 'Family lunch - everyone together which is rare. Felt nice despite the usual drama.', daysAgo: 1 },
  { content: 'Evening: reviewed my fitness progress. Down 3kg this month, lifts going up. The body recomp is real.', daysAgo: 1 },
  { content: 'Video call with Priya before bed. Planning to meet her family next month. Nervous about it.', daysAgo: 1 },
];

// ============================================================================
// Utilities
// ============================================================================

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function waitForJobsToComplete(userId: string, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const pendingJobs = await prisma.workerJob.count({
      where: {
        userId,
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
      },
    });

    if (pendingJobs === 0) {
      return true;
    }

    log(`  Waiting for ${pendingJobs} jobs to complete...`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  return false;
}

async function getStats(userId: string): Promise<void> {
  const [events, interpretations, patterns, insights, reviews, plans, suggestions] = await Promise.all([
    prisma.event.count({ where: { userId } }),
    prisma.interpretation.count({ where: { userId } }),
    prisma.pattern.count({ where: { userId } }),
    prisma.insight.count({ where: { userId } }),
    prisma.review.count({ where: { userId } }),
    prisma.dailyPlan.count({ where: { userId } }),
    prisma.uOMUpdateSuggestion.count({ where: { userId } }),
  ]);

  console.log('\n📊 Database Stats for Mock User:');
  console.log(`   Events:          ${events}`);
  console.log(`   Interpretations: ${interpretations}`);
  console.log(`   Patterns:        ${patterns}`);
  console.log(`   Insights:        ${insights}`);
  console.log(`   Reviews:         ${reviews}`);
  console.log(`   Daily Plans:     ${plans}`);
  console.log(`   UOM Suggestions: ${suggestions}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('🌱 Seeding Mock User Data\n');
  console.log('='.repeat(50));
  console.log('⚠️  This will make real OpenAI API calls!');
  console.log('='.repeat(50));

  try {
    // Check if mock user exists
    const user = await prisma.user.findUnique({
      where: { id: MOCK_USER_ID },
      select: { id: true, name: true, baseline: true },
    });

    if (!user) {
      console.error('❌ Mock user not found! Run: npx ts-node scripts/create-test-user.ts first');
      process.exit(1);
    }

    log(`Found mock user: ${user.name}`);

    // Show current stats
    await getStats(MOCK_USER_ID);

    // Register handlers and start worker
    log('\nStarting worker...');
    registerAllHandlers();
    await startWorker({ workerId: 'seed-worker' });

    // Create events
    log('\n📝 Creating events...');
    for (const event of SAMPLE_EVENTS) {
      const occurredAt = subDays(new Date(), event.daysAgo);
      occurredAt.setHours(9 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60));

      const result = await createEvent({
        userId: MOCK_USER_ID,
        content: event.content,
        occurredAt,
      });

      log(`  Created event: ${result.eventId.slice(0, 8)}... (${event.daysAgo} days ago)`);
    }

    // Wait for interpretation and pattern detection
    log('\n⏳ Waiting for events to be processed (interpretation + patterns)...');
    const eventsProcessed = await waitForJobsToComplete(MOCK_USER_ID, MAX_WAIT_MS);

    if (!eventsProcessed) {
      log('⚠️  Timeout waiting for event processing, continuing anyway...');
    } else {
      log('✅ Events processed!');
    }

    // Trigger daily review for yesterday
    log('\n📅 Triggering DAILY review...');
    const yesterday = subDays(new Date(), 1);
    const dailyPeriodKey = format(yesterday, 'yyyy-MM-dd');

    await enqueueGenerateReview({
      userId: MOCK_USER_ID,
      type: 'DAILY',
      periodKey: dailyPeriodKey,
      timezone: 'America/New_York',
    });

    // Wait for daily review chain (review → tomorrow plan → uom suggestion)
    log('⏳ Waiting for daily review chain...');
    const dailyDone = await waitForJobsToComplete(MOCK_USER_ID, MAX_WAIT_MS);

    if (!dailyDone) {
      log('⚠️  Timeout waiting for daily review, continuing...');
    } else {
      log('✅ Daily review chain complete!');
    }

    // Trigger weekly review
    log('\n📅 Triggering WEEKLY review...');
    const weekStart = subDays(new Date(), 7);
    const weeklyPeriodKey = format(weekStart, "yyyy-'W'ww");

    await enqueueGenerateReview({
      userId: MOCK_USER_ID,
      type: 'WEEKLY',
      periodKey: weeklyPeriodKey,
      timezone: 'America/New_York',
    });

    // Wait for weekly review
    log('⏳ Waiting for weekly review...');
    const weeklyDone = await waitForJobsToComplete(MOCK_USER_ID, MAX_WAIT_MS);

    if (!weeklyDone) {
      log('⚠️  Timeout waiting for weekly review');
    } else {
      log('✅ Weekly review complete!');
    }

    // Stop worker
    if (isWorkerRunning()) {
      log('\nStopping worker...');
      await stopWorker(true, 30000);
    }

    // Final stats
    await getStats(MOCK_USER_ID);

    // Show any failed jobs
    const failedJobs = await prisma.workerJob.findMany({
      where: {
        userId: MOCK_USER_ID,
        status: JobStatus.DEAD_LETTER,
      },
      select: { type: true, lastError: true },
    });

    if (failedJobs.length > 0) {
      console.log('\n⚠️  Failed Jobs:');
      for (const job of failedJobs) {
        console.log(`   ${job.type}: ${job.lastError?.slice(0, 100)}...`);
      }
    }

    console.log('\n✅ Seeding complete!');

  } catch (error) {
    console.error('\n💥 Error:', error);
    process.exit(1);
  } finally {
    if (isWorkerRunning()) {
      await stopWorker(true, 10000);
    }
    await prisma.$disconnect();
  }
}

main();
