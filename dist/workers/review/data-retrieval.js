"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ENHANCED_CONFIG = exports.DEFAULT_RETRIEVAL_CONFIG = void 0;
exports.retrieveDailyReviewData = retrieveDailyReviewData;
exports.retrieveWeeklyReviewData = retrieveWeeklyReviewData;
exports.retrieveMonthlyReviewData = retrieveMonthlyReviewData;
exports.retrieveReviewData = retrieveReviewData;
exports.reviewExists = reviewExists;
const prisma_1 = __importDefault(require("../../prisma"));
const schema_1 = require("./schema");
const temporal_utils_1 = require("./temporal-utils");
exports.DEFAULT_RETRIEVAL_CONFIG = {
    maxPatternsPerReview: 30,
    maxInsightsPerReview: 20,
    maxPriorReviews: 7, // For weekly comparisons
};
// Default weights - configurable constants, expect to tune after real data
exports.DEFAULT_ENHANCED_CONFIG = {
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
    minSimilarityThreshold: 0.4, // Reasonable floor for relevance
    noEmbeddingPenalty: 0.7, // Items without embeddings get 70% of recency score
    // Bucket allocation: 60% temporal, 40% semantic
    temporalAllocation: 0.6,
    semanticAllocation: 0.4,
    // Recency: score halves every 30 days
    recencyHalfLifeDays: 30,
    // Enable debug logging during development
    enableDebugLogging: true,
};
// ============================================================================
// Common Retrieval Functions
// ============================================================================
/**
 * Retrieves events with their interpretations for a time range.
 */
async function retrieveEventsInPeriod(userId, periodStart, periodEnd) {
    const events = await prisma_1.default.event.findMany({
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
async function retrievePatternsForPeriod(userId, periodStart, periodEnd, config) {
    // Get patterns that were reinforced in this period
    const patterns = await prisma_1.default.pattern.findMany({
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
    const eventCounts = await prisma_1.default.patternEvent.groupBy({
        by: ['patternId'],
        where: { patternId: { in: patternIds } },
        _count: { eventId: true },
    });
    const eventCountMap = new Map(eventCounts.map((ec) => [ec.patternId, ec._count.eventId]));
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
async function retrieveInsightsForPeriod(userId, periodStart, periodEnd, config) {
    // Get insights created or reinforced in this period
    const insights = await prisma_1.default.insight.findMany({
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
async function retrievePriorReviews(userId, reviewType, beforeDate, limit) {
    const reviews = await prisma_1.default.review.findMany({
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
        type: r.type,
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
async function computeDeterministicFacts(userId, periodStart, periodEnd, reviewType) {
    const now = new Date();
    // Period-specific counts
    const [eventCount, interpretationCount, patternsReinforced, patternsCreated] = await Promise.all([
        prisma_1.default.event.count({
            where: {
                userId,
                occurredAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma_1.default.interpretation.count({
            where: {
                userId,
                createdAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma_1.default.pattern.count({
            where: {
                userId,
                lastReinforcedAt: { gte: periodStart, lt: periodEnd },
            },
        }),
        prisma_1.default.pattern.count({
            where: {
                userId,
                firstDetectedAt: { gte: periodStart, lt: periodEnd },
            },
        }),
    ]);
    // Overall user stats
    const [totalEvents, totalPatterns, totalInsights, earliestEvent] = await Promise.all([
        prisma_1.default.event.count({ where: { userId } }),
        prisma_1.default.pattern.count({ where: { userId, status: 'ACTIVE' } }),
        prisma_1.default.insight.count({ where: { userId, status: { not: 'SUPERSEDED' } } }),
        prisma_1.default.event.findFirst({
            where: { userId },
            orderBy: { occurredAt: 'asc' },
            select: { occurredAt: true },
        }),
    ]);
    const daysSinceFirstEvent = earliestEvent
        ? Math.floor((now.getTime() - earliestEvent.occurredAt.getTime()) / (24 * 60 * 60 * 1000))
        : 0;
    // Time distribution for weekly/monthly
    let eventsPerDay;
    let mostActiveDay;
    let leastActiveDay;
    if (reviewType !== schema_1.ReviewType.DAILY) {
        const dayDistribution = await prisma_1.default.$queryRaw `
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
function parseEmbedding(embedding) {
    if (!embedding)
        return null;
    if (Array.isArray(embedding)) {
        return embedding;
    }
    if (typeof embedding === 'string') {
        try {
            // pgvector format: "[0.1,0.2,...]"
            const parsed = JSON.parse(embedding);
            if (Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            return null;
        }
    }
    return null;
}
/**
 * Normalizes a vector to unit length.
 */
function normalizeVector(vec) {
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude === 0)
        return vec;
    return vec.map((v) => v / magnitude);
}
/**
 * Computes a period embedding as the centroid of interpretation embeddings for events in the period.
 * Returns null if no interpretations with embeddings exist in the period.
 */
async function computePeriodEmbedding(userId, periodStart, periodEnd, config) {
    // Fetch interpretation embeddings for events in the period
    const interpretations = await prisma_1.default.$queryRaw `
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
    const embeddings = [];
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
function computeRecencyScore(lastReinforcedAt, referenceDate, halfLifeDays) {
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
function computeHybridScore(recencyScore, similarityScore, bonusScore, weights, noEmbeddingPenalty) {
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
async function retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, config) {
    const referenceDate = periodEnd;
    const limit = config.maxPatternsPerReview;
    // Calculate bucket sizes
    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);
    // Temporal bucket: existing logic (reinforced/created in period or ACTIVE)
    const temporalPatterns = await prisma_1.default.pattern.findMany({
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
    let semanticPatterns = [];
    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticPatterns = await prisma_1.default.$queryRaw `
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
    const eventCounts = await prisma_1.default.patternEvent.groupBy({
        by: ['patternId'],
        where: { patternId: { in: uniquePatternIds } },
        _count: { eventId: true },
    });
    const eventCountMap = new Map(eventCounts.map((ec) => [ec.patternId, ec._count.eventId]));
    // Build scored patterns map (deduplication happens naturally)
    const scoredMap = new Map();
    // Score temporal patterns
    for (const p of temporalPatterns) {
        const recencyScore = computeRecencyScore(p.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = p.status === 'ACTIVE' ? 1.0 : 0.0;
        // Check if this pattern also appeared in semantic bucket
        const semanticMatch = semanticPatterns.find((sp) => sp.id === p.id);
        const similarityScore = semanticMatch ? semanticMatch.similarity : null;
        const hybridScore = computeHybridScore(recencyScore, similarityScore, bonusScore, config.patternWeights, config.noEmbeddingPenalty);
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
        if (scoredMap.has(p.id))
            continue; // Already scored from temporal bucket
        const recencyScore = computeRecencyScore(p.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = p.status === 'ACTIVE' ? 1.0 : 0.0;
        const similarityScore = p.similarity;
        const hybridScore = computeHybridScore(recencyScore, similarityScore, bonusScore, config.patternWeights, config.noEmbeddingPenalty);
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
            console.log(`[Retrieval] Pattern ${p.id.slice(0, 8)}: recency=${p.recencyScore.toFixed(3)}, ` +
                `similarity=${p.similarityScore?.toFixed(3) ?? 'null'}, bonus=${p.bonusScore.toFixed(1)}, ` +
                `hybrid=${p.hybridScore.toFixed(3)}, source=${p.source}`);
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
async function retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, config) {
    const referenceDate = periodEnd;
    const limit = config.maxInsightsPerReview;
    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);
    // Temporal bucket
    const temporalInsights = await prisma_1.default.insight.findMany({
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
    let semanticInsights = [];
    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticInsights = await prisma_1.default.$queryRaw `
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
    const scoredMap = new Map();
    // Confidence bonus mapping
    const confidenceBonus = (confidence) => {
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
        const hybridScore = computeHybridScore(recencyScore, similarityScore, bonusScore, config.insightWeights, config.noEmbeddingPenalty);
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
        if (scoredMap.has(i.id))
            continue;
        const recencyScore = computeRecencyScore(i.lastReinforcedAt, referenceDate, config.recencyHalfLifeDays);
        const bonusScore = confidenceBonus(i.confidence);
        const similarityScore = i.similarity;
        const hybridScore = computeHybridScore(recencyScore, similarityScore, bonusScore, config.insightWeights, config.noEmbeddingPenalty);
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
            console.log(`[Retrieval] Insight ${i.id.slice(0, 8)}: recency=${i.recencyScore.toFixed(3)}, ` +
                `similarity=${i.similarityScore?.toFixed(3) ?? 'null'}, bonus=${i.bonusScore.toFixed(1)}, ` +
                `hybrid=${i.hybridScore.toFixed(3)}, source=${i.source}`);
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
async function retrievePriorReviewsEnhanced(userId, reviewType, beforeDate, periodEmbedding, config) {
    const limit = config.maxPriorReviews;
    const temporalLimit = Math.ceil(limit * config.temporalAllocation);
    const semanticLimit = Math.ceil(limit * config.semanticAllocation);
    // Temporal bucket: most recent reviews
    const temporalReviews = await prisma_1.default.review.findMany({
        where: {
            userId,
            type: reviewType,
            periodEnd: { lt: beforeDate },
        },
        orderBy: { periodEnd: 'desc' },
        take: temporalLimit,
    });
    // Semantic bucket: similar historical periods
    let semanticReviews = [];
    if (periodEmbedding) {
        const embeddingStr = `[${periodEmbedding.join(',')}]`;
        semanticReviews = await prisma_1.default.$queryRaw `
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
    const scoredMap = new Map();
    // Score temporal reviews
    for (const r of temporalReviews) {
        const recencyScore = computeRecencyScore(r.periodEnd, beforeDate, config.recencyHalfLifeDays);
        const semanticMatch = semanticReviews.find((sr) => sr.id === r.id);
        const similarityScore = semanticMatch ? semanticMatch.similarity : null;
        const hybridScore = computeHybridScore(recencyScore, similarityScore, 0, // No bonus for reviews
        config.reviewWeights, config.noEmbeddingPenalty);
        scoredMap.set(r.id, {
            id: r.id,
            type: r.type,
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
        if (scoredMap.has(r.id))
            continue;
        const recencyScore = computeRecencyScore(r.periodEnd, beforeDate, config.recencyHalfLifeDays);
        const similarityScore = r.similarity;
        const hybridScore = computeHybridScore(recencyScore, similarityScore, 0, config.reviewWeights, config.noEmbeddingPenalty);
        scoredMap.set(r.id, {
            id: r.id,
            type: r.type,
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
            console.log(`[Retrieval] Review ${r.periodKey}: recency=${r.recencyScore.toFixed(3)}, ` +
                `similarity=${r.similarityScore?.toFixed(3) ?? 'null'}, hybrid=${r.hybridScore.toFixed(3)}, source=${r.source}`);
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
function toEnhancedConfig(config) {
    return {
        ...exports.DEFAULT_ENHANCED_CONFIG,
        ...config,
    };
}
/**
 * Retrieves all data needed for a daily review.
 * Uses hybrid temporal + semantic retrieval when embeddings are available.
 */
async function retrieveDailyReviewData(userId, targetDate, config = exports.DEFAULT_RETRIEVAL_CONFIG) {
    const { start: periodStart, end: periodEnd } = (0, temporal_utils_1.getPeriodBounds)(schema_1.ReviewType.DAILY, targetDate);
    const enhancedConfig = toEnhancedConfig(config);
    console.log(`[DailyReview] Retrieving data for ${targetDate.toISOString().split('T')[0]}`);
    // Get current week bounds for prior daily reviews comparison
    const { start: weekStart } = (0, temporal_utils_1.getWeekBounds)(targetDate);
    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);
    // Run all retrievals in parallel using enhanced functions
    const [events, patterns, insights, priorDailyReviews, facts] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get daily reviews from current week up to this day (enhanced)
        retrievePriorReviewsEnhanced(userId, schema_1.ReviewType.DAILY, periodStart, periodEmbedding, enhancedConfig),
        computeDeterministicFacts(userId, periodStart, periodEnd, schema_1.ReviewType.DAILY),
    ]);
    // Filter prior reviews to only include current week
    const currentWeekReviews = priorDailyReviews.filter((r) => r.periodStart >= weekStart && r.periodEnd <= periodEnd);
    console.log(`[DailyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${currentWeekReviews.length} prior daily reviews`);
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
async function retrieveWeeklyReviewData(userId, targetDate, config = exports.DEFAULT_RETRIEVAL_CONFIG) {
    const { start: periodStart, end: periodEnd } = (0, temporal_utils_1.getWeekBounds)(targetDate);
    const enhancedConfig = toEnhancedConfig(config);
    console.log(`[WeeklyReview] Retrieving data for week of ${periodStart.toISOString().split('T')[0]}`);
    // Get previous week's review for comparison
    const previousWeekDate = (0, temporal_utils_1.getPreviousPeriodDate)(schema_1.ReviewType.WEEKLY, targetDate);
    const previousWeekKey = (0, temporal_utils_1.getPeriodKey)(schema_1.ReviewType.WEEKLY, previousWeekDate);
    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);
    // Run all retrievals in parallel using enhanced functions
    const [events, patterns, insights, dailyReviews, previousWeeklyReviewResult, facts] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get all daily reviews within this week (not enhanced - we want all of them)
        prisma_1.default.review.findMany({
            where: {
                userId,
                type: 'DAILY',
                periodStart: { gte: periodStart },
                periodEnd: { lte: periodEnd },
            },
            orderBy: { periodStart: 'asc' },
        }),
        // Get previous week's review (specific lookup, not enhanced)
        prisma_1.default.review.findUnique({
            where: {
                userId_type_periodKey: {
                    userId,
                    type: 'WEEKLY',
                    periodKey: previousWeekKey,
                },
            },
        }),
        computeDeterministicFacts(userId, periodStart, periodEnd, schema_1.ReviewType.WEEKLY),
    ]);
    const previousWeeklyReview = previousWeeklyReviewResult
        ? {
            id: previousWeeklyReviewResult.id,
            type: previousWeeklyReviewResult.type,
            periodKey: previousWeeklyReviewResult.periodKey,
            periodStart: previousWeeklyReviewResult.periodStart,
            periodEnd: previousWeeklyReviewResult.periodEnd,
            summary: previousWeeklyReviewResult.summary,
            structuredContent: previousWeeklyReviewResult.structuredContent,
        }
        : null;
    const formattedDailyReviews = dailyReviews.map((r) => ({
        id: r.id,
        type: r.type,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));
    console.log(`[WeeklyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${formattedDailyReviews.length} daily reviews, ` +
        `previous weekly: ${previousWeeklyReview ? 'yes' : 'no'}`);
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
async function retrieveMonthlyReviewData(userId, targetDate, config = exports.DEFAULT_RETRIEVAL_CONFIG) {
    const { start: periodStart, end: periodEnd } = (0, temporal_utils_1.getMonthBounds)(targetDate);
    const enhancedConfig = toEnhancedConfig(config);
    console.log(`[MonthlyReview] Retrieving data for ${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}`);
    // Get previous month's review for comparison
    const previousMonthDate = (0, temporal_utils_1.getPreviousPeriodDate)(schema_1.ReviewType.MONTHLY, targetDate);
    const previousMonthKey = (0, temporal_utils_1.getPeriodKey)(schema_1.ReviewType.MONTHLY, previousMonthDate);
    // Compute period embedding first (needed for enhanced retrieval)
    const periodEmbedding = await computePeriodEmbedding(userId, periodStart, periodEnd, enhancedConfig);
    // Run all retrievals in parallel using enhanced functions
    const [events, patterns, insights, weeklyReviews, previousMonthlyReviewResult, earlierMonthlyReviews, facts,] = await Promise.all([
        retrieveEventsInPeriod(userId, periodStart, periodEnd),
        retrievePatternsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        retrieveInsightsEnhanced(userId, periodStart, periodEnd, periodEmbedding, enhancedConfig),
        // Get all weekly reviews within this month (not enhanced - we want all of them)
        prisma_1.default.review.findMany({
            where: {
                userId,
                type: 'WEEKLY',
                periodStart: { gte: periodStart },
                periodEnd: { lte: periodEnd },
            },
            orderBy: { periodStart: 'asc' },
        }),
        // Get previous month's review (specific lookup, not enhanced)
        prisma_1.default.review.findUnique({
            where: {
                userId_type_periodKey: {
                    userId,
                    type: 'MONTHLY',
                    periodKey: previousMonthKey,
                },
            },
        }),
        // Get earlier monthly reviews using semantic search for similar months
        retrievePriorReviewsEnhanced(userId, schema_1.ReviewType.MONTHLY, periodStart, periodEmbedding, enhancedConfig),
        computeDeterministicFacts(userId, periodStart, periodEnd, schema_1.ReviewType.MONTHLY),
    ]);
    const previousMonthlyReview = previousMonthlyReviewResult
        ? {
            id: previousMonthlyReviewResult.id,
            type: previousMonthlyReviewResult.type,
            periodKey: previousMonthlyReviewResult.periodKey,
            periodStart: previousMonthlyReviewResult.periodStart,
            periodEnd: previousMonthlyReviewResult.periodEnd,
            summary: previousMonthlyReviewResult.summary,
            structuredContent: previousMonthlyReviewResult.structuredContent,
        }
        : null;
    const formattedWeeklyReviews = weeklyReviews.map((r) => ({
        id: r.id,
        type: r.type,
        periodKey: r.periodKey,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        summary: r.summary,
        structuredContent: r.structuredContent,
    }));
    console.log(`[MonthlyReview] Retrieved: ${events.length} events, ${patterns.length} patterns, ` +
        `${insights.length} insights, ${formattedWeeklyReviews.length} weekly reviews, ` +
        `previous monthly: ${previousMonthlyReview ? 'yes' : 'no'}, ` +
        `${earlierMonthlyReviews.length} earlier monthly reviews`);
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
async function retrieveReviewData(userId, reviewType, targetDate, config = exports.DEFAULT_RETRIEVAL_CONFIG) {
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            return retrieveDailyReviewData(userId, targetDate, config);
        case schema_1.ReviewType.WEEKLY:
            return retrieveWeeklyReviewData(userId, targetDate, config);
        case schema_1.ReviewType.MONTHLY:
            return retrieveMonthlyReviewData(userId, targetDate, config);
    }
}
/**
 * Checks if a review already exists for a period.
 */
async function reviewExists(userId, reviewType, periodKey) {
    const existing = await prisma_1.default.review.findUnique({
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
