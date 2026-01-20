import { cosineSimilarity } from '../../services/embedding';
import { InterpretationWithEmbedding, InterpretationCluster } from './schema';

/**
 * Configuration for clustering algorithm.
 */
export interface ClusteringConfig {
    similarityThreshold: number; // Minimum similarity to be considered related (default: 0.75)
    minClusterSize: number; // Minimum events to form a pattern (default: 3)
}

export const DEFAULT_CLUSTERING_CONFIG: ClusteringConfig = {
    similarityThreshold: 0.75,
    minClusterSize: 3,
};

/**
 * Computes pairwise similarity matrix for a set of interpretations.
 */
export function computeSimilarityMatrix(
    interpretations: InterpretationWithEmbedding[]
): number[][] {
    const n = interpretations.length;
    const matrix: number[][] = Array(n)
        .fill(null)
        .map(() => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            if (i === j) {
                matrix[i][j] = 1;
            } else {
                const sim = cosineSimilarity(
                    interpretations[i].embedding,
                    interpretations[j].embedding
                );
                matrix[i][j] = sim;
                matrix[j][i] = sim;
            }
        }
    }

    return matrix;
}

/**
 * Simple greedy clustering based on similarity threshold.
 * 
 * Algorithm:
 * 1. For each unclustered interpretation, find all similar ones
 * 2. If cluster size >= minClusterSize, form a cluster
 * 3. Mark all members as clustered
 * 4. Compute centroid as mean of embeddings
 */
export function clusterInterpretations(
    interpretations: InterpretationWithEmbedding[],
    config: ClusteringConfig = DEFAULT_CLUSTERING_CONFIG
): InterpretationCluster[] {
    const n = interpretations.length;
    if (n === 0) return [];

    const similarityMatrix = computeSimilarityMatrix(interpretations);
    const clustered = new Set<number>();
    const clusters: InterpretationCluster[] = [];

    for (let i = 0; i < n; i++) {
        if (clustered.has(i)) continue;

        // Find all similar interpretations
        const similar: number[] = [i];
        for (let j = 0; j < n; j++) {
            if (i !== j && !clustered.has(j)) {
                if (similarityMatrix[i][j] >= config.similarityThreshold) {
                    similar.push(j);
                }
            }
        }

        // Form cluster if large enough
        if (similar.length >= config.minClusterSize) {
            const clusterMembers = similar.map((idx) => interpretations[idx]);

            // Compute centroid (mean embedding)
            const dims = clusterMembers[0].embedding.length;
            const centroid = new Array(dims).fill(0);
            for (const member of clusterMembers) {
                for (let d = 0; d < dims; d++) {
                    centroid[d] += member.embedding[d];
                }
            }
            for (let d = 0; d < dims; d++) {
                centroid[d] /= clusterMembers.length;
            }

            // Compute average similarity within cluster
            let totalSim = 0;
            let count = 0;
            for (let a = 0; a < similar.length; a++) {
                for (let b = a + 1; b < similar.length; b++) {
                    totalSim += similarityMatrix[similar[a]][similar[b]];
                    count++;
                }
            }
            const avgSimilarity = count > 0 ? totalSim / count : 1;

            clusters.push({
                interpretations: clusterMembers,
                centroid,
                avgSimilarity,
            });

            // Mark as clustered
            for (const idx of similar) {
                clustered.add(idx);
            }
        }
    }

    return clusters;
}

/**
 * Finds the most similar existing patterns to a cluster.
 * Used to determine if a cluster matches an existing pattern or is new.
 */
export function findSimilarPatterns(
    clusterCentroid: number[],
    patternEmbeddings: { id: string; embedding: number[] }[],
    threshold: number = 0.8
): string[] {
    const matches: string[] = [];

    for (const pattern of patternEmbeddings) {
        const sim = cosineSimilarity(clusterCentroid, pattern.embedding);
        if (sim >= threshold) {
            matches.push(pattern.id);
        }
    }

    return matches;
}
