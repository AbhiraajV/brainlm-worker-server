import { z } from 'zod';

// ============================================================================
// Input Schema
// ============================================================================

export const SuggestUOMUpdateInputSchema = z.object({
  userId: z.string().min(1),
  dailyPlanId: z.string().min(1),
});

export type SuggestUOMUpdateInput = z.infer<typeof SuggestUOMUpdateInputSchema>;

// ============================================================================
// Output Schema (LLM Response)
// ============================================================================

export const UOMSuggestionOutputSchema = z.object({
  shouldSuggest: z.boolean(),
  skipReason: z.string().max(200).optional(), // Why no suggestion (cooldown, no drift, etc.)

  suggestion: z.object({
    content: z.string().min(20).max(500), // What should be changed in baseline
    reasoning: z.string().min(50).max(1000), // Why (evidence summary)
    driftType: z.enum(['ADDITION', 'MODIFICATION', 'REMOVAL']),
    confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']),
    targetSection: z.string().max(100).optional(), // Which section of baseline to update
    patternRefs: z.array(z.string()), // Pattern IDs supporting this
    insightRefs: z.array(z.string()), // Insight IDs supporting this
    reviewRefs: z.array(z.string()), // Review IDs supporting this
  }).optional(),

  processingNotes: z.string().max(500).optional(),
});

export type UOMSuggestionOutput = z.infer<typeof UOMSuggestionOutputSchema>;

// ============================================================================
// Result Schema
// ============================================================================

export interface SuggestUOMUpdateResult {
  success: boolean;
  suggestionId?: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
}
