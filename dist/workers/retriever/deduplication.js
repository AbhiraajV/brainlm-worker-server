"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deduplicateAndControl = deduplicateAndControl;
const prisma_1 = __importDefault(require("../../prisma"));
const embedding_1 = require("../../services/embedding");
const schema_1 = require("./schema");
// Time boundaries for coverage control
const RECENT_DAYS = 7;
const HISTORICAL_DAYS = 30;
/**
 * Deduplicates evidence and ensures temporal coverage.
 *
 * Step 6 of the retriever pipeline.
 *
 * 1. Removes exact content duplicates
 * 2. Removes items with >threshold cosine similarity
 * 3. Ensures minimum recent items (last 7 days)
 * 4. Ensures minimum historical items (>30 days)
 * 5. Caps total items per question
 *
 * @param evidence - All normalized evidence (grouped by source)
 * @param config - Retriever configuration
 * @param userId - User ID (for coverage control fetches)
 * @returns Deduplicated and coverage-controlled evidence
 */
async function deduplicateAndControl(evidence, config, userId) {
    console.log('[Retriever] Step 6: Deduplicating and applying coverage control...');
    // Flatten all evidence for deduplication
    const allEvidence = [
        ...evidence.events,
        ...evidence.interpretations,
        ...evidence.patterns,
        ...evidence.insights,
    ];
    // Step 1: Remove exact content duplicates
    const uniqueContent = dedupeByContent(allEvidence);
    // Step 2: Remove high-similarity items (expensive, so do after content dedupe)
    const dedupedEvidence = await dedupeByEmbeddingSimilarity(uniqueContent, config.dedupeThreshold);
    // Separate back by source
    let events = dedupedEvidence.filter(e => e.source === schema_1.EvidenceSource.EVENT);
    let interpretations = dedupedEvidence.filter(e => e.source === schema_1.EvidenceSource.INTERPRETATION);
    let patterns = dedupedEvidence.filter(e => e.source === schema_1.EvidenceSource.PATTERN);
    let insights = dedupedEvidence.filter(e => e.source === schema_1.EvidenceSource.INSIGHT);
    // Step 3: Coverage control for events (they have timestamps)
    const now = new Date();
    const recentBoundary = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
    const historicalBoundary = new Date(now.getTime() - HISTORICAL_DAYS * 24 * 60 * 60 * 1000);
    const recentEvents = events.filter(e => e.timestamp >= recentBoundary);
    const historicalEvents = events.filter(e => e.timestamp < historicalBoundary);
    // Add more recent events if needed
    if (recentEvents.length < config.minRecentItems) {
        const additionalRecent = await fetchRecentEvents(userId, config.minRecentItems - recentEvents.length, recentBoundary, events.map(e => e.id));
        events = [...events, ...additionalRecent];
    }
    // Add more historical events if needed
    if (historicalEvents.length < config.minHistoricalItems) {
        const additionalHistorical = await fetchHistoricalEvents(userId, config.minHistoricalItems - historicalEvents.length, historicalBoundary, events.map(e => e.id));
        events = [...events, ...additionalHistorical];
    }
    // Step 4: Sort each source by relevance and cap
    events = sortAndCap(events, config.maxTotalPerQuestion);
    interpretations = sortAndCap(interpretations, config.maxTotalPerQuestion);
    patterns = sortAndCap(patterns, config.maxTotalPerQuestion);
    insights = sortAndCap(insights, config.maxTotalPerQuestion);
    // Apply global cap across all sources
    const totalItems = events.length + interpretations.length + patterns.length + insights.length;
    if (totalItems > config.maxTotalPerQuestion) {
        // Proportionally reduce each source
        const ratio = config.maxTotalPerQuestion / totalItems;
        events = events.slice(0, Math.max(1, Math.floor(events.length * ratio)));
        interpretations = interpretations.slice(0, Math.max(1, Math.floor(interpretations.length * ratio)));
        patterns = patterns.slice(0, Math.max(1, Math.floor(patterns.length * ratio)));
        insights = insights.slice(0, Math.max(1, Math.floor(insights.length * ratio)));
    }
    console.log(`[Retriever] Step 6 complete: ${events.length} events, ${interpretations.length} interpretations, ` +
        `${patterns.length} patterns, ${insights.length} insights after dedup`);
    return { events, interpretations, patterns, insights };
}
/**
 * Remove items with identical content.
 */
function dedupeByContent(evidence) {
    const seen = new Set();
    const unique = [];
    for (const item of evidence) {
        // Normalize content for comparison
        const normalizedContent = item.content.toLowerCase().trim();
        if (!seen.has(normalizedContent)) {
            seen.add(normalizedContent);
            unique.push(item);
        }
    }
    return unique;
}
/**
 * Remove items with high embedding similarity.
 * Only checks items from the same source to avoid cross-source removal.
 */
async function dedupeByEmbeddingSimilarity(evidence, threshold) {
    if (evidence.length <= 1) {
        return evidence;
    }
    // Group by source
    const bySource = new Map();
    for (const item of evidence) {
        const existing = bySource.get(item.source) ?? [];
        existing.push(item);
        bySource.set(item.source, existing);
    }
    const result = [];
    // Dedupe within each source
    for (const [source, items] of bySource) {
        if (items.length <= 1) {
            result.push(...items);
            continue;
        }
        // For small sets, use pairwise comparison
        // For large sets, this would be expensive - we could use LSH but keep simple for now
        if (items.length > 50) {
            // Skip expensive similarity check for large sets
            // Just keep top items by relevance
            result.push(...items.slice(0, 30));
            continue;
        }
        // Generate embeddings for all items in this source
        const embeddings = await Promise.all(items.map(item => (0, embedding_1.embedText)({ text: item.content.substring(0, 8000) })));
        const kept = new Set();
        kept.add(0); // Always keep the first (highest relevance)
        for (let i = 1; i < items.length; i++) {
            let isDuplicate = false;
            for (const keptIdx of kept) {
                const similarity = (0, embedding_1.cosineSimilarity)(embeddings[i].embedding, embeddings[keptIdx].embedding);
                if (similarity > threshold) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                kept.add(i);
            }
        }
        for (const idx of kept) {
            result.push(items[idx]);
        }
    }
    return result;
}
/**
 * Fetch recent events for coverage control.
 */
async function fetchRecentEvents(userId, limit, recentBoundary, excludeIds) {
    const events = await prisma_1.default.event.findMany({
        where: {
            userId,
            occurredAt: { gte: recentBoundary },
            id: { notIn: excludeIds },
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        select: {
            id: true,
            content: true,
            occurredAt: true,
        },
    });
    return events.map(event => ({
        source: schema_1.EvidenceSource.EVENT,
        id: event.id,
        content: event.content,
        relatedEventId: event.id,
        timestamp: event.occurredAt,
        whyThisWasRetrieved: `Added for recent temporal coverage (last ${RECENT_DAYS} days)`,
        relevanceScore: 0.5, // Lower score since not similarity-matched
        retrievalReason: schema_1.RetrievalReason.COVERAGE_CONTROL,
    }));
}
/**
 * Fetch historical events for coverage control.
 */
async function fetchHistoricalEvents(userId, limit, historicalBoundary, excludeIds) {
    const events = await prisma_1.default.event.findMany({
        where: {
            userId,
            occurredAt: { lt: historicalBoundary },
            id: { notIn: excludeIds },
        },
        orderBy: { occurredAt: 'desc' },
        take: limit,
        select: {
            id: true,
            content: true,
            occurredAt: true,
        },
    });
    return events.map(event => ({
        source: schema_1.EvidenceSource.EVENT,
        id: event.id,
        content: event.content,
        relatedEventId: event.id,
        timestamp: event.occurredAt,
        whyThisWasRetrieved: `Added for historical coverage (>${HISTORICAL_DAYS} days ago)`,
        relevanceScore: 0.4, // Even lower score for historical coverage
        retrievalReason: schema_1.RetrievalReason.COVERAGE_CONTROL,
    }));
}
/**
 * Sort by relevance and cap at limit.
 */
function sortAndCap(evidence, limit) {
    return evidence
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, limit);
}
