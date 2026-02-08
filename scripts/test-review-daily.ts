#!/usr/bin/env ts-node
/**
 * Daily Review + UOM baseline test — creates events, runs the full pipeline,
 * generates a daily review, and verifies the output.
 * Does NOT require the server to be running.
 * Usage: npx ts-node scripts/test-review-daily.ts
 */

import prisma from '../src/prisma';
import { processMemoryPipeline } from '../src/pipeline/pipeline';
import { generateReview } from '../src/workers/review/generate-review';
import { ReviewType } from '../src/workers/review/schema';

const USER_ID = 'mock-user-001';

// ============================================================================
// User Baseline (UOM)
// ============================================================================

const USER_BASELINE = `## Goals
- Gym: 4 sessions/week, bench press 80kg for 8 reps by end of month
- Diet: 2200 cal/day, 160g protein, recomposition phase
- Habits: Cold shower daily, read 30 min, no phone before bed

## Current Struggles
- Bench press stalling around 70kg
- Tends to skip protein at breakfast
- Phone scrolling before bed disrupts sleep`;

// ============================================================================
// Mock Events (all for "yesterday" so the period is complete)
// ============================================================================

const GYM_EVENT = {
    content: `Chest & Triceps session. Barbell bench press — hit 72.5kg for 7 reps first set, 6 reps second set, felt heavier than expected. Incline dumbbell press 30kg each hand for 3x8. Cable flyes 15kg for 3x12. Tricep pushdowns 25kg for 3x10. Good pump but bench still feels stuck.`,
    trackedType: 'GYM' as const,
    rawJson: {
        exercises: [
            { name: 'Barbell Bench Press', sets: [{ weight: 72.5, unit: 'kg', reps: 7, toFailure: false }, { weight: 72.5, unit: 'kg', reps: 6, toFailure: true }] },
            { name: 'Incline Dumbbell Press', sets: [{ weight: 30, unit: 'kg', reps: 8, toFailure: false }, { weight: 30, unit: 'kg', reps: 8, toFailure: false }, { weight: 30, unit: 'kg', reps: 8, toFailure: false }] },
            { name: 'Cable Flyes', sets: [{ weight: 15, unit: 'kg', reps: 12, toFailure: false }, { weight: 15, unit: 'kg', reps: 12, toFailure: false }, { weight: 15, unit: 'kg', reps: 12, toFailure: false }] },
            { name: 'Tricep Pushdowns', sets: [{ weight: 25, unit: 'kg', reps: 10, toFailure: false }, { weight: 25, unit: 'kg', reps: 10, toFailure: false }, { weight: 25, unit: 'kg', reps: 10, toFailure: false }] },
        ],
        totalSets: 11,
        totalReps: 101,
        totalVolume: 3095,
        volumeUnit: 'kg',
    },
};

const DIET_EVENT = {
    content: `Meal log — Breakfast: 4-egg omelette with spinach and cheese, protein shake (40g whey). Lunch: grilled chicken breast 250g with brown rice and broccoli. Snack: Greek yogurt with almonds. Dinner: salmon fillet 200g with sweet potato and salad. Total protein around 170g, calories roughly 2300.`,
    trackedType: 'DIET' as const,
    rawJson: {
        meals: [
            { name: 'Breakfast', items: ['4-egg omelette with spinach and cheese', 'protein shake (40g whey)'], estimatedProtein: 55, estimatedCalories: 550 },
            { name: 'Lunch', items: ['grilled chicken breast 250g', 'brown rice', 'broccoli'], estimatedProtein: 55, estimatedCalories: 600 },
            { name: 'Snack', items: ['Greek yogurt', 'almonds'], estimatedProtein: 20, estimatedCalories: 250 },
            { name: 'Dinner', items: ['salmon fillet 200g', 'sweet potato', 'salad'], estimatedProtein: 40, estimatedCalories: 600 },
        ],
        totalEstimatedProtein: 170,
        totalEstimatedCalories: 2300,
    },
};

const HABIT_EVENT = {
    content: `Habit check-in — Did cold shower this morning (3 minutes, getting easier). Read for 35 minutes before dinner, finished a chapter of Atomic Habits. However, scrolled phone for 20 minutes in bed before sleep — need to work on this one.`,
    trackedType: 'HABIT' as const,
    rawJson: {
        habits: [
            { name: 'Cold shower', completed: true, notes: '3 minutes, getting easier' },
            { name: 'Read 30 min', completed: true, notes: '35 minutes, Atomic Habits' },
            { name: 'No phone before bed', completed: false, notes: 'Scrolled for 20 min in bed' },
        ],
        completionRate: 2 / 3,
    },
};

const ALL_EVENTS = [GYM_EVENT, DIET_EVENT, HABIT_EVENT];

// ============================================================================
// Helpers
// ============================================================================

function separator(label: string) {
    console.log('\n' + '='.repeat(80));
    console.log(`  ${label}`);
    console.log('='.repeat(80));
}

/** Yesterday at noon UTC — ensures `canGenerateReview` passes (period is complete). */
function getYesterday(): Date {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(12, 0, 0, 0);
    return d;
}

async function createEvent(data: { content: string; trackedType: string; rawJson?: any }, occurredAt: Date): Promise<string> {
    const event = await prisma.event.create({
        data: {
            userId: USER_ID,
            content: data.content,
            trackedType: data.trackedType as any,
            rawJson: data.rawJson || undefined,
            occurredAt,
        },
        select: { id: true },
    });
    return event.id;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const yesterday = getYesterday();
    console.log(`Target date (yesterday): ${yesterday.toISOString().split('T')[0]}`);

    // ------------------------------------------------------------------
    // Step 1: Save original baseline, then upsert UOM baseline
    // ------------------------------------------------------------------
    separator('STEP 1 — SET USER BASELINE (UOM)');

    const originalUser = await prisma.user.findUnique({
        where: { id: USER_ID },
        select: { baseline: true },
    });
    const originalBaseline = originalUser?.baseline ?? null;

    await prisma.user.update({
        where: { id: USER_ID },
        data: { baseline: USER_BASELINE },
    });
    console.log('User baseline set ✓');
    console.log(USER_BASELINE.substring(0, 120) + '...');

    // ------------------------------------------------------------------
    // Step 2: Create events
    // ------------------------------------------------------------------
    separator('STEP 2 — CREATE EVENTS');

    const eventIds: string[] = [];
    for (const eventData of ALL_EVENTS) {
        const id = await createEvent(eventData, yesterday);
        eventIds.push(id);
        console.log(`Created ${eventData.trackedType} event: ${id}`);
    }

    // ------------------------------------------------------------------
    // Step 3: Run pipeline for each event
    // ------------------------------------------------------------------
    separator('STEP 3 — RUN PIPELINE (interpret → pattern → insight)');

    for (const eventId of eventIds) {
        console.log(`\nProcessing event ${eventId}...`);
        const result = await processMemoryPipeline(eventId);
        console.log(`  Pipeline: success=${result.success}, duration=${result.durationMs}ms`);
        if (result.errors.length > 0) {
            console.log(`  Errors:`, result.errors);
        }
    }

    // ------------------------------------------------------------------
    // Step 4: Generate daily review
    // ------------------------------------------------------------------
    separator('STEP 4 — GENERATE DAILY REVIEW');

    const reviewResult = await generateReview({
        userId: USER_ID,
        reviewType: ReviewType.DAILY,
        targetDate: yesterday,
        force: true,
    });

    console.log('Review result:', JSON.stringify(reviewResult, null, 2));

    if (!reviewResult.success || !reviewResult.reviewId) {
        console.error('Review generation failed or was skipped — aborting display.');
        await cleanup(eventIds, null, originalBaseline);
        return;
    }

    // ------------------------------------------------------------------
    // Step 5: Fetch and display the review
    // ------------------------------------------------------------------
    separator('STEP 5 — FETCH & DISPLAY REVIEW');

    const review = await prisma.review.findUnique({
        where: { id: reviewResult.reviewId },
    });

    if (!review) {
        console.error('Review not found in DB');
        await cleanup(eventIds, reviewResult.reviewId, originalBaseline);
        return;
    }

    separator('DAILY REVIEW — SUMMARY');
    console.log(review.summary);

    separator('DAILY REVIEW — STRUCTURED CONTENT');
    try {
        console.log(JSON.stringify(review.structuredContent, null, 2));
    } catch {
        console.log(String(review.structuredContent));
    }

    separator('DAILY REVIEW — RENDERED MARKDOWN');
    console.log(review.renderedMarkdown);

    separator('DATA QUALITY');
    // dataQuality is embedded in structuredContent or in a separate field
    // The review schema stores it as part of the Review model or within structuredContent
    // Let's check what's available
    const sc = review.structuredContent as any;
    if (sc?.dataQuality) {
        console.log(JSON.stringify(sc.dataQuality, null, 2));
    } else {
        console.log('(dataQuality not found in structuredContent — check review model fields)');
    }

    // ------------------------------------------------------------------
    // Step 6: Cleanup
    // ------------------------------------------------------------------
    await cleanup(eventIds, reviewResult.reviewId, originalBaseline);
}

async function cleanup(eventIds: string[], reviewId: string | null, originalBaseline: string | null) {
    separator('CLEANUP');

    // 1. Delete review
    if (reviewId) {
        await prisma.review.delete({ where: { id: reviewId } }).catch(() => {});
        console.log(`Deleted review: ${reviewId}`);
    }

    // 2. For each event: delete insight join tables, pattern join tables, interpretations
    for (const eventId of eventIds) {
        // Insight join tables
        await prisma.insightEvent.deleteMany({ where: { eventId } });
        await prisma.insightInterpretation.deleteMany({
            where: { interpretation: { eventId } },
        });

        // Collect pattern IDs linked to this event
        const patternLinks = await prisma.patternEvent.findMany({
            where: { eventId },
            select: { patternId: true },
        });
        const patternIds = patternLinks.map((pl) => pl.patternId);

        // Delete insight-pattern links for these patterns
        if (patternIds.length > 0) {
            await prisma.insightPattern.deleteMany({
                where: { patternId: { in: patternIds } },
            });
        }

        // Delete pattern-event links
        await prisma.patternEvent.deleteMany({ where: { eventId } });

        // Delete orphaned patterns (no other events linked)
        for (const pid of patternIds) {
            const otherLinks = await prisma.patternEvent.count({ where: { patternId: pid } });
            if (otherLinks === 0) {
                await prisma.pattern.delete({ where: { id: pid } }).catch(() => {});
            }
        }

        // Delete interpretations
        await prisma.interpretation.deleteMany({ where: { eventId } });

        // Delete event
        await prisma.event.delete({ where: { id: eventId } }).catch(() => {});

        console.log(`Cleaned up event: ${eventId}`);
    }

    // 3. Restore original baseline
    await prisma.user.update({
        where: { id: USER_ID },
        data: { baseline: originalBaseline },
    });
    console.log(`User baseline restored to ${originalBaseline ? 'original value' : 'null'}`);

    console.log('Cleanup complete.');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
