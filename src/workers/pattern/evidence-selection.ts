import prisma from '../../prisma';
import { cosineSimilarity } from '../../services/embedding';
import { InterpretationWithEmbedding } from './schema';

// ============================================================================
// Types
// ============================================================================

export interface EvidenceSelectionConfig {
    maxGlobalSimilar: number;        // Top-K most similar (global, no time filter)
    maxRecent: number;               // Top-K most recent matching
    maxOldest: number;               // Top-K oldest matching (historical recurrence)
    maxFromExistingPatterns: number; // Top-K from related existing patterns
    dedupeThreshold: number;         // Similarity threshold for deduplication (e.g., 0.95)
    maxTotal: number;                // Final cap on evidence set
    mandatoryRecentCount: number;    // Always include last N regardless of similarity
}

export const DEFAULT_EVIDENCE_CONFIG: EvidenceSelectionConfig = {
    maxGlobalSimilar: 8,
    maxRecent: 6,
    maxOldest: 4,
    maxFromExistingPatterns: 5,
    dedupeThreshold: 0.95,
    maxTotal: 25,
    mandatoryRecentCount: 5,  // Always include last 5 events
};

export interface ScoredInterpretation {
    interpretation: InterpretationWithEmbedding;
    similarityScore: number;
    recencyScore: number;
    fromPatternId?: string;  // If this came from pattern-relative retrieval
    combinedScore: number;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Selects representative evidence for pattern synthesis.
 *
 * Strategy:
 * 1. Full-timeline semantic search (no time filter)
 * 2. Top-K most similar interpretations (global)
 * 3. Top-K most recent matching interpretations
 * 4. Top-K oldest matching interpretations (historical recurrence)
 * 5. Top-K from existing similar patterns (pattern-relative)
 * 6. Deduplicate near-duplicates
 * 7. Cap at maxTotal
 *
 * This allows patterns to reflect the user's entire behavioral history
 * without exploding context size.
 */
export async function selectRepresentativeEvidence(
    userId: string,
    targetEmbedding: number[],
    config: EvidenceSelectionConfig = DEFAULT_EVIDENCE_CONFIG
): Promise<ScoredInterpretation[]> {
    const embeddingStr = `[${targetEmbedding.join(',')}]`;

    // ========================================================================
    // 1. Fetch ALL interpretations with embeddings (full timeline)
    // ========================================================================

    const allInterpretations = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            userId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT 
            id, 
            "eventId", 
            "userId", 
            content, 
            embedding::text,
            "createdAt"
        FROM "Interpretation"
        WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
        ORDER BY "createdAt" DESC
        LIMIT 200
    `;

    if (allInterpretations.length === 0) {
        return [];
    }

    // Parse embeddings and compute similarity scores
    const scored: ScoredInterpretation[] = allInterpretations.map((row) => {
        const embedding = parseEmbedding(row.embedding);
        const similarityScore = cosineSimilarity(targetEmbedding, embedding);

        // Recency score: 1.0 for today, decays over time
        const ageMs = Date.now() - row.createdAt.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-ageDays / 30); // Half-life ~30 days

        return {
            interpretation: {
                id: row.id,
                eventId: row.eventId,
                userId: row.userId,
                content: row.content,
                embedding,
                createdAt: row.createdAt,
            },
            similarityScore,
            recencyScore,
            combinedScore: similarityScore * 0.7 + recencyScore * 0.3,
        };
    });

    // ========================================================================
    // 2. Select Top-K by different strategies
    // ========================================================================

    // Filter to only reasonably similar items (threshold 0.5)
    const relevant = scored.filter((s) => s.similarityScore >= 0.5);

    // Strategy A: Top-K most similar (global)
    const bySimilarity = [...relevant]
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, config.maxGlobalSimilar);

    // Strategy B: Top-K most recent
    const byRecency = [...relevant]
        .sort((a, b) => b.recencyScore - a.recencyScore)
        .slice(0, config.maxRecent);

    // Strategy C: Top-K oldest (historical recurrence)
    const byOldest = [...relevant]
        .sort((a, b) => a.recencyScore - b.recencyScore) // Ascending recency = oldest
        .slice(0, config.maxOldest);

    // ========================================================================
    // 3. Pattern-Relative Retrieval
    // ========================================================================

    const fromPatterns = await fetchFromSimilarPatterns(
        userId,
        targetEmbedding,
        config.maxFromExistingPatterns
    );

    // ========================================================================
    // 4. Merge and Deduplicate
    // ========================================================================

    const merged = new Map<string, ScoredInterpretation>();

    // Add from each strategy (later ones override if same ID)
    for (const item of [...byOldest, ...byRecency, ...bySimilarity, ...fromPatterns]) {
        merged.set(item.interpretation.id, item);
    }

    let candidates = Array.from(merged.values());

    // Ensure most recent events are always included (causal context)
    if (config.mandatoryRecentCount > 0) {
        const recentByDate = [...scored]
            .sort((a, b) => b.interpretation.createdAt.getTime() - a.interpretation.createdAt.getTime())
            .slice(0, config.mandatoryRecentCount);

        for (const item of recentByDate) {
            if (!merged.has(item.interpretation.id)) {
                merged.set(item.interpretation.id, item);
            }
        }
        candidates = Array.from(merged.values());
    }

    // Deduplicate near-duplicates (keep the one with higher combined score)
    candidates = deduplicateByEmbedding(candidates, config.dedupeThreshold);

    // ========================================================================
    // 5. Final ranking and cap
    // ========================================================================

    candidates.sort((a, b) => b.combinedScore - a.combinedScore);

    return candidates.slice(0, config.maxTotal);
}

// ============================================================================
// Pattern-Relative Retrieval
// ============================================================================

/**
 * Fetches interpretations from existing patterns that are similar to the target.
 * This allows patterns to evolve rather than restart.
 */
async function fetchFromSimilarPatterns(
    userId: string,
    targetEmbedding: number[],
    maxItems: number
): Promise<ScoredInterpretation[]> {
    const embeddingStr = `[${targetEmbedding.join(',')}]`;

    // Find similar existing patterns
    const similarPatterns = await prisma.$queryRaw<
        Array<{ id: string; embedding: string; similarity: number }>
    >`
        SELECT 
            id, 
            embedding::text,
            1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "Pattern"
        WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
            AND status = 'ACTIVE'
            AND 1 - (embedding <=> ${embeddingStr}::vector) >= 0.6
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT 5
    `;

    if (similarPatterns.length === 0) {
        return [];
    }

    const patternIds = similarPatterns.map((p) => p.id);

    // Fetch interpretations linked to these patterns via PatternEvent
    const linkedInterpretations = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            userId: string;
            content: string;
            embedding: string;
            createdAt: Date;
            patternId: string;
        }>
    >`
        SELECT DISTINCT
            i.id,
            i."eventId",
            i."userId",
            i.content,
            i.embedding::text,
            i."createdAt",
            pe."patternId"
        FROM "Interpretation" i
        JOIN "PatternEvent" pe ON pe."eventId" = i."eventId"
        WHERE pe."patternId" = ANY(${patternIds})
            AND i.embedding IS NOT NULL
        LIMIT ${maxItems * 2}
    `;

    // Score them
    const scored: ScoredInterpretation[] = linkedInterpretations.map((row) => {
        const embedding = parseEmbedding(row.embedding);
        const similarityScore = cosineSimilarity(targetEmbedding, embedding);

        const ageMs = Date.now() - row.createdAt.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyScore = Math.exp(-ageDays / 30);

        return {
            interpretation: {
                id: row.id,
                eventId: row.eventId,
                userId: row.userId,
                content: row.content,
                embedding,
                createdAt: row.createdAt,
            },
            similarityScore,
            recencyScore,
            fromPatternId: row.patternId,
            combinedScore: similarityScore * 0.6 + recencyScore * 0.2 + 0.2, // Bonus for pattern-relative
        };
    });

    return scored.slice(0, maxItems);
}

// ============================================================================
// Helpers
// ============================================================================

function parseEmbedding(embeddingStr: string): number[] {
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

/**
 * Removes near-duplicate interpretations based on embedding similarity.
 * Keeps the one with the higher combined score.
 */
function deduplicateByEmbedding(
    items: ScoredInterpretation[],
    threshold: number
): ScoredInterpretation[] {
    const result: ScoredInterpretation[] = [];

    for (const item of items) {
        let isDuplicate = false;

        for (const existing of result) {
            const sim = cosineSimilarity(
                item.interpretation.embedding,
                existing.interpretation.embedding
            );
            if (sim >= threshold) {
                isDuplicate = true;
                // Keep the higher scored one
                if (item.combinedScore > existing.combinedScore) {
                    const idx = result.indexOf(existing);
                    result[idx] = item;
                }
                break;
            }
        }

        if (!isDuplicate) {
            result.push(item);
        }
    }

    return result;
}
