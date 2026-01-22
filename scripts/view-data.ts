#!/usr/bin/env ts-node
/**
 * View database data for debugging
 * Usage:
 *   npx ts-node scripts/view-data.ts patterns     - List all active patterns
 *   npx ts-node scripts/view-data.ts insights     - List recent insights
 *   npx ts-node scripts/view-data.ts events [n]   - List last n events (default 5)
 *   npx ts-node scripts/view-data.ts jobs         - List recent job statuses
 *   npx ts-node scripts/view-data.ts event <id>   - View specific event with all related data
 */

import prisma from '../src/prisma';

const USER_ID = 'mock-user-001';

async function viewPatterns() {
    const patterns = await prisma.pattern.findMany({
        where: { userId: USER_ID, status: 'ACTIVE' },
        orderBy: { reinforcementCount: 'desc' }
    });

    console.log('=== ACTIVE PATTERNS ===\n');
    patterns.forEach((p, i) => {
        console.log(`Pattern ${i + 1}: ${p.id}`);
        console.log(`Reinforcements: ${p.reinforcementCount}`);
        console.log(`First Detected: ${p.firstDetectedAt.toISOString()}`);
        console.log(`Last Reinforced: ${p.lastReinforcedAt.toISOString()}`);
        console.log(`\nDescription (first 800 chars):`);
        console.log(p.description.substring(0, 800));
        if (p.description.length > 800) console.log('...[truncated]');
        console.log('\n' + '='.repeat(80) + '\n');
    });
    console.log(`Total: ${patterns.length} active patterns`);
}

async function viewInsights() {
    const insights = await prisma.insight.findMany({
        where: { userId: USER_ID },
        orderBy: { createdAt: 'desc' },
        take: 10
    });

    console.log('=== RECENT INSIGHTS ===\n');
    insights.forEach((ins, i) => {
        console.log(`Insight ${i + 1}:`);
        console.log(`Statement: ${ins.statement}`);
        console.log(`Category: ${ins.category} | Confidence: ${ins.confidence} | Status: ${ins.status}`);
        console.log(`Created: ${ins.createdAt.toISOString()}`);
        console.log('-'.repeat(80));
    });
}

async function viewEvents(count: number = 5) {
    const events = await prisma.event.findMany({
        where: { userId: USER_ID },
        orderBy: { createdAt: 'desc' },
        take: count
    });

    console.log(`=== LAST ${count} EVENTS ===\n`);
    for (const event of events) {
        const interpretation = await prisma.interpretation.findFirst({
            where: { eventId: event.id }
        });
        const patternEvent = await prisma.patternEvent.findFirst({
            where: { eventId: event.id },
            include: { pattern: true }
        });
        const insightCount = await prisma.insightEvent.count({
            where: { eventId: event.id }
        });

        console.log(`ID: ${event.id}`);
        console.log(`Content: "${event.content}"`);
        console.log(`Created: ${event.createdAt.toISOString()}`);
        console.log(`Interpretation: ${interpretation ? '✓' : '✗'}`);
        console.log(`Pattern: ${patternEvent?.pattern?.description.substring(0, 50) || '✗'}...`);
        console.log(`Insights: ${insightCount}`);
        console.log('-'.repeat(80));
    }
}

async function viewJobs() {
    const jobs = await prisma.workerJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15
    });

    console.log('=== RECENT JOBS ===\n');
    jobs.forEach((j) => {
        console.log(`${j.type.padEnd(20)} | ${j.status.padEnd(12)} | ${j.createdAt.toISOString()}`);
    });
}

async function viewEventDetail(eventId: string) {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
        console.log('Event not found:', eventId);
        return;
    }

    console.log('='.repeat(80));
    console.log('EVENT DETAIL');
    console.log('='.repeat(80));

    console.log('\n📝 RAW EVENT:');
    console.log(`"${event.content}"`);
    console.log(`Created: ${event.createdAt.toISOString()}`);

    // Layer 1
    const interpretation = await prisma.interpretation.findFirst({ where: { eventId } });
    console.log('\n' + '-'.repeat(80));
    console.log('🔍 LAYER 1 - INTERPRETATION:');
    console.log('-'.repeat(80));
    console.log(interpretation?.content || '❌ No interpretation');

    // Layer 2
    const patternEvent = await prisma.patternEvent.findFirst({
        where: { eventId },
        include: { pattern: true }
    });
    console.log('\n' + '-'.repeat(80));
    console.log('📊 LAYER 2 - PATTERN:');
    console.log('-'.repeat(80));
    if (patternEvent?.pattern) {
        console.log('Pattern ID:', patternEvent.pattern.id);
        console.log('Reinforcements:', patternEvent.pattern.reinforcementCount);
        console.log('\nDescription:');
        console.log(patternEvent.pattern.description);
    } else {
        console.log('❌ No pattern');
    }

    // Layer 3
    const insightEvents = await prisma.insightEvent.findMany({
        where: { eventId },
        include: { insight: true }
    });
    console.log('\n' + '-'.repeat(80));
    console.log('💡 LAYER 3 - INSIGHTS:');
    console.log('-'.repeat(80));
    if (insightEvents.length) {
        insightEvents.forEach((ie, i) => {
            console.log(`\nInsight ${i + 1}:`);
            console.log('Statement:', ie.insight.statement);
            console.log('Explanation:', ie.insight.explanation);
            console.log('Category:', ie.insight.category, '| Confidence:', ie.insight.confidence);
        });
    } else {
        console.log('❌ No insights');
    }
}

async function main() {
    const command = process.argv[2];
    const arg = process.argv[3];

    switch (command) {
        case 'patterns':
            await viewPatterns();
            break;
        case 'insights':
            await viewInsights();
            break;
        case 'events':
            await viewEvents(arg ? parseInt(arg) : 5);
            break;
        case 'jobs':
            await viewJobs();
            break;
        case 'event':
            if (!arg) {
                console.log('Usage: npx ts-node scripts/view-data.ts event <event-id>');
                return;
            }
            await viewEventDetail(arg);
            break;
        default:
            console.log(`
Usage:
  npx ts-node scripts/view-data.ts patterns     - List all active patterns
  npx ts-node scripts/view-data.ts insights     - List recent insights
  npx ts-node scripts/view-data.ts events [n]   - List last n events (default 5)
  npx ts-node scripts/view-data.ts jobs         - List recent job statuses
  npx ts-node scripts/view-data.ts event <id>   - View specific event with all data
            `);
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('Error:', e);
        process.exit(1);
    });
