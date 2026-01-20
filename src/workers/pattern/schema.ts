import { z } from 'zod';

/**
 * Mandatory outcome for pattern detection.
 * Every call MUST produce one of these outcomes.
 */
export enum PatternOutcome {
    REINFORCED_PATTERN = 'REINFORCED_PATTERN',
    EVOLVED_PATTERN = 'EVOLVED_PATTERN',
    CREATED_NEW_PATTERN = 'CREATED_NEW_PATTERN',
}

/**
 * Schema for LLM pattern synthesis output.
 */
export const PatternOutputSchema = z.object({
    pattern: z
        .string()
        .min(100, 'Pattern description must be at least 100 characters')
        .max(10000, 'Pattern description must not exceed 10000 characters'),
});

export type PatternOutput = z.infer<typeof PatternOutputSchema>;

/**
 * Represents an interpretation with its embedding for clustering.
 */
export interface InterpretationWithEmbedding {
    id: string;
    eventId: string;
    userId: string;
    content: string;
    embedding: number[];
    createdAt: Date;
}

/**
 * Represents a cluster of similar interpretations.
 */
export interface InterpretationCluster {
    interpretations: InterpretationWithEmbedding[];
    centroid: number[];
    avgSimilarity: number;
}
