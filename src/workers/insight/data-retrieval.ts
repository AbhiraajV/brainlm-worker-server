import prisma from '../../prisma';
import { cosineSimilarity } from '../../services/embedding';
import {
    TriggerContext,
    ExistingInsight,
    InsightStatus,
    ConfidenceLevel,
} from './schema';

// ============================================================================
// Configuration
// ============================================================================

export interface InsightRetrievalConfig {
    maxPatterns: number;
    maxInterpretations: number;
    maxExistingInsights: number;
    patternSimilarityThreshold: number;
    interpretationSimilarityThreshold: number;
    insightSimilarityThreshold: number;
    recentSupersededDays: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: InsightRetrievalConfig = {
    maxPatterns: 20,
    maxInterpretations: 35,
    maxExistingInsights: 15,
    patternSimilarityThreshold: 0.5,
    interpretationSimilarityThreshold: 0.4,
    insightSimilarityThreshold: 0.5,
    recentSupersededDays: 30,
};

// ============================================================================
// Layer Types
// ============================================================================

export interface PatternWithEmbedding {
    id: string;
    description: string;
    status: string;
    embedding: number[];
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
    eventCount: number;
}

export interface InterpretationWithEmbedding {
    id: string;
    eventId: string;
    content: string;
    embedding: number[];
    createdAt: Date;
    source: 'semantic' | 'recent' | 'historical' | 'pattern_linked';
}

export interface DeterministicFacts {
    // Event stats
    totalEvents: number;
    eventsLast7Days: number;
    eventsLast30Days: number;
    eventsLast90Days: number;

    // Pattern stats
    totalActivePatterns: number;
    totalSupersededPatterns: number;
    totalDormantPatterns: number;

    // Timeline
    earliestEventDate: Date | null;
    daysSinceFirstEvent: number;
    avgEventsPerWeek: number;

    // Insight stats
    totalInsights: number;
    confirmedInsights: number;
    likelyInsights: number;
    speculativeInsights: number;

    // Activity metrics
    mostActiveDay: string | null;
    eventFrequencyTrend: 'increasing' | 'stable' | 'decreasing' | 'insufficient_data';
}

export interface DayEventsGrouped {
    [trackedType: string]: Array<{ id: string; content: string; occurredAt: Date; trackedType: string | null }>;
}

export interface TrackTypeEvent {
    id: string;
    content: string;
    occurredAt: Date;
    trackedType: string | null;
}

export interface TriggerEvent {
    id: string;
    content: string;
    occurredAt: Date;
    trackedType: string | null;
}

export interface TriggerInterpretation {
    id: string;
    content: string;
}

export interface InsightDataContext {
    trigger: TriggerContext;
    triggerEvent: TriggerEvent | null;
    triggerInterpretation: TriggerInterpretation | null;
    patterns: PatternWithEmbedding[];
    interpretations: InterpretationWithEmbedding[];
    existingInsights: ExistingInsight[];
    facts: DeterministicFacts;
    dayEvents: DayEventsGrouped;
    trackTypeHistory: TrackTypeEvent[];
}

// ============================================================================
// Helper: Parse Embedding
// ============================================================================

function parseEmbedding(embeddingStr: string): number[] {
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

// ============================================================================
// Layer 1: Trigger Context (passed in)
// ============================================================================

// Trigger context is passed directly, no retrieval needed

// ============================================================================
// Layer 2: Pattern Retrieval
// ============================================================================

async function retrievePatterns(
    userId: string,
    targetEmbedding: number[],
    config: InsightRetrievalConfig
): Promise<PatternWithEmbedding[]> {
    const recentSupersededDate = new Date();
    recentSupersededDate.setDate(recentSupersededDate.getDate() - config.recentSupersededDays);

    // Fetch all ACTIVE patterns + recently SUPERSEDED patterns
    const rawPatterns = await prisma.$queryRaw<
        Array<{
            id: string;
            description: string;
            status: string;
            embedding: string;
            firstDetectedAt: Date;
            lastReinforcedAt: Date;
        }>
    >`
        SELECT
            id,
            description,
            status,
            embedding::text,
            "firstDetectedAt",
            "lastReinforcedAt"
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND embedding IS NOT NULL
          AND (
            status = 'ACTIVE'
            OR (status = 'SUPERSEDED' AND "lastReinforcedAt" >= ${recentSupersededDate})
          )
        ORDER BY "lastReinforcedAt" DESC
    `;

    // Get event counts for each pattern
    const patternIds = rawPatterns.map((p) => p.id);
    const eventCounts = await prisma.patternEvent.groupBy({
        by: ['patternId'],
        where: { patternId: { in: patternIds } },
        _count: { eventId: true },
    });

    const eventCountMap = new Map(
        eventCounts.map((ec) => [ec.patternId, ec._count.eventId])
    );

    // Parse embeddings and compute similarity
    const patternsWithSimilarity = rawPatterns.map((p) => {
        const embedding = parseEmbedding(p.embedding);
        const similarity = cosineSimilarity(targetEmbedding, embedding);
        return {
            id: p.id,
            description: p.description,
            status: p.status,
            embedding,
            firstDetectedAt: p.firstDetectedAt,
            lastReinforcedAt: p.lastReinforcedAt,
            eventCount: eventCountMap.get(p.id) || 0,
            similarity,
        };
    });

    // Filter by similarity threshold OR include all ACTIVE
    const filtered = patternsWithSimilarity.filter(
        (p) => p.status === 'ACTIVE' || p.similarity >= config.patternSimilarityThreshold
    );

    // Sort by similarity, then by lastReinforcedAt
    filtered.sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        return b.lastReinforcedAt.getTime() - a.lastReinforcedAt.getTime();
    });

    // Return up to max, excluding similarity from final output
    return filtered.slice(0, config.maxPatterns).map(({ similarity, ...rest }) => rest);
}

// ============================================================================
// Layer 3: Interpretation Retrieval (Multi-Axis)
// ============================================================================

async function retrieveInterpretations(
    userId: string,
    targetEmbedding: number[],
    config: InsightRetrievalConfig
): Promise<InterpretationWithEmbedding[]> {
    const maxTotal = config.maxInterpretations;

    // Allocations: 35% semantic, 30% recent, 15% historical, 20% pattern-linked
    const semanticCount = Math.ceil(maxTotal * 0.35);
    const recentCount = Math.ceil(maxTotal * 0.30);
    const historicalCount = Math.ceil(maxTotal * 0.15);
    const patternLinkedCount = Math.ceil(maxTotal * 0.20);

    // Fetch all interpretations with embeddings
    const allInterpretations = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT id, "eventId", content, embedding::text, "createdAt"
        FROM "Interpretation"
        WHERE "userId" = ${userId}
          AND embedding IS NOT NULL
        ORDER BY "createdAt" DESC
    `;

    if (allInterpretations.length === 0) {
        return [];
    }

    // Parse embeddings
    const parsed = allInterpretations.map((i) => ({
        ...i,
        embedding: parseEmbedding(i.embedding),
    }));

    // Track which interpretations we've selected
    const selectedIds = new Set<string>();
    const results: InterpretationWithEmbedding[] = [];

    // --- Axis 1: Top-K Semantically Similar (35%) ---
    const withSimilarity = parsed.map((i) => ({
        ...i,
        similarity: cosineSimilarity(targetEmbedding, i.embedding),
    }));
    withSimilarity.sort((a, b) => b.similarity - a.similarity);

    for (const interp of withSimilarity) {
        if (results.length >= semanticCount) break;
        if (interp.similarity < config.interpretationSimilarityThreshold) break;
        if (!selectedIds.has(interp.id)) {
            selectedIds.add(interp.id);
            results.push({
                id: interp.id,
                eventId: interp.eventId,
                content: interp.content,
                embedding: interp.embedding,
                createdAt: interp.createdAt,
                source: 'semantic',
            });
        }
    }

    // --- Axis 2: Most Recent (30%) ---
    // Already sorted by createdAt DESC
    for (const interp of parsed) {
        if (results.filter((r) => r.source === 'recent').length >= recentCount) break;
        if (!selectedIds.has(interp.id)) {
            selectedIds.add(interp.id);
            results.push({
                id: interp.id,
                eventId: interp.eventId,
                content: interp.content,
                embedding: interp.embedding,
                createdAt: interp.createdAt,
                source: 'recent',
            });
        }
    }

    // --- Axis 3: Oldest/Historical (15%) ---
    const sortedByAge = [...parsed].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    for (const interp of sortedByAge) {
        if (results.filter((r) => r.source === 'historical').length >= historicalCount) break;
        if (!selectedIds.has(interp.id)) {
            selectedIds.add(interp.id);
            results.push({
                id: interp.id,
                eventId: interp.eventId,
                content: interp.content,
                embedding: interp.embedding,
                createdAt: interp.createdAt,
                source: 'historical',
            });
        }
    }

    // --- Axis 4: Pattern-Linked (20%) ---
    // Get interpretations linked to active patterns via events
    const patternLinkedInterps = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT DISTINCT i.id, i."eventId", i.content, i.embedding::text, i."createdAt"
        FROM "Interpretation" i
        JOIN "PatternEvent" pe ON pe."eventId" = i."eventId"
        JOIN "Pattern" p ON p.id = pe."patternId"
        WHERE i."userId" = ${userId}
          AND p.status = 'ACTIVE'
          AND i.embedding IS NOT NULL
        ORDER BY i."createdAt" DESC
        LIMIT ${patternLinkedCount * 2}
    `;

    for (const interp of patternLinkedInterps) {
        if (results.filter((r) => r.source === 'pattern_linked').length >= patternLinkedCount) break;
        if (!selectedIds.has(interp.id)) {
            selectedIds.add(interp.id);
            results.push({
                id: interp.id,
                eventId: interp.eventId,
                content: interp.content,
                embedding: parseEmbedding(interp.embedding),
                createdAt: interp.createdAt,
                source: 'pattern_linked',
            });
        }
    }

    return results.slice(0, maxTotal);
}

// ============================================================================
// Layer 4: Deterministic Facts (Pure SQL)
// ============================================================================

async function retrieveDeterministicFacts(userId: string): Promise<DeterministicFacts> {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Event counts
    const [
        totalEvents,
        eventsLast7,
        eventsLast30,
        eventsLast90,
        earliestEvent,
    ] = await Promise.all([
        prisma.event.count({ where: { userId } }),
        prisma.event.count({ where: { userId, occurredAt: { gte: sevenDaysAgo } } }),
        prisma.event.count({ where: { userId, occurredAt: { gte: thirtyDaysAgo } } }),
        prisma.event.count({ where: { userId, occurredAt: { gte: ninetyDaysAgo } } }),
        prisma.event.findFirst({
            where: { userId },
            orderBy: { occurredAt: 'asc' },
            select: { occurredAt: true },
        }),
    ]);

    // Pattern counts
    const [activePatterns, supersededPatterns, dormantPatterns] = await Promise.all([
        prisma.pattern.count({ where: { userId, status: 'ACTIVE' } }),
        prisma.pattern.count({ where: { userId, status: 'SUPERSEDED' } }),
        prisma.pattern.count({ where: { userId, status: 'DORMANT' } }),
    ]);

    // Insight counts
    const [
        totalInsights,
        confirmedInsights,
        likelyInsights,
        speculativeInsights,
    ] = await Promise.all([
        prisma.insight.count({ where: { userId } }),
        prisma.insight.count({ where: { userId, status: 'CONFIRMED' } }),
        prisma.insight.count({ where: { userId, status: 'LIKELY' } }),
        prisma.insight.count({ where: { userId, status: 'SPECULATIVE' } }),
    ]);

    // Calculate derived metrics
    const earliestEventDate = earliestEvent?.occurredAt || null;
    const daysSinceFirstEvent = earliestEventDate
        ? Math.floor((now.getTime() - earliestEventDate.getTime()) / (24 * 60 * 60 * 1000))
        : 0;

    const weeksWithData = Math.max(1, daysSinceFirstEvent / 7);
    const avgEventsPerWeek = totalEvents / weeksWithData;

    // Event frequency trend
    let eventFrequencyTrend: DeterministicFacts['eventFrequencyTrend'] = 'insufficient_data';
    if (daysSinceFirstEvent >= 14) {
        const firstHalfEnd = new Date(now.getTime() - (daysSinceFirstEvent / 2) * 24 * 60 * 60 * 1000);
        const firstHalfEvents = await prisma.event.count({
            where: {
                userId,
                occurredAt: {
                    gte: earliestEventDate!,
                    lt: firstHalfEnd,
                },
            },
        });
        const secondHalfEvents = totalEvents - firstHalfEvents;

        const ratio = secondHalfEvents / Math.max(1, firstHalfEvents);
        if (ratio > 1.2) eventFrequencyTrend = 'increasing';
        else if (ratio < 0.8) eventFrequencyTrend = 'decreasing';
        else eventFrequencyTrend = 'stable';
    }

    // Most active day of week
    let mostActiveDay: string | null = null;
    if (totalEvents > 0) {
        const dayOfWeekCounts = await prisma.$queryRaw<
            Array<{ day: number; count: bigint }>
        >`
            SELECT EXTRACT(DOW FROM "occurredAt") as day, COUNT(*) as count
            FROM "Event"
            WHERE "userId" = ${userId}
            GROUP BY day
            ORDER BY count DESC
            LIMIT 1
        `;
        if (dayOfWeekCounts.length > 0) {
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            mostActiveDay = days[Number(dayOfWeekCounts[0].day)];
        }
    }

    return {
        totalEvents,
        eventsLast7Days: eventsLast7,
        eventsLast30Days: eventsLast30,
        eventsLast90Days: eventsLast90,
        totalActivePatterns: activePatterns,
        totalSupersededPatterns: supersededPatterns,
        totalDormantPatterns: dormantPatterns,
        earliestEventDate,
        daysSinceFirstEvent,
        avgEventsPerWeek: Math.round(avgEventsPerWeek * 100) / 100,
        totalInsights,
        confirmedInsights,
        likelyInsights,
        speculativeInsights,
        mostActiveDay,
        eventFrequencyTrend,
    };
}

// ============================================================================
// Existing Insights Retrieval
// ============================================================================

async function retrieveExistingInsights(
    userId: string,
    targetEmbedding: number[],
    config: InsightRetrievalConfig
): Promise<ExistingInsight[]> {
    // Fetch non-superseded insights with embeddings
    const rawInsights = await prisma.$queryRaw<
        Array<{
            id: string;
            statement: string;
            explanation: string;
            confidence: string;
            status: string;
            category: string | null;
            embedding: string;
            firstDetectedAt: Date;
            lastReinforcedAt: Date;
        }>
    >`
        SELECT
            id,
            statement,
            explanation,
            confidence,
            status,
            category,
            embedding::text,
            "firstDetectedAt",
            "lastReinforcedAt"
        FROM "Insight"
        WHERE "userId" = ${userId}
          AND embedding IS NOT NULL
          AND status != 'SUPERSEDED'
        ORDER BY "lastReinforcedAt" DESC
    `;

    if (rawInsights.length === 0) {
        return [];
    }

    // Parse and compute similarity
    const withSimilarity = rawInsights.map((i) => {
        const embedding = parseEmbedding(i.embedding);
        const similarity = cosineSimilarity(targetEmbedding, embedding);
        return {
            id: i.id,
            statement: i.statement,
            explanation: i.explanation,
            confidence: i.confidence as ConfidenceLevel,
            status: i.status as InsightStatus,
            category: i.category,
            embedding,
            firstDetectedAt: i.firstDetectedAt,
            lastReinforcedAt: i.lastReinforcedAt,
            similarity,
        };
    });

    // Sort by similarity
    withSimilarity.sort((a, b) => b.similarity - a.similarity);

    // Filter by threshold and limit
    return withSimilarity
        .filter((i) => i.similarity >= config.insightSimilarityThreshold)
        .slice(0, config.maxExistingInsights)
        .map(({ similarity, ...rest }) => rest);
}

// ============================================================================
// Track-Type-Aware Retrieval Functions
// ============================================================================

/**
 * Fetches ALL events for the same day, grouped by trackedType.
 * Provides holistic cross-domain context for insight generation.
 */
async function retrieveDayEvents(userId: string, targetDate: Date): Promise<DayEventsGrouped> {
    const dayStart = new Date(targetDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const events = await prisma.event.findMany({
        where: {
            userId,
            occurredAt: { gte: dayStart, lte: dayEnd },
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'asc' },
    });

    const grouped: DayEventsGrouped = {};
    for (const event of events) {
        const type = event.trackedType || 'GENERAL';
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push({
            id: event.id,
            content: event.content,
            occurredAt: event.occurredAt,
            trackedType: event.trackedType,
        });
    }

    return grouped;
}

/**
 * Fetches same-track-type events historically for progression analysis.
 */
async function retrieveTrackTypeHistory(
    userId: string,
    trackedType: string,
    limit: number = 15
): Promise<TrackTypeEvent[]> {
    const events = await prisma.event.findMany({
        where: {
            userId,
            trackedType: trackedType as any,
        },
        select: { id: true, content: true, occurredAt: true, trackedType: true },
        orderBy: { occurredAt: 'desc' },
        take: limit,
    });

    return events.map(e => ({
        id: e.id,
        content: e.content,
        occurredAt: e.occurredAt,
        trackedType: e.trackedType,
    }));
}

// ============================================================================
// Main Retrieval Function
// ============================================================================

/**
 * Retrieves all context needed for insight generation.
 * This is the "databases measure" part - all quantitative analysis happens here.
 *
 * @param userId - The user ID
 * @param trigger - What triggered insight generation
 * @param targetEmbedding - Embedding to use for similarity search
 * @param config - Retrieval configuration
 * @returns Complete context for LLM reasoning
 */
export async function retrieveInsightContext(
    userId: string,
    trigger: TriggerContext,
    targetEmbedding: number[],
    config: InsightRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<InsightDataContext> {
    console.log(`[InsightRetrieval] Starting context retrieval for user ${userId}`);

    // Fetch the CURRENT event and its interpretation (the trigger)
    let triggerEvent: TriggerEvent | null = null;
    let triggerInterpretation: TriggerInterpretation | null = null;

    if (trigger.eventId) {
        const event = await prisma.event.findUnique({
            where: { id: trigger.eventId },
            select: { id: true, content: true, occurredAt: true, trackedType: true },
        });
        if (event) {
            triggerEvent = {
                id: event.id,
                content: event.content,
                occurredAt: event.occurredAt,
                trackedType: event.trackedType,
            };
        }

        const interpretation = await prisma.interpretation.findFirst({
            where: { eventId: trigger.eventId },
            select: { id: true, content: true },
        });
        if (interpretation) {
            triggerInterpretation = {
                id: interpretation.id,
                content: interpretation.content,
            };
        }
    }

    console.log(
        `[InsightRetrieval] Trigger event: ${triggerEvent ? 'found' : 'not found'}, ` +
        `interpretation: ${triggerInterpretation ? 'found' : 'not found'}`
    );

    // Retrieve day events and track type history for holistic context
    const dayEventsPromise = triggerEvent
        ? retrieveDayEvents(userId, triggerEvent.occurredAt)
        : Promise.resolve({} as DayEventsGrouped);

    const trackTypeHistoryPromise = triggerEvent?.trackedType
        ? retrieveTrackTypeHistory(userId, triggerEvent.trackedType, 15)
        : Promise.resolve([] as TrackTypeEvent[]);

    // Run all other retrievals in parallel
    const [patterns, interpretations, existingInsights, facts, dayEvents, trackTypeHistory] = await Promise.all([
        retrievePatterns(userId, targetEmbedding, config),
        retrieveInterpretations(userId, targetEmbedding, config),
        retrieveExistingInsights(userId, targetEmbedding, config),
        retrieveDeterministicFacts(userId),
        dayEventsPromise,
        trackTypeHistoryPromise,
    ]);

    console.log(
        `[InsightRetrieval] Retrieved: ${patterns.length} patterns, ` +
        `${interpretations.length} interpretations, ` +
        `${existingInsights.length} existing insights, ` +
        `${Object.keys(dayEvents).length} track types today, ` +
        `${trackTypeHistory.length} track type history events`
    );
    console.log(
        `[InsightRetrieval] Facts: ${facts.totalEvents} events, ` +
        `${facts.totalActivePatterns} active patterns, ` +
        `${facts.daysSinceFirstEvent} days of history`
    );

    return {
        trigger,
        triggerEvent,
        triggerInterpretation,
        patterns,
        interpretations,
        existingInsights,
        facts,
        dayEvents,
        trackTypeHistory,
    };
}
