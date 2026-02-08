#!/usr/bin/env ts-node
/**
 * Direct pipeline test — creates events and runs interpret→pattern→insight synchronously.
 * Does NOT require the server to be running.
 * Usage: npx ts-node scripts/test-pipeline-direct.ts
 */

import prisma from '../src/prisma';
import { processMemoryPipeline } from '../src/pipeline/pipeline';

const USER_ID = 'mock-user-001';

// Sample gym event with rawJson (realistic workout data)
const GYM_EVENT = {
    content: `Chest & Triceps session. Started with barbell bench press — hit 70kg for 8 reps first set, then failed at 5 reps second set. Moved to incline dumbbell press — 32.5kg each hand, got 7 reps then 8 reps. Finished with standing cable crunches 70lbs for 8 reps. Coach said to push through but I was gassed after bench.`,
    trackedType: 'GYM' as const,
    rawJson: {
        exercises: [
            { name: 'Barbell Bench Press', sets: [{ weight: 70, unit: 'kg', reps: 8, toFailure: false }, { weight: 70, unit: 'kg', reps: 5, toFailure: true }] },
            { name: 'Incline Dumbbell Press', sets: [{ weight: 32.5, unit: 'kg', reps: 7, toFailure: false }, { weight: 32.5, unit: 'kg', reps: 8, toFailure: false }] },
            { name: 'Standing Cable Crunch', sets: [{ weight: 70, unit: 'lbs', reps: 8, toFailure: false }] },
        ],
        totalSets: 5,
        totalReps: 36,
        totalVolume: 2520,
        volumeUnit: 'kg',
        coachNotes: 'Push through the bench failure. Your incline is strong — try going heavier next session.',
    },
};

async function createEvent(data: { content: string; trackedType: string; rawJson?: any }) {
    const event = await prisma.event.create({
        data: {
            userId: USER_ID,
            content: data.content,
            trackedType: data.trackedType as any,
            rawJson: data.rawJson || undefined,
            occurredAt: new Date(),
        },
        select: { id: true },
    });
    return event.id;
}

function separator(label: string) {
    console.log('\n' + '='.repeat(80));
    console.log(`  ${label}`);
    console.log('='.repeat(80));
}

async function showResults(eventId: string) {
    // Interpretation
    const interpretation = await prisma.interpretation.findFirst({ where: { eventId } });
    separator('INTERPRETATION');
    console.log(interpretation?.content || '(none)');

    // Pattern
    const patternEvents = await prisma.patternEvent.findMany({
        where: { eventId },
        include: { pattern: true },
    });
    separator('PATTERN(S)');
    if (patternEvents.length === 0) {
        console.log('(none)');
    }
    for (const pe of patternEvents) {
        console.log(`[${pe.pattern.status}] reinforcements=${pe.pattern.reinforcementCount}`);
        console.log(pe.pattern.description);
        console.log('');
    }

    // Insights
    const insightEvents = await prisma.insightEvent.findMany({
        where: { eventId },
        include: { insight: true },
    });
    separator('INSIGHTS');
    if (insightEvents.length === 0) {
        console.log('(none)');
    }
    for (const ie of insightEvents) {
        console.log(`[${ie.insight.confidence}/${ie.insight.status}] ${ie.insight.category}`);
        console.log(`Statement: ${ie.insight.statement}`);
        console.log(`Explanation: ${ie.insight.explanation}`);
        console.log('');
    }
}

async function main() {
    console.log('Creating gym event...');
    const gymEventId = await createEvent(GYM_EVENT);
    console.log(`Event ID: ${gymEventId}`);

    separator('RUNNING PIPELINE');
    const result = await processMemoryPipeline(gymEventId);
    console.log(`Pipeline completed in ${result.durationMs}ms, success=${result.success}`);
    if (result.errors.length > 0) {
        console.log('Errors:', result.errors);
    }

    await showResults(gymEventId);

    // Cleanup: delete what we just created (so test is repeatable)
    console.log('\nCleaning up test data...');
    // Delete in order: insightEvents, insights, insightPatterns, insightInterpretations, patternEvents, patterns, interpretations, event
    await prisma.insightEvent.deleteMany({ where: { eventId: gymEventId } });
    const patternIds = (await prisma.patternEvent.findMany({ where: { eventId: gymEventId }, select: { patternId: true } })).map(pe => pe.patternId);
    await prisma.insightPattern.deleteMany({ where: { patternId: { in: patternIds } } });
    await prisma.insightInterpretation.deleteMany({ where: { interpretation: { eventId: gymEventId } } });
    await prisma.patternEvent.deleteMany({ where: { eventId: gymEventId } });
    // Only delete patterns that were created specifically for this event (no other events linked)
    for (const pid of patternIds) {
        const otherLinks = await prisma.patternEvent.count({ where: { patternId: pid } });
        if (otherLinks === 0) {
            await prisma.pattern.delete({ where: { id: pid } }).catch(() => {});
        }
    }
    await prisma.interpretation.deleteMany({ where: { eventId: gymEventId } });
    await prisma.event.delete({ where: { id: gymEventId } });
    console.log('Done.');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
