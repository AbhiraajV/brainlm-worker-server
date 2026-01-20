import { z } from 'zod';

/**
 * Schema for LLM interpretation output.
 * Validates the rich interpretation document.
 */
export const InterpretationOutputSchema = z.object({
    interpretation: z
        .string()
        .min(200, 'Interpretation must be at least 200 characters')
        .max(15000, 'Interpretation must not exceed 15000 characters'),
});

export type InterpretationOutput = z.infer<typeof InterpretationOutputSchema>;
