import { z } from 'zod';

// ============================================================================
// Enums (matching Prisma schema)
// ============================================================================

export enum ReviewType {
    DAILY = 'DAILY',
    WEEKLY = 'WEEKLY',
    MONTHLY = 'MONTHLY',
}

// ============================================================================
// TypeScript Types for Structured Content
// ============================================================================
// Note: These are for TypeScript type hints only. Validation is handled by
// OpenAI Structured Outputs at the API level, not by Zod at runtime.
// This ensures the review generation NEVER fails due to schema mismatches.

// Daily review structured content
export interface DailyStructuredContent {
    activities?: string[];
    emotions?: Array<{
        emotion: string;
        intensity?: string;
        context?: string;
    }>;
    estimatedMetrics?: Array<{
        metric: string;
        value: string;
        basis?: string;
        confidence?: string;
    }>;
    patternsReinforced?: Array<{
        patternId?: string;
        description: string;
    }>;
    patternsAbsent?: Array<{
        patternId?: string;
        description: string;
        significance?: string;
    }>;
    dataGaps?: Array<{
        description: string;
        loggingSuggestion?: string;
    }>;
    comparisonToRecent?: string;
    reflections?: Array<{
        question: string;
        answer: string;
    }>;
    [key: string]: unknown; // Allow any additional fields
}

// Weekly review structured content
export interface WeeklyStructuredContent {
    behaviorsIncreased?: Array<{
        behavior: string;
        change: string;
    }>;
    behaviorsDecreased?: Array<{
        behavior: string;
        change: string;
    }>;
    strongestDays?: Array<{
        day: string;
        reason: string;
    }>;
    weakestDays?: Array<{
        day: string;
        reason: string;
    }>;
    emergingPatterns?: Array<{
        description: string;
        evidence?: string;
    }>;
    collapsingPatterns?: Array<{
        patternId?: string;
        description: string;
        evidence?: string;
    }>;
    habitStability?: {
        stable?: string[];
        inconsistent?: string[];
        trending?: string;
    };
    weekOverWeekChanges?: string;
    [key: string]: unknown;
}

// Monthly review structured content
export interface MonthlyStructuredContent {
    overallTrajectory?: {
        direction?: string;
        description?: string;
    };
    stabilized?: Array<{
        area: string;
        description: string;
    }>;
    deteriorated?: Array<{
        area: string;
        description: string;
    }>;
    progressMade?: Array<{
        area: string;
        achievement: string;
    }>;
    setbacks?: Array<{
        area: string;
        issue: string;
    }>;
    comparisonToEarlierMonths?: string;
    seasonalityHints?: string[];
    keyRealizations?: string[];
    [key: string]: unknown;
}

// Union type for any structured content
export type StructuredContent = DailyStructuredContent | WeeklyStructuredContent | MonthlyStructuredContent | Record<string, unknown>;

// ============================================================================
// Zod Schemas (for optional runtime validation - never used to block)
// ============================================================================
// These exist for backwards compatibility and type inference only.
// The generate-review.ts uses bulletproof extraction that never throws.

export const DailyStructuredContentSchema = z.object({}).passthrough();
export const WeeklyStructuredContentSchema = z.object({}).passthrough();
export const MonthlyStructuredContentSchema = z.object({}).passthrough();
export const StructuredContentSchema = z.object({}).passthrough();

export const ReviewOutputSchema = z.object({
    summary: z.string(),
    renderedMarkdown: z.string(),
    structuredContent: z.any(),
    dataQuality: z.any(),
}).passthrough();

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// ============================================================================
// Input/Output Types
// ============================================================================

export interface GenerateReviewInput {
    userId: string;
    reviewType: ReviewType;
    targetDate: Date;
    force?: boolean; // Skip existence check
}

export interface GenerateReviewResult {
    success: boolean;
    reviewId?: string;
    periodKey: string;
    skipped?: boolean;
    skipReason?: string;
    error?: string;
}

// ============================================================================
// Data Context Types (for retrieval)
// ============================================================================

export interface EventWithInterpretation {
    id: string;
    content: string;
    occurredAt: Date;
    trackedType: string | null;
    interpretation: {
        id: string;
        content: string;
    } | null;
}

export interface PatternSummary {
    id: string;
    description: string;
    status: string;
    eventCount: number;
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
}

export interface InsightSummary {
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    status: string;
    category: string | null;
}

export interface PriorReview {
    id: string;
    type: ReviewType;
    periodKey: string;
    periodStart: Date;
    periodEnd: Date;
    summary: string;
    structuredContent: unknown;
}

export interface DailyReviewData {
    events: EventWithInterpretation[];
    patterns: PatternSummary[];
    insights: InsightSummary[];
    priorDailyReviews: PriorReview[];
    facts: ReviewDeterministicFacts;
}

export interface WeeklyReviewData {
    events: EventWithInterpretation[];
    patterns: PatternSummary[];
    insights: InsightSummary[];
    dailyReviews: PriorReview[];
    previousWeeklyReview: PriorReview | null;
    facts: ReviewDeterministicFacts;
}

export interface MonthlyReviewData {
    events: EventWithInterpretation[];
    patterns: PatternSummary[];
    insights: InsightSummary[];
    weeklyReviews: PriorReview[];
    previousMonthlyReview: PriorReview | null;
    earlierMonthlyReviews: PriorReview[];
    facts: ReviewDeterministicFacts;
}

export interface ReviewDeterministicFacts {
    // Period-specific counts
    eventCount: number;
    interpretationCount: number;
    patternsReinforced: number;
    patternsCreated: number;

    // Per-track-type event counts
    eventsPerTrackType?: Record<string, number>;

    // Overall user stats
    totalEvents: number;
    totalPatterns: number;
    totalInsights: number;
    daysSinceFirstEvent: number;

    // Time distribution (for weekly/monthly)
    eventsPerDay?: Record<string, number>;
    mostActiveDay?: string;
    leastActiveDay?: string;
}

export type ReviewData = DailyReviewData | WeeklyReviewData | MonthlyReviewData;
