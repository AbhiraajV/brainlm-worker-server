"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEventWithContext = getEventWithContext;
exports.searchEvents = searchEvents;
exports.getRecentEvents = getRecentEvents;
const prisma_1 = __importDefault(require("../prisma"));
// ============================================================================
// Get Single Event with Full Context
// ============================================================================
/**
 * Gets a single event with all related data:
 * - The event itself
 * - Its interpretation
 * - Associated patterns (via PatternEvent)
 * - Associated insights (via InsightEvent)
 */
async function getEventWithContext(eventId, userId) {
    // Get event with interpretation
    const event = await prisma_1.default.event.findFirst({
        where: {
            id: eventId,
            userId, // Ensure user owns this event
        },
        include: {
            interpretation: true,
            patternEvents: {
                include: {
                    pattern: {
                        include: {
                            _count: {
                                select: { patternEvents: true },
                            },
                        },
                    },
                },
            },
            insightEvents: {
                include: {
                    insight: true,
                },
            },
        },
    });
    if (!event) {
        return null;
    }
    return formatEventWithContext(event);
}
// ============================================================================
// Search Events with Full Context
// ============================================================================
/**
 * Searches events by content (case-insensitive) and returns with full context.
 * Supports pagination and date filtering.
 */
async function searchEvents(input) {
    const { userId, query, limit = 20, offset = 0, startDate, endDate, } = input;
    // Build where clause
    const where = { userId };
    if (query && query.trim()) {
        where.OR = [
            { content: { contains: query, mode: 'insensitive' } },
            {
                interpretation: {
                    content: { contains: query, mode: 'insensitive' },
                },
            },
        ];
    }
    if (startDate || endDate) {
        where.occurredAt = {};
        if (startDate)
            where.occurredAt.gte = startDate;
        if (endDate)
            where.occurredAt.lte = endDate;
    }
    // Get total count
    const total = await prisma_1.default.event.count({ where });
    // Get events with full context
    const events = await prisma_1.default.event.findMany({
        where,
        include: {
            interpretation: true,
            patternEvents: {
                include: {
                    pattern: {
                        include: {
                            _count: {
                                select: { patternEvents: true },
                            },
                        },
                    },
                },
            },
            insightEvents: {
                include: {
                    insight: true,
                },
            },
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        skip: offset,
    });
    return {
        events: events.map(formatEventWithContext),
        total,
        limit,
        offset,
    };
}
// ============================================================================
// Get Recent Events
// ============================================================================
/**
 * Gets the most recent events for a user with full context.
 */
async function getRecentEvents(userId, limit = 10) {
    const events = await prisma_1.default.event.findMany({
        where: { userId },
        include: {
            interpretation: true,
            patternEvents: {
                include: {
                    pattern: {
                        include: {
                            _count: {
                                select: { patternEvents: true },
                            },
                        },
                    },
                },
            },
            insightEvents: {
                include: {
                    insight: true,
                },
            },
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
    });
    return events.map(formatEventWithContext);
}
// ============================================================================
// Helper: Format Event with Context
// ============================================================================
function formatEventWithContext(event) {
    return {
        event: {
            id: event.id,
            content: event.content,
            occurredAt: event.occurredAt,
            createdAt: event.createdAt,
        },
        interpretation: event.interpretation
            ? {
                id: event.interpretation.id,
                content: event.interpretation.content,
                source: event.interpretation.source,
                createdAt: event.interpretation.createdAt,
            }
            : null,
        patterns: event.patternEvents.map((pe) => ({
            id: pe.pattern.id,
            description: pe.pattern.description,
            status: pe.pattern.status,
            firstDetectedAt: pe.pattern.firstDetectedAt,
            lastReinforcedAt: pe.pattern.lastReinforcedAt,
            eventCount: pe.pattern._count.patternEvents,
        })),
        insights: event.insightEvents.map((ie) => ({
            id: ie.insight.id,
            statement: ie.insight.statement,
            explanation: ie.insight.explanation,
            confidence: ie.insight.confidence,
            status: ie.insight.status,
            category: ie.insight.category,
            temporalScope: ie.insight.temporalScope,
            relevance: ie.relevance,
            firstDetectedAt: ie.insight.firstDetectedAt,
            lastReinforcedAt: ie.insight.lastReinforcedAt,
        })),
    };
}
