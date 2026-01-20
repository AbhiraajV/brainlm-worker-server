"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandEvents = expandEvents;
const prisma_1 = __importDefault(require("../../prisma"));
/**
 * Expands events into mini knowledge graphs by fetching related data.
 *
 * Step 4 of the retriever pipeline.
 *
 * For each event, retrieves:
 * - Its interpretation (if exists)
 * - Linked patterns via PatternEvent join table
 * - Linked insights via InsightEvent join table
 *
 * @param userId - User ID
 * @param events - Raw events from retrieval
 * @returns Expanded events with linked knowledge
 */
async function expandEvents(userId, events) {
    if (events.length === 0) {
        return [];
    }
    const eventIds = events.map(e => e.id);
    console.log(`[Retriever] Step 4: Expanding ${eventIds.length} events...`);
    // Fetch all related data in parallel
    const [interpretations, patternLinks, insightLinks] = await Promise.all([
        fetchInterpretations(eventIds),
        fetchPatternLinks(eventIds),
        fetchInsightLinks(eventIds),
    ]);
    // Build lookup maps for efficient access
    const interpretationMap = new Map(interpretations.map(i => [i.eventId, i]));
    const patternMap = buildPatternMap(patternLinks);
    const insightMap = buildInsightMap(insightLinks);
    // Expand each event
    const expanded = events.map(event => ({
        event: {
            id: event.id,
            content: event.content,
            occurredAt: event.occurredAt,
            similarity: event.similarity,
        },
        interpretation: interpretationMap.get(event.id) ?? null,
        linkedPatterns: patternMap.get(event.id) ?? [],
        linkedInsights: insightMap.get(event.id) ?? [],
    }));
    const linkedPatternsCount = expanded.reduce((sum, e) => sum + e.linkedPatterns.length, 0);
    const linkedInsightsCount = expanded.reduce((sum, e) => sum + e.linkedInsights.length, 0);
    const interpretationsCount = expanded.filter(e => e.interpretation !== null).length;
    console.log(`[Retriever] Step 4 complete: expanded ${events.length} events ` +
        `(${interpretationsCount} interpretations, ${linkedPatternsCount} pattern links, ` +
        `${linkedInsightsCount} insight links)`);
    return expanded;
}
/**
 * Fetch interpretations for given event IDs.
 */
async function fetchInterpretations(eventIds) {
    return prisma_1.default.interpretation.findMany({
        where: {
            eventId: { in: eventIds },
        },
        select: {
            id: true,
            eventId: true,
            content: true,
        },
    });
}
/**
 * Fetch pattern links for given event IDs.
 */
async function fetchPatternLinks(eventIds) {
    const links = await prisma_1.default.patternEvent.findMany({
        where: {
            eventId: { in: eventIds },
            pattern: { status: 'ACTIVE' },
        },
        select: {
            eventId: true,
            pattern: {
                select: {
                    id: true,
                    description: true,
                    status: true,
                },
            },
        },
    });
    return links;
}
/**
 * Fetch insight links for given event IDs.
 */
async function fetchInsightLinks(eventIds) {
    const links = await prisma_1.default.insightEvent.findMany({
        where: {
            eventId: { in: eventIds },
            insight: { status: { not: 'SUPERSEDED' } },
        },
        select: {
            eventId: true,
            relevance: true,
            insight: {
                select: {
                    id: true,
                    statement: true,
                    explanation: true,
                },
            },
        },
    });
    return links;
}
/**
 * Build a map of eventId -> linked patterns.
 */
function buildPatternMap(links) {
    const map = new Map();
    for (const link of links) {
        const existing = map.get(link.eventId) ?? [];
        existing.push(link.pattern);
        map.set(link.eventId, existing);
    }
    return map;
}
/**
 * Build a map of eventId -> linked insights.
 */
function buildInsightMap(links) {
    const map = new Map();
    for (const link of links) {
        const existing = map.get(link.eventId) ?? [];
        existing.push({
            ...link.insight,
            relevance: link.relevance,
        });
        map.set(link.eventId, existing);
    }
    return map;
}
