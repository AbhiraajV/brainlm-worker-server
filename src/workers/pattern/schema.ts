import { z } from 'zod';

/**
 * Mandatory outcome for pattern detection.
 * Every call MUST produce one of these outcomes.
 * Note: EVOLVED_PATTERN is deprecated - we now only REINFORCE or CREATE.
 */
export enum PatternOutcome {
    REINFORCED_PATTERN = 'REINFORCED_PATTERN',
    EVOLVED_PATTERN = 'EVOLVED_PATTERN', // Deprecated - kept for backward compatibility
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

/**
 * Schema for LLM pattern decision output.
 * LLM always decides: reinforce an existing pattern OR create a new one.
 * Key: LLM must verify SEMANTIC RELEVANCE before reinforcing.
 *
 * Note: Uses nullable() instead of optional() to match OpenAI's structured outputs
 * which return null for missing optional fields.
 */
export const PatternDecisionSchema = z.object({
    action: z.enum(['reinforce', 'create']),
    patternId: z.string().nullable().optional(), // Required if action=reinforce
    description: z.string().nullable().optional(), // Required if action=create - enforced as string by OpenAI structured outputs
    reasoning: z.string(), // Why this decision was made
});

export type PatternDecision = z.infer<typeof PatternDecisionSchema>;
