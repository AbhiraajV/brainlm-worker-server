import prisma from '../prisma';

// ============================================================================
// Types
// ============================================================================

export interface EventWithFullContext {
    event: {
        id: string;
        content: string;
        occurredAt: Date;
        createdAt: Date;
    };
    interpretation: {
        id: string;
        content: string;
        source: string;
        createdAt: Date;
    } | null;
    patterns: Array<{
        id: string;
        description: string;
        status: string;
        firstDetectedAt: Date;
        lastReinforcedAt: Date;
        eventCount: number;
    }>;
    insights: Array<{
        id: string;
        statement: string;
        explanation: string;
        confidence: string;
        status: string;
        category: string | null;
        temporalScope: string | null;
        relevance: string;
        firstDetectedAt: Date;
        lastReinforcedAt: Date;
    }>;
}

export interface SearchEventsInput {
    userId: string;
    query?: string;
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
}

export interface SearchEventsResult {
    events: EventWithFullContext[];
    total: number;
    limit: number;
    offset: number;
}

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
export async function getEventWithContext(
    eventId: string,
    userId: string
): Promise<EventWithFullContext | null> {
    // Get event with interpretation
    const event = await prisma.event.findFirst({
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
export async function searchEvents(
    input: SearchEventsInput
): Promise<SearchEventsResult> {
    const {
        userId,
        query,
        limit = 20,
        offset = 0,
        startDate,
        endDate,
    } = input;

    // Build where clause
    const where: any = { userId };

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
        if (startDate) where.occurredAt.gte = startDate;
        if (endDate) where.occurredAt.lte = endDate;
    }

    // Get total count
    const total = await prisma.event.count({ where });

    // Get events with full context
    const events = await prisma.event.findMany({
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
export async function getRecentEvents(
    userId: string,
    limit: number = 10
): Promise<EventWithFullContext[]> {
    const events = await prisma.event.findMany({
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

function formatEventWithContext(event: any): EventWithFullContext {
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
        patterns: event.patternEvents.map((pe: any) => ({
            id: pe.pattern.id,
            description: pe.pattern.description,
            status: pe.pattern.status,
            firstDetectedAt: pe.pattern.firstDetectedAt,
            lastReinforcedAt: pe.pattern.lastReinforcedAt,
            eventCount: pe.pattern._count.patternEvents,
        })),
        insights: event.insightEvents.map((ie: any) => ({
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
