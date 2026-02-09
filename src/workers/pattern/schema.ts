import { z } from 'zod';

/**
 * Schema for a single pattern analysis observation.
 * Each observation comes from a different analytical dimension.
 */
export const PatternAnalysisItemSchema = z.object({
    observation: z.string().describe('The structural finding'),
    evidence: z.string().describe('Specific data points supporting it'),
    timesObserved: z.number().int().min(1).describe('Count of supporting data points'),
});

export type PatternAnalysisItem = z.infer<typeof PatternAnalysisItemSchema>;

/**
 * Schema for the full pattern analysis LLM output.
 * Always produces 2-3 observations, each from a different analytical dimension.
 */
export const PatternAnalysisOutputSchema = z.object({
    patterns: z
        .array(PatternAnalysisItemSchema)
        .min(2, 'Must generate at least 2 pattern observations')
        .max(3, 'Maximum 3 pattern observations'),
});

export type PatternAnalysisOutput = z.infer<typeof PatternAnalysisOutputSchema>;
