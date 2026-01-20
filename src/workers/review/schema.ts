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
// Structured Content Schemas (Type-specific)
// ============================================================================

// Daily review structured content
export const DailyStructuredContentSchema = z.object({
    // What happened
    activities: z.array(z.string()).describe('Key activities of the day'),
    emotions: z.array(z.object({
        emotion: z.string(),
        intensity: z.enum(['low', 'medium', 'high']),
        context: z.string().optional(),
    })).describe('Dominant emotions observed'),

    // Pattern analysis
    patternsReinforced: z.array(z.object({
        patternId: z.string(),
        description: z.string(),
    })).describe('Patterns that were reinforced today'),
    patternsAbsent: z.array(z.object({
        patternId: z.string(),
        description: z.string(),
        significance: z.string().optional(),
    })).describe('Expected patterns that were missing'),

    // Comparison
    comparisonToRecent: z.string().describe('How today differed from recent days'),

    // Reflections (questions with answers)
    reflections: z.array(z.object({
        question: z.string(),
        answer: z.string(),
    })).describe('Questions raised by today\'s data with answers based on patterns and insights'),
});

export type DailyStructuredContent = z.infer<typeof DailyStructuredContentSchema>;

// Weekly review structured content
export const WeeklyStructuredContentSchema = z.object({
    // Behavior trends
    behaviorsIncreased: z.array(z.object({
        behavior: z.string(),
        change: z.string(),
    })).describe('Behaviors that increased this week'),
    behaviorsDecreased: z.array(z.object({
        behavior: z.string(),
        change: z.string(),
    })).describe('Behaviors that decreased this week'),

    // Day analysis
    strongestDays: z.array(z.object({
        day: z.string(),
        reason: z.string(),
    })).describe('Days with most positive signals'),
    weakestDays: z.array(z.object({
        day: z.string(),
        reason: z.string(),
    })).describe('Days with challenges'),

    // Pattern analysis
    emergingPatterns: z.array(z.object({
        description: z.string(),
        evidence: z.string(),
    })).describe('Patterns starting to form'),
    collapsingPatterns: z.array(z.object({
        patternId: z.string().optional(),
        description: z.string(),
        evidence: z.string(),
    })).describe('Patterns losing strength'),

    // Habit stability
    habitStability: z.object({
        stable: z.array(z.string()),
        inconsistent: z.array(z.string()),
        trending: z.enum(['improving', 'stable', 'declining', 'mixed']),
    }).describe('Analysis of habit consistency'),

    // Comparison to previous week
    weekOverWeekChanges: z.string().describe('Notable changes from previous week'),
});

export type WeeklyStructuredContent = z.infer<typeof WeeklyStructuredContentSchema>;

// Monthly review structured content
export const MonthlyStructuredContentSchema = z.object({
    // Trajectory analysis
    overallTrajectory: z.object({
        direction: z.enum(['positive', 'neutral', 'negative', 'mixed']),
        description: z.string(),
    }).describe('Overall direction of the month'),

    // Stability analysis
    stabilized: z.array(z.object({
        area: z.string(),
        description: z.string(),
    })).describe('What became more stable'),
    deteriorated: z.array(z.object({
        area: z.string(),
        description: z.string(),
    })).describe('What got worse'),

    // Progress tracking
    progressMade: z.array(z.object({
        area: z.string(),
        achievement: z.string(),
    })).describe('Concrete progress'),
    setbacks: z.array(z.object({
        area: z.string(),
        issue: z.string(),
    })).describe('Setbacks encountered'),

    // Comparison
    comparisonToEarlierMonths: z.string().describe('How this month compares to earlier'),
    seasonalityHints: z.array(z.string()).optional().describe('Potential seasonal patterns'),

    // Key insights
    keyRealizations: z.array(z.string()).describe('Major insights from the month'),
});

export type MonthlyStructuredContent = z.infer<typeof MonthlyStructuredContentSchema>;

// Union schema for structured content
export const StructuredContentSchema = z.union([
    DailyStructuredContentSchema,
    WeeklyStructuredContentSchema,
    MonthlyStructuredContentSchema,
]);

export type StructuredContent = z.infer<typeof StructuredContentSchema>;

// ============================================================================
// Review Output Schema (LLM response)
// ============================================================================

export const ReviewOutputSchema = z.object({
    summary: z
        .string()
        .min(50, 'Summary must be at least 50 characters')
        .max(500, 'Summary must not exceed 500 characters')
        .describe('1-3 sentence summary of the period'),

    structuredContent: StructuredContentSchema.describe('Type-specific structured analysis'),

    renderedMarkdown: z
        .string()
        .min(200, 'Markdown must be at least 200 characters')
        .describe('Full review as markdown for display'),

    dataQuality: z.object({
        hasAdequateData: z.boolean(),
        limitations: z.array(z.string()),
        confidenceLevel: z.enum(['high', 'medium', 'low']),
    }).describe('Assessment of data quality and limitations'),

    processingNotes: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('Optional notes about the generation process'),
});

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
