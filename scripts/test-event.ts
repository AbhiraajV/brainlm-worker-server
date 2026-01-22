#!/usr/bin/env ts-node
/**
 * Test script for pushing events and viewing generated data
 * Usage: npx ts-node scripts/test-event.ts "Your event content here"
 */

import prisma from '../src/prisma';

const USER_ID = 'mock-user-001';
const SERVER_URL = 'http://localhost:3001';

async function pushEvent(content: string): Promise<string> {
    const response = await fetch(`${SERVER_URL}/memory`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-user-id': USER_ID,
        },
        body: JSON.stringify({
            content,
            occurredAt: new Date().toISOString(),
        }),
    });
    const data = await response.json();
    console.log('✓ Event created:', data.eventId);
    return data.eventId;
}

async function waitForProcessing(eventId: string, maxWaitMs = 60000): Promise<void> {
    const startTime = Date.now();
    console.log('⏳ Waiting for processing...');

    while (Date.now() - startTime < maxWaitMs) {
        // Check if interpretation exists
        const interpretation = await prisma.interpretation.findFirst({
            where: { eventId }
        });

        // Check if insights exist
        const insights = await prisma.insightEvent.findMany({
            where: { eventId }
        });

        if (interpretation && insights.length > 0) {
            console.log('✓ Processing complete!');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        process.stdout.write('.');
    }

    console.log('\n⚠ Timeout waiting for processing');
}

async function viewEventData(eventId: string): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('EVENT DATA');
    console.log('='.repeat(80));

    // Get event
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    console.log('\n📝 RAW EVENT:');
    console.log(`"${event?.content}"`);

    // Get interpretation (Layer 1)
    const interpretation = await prisma.interpretation.findFirst({ where: { eventId } });
    console.log('\n' + '-'.repeat(80));
    console.log('🔍 LAYER 1 - INTERPRETATION (Factual Capture):');
    console.log('-'.repeat(80));
    console.log(interpretation?.content || '❌ No interpretation');

    // Get pattern (Layer 2)
    const patternEvent = await prisma.patternEvent.findFirst({
        where: { eventId },
        include: { pattern: true }
    });
    console.log('\n' + '-'.repeat(80));
    console.log('📊 LAYER 2 - PATTERN (Temporal Analysis):');
    console.log('-'.repeat(80));
    if (patternEvent?.pattern) {
        console.log('Pattern ID:', patternEvent.pattern.id);
        console.log('Status:', patternEvent.pattern.status);
        console.log('Reinforcement Count:', patternEvent.pattern.reinforcementCount);
        console.log('\nDescription:');
        console.log(patternEvent.pattern.description);
    } else {
        console.log('❌ No pattern');
    }

    // Get insights (Layer 3)
    const insightEvents = await prisma.insightEvent.findMany({
        where: { eventId },
        include: { insight: true }
    });
    console.log('\n' + '-'.repeat(80));
    console.log('💡 LAYER 3 - INSIGHTS (Synthesis):');
    console.log('-'.repeat(80));
    if (insightEvents.length) {
        insightEvents.forEach((ie, i) => {
            console.log(`\nInsight ${i + 1}:`);
            console.log('Statement:', ie.insight.statement);
            console.log('Explanation:', ie.insight.explanation);
            console.log('Category:', ie.insight.category);
            console.log('Confidence:', ie.insight.confidence);
        });
    } else {
        console.log('❌ No insights');
    }

    console.log('\n' + '='.repeat(80));
}

async function main() {
    const content = process.argv[2];

    if (!content) {
        // If no content provided, show last event
        console.log('No content provided. Showing last event data...\n');
        const lastEvent = await prisma.event.findFirst({
            where: { userId: USER_ID },
            orderBy: { createdAt: 'desc' }
        });
        if (lastEvent) {
            await viewEventData(lastEvent.id);
        } else {
            console.log('No events found.');
        }
        return;
    }

    // Push new event
    const eventId = await pushEvent(content);

    // Wait for processing
    await waitForProcessing(eventId);

    // View data
    await viewEventData(eventId);
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error('Error:', e);
        process.exit(1);
    });
