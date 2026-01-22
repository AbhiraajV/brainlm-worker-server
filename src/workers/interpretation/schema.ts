import { z } from 'zod';

/**
 * Schema for LLM interpretation output.
 * Validates the rich interpretation document.
 */
export const InterpretationOutputSchema = z.object({
    interpretation: z
        .string()
        .min(50, 'Interpretation must be at least 50 characters')
        .max(5000, 'Interpretation must not exceed 5000 characters'),
});

export type InterpretationOutput = z.infer<typeof InterpretationOutputSchema>;
