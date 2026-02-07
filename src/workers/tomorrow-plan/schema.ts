import { z } from 'zod';

// ============================================================================
// Input Schema
// ============================================================================

export const GenerateTomorrowPlanInputSchema = z.object({
  userId: z.string().min(1),
  reviewId: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
});

export type GenerateTomorrowPlanInput = z.infer<typeof GenerateTomorrowPlanInputSchema>;

// ============================================================================
// Output Schema (LLM Response)
// ============================================================================

// Using flexible strings instead of strict enums - the LLM can use any reasonable value
// and we don't fail on minor variations. The JSON schema enforces structure, not values.

export const FocusAreaSchema = z.object({
  area: z.string(),
  reasoning: z.string(),
  patternRef: z.string().nullable().optional(),
  insightRef: z.string().nullable().optional(),
  confidence: z.string(), // e.g., "HIGH", "MEDIUM", "EMERGING" - but any string works
});

export const ActionItemSchema = z.object({
  trackType: z.string(),
  action: z.string(),
  reasoning: z.string(),
  evidence: z.string(),
  patternRef: z.string().nullable().optional(),
  insightRef: z.string().nullable().optional(),
  priority: z.string(),
});

export const WarningSchema = z.object({
  warning: z.string(),
  patternId: z.string().nullable().optional(),
  insightId: z.string().nullable().optional(),
  confidence: z.string(),
});

export const CTASchema = z.object({
  action: z.string(),
  ctaType: z.string(), // e.g., "TRACK", "NOTICE", "REFLECT" - but any string works
  priority: z.string(), // e.g., "HIGH", "MEDIUM", "LOW" - but any string works
  reasoning: z.string(),
  patternRef: z.string().nullable().optional(),
});

export const TomorrowPlanOutputSchema = z.object({
  focusAreas: z.array(FocusAreaSchema),
  actionItems: z.array(ActionItemSchema),
  warnings: z.array(WarningSchema),
  ctas: z.array(CTASchema),
  baselineStale: z.boolean(),
  baselineStaleDays: z.number().nullable().optional(),
  baselineStaleReason: z.string().nullable().optional(),
  renderedMarkdown: z.string(),
});

export type TomorrowPlanOutput = z.infer<typeof TomorrowPlanOutputSchema>;
export type FocusArea = z.infer<typeof FocusAreaSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type CTA = z.infer<typeof CTASchema>;

// ============================================================================
// Result Schema
// ============================================================================

export interface GenerateTomorrowPlanResult {
  success: boolean;
  dailyPlanId?: string;
  skipped?: boolean;
  reason?: string;
  error?: string;
}
