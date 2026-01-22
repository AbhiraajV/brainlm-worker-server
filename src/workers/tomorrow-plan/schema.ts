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

export const FocusAreaSchema = z.object({
  area: z.string().min(5).max(100),
  reasoning: z.string().min(20).max(500),
  patternRef: z.string().optional(),
  insightRef: z.string().optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']),
});

export const SessionSchema = z.object({
  timeSlot: z.string().min(3).max(50), // e.g., "Morning (6-9am)", "Evening"
  activity: z.string().min(5).max(200),
  sessionType: z.string().min(2).max(30), // e.g., "gym", "diet", "work", "reflection", "social"
  intent: z.string().min(10).max(200), // What this session is for
  reasoning: z.string().min(20).max(500),
  patternRef: z.string().optional(),
  optional: z.boolean().default(false),
});

export const WarningSchema = z.object({
  warning: z.string().min(10).max(300),
  patternId: z.string().optional(),
  insightId: z.string().optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']),
});

export const CTASchema = z.object({
  action: z.string().min(5).max(200),
  ctaType: z.enum(['TRACK', 'NOTICE', 'REFLECT']), // TRACK=log this, NOTICE=watch for this, REFLECT=think about this
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  reasoning: z.string().min(20).max(300),
  patternRef: z.string().optional(),
});

export const TomorrowPlanOutputSchema = z.object({
  focusAreas: z.array(FocusAreaSchema).min(1).max(3),
  sessions: z.array(SessionSchema).min(1).max(6),
  warnings: z.array(WarningSchema).max(3),
  ctas: z.array(CTASchema).min(1).max(3),
  baselineStale: z.boolean(),
  baselineStaleDays: z.number().optional(),
  baselineStaleReason: z.string().min(50).max(200).optional(), // Why staleness matters (e.g., "Recent patterns differ from baseline")
  renderedMarkdown: z.string().min(100).max(5000),
});

export type TomorrowPlanOutput = z.infer<typeof TomorrowPlanOutputSchema>;
export type FocusArea = z.infer<typeof FocusAreaSchema>;
export type Session = z.infer<typeof SessionSchema>;
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
