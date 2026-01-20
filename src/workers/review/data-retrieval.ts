import prisma from '../../prisma';
import {
    ReviewType,
    EventWithInterpretation,
    PatternSummary,
    InsightSummary,
    PriorReview,
    DailyReviewData,
    WeeklyReviewData,
    MonthlyReviewData,
    ReviewDeterministicFacts,
    ReviewData,
} from './schema';
import {
    getPeriodBounds,
    getPeriodKey,
    getWeekBounds,
    getMonthBounds,
    getPreviousPeriodDate,
    getDatesInPeriod,
} from './temporal-utils';

// ============================================================================
// Configuration
// ============================================================================

export interface ReviewRetrievalConfig {
    maxPatternsPerReview: number;
    maxInsightsPerReview: number;
    maxPriorReviews: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: ReviewRetrievalConfig = {
    maxPatternsPerReview: 30,
    maxInsightsPerReview: 20,
    maxPriorReviews: 7, // For weekly comparisons
};

// ============================================================================
// Enhanced Retrieval Configuration (Hybrid Temporal + Semantic)
// ============================================================================

export interface HybridWeights {
    recencyWeight: number;
    similarityWeight: number;
    bonusWeight: number;
}

export interface EnhancedRetrievalConfig extends ReviewRetrievalConfig {
    // Weights for hybrid scoring (expect to tune after real data)
    patternWeights: HybridWeights;
    insightWeights: HybridWeights;
    reviewWeights: HybridWeights;

    // Similarity thresholds
    minSimilarityThreshold: number;  // Filter out low-similarity matches
    noEmbeddingPenalty: number;      // Multiplier for items without embeddings

    // Allocation between temporal and semantic buckets
    temporalAllocation: number;      // Fraction of limit for temporal bucket
    semanticAllocation: number;      // Fraction of limit for semantic bucket

    // Recency scoring
    recencyHalfLifeDays: number;     // Days until recency score halves

    // Debug logging
    enableDebugLogging: boolean;
}

// Default weights - configurable constants, expect to tune after real data
export const DEFAULT_ENHANCED_CONFIG: EnhancedRetrievalConfig = {
    // Base limits (same as before)
    maxPatternsPerReview: 30,
    maxInsightsPerReview: 20,
    maxPriorReviews: 7,

    // Hybrid weights per entity type
    // Patterns: balance recency and similarity, small bonus for ACTIVE status
    patternWeights: { recencyWeight: 0.4, similarityWeight: 0.5, bonusWeight: 0.1 },
    // Insights: favor similarity more, confidence bonus
    insightWeights: { recencyWeight: 0.3, similarityWeight: 0.6, bonusWeight: 0.1 },
    // Prior reviews: heavily favor similarity (find similar periods)
    reviewWeights: { recencyWeight: 0.2, similarityWeight: 0.8, bonusWeight: 0 },

    // Similarity thresholds
    minSimilarityThreshold: 0.4,     // Reasonable floor for relevance
    noEmbeddingPenalty: 0.7,         // Items without embeddings get 70% of recency score

    // Bucket allocation: 60% temporal, 40% semantic
    temporalAllocation: 0.6,
    semanticAllocation: 0.4,

    // Recency: score halves every 30 days
    recencyHalfLifeDays: 30,

    // Enable debug logging during development
    enableDebugLogging: true,
};

// ============================================================================
// Scored Entity Types (Internal - for hybrid ranking)
// ============================================================================

interface ScoredPattern {
    id: string;
    description: string;
    status: string;
    eventCount: number;
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
    // Scoring metadata
    recencyScore: number;
    similarityScore: number | null;  // null if no embedding match
    bonusScore: number;
    hybridScore: number;
    source: 'temporal' | 'semantic';
}

interface ScoredInsight {
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    status: string;
    category: string | null;
    // Scoring metadata
    recencyScore: number;
    similarityScore: number | null;
    bonusScore: number;
    hybridScore: number;
    source: 'temporal' | 'semantic';
}

interface ScoredReview {
    id: string;
    type: ReviewType;
    periodKey: string;
    periodStart: Date;
    periodEnd: Date;
    summary: string;
    structuredContent: unknown;
    // Scoring metadata
    recencyScore: number;
    similarityScore: number | null;
    bonusScore: number;
    hybridScore: number;
    source: 'temporal' | 'semantic';
}

// ============================================================================
// Common Retrieval Functions
// ============================================================================

/**
 * Retrieves events with their interpretations for a time range.
 */
async function retrieveEventsInPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date
): Promise<EventWithInterpretation[]> {
    const events = await prisma.event.findMany({
        where: {
            userId,
            occurredAt: {
                gte: periodStart,
                lt: periodEnd,
            },
        },
        include: {
            interpretation: {
                select: {
                    id: true,
                    content: true,
                },
            },
        },
        orderBy: { occurredAt: 'asc' },
    });

    return events.map((e) => ({
        id: e.id,
        content: e.content,
        occurredAt: e.occurredAt,
        interpretation: e.interpretation,
    }));
}

/**
 * Retrieves patterns reinforced or created within a time period.
 */
async function retrievePatternsForPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    config: ReviewRetrievalConfig
): Promise<PatternSummary[]> {
    // Get patterns that were reinforced in this period
    const patterns = await prisma.pattern.findMany({
        where: {
            userId,
            OR: [
                // Reinforced during period
                {
                    lastReinforcedAt: {
                        gte: periodStart,
                        lt: periodEnd,
                    },
                },
                // Created during period
                {
                    firstDetectedAt: {
                        gte: periodStart,
                        lt: periodEnd,
                    },
                },
                // Active patterns (for context)
                { status: 'ACTIVE' },
            ],
        },
        orderBy: { lastReinforcedAt: 'desc' },
        take: config.maxPatternsPerReview,
    });

    // Get event counts for each pattern
    const patternIds = patterns.map((p) => p.id);
    const eventCounts = await prisma.patternEvent.groupBy({
        by: ['patternId'],
        where: { patternId: { in: patternIds } },
        _count: { eventId: true },
    });

    const eventCountMap = new Map(
        eventCounts.map((ec) => [ec.patternId, ec._count.eventId])
    );

    return patterns.map((p) => ({
        id: p.id,
        description: p.description,
        status: p.status,
        eventCount: eventCountMap.get(p.id) || 0,
        firstDetectedAt: p.firstDetectedAt,
        lastReinforcedAt: p.lastReinforcedAt,
    }));
}

/**
 * Retrieves insights linked to events in a time period.
 */
async function retrieveInsightsForPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    config: ReviewRetrievalConfig
): Promise<InsightSummary[]> {
    // Get insights created or reinforced in this period
    const insights = await prisma.insight.findMany({
        where: {
            userId,
            OR: [
                {
                    firstDetectedAt: {
                        gte: periodStart,
                        lt: periodEnd,
                    },
                },
                {
                    lastReinforcedAt: {
                        gte: periodStart,
                        lt: periodEnd,
                    },
                },
            ],
            status: { not: 'SUPERSEDED' },
        },
        orderBy: { lastReinforcedAt: 'desc' },
        take: config.maxInsightsPerReview,
    });

    return insights.map((i) => ({
        id: i.id,
        statement: i.statement,
        explanation: i.explanation,
        confidence: i.confidence,
        status: i.status,
        category: i.category,
    }));
}

/**
 * Retrieves prior reviews of a specific type for a user.
 */
async function retrievePriorReviews(
    userId: string,
    reviewType: ReviewType,
    beforeDate: Date,
    limit: number
): Promise<PriorReview[]> {
    const reviews = await prisma.review.findMany({
        where: {
            userId,
            type: reviewType,
            periodEnd: { lt: beforeDate },
        },
        orderBy: { periodEnd: 'desc' },
        take: limit,
    });

    return reviews.map((r) => ({
        id: r.id,
        type: r.type as ReviewType,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));
}

/**
 * Computes deterministic facts for a review period.
 */
async function computeDeterministicFacts(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    reviewType: ReviewType
): Promise<ReviewDeterministicFacts> {
    const now = new Date();

    // Period-specific counts
    const [eventCount, interpretationCount, patternsReinforced, patternsCreated] = await Promise.all([
        prisma.event.count({
            where: {
                userId,
                occurredAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma.interpretation.count({
            where: {
                userId,
                createdAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma.pattern.count({
            where: {
                userId,
                lastReinforcedAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma.pattern.count({
            where: {
                userId,
                firstDetectedAt: { gte: periodStart, lt: periodEnd },
            },
        }),
    ]);

    // Overall user stats
    const [totalEvents, totalPatterns, totalInsights, earliestEvent] = await Promise.all([
        prisma.event.count({ where: { userId } }),
        prisma.pattern.count({ where: { userId, status: 'ACTIVE' } }),
        prisma.insight.count({ where: { userId, status: { not: 'SUPERSEDED' } } }),
        prisma.event.findFirst({
            where: { userId },
            orderBy: { occurredAt: 'asc' },
            select: { occurredAt: true },
        }),
    ]);

    const daysSinceFirstEvent = earliestEvent
        ? Math.floor((now.getTime() - earliestEvent.occurredAt.getTime()) / (24 * 60 * 60 * 1000))
        : 0;

    // Time distribution for weekly/monthly
    let eventsPerDay: Record<string, number> | undefined;
    let mostActiveDay: string | undefined;
    let leastActiveDay: string | undefined;

    if (reviewType !== ReviewType.DAILY) {
        const dayDistribution = await prisma.$queryRaw<
            Array<{ day: string; count: bigint }>
        >`
            SELECT TO_CHAR("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') as day, COUNT(*) as count
            FROM "Event"
            WHERE "userId" = ${userId}
              AND "occurredAt" >= ${periodStart}
              AND "occurredAt" < ${periodEnd}
            GROUP BY day
            ORDER BY count DESC
        `;

        eventsPerDay = {};
        for (const row of dayDistribution) {
            eventsPerDay[row.day] = Number(row.count);
        }

        if (dayDistribution.length > 0) {
            mostActiveDay = dayDistribution[0].day;
            leastActiveDay = dayDistribution[dayDistribution.length - 1].day;
        }
    }

    return {
        eventCount,
        interpretationCount,
        patternsReinforced,
        patternsCreated,
        totalEvents,
        totalPatterns,
        totalInsights,
        daysSinceFirstEvent,
        eventsPerDay,
        mostActiveDay,
        leastActiveDay,
    };
}

// ============================================================================
// Enhanced Retrieval: Embedding & Scoring Utilities
// ============================================================================

/**
 * Parses an embedding from database format (string or array) to number array.
 * pgvector returns embeddings as strings like "[0.1,0.2,...]"
 */
function parseEmbedding(embedding: unknown): number[] | null {
    if (!embedding) return null;

    if (Array.isArray(embedding)) {
        return embedding as number[];
    }

    if (typeof embedding === 'string') {
        try {
            // pgvector format: "[0.1,0.2,...]"
            const parsed = JSON.parse(embedding);
            if (Array.isArray(parsed)) {
                return parsed as number[];
            }
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Normalizes a vector to unit length.
 */
function normalizeVector(vec: number[]): number[] {
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0) return vec;
    return vec.map((v) => v / magnitude);
}

/**
 * Computes a period embedding as the centroid of interpretation embeddings for events in the period.
 * Returns null if no interpretations with embeddings exist in the period.
 */
async function computePeriodEmbedding(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    config: EnhancedRetrievalConfig
): Promise<number[] | null> {
    // Fetch interpretation embeddings for events in the period
    const interpretations = await prisma.$queryRaw<
        Array<{ embedding: string }>
    >`
        SELECT i.embedding::text as embedding
        FROM "Interpretation" i
        JOIN "Event" e ON i."eventId" = e.id
        WHERE i."userId" = ${userId}
          AND e."occurredAt" >= ${periodStart}
          AND e."occurredAt" < ${periodEnd}
          AND i.embedding IS NOT NULL
    `;

    if (interpretations.length === 0) {
        if (config.enableDebugLogging) {
            console.log(`[Retrieval] Period embedding: null (no interpretations with embeddings)`);
        }
        return null;
    }

    // Parse embeddings and compute centroid
    const embeddings: number[][] = [];
    for (const row of interpretations) {
        const parsed = parseEmbedding(row.embedding);
        if (parsed && parsed.length > 0) {
            embeddings.push(parsed);
        }
    }

    if (embeddings.length === 0) {
        if (config.enableDebugLogging) {
            console.log(`[Retrieval] Period embedding: null (failed to parse embeddings)`);
        }
        return null;
    }

    // Compute element-wise average (centroid)
    const dimensions = embeddings[0].length;
    const centroid = new Array(dimensions).fill(0);

    for (const emb of embeddings) {
        for (let i = 0; i < dimensions; i++) {
            centroid[i] += emb[i];
        }
    }

    for (let i = 0; i < dimensions; i++) {
        centroid[i] /= embeddings.length;
    }

    // Normalize to unit vector
    const normalized = normalizeVector(centroid);

    if (config.enableDebugLogging) {
        console.log(`[Retrieval] Period embedding: computed from ${embeddings.length} interpretations`);
    }

    return normalized;
}

/**
 * Computes recency score using exponential decay.
 * Score = exp(-ageDays / halfLife)
 * At halfLife days, score = ~0.5
 */
function computeRecencyScore(
    lastReinforcedAt: Date,
    referenceDate: Date,
    halfLifeDays: number
): number {
    const ageDays = (referenceDate.getTime() - lastReinforcedAt.getTime()) / (24 * 60 * 60 * 1000);
    // Clamp to positive (in case of future dates)
    const clampedAge = Math.max(0, ageDays);
    // Exponential decay: exp(-age / halfLife * ln(2)) so score halves at halfLife
    return Math.exp(-clampedAge / halfLifeDays * Math.LN2);
}

/**
 * Computes hybrid score from recency, similarity, and bonus components.
 * When similarity is null (no embedding), applies noEmbeddingPenalty to recency score.
 */
function computeHybridScore(
    recencyScore: number,
    similarityScore: number | null,
    bonusScore: number,
    weights: HybridWeights,
    noEmbeddingPenalty: number
): number {
    if (similarityScore === null) {
        // No embedding available: use penalized recency only
        return recencyScore * noEmbeddingPenalty * (weights.recencyWeight + weights.similarityWeight) +
               bonusScore * weights.bonusWeight;
    }

    return recencyScore * weights.recencyWeight +
           similarityScore * weights.similarityWeight +
           bonusScore * weights.bonusWeight;
}

// ============================================================================
// Enhanced Retrieval: Pattern Retrieval with Hybrid Scoring
// ============================================================================

/**
 * Retrieves patterns using hybrid temporal + semantic scoring.
 * Uses dual-bucket approach: temporal bucket (recent) + semantic bucket (similar).
 * Falls back to temporal-only when periodEmbedding is null.
 */
async function retrievePatternsEnhanced(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    periodEmbedding: number[] | null,
    config: EnhancedRetrievalConfig
): Promise<PatternSummary[]> {
    const referenceDate = periodEnd;
    const limit = config.maxPatternsPerReview;

    // Calculate bucket sizes
    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);

    // Temporal bucket: existing logic (reinforced/created in period or ACTIVE)
    const temporalPatterns = await prisma.pattern.findMany({
        where: {
            userId,
            OR: [
                { lastReinforcedAt: { gte: periodStart, lt: periodEnd } },
                { firstDetectedAt: { gte: periodStart, lt: periodEnd } },
                { status: 'ACTIVE' },
            ],
        },
        orderBy: { lastReinforcedAt: 'desc' },
        take: temporalLimit,
    });

    // Semantic bucket: pgvector similarity search (only if we have period embedding)
    let semanticPatterns: Array<{
        id: string;
        description: string;
        status: string;
        firstDetectedAt: Date;
        lastReinforcedAt: Date;
        similarity: number;
    }> = [];

    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticPatterns = await prisma.$queryRaw<typeof semanticPatterns>`
            SELECT
                id,
                description,
                status,
                "firstDetectedAt",
                "lastReinforcedAt",
                1 - (embedding <=> ${embeddingStr}::vector) as similarity
            FROM "Pattern"
            WHERE "userId" = ${userId}
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${config.minSimilarityThreshold}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${semanticLimit}
        `;
    }

    // Get event counts for all patterns
    const allPatternIds = [
        ...temporalPatterns.map((p) => p.id),
        ...semanticPatterns.map((p) => p.id),
    ];
    const uniquePatternIds = [...new Set(allPatternIds)];

    const eventCounts = await prisma.patternEvent.groupBy({
        by: ['patternId'],
        where: { patternId: { in: uniquePatternIds } },
        _count: { eventId: true },
    });
    const eventCountMap = new Map(
        eventCounts.map((ec) => [ec.patternId, ec._count.eventId])
    );

    // Build scored patterns map (deduplication happens naturally)
    const scoredMap = new Map<string, ScoredPattern>();

    // Score temporal patterns
    for (const p of temporalPatterns) {
        const recencyScore = computeRecencyScore(p.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = p.status === 'ACTIVE' ? 1.0 : 0.0;

        // Check if this pattern also appeared in semantic bucket
        const semanticMatch = semanticPatterns.find((sp) => sp.id === p.id);
        const similarityScore = semanticMatch ? semanticMatch.similarity : null;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            bonusScore,
            config.patternWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(p.id, {
            id: p.id,
            description: p.description,
            status: p.status,
            eventCount: eventCountMap.get(p.id) || 0,
            firstDetectedAt: p.firstDetectedAt,
            lastReinforcedAt: p.lastReinforcedAt,
            recencyScore,
            similarityScore,
            bonusScore,
            hybridScore,
            source: 'temporal',
        });
    }

    // Score semantic patterns (add if not already in map)
    for (const p of semanticPatterns) {
        if (scoredMap.has(p.id)) continue; // Already scored from temporal bucket

        const recencyScore = computeRecencyScore(p.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = p.status === 'ACTIVE' ? 1.0 : 0.0;
        const similarityScore = p.similarity;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            bonusScore,
            config.patternWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(p.id, {
            id: p.id,
            description: p.description,
            status: p.status,
            eventCount: eventCountMap.get(p.id) || 0,
            firstDetectedAt: p.firstDetectedAt,
            lastReinforcedAt: p.lastReinforcedAt,
            recencyScore,
            similarityScore,
            bonusScore,
            hybridScore,
            source: 'semantic',
        });
    }

    // Sort by hybrid score and take top N
    const sorted = Array.from(scoredMap.values())
        .sort((a, b) => b.hybridScore - a.hybridScore)
        .slice(0, limit);

    // Debug logging
    if (config.enableDebugLogging) {
        console.log(`[Retrieval] Patterns: ${temporalPatterns.length} temporal, ${semanticPatterns.length} semantic, ${sorted.length} final`);
        for (const p of sorted.slice(0, 5)) { // Log top 5
            console.log(
                `[Retrieval] Pattern ${p.id.slice(0, 8)}: recency=${p.recencyScore.toFixed(3)}, ` +
                `similarity=${p.similarityScore?.toFixed(3) ?? 'null'}, bonus=${p.bonusScore.toFixed(1)}, ` +
                `hybrid=${p.hybridScore.toFixed(3)}, source=${p.source}`
            );
        }
    }

    // Return as PatternSummary (strip scoring metadata)
    return sorted.map((p) => ({
        id: p.id,
        description: p.description,
        status: p.status,
        eventCount: p.eventCount,
        firstDetectedAt: p.firstDetectedAt,
        lastReinforcedAt: p.lastReinforcedAt,
    }));
}

// ============================================================================
// Enhanced Retrieval: Insight Retrieval with Hybrid Scoring
// ============================================================================

/**
 * Retrieves insights using hybrid temporal + semantic scoring.
 */
async function retrieveInsightsEnhanced(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    periodEmbedding: number[] | null,
    config: EnhancedRetrievalConfig
): Promise<InsightSummary[]> {
    const referenceDate = periodEnd;
    const limit = config.maxInsightsPerReview;

    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);

    // Temporal bucket
    const temporalInsights = await prisma.insight.findMany({
        where: {
            userId,
            OR: [
                { firstDetectedAt: { gte: periodStart, lt: periodEnd } },
                { lastReinforcedAt: { gte: periodStart, lt: periodEnd } },
            ],
            status: { not: 'SUPERSEDED' },
        },
        orderBy: { lastReinforcedAt: 'desc' },
        take: temporalLimit,
    });

    // Semantic bucket
    let semanticInsights: Array<{
        id: string;
        statement: string;
        explanation: string;
        confidence: string;
        status: string;
        category: string | null;
        lastReinforcedAt: Date;
        similarity: number;
    }> = [];

    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticInsights = await prisma.$queryRaw<typeof semanticInsights>`
            SELECT
                id,
                statement,
                explanation,
                confidence::text as confidence,
                status::text as status,
                category,
                "lastReinforcedAt",
                1 - (embedding <=> ${embeddingStr}::vector) as similarity
            FROM "Insight"
            WHERE "userId" = ${userId}
              AND embedding IS NOT NULL
              AND status != 'SUPERSEDED'
              AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${config.minSimilarityThreshold}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${semanticLimit}
        `;
    }

    // Build scored insights map
    const scoredMap = new Map<string, ScoredInsight>();

    // Confidence bonus mapping
    const confidenceBonus = (confidence: string): number => {
        switch (confidence) {
            case 'HIGH': return 1.0;
            case 'MEDIUM': return 0.6;
            case 'EMERGING': return 0.3;
            default: return 0.0;
        }
    };

    // Score temporal insights
    for (const i of temporalInsights) {
        const recencyScore = computeRecencyScore(i.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = confidenceBonus(i.confidence);

        const semanticMatch = semanticInsights.find((si) => si.id === i.id);
        const similarityScore = semanticMatch ? semanticMatch.similarity : null;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            bonusScore,
            config.insightWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(i.id, {
            id: i.id,
            statement: i.statement,
            explanation: i.explanation,
            confidence: i.confidence,
            status: i.status,
            category: i.category,
            recencyScore,
            similarityScore,
            bonusScore,
            hybridScore,
            source: 'temporal',
        });
    }

    // Score semantic insights
    for (const i of semanticInsights) {
        if (scoredMap.has(i.id)) continue;

        const recencyScore = computeRecencyScore(i.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = confidenceBonus(i.confidence);
        const similarityScore = i.similarity;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            bonusScore,
            config.insightWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(i.id, {
            id: i.id,
            statement: i.statement,
            explanation: i.explanation,
            confidence: i.confidence,
            status: i.status,
            category: i.category,
            recencyScore,
            similarityScore,
            bonusScore,
            hybridScore,
            source: 'semantic',
        });
    }

    const sorted = Array.from(scoredMap.values())
        .sort((a, b) => b.hybridScore - a.hybridScore)
        .slice(0, limit);

    // Debug logging
    if (config.enableDebugLogging) {
        console.log(`[Retrieval] Insights: ${temporalInsights.length} temporal, ${semanticInsights.length} semantic, ${sorted.length} final`);
        for (const i of sorted.slice(0, 5)) {
            console.log(
                `[Retrieval] Insight ${i.id.slice(0, 8)}: recency=${i.recencyScore.toFixed(3)}, ` +
                `similarity=${i.similarityScore?.toFixed(3) ?? 'null'}, bonus=${i.bonusScore.toFixed(1)}, ` +
                `hybrid=${i.hybridScore.toFixed(3)}, source=${i.source}`
            );
        }
    }

    return sorted.map((i) => ({
        id: i.id,
        statement: i.statement,
        explanation: i.explanation,
        confidence: i.confidence,
        status: i.status,
        category: i.category,
    }));
}

// ============================================================================
// Enhanced Retrieval: Prior Reviews with Semantic Search
// ============================================================================

/**
 * Retrieves prior reviews using hybrid temporal + semantic scoring.
 * Finds both recent reviews AND semantically similar historical periods.
 */
async function retrievePriorReviewsEnhanced(
    userId: string,
    reviewType: ReviewType,
    beforeDate: Date,
    periodEmbedding: number[] | null,
    config: EnhancedRetrievalConfig
): Promise<PriorReview[]> {
    const limit = config.maxPriorReviews;

    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);

    // Temporal bucket: most recent reviews
    const temporalReviews = await prisma.review.findMany({
        where: {
            userId,
            type: reviewType,
            periodEnd: { lt: beforeDate },
        },
        orderBy: { periodEnd: 'desc' },
        take: temporalLimit,
    });

    // Semantic bucket: similar historical periods
    let semanticReviews: Array<{
        id: string;
        type: string;
        periodKey: string;
        periodStart: Date;
        periodEnd: Date;
        summary: string;
        structuredContent: unknown;
        similarity: number;
    }> = [];

    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticReviews = await prisma.$queryRaw<typeof semanticReviews>`
            SELECT
                id,
                type::text as type,
                "periodKey",
                "periodStart",
                "periodEnd",
                summary,
                "structuredContent",
                1 - (embedding <=> ${embeddingStr}::vector) as similarity
            FROM "Review"
            WHERE "userId" = ${userId}
              AND type = ${reviewType}::"ReviewType"
              AND "periodEnd" < ${beforeDate}
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${config.minSimilarityThreshold}
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${semanticLimit}
        `;
    }

    // Build scored reviews map
    const scoredMap = new Map<string, ScoredReview>();

    // Score temporal reviews
    for (const r of temporalReviews) {
        const recencyScore = computeRecencyScore(r.periodEnd, beforeDate, config.recencyHalfLifeDays);

        const semanticMatch = semanticReviews.find((sr) => sr.id === r.id);
        const similarityScore = semanticMatch ? semanticMatch.similarity : null;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            0, // No bonus for reviews
            config.reviewWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(r.id, {
            id: r.id,
            type: r.type as ReviewType,
            periodKey: r.periodKey,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            summary: r.summary,
            structuredContent: r.structuredContent,
            recencyScore,
            similarityScore,
            bonusScore: 0,
            hybridScore,
            source: 'temporal',
        });
    }

    // Score semantic reviews
    for (const r of semanticReviews) {
        if (scoredMap.has(r.id)) continue;

        const recencyScore = computeRecencyScore(r.periodEnd, beforeDate, config.recencyHalfLifeDays);
        const similarityScore = r.similarity;

        const hybridScore = computeHybridScore(
            recencyScore,
            similarityScore,
            0,
            config.reviewWeights,
            config.noEmbeddingPenalty
        );

        scoredMap.set(r.id, {
            id: r.id,
            type: r.type as ReviewType,
            periodKey: r.periodKey,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            summary: r.summary,
            structuredContent: r.structuredContent,
            recencyScore,
            similarityScore,
            bonusScore: 0,
            hybridScore,
            source: 'semantic',
        });
    }

    const sorted = Array.from(scoredMap.values())
        .sort((a, b) => b.hybridScore - a.hybridScore)
        .slice(0, limit);

    // Debug logging
    if (config.enableDebugLogging) {
        console.log(`[Retrieval] Prior reviews (${reviewType}): ${temporalReviews.length} temporal, ${semanticReviews.length} semantic, ${sorted.length} final`);
        for (const r of sorted.slice(0, 3)) {
            console.log(
                `[Retrieval] Review ${r.periodKey}: recency=${r.recencyScore.toFixed(3)}, ` +
                `similarity=${r.similarityScore?.toFixed(3) ?? 'null'}, hybrid=${r.hybridScore.toFixed(3)}, source=${r.source}`
            );
        }
    }

    return sorted.map((r) => ({
        id: r.id,
        type: r.type,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));
}

// ============================================================================
// Review Type Specific Retrieval
// ============================================================================

/**
 * Merges basic config with enhanced defaults to get full EnhancedRetrievalConfig.
 */
function toEnhancedConfig(config: ReviewRetrievalConfig): EnhancedRetrievalConfig {
    return {
        ...DEFAULT_ENHANCED_CONFIG,
        ...config,
    };
}

/**
 * Retrieves all data needed for a daily review.
 * Uses hybrid temporal + semantic retrieval when embeddings are available.
 */
export async function retrieveDailyReviewData(
    userId: string,
    targetDate: Date,
    config: ReviewRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<DailyReviewData> {
    const { start: periodStart, end: periodEnd } = getPeriodBounds(ReviewType.DAILY, targetDate);
    const enhancedConfig = toEnhancedConfig(config);

    console.log(`[DailyReview] Retrieving data for ${targetDate.toISOString().split('T')[0]}`);

    // Get current week bounds for prior daily reviews comparison
    const { start: weekStart } = getWeekBounds(targetDate);

    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);

    // Run all retrievals in parallel using enhanced functions
    const [events, patterns, insights, priorDailyReviews, facts] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get daily reviews from current week up to this day (enhanced)
        retrievePriorReviewsEnhanced(userId, ReviewType.DAILY, periodStart, periodEmbedding, enhancedConfig),
        computeDeterministicFacts(userId, periodStart, periodEnd, ReviewType.DAILY),
    ]);

    // Filter prior reviews to only include current week
    const currentWeekReviews = priorDailyReviews.filter(
        (r) => r.periodStart >= weekStart && r.periodEnd <= periodEnd
    );

    console.log(
        `[DailyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${currentWeekReviews.length} prior daily reviews`
    );

    return {
        events,
        patterns,
        insights,
        priorDailyReviews: currentWeekReviews,
        facts,
    };
}

/**
 * Retrieves all data needed for a weekly review.
 * Uses hybrid temporal + semantic retrieval when embeddings are available.
 */
export async function retrieveWeeklyReviewData(
    userId: string,
    targetDate: Date,
    config: ReviewRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<WeeklyReviewData> {
    const { start: periodStart, end: periodEnd } = getWeekBounds(targetDate);
    const enhancedConfig = toEnhancedConfig(config);

    console.log(
        `[WeeklyReview] Retrieving data for week of ${periodStart.toISOString().split('T')[0]}`
    );

    // Get previous week's review for comparison
    const previousWeekDate = getPreviousPeriodDate(ReviewType.WEEKLY, targetDate);
    const previousWeekKey = getPeriodKey(ReviewType.WEEKLY, previousWeekDate);

    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);

    // Run all retrievals in parallel using enhanced functions
    const [events, patterns, insights, dailyReviews, previousWeeklyReviewResult, facts] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get all daily reviews within this week (not enhanced - we want all of them)
        prisma.review.findMany({
            where: {
                userId,
                type: 'DAILY',
                periodStart: { gte: periodStart },
                periodEnd: { lte: periodEnd },
            },
            orderBy: { periodStart: 'asc' },
        }),
        // Get previous week's review (specific lookup, not enhanced)
        prisma.review.findUnique({
            where: {
                userId_type_periodKey: {
                    userId,
                    type: 'WEEKLY',
                    periodKey: previousWeekKey,
                },
            },
        }),
        computeDeterministicFacts(userId, periodStart, periodEnd, ReviewType.WEEKLY),
    ]);

    const previousWeeklyReview = previousWeeklyReviewResult
        ? {
              id: previousWeeklyReviewResult.id,
              type: previousWeeklyReviewResult.type as ReviewType,
              periodKey: previousWeeklyReviewResult.periodKey,
              periodStart: previousWeeklyReviewResult.periodStart,
              periodEnd: previousWeeklyReviewResult.periodEnd,
              summary: previousWeeklyReviewResult.summary,
              structuredContent: previousWeeklyReviewResult.structuredContent,
          }
        : null;

    const formattedDailyReviews: PriorReview[] = dailyReviews.map((r) => ({
        id: r.id,
        type: r.type as ReviewType,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));

    console.log(
        `[WeeklyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${formattedDailyReviews.length} daily reviews, ` +
        `previous weekly: ${previousWeeklyReview ? 'yes' : 'no'}`
    );

    return {
        events,
        patterns,
        insights,
        dailyReviews: formattedDailyReviews,
        previousWeeklyReview,
        facts,
    };
}

/**
 * Retrieves all data needed for a monthly review.
 * Uses hybrid temporal + semantic retrieval when embeddings are available.
 */
export async function retrieveMonthlyReviewData(
    userId: string,
    targetDate: Date,
    config: ReviewRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<MonthlyReviewData> {
    const { start: periodStart, end: periodEnd } = getMonthBounds(targetDate);
    const enhancedConfig = toEnhancedConfig(config);

    console.log(
        `[MonthlyReview] Retrieving data for ${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}`
    );

    // Get previous month's review for comparison
    const previousMonthDate = getPreviousPeriodDate(ReviewType.MONTHLY, targetDate);
    const previousMonthKey = getPeriodKey(ReviewType.MONTHLY, previousMonthDate);

    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);

    // Run all retrievals in parallel using enhanced functions
    const [
        events,
        patterns,
        insights,
        weeklyReviews,
        previousMonthlyReviewResult,
        earlierMonthlyReviews,
        facts,
    ] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get all weekly reviews within this month (not enhanced - we want all of them)
        prisma.review.findMany({
            where: {
                userId,
                type: 'WEEKLY',
                periodStart: { gte: periodStart },
                periodEnd: { lte: periodEnd },
            },
            orderBy: { periodStart: 'asc' },
        }),
        // Get previous month's review (specific lookup, not enhanced)
        prisma.review.findUnique({
            where: {
                userId_type_periodKey: {
                    userId,
                    type: 'MONTHLY',
                    periodKey: previousMonthKey,
                },
            },
        }),
        // Get earlier monthly reviews using semantic search for similar months
        retrievePriorReviewsEnhanced(userId, ReviewType.MONTHLY, periodStart, periodEmbedding, enhancedConfig),
        computeDeterministicFacts(userId, periodStart, periodEnd, ReviewType.MONTHLY),
    ]);

    const previousMonthlyReview = previousMonthlyReviewResult
        ? {
              id: previousMonthlyReviewResult.id,
              type: previousMonthlyReviewResult.type as ReviewType,
              periodKey: previousMonthlyReviewResult.periodKey,
              periodStart: previousMonthlyReviewResult.periodStart,
              periodEnd: previousMonthlyReviewResult.periodEnd,
              summary: previousMonthlyReviewResult.summary,
              structuredContent: previousMonthlyReviewResult.structuredContent,
          }
        : null;

    const formattedWeeklyReviews: PriorReview[] = weeklyReviews.map((r) => ({
        id: r.id,
        type: r.type as ReviewType,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));

    console.log(
        `[MonthlyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${formattedWeeklyReviews.length} weekly reviews, ` +
        `previous monthly: ${previousMonthlyReview ? 'yes' : 'no'}, ` +
        `${earlierMonthlyReviews.length} earlier monthly reviews`
    );

    return {
        events,
        patterns,
        insights,
        weeklyReviews: formattedWeeklyReviews,
        previousMonthlyReview,
        earlierMonthlyReviews, // Already PriorReview[] from retrievePriorReviewsEnhanced
        facts,
    };
}

// ============================================================================
// Main Retrieval Function
// ============================================================================

/**
 * Retrieves all data needed for a review based on type.
 */
export async function retrieveReviewData(
    userId: string,
    reviewType: ReviewType,
    targetDate: Date,
    config: ReviewRetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): Promise<ReviewData> {
    switch (reviewType) {
        case ReviewType.DAILY:
            return retrieveDailyReviewData(userId, targetDate, config);

        case ReviewType.WEEKLY:
            return retrieveWeeklyReviewData(userId, targetDate, config);

        case ReviewType.MONTHLY:
            return retrieveMonthlyReviewData(userId, targetDate, config);
    }
}

/**
 * Checks if a review already exists for a period.
 */
export async function reviewExists(
    userId: string,
    reviewType: ReviewType,
    periodKey: string
): Promise<boolean> {
    const existing = await prisma.review.findUnique({
        where: {
            userId_type_periodKey: {
                userId,
                type: reviewType,
                periodKey,
            },
        },
        select: { id: true },
    });

    return existing !== null;
}
