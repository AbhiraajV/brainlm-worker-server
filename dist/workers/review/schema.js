"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewOutputSchema = exports.StructuredContentSchema = exports.MonthlyStructuredContentSchema = exports.WeeklyStructuredContentSchema = exports.DailyStructuredContentSchema = exports.ReviewType = void 0;
const zod_1 = require("zod");
// ============================================================================
// Enums (matching Prisma schema)
// ============================================================================
var ReviewType;
(function (ReviewType) {
    ReviewType["DAILY"] = "DAILY";
    ReviewType["WEEKLY"] = "WEEKLY";
    ReviewType["MONTHLY"] = "MONTHLY";
})(ReviewType || (exports.ReviewType = ReviewType = {}));
// ============================================================================
// Structured Content Schemas (Type-specific)
// ============================================================================
// Daily review structured content
exports.DailyStructuredContentSchema = zod_1.z.object({
    // What happened
    activities: zod_1.z.array(zod_1.z.string()).describe('Key activities of the day'),
    emotions: zod_1.z.array(zod_1.z.object({
        emotion: zod_1.z.string(),
        intensity: zod_1.z.enum(['low', 'medium', 'high']),
        context: zod_1.z.string().optional(),
    })).describe('Dominant emotions observed'),
    // Pattern analysis
    patternsReinforced: zod_1.z.array(zod_1.z.object({
        patternId: zod_1.z.string(),
        description: zod_1.z.string(),
    })).describe('Patterns that were reinforced today'),
    patternsAbsent: zod_1.z.array(zod_1.z.object({
        patternId: zod_1.z.string(),
        description: zod_1.z.string(),
        significance: zod_1.z.string().optional(),
    })).describe('Expected patterns that were missing'),
    // Comparison
    comparisonToRecent: zod_1.z.string().describe('How today differed from recent days'),
    // Reflections (questions with answers)
    reflections: zod_1.z.array(zod_1.z.object({
        question: zod_1.z.string(),
        answer: zod_1.z.string(),
    })).describe('Questions raised by today\'s data with answers based on patterns and insights'),
});
// Weekly review structured content
exports.WeeklyStructuredContentSchema = zod_1.z.object({
    // Behavior trends
    behaviorsIncreased: zod_1.z.array(zod_1.z.object({
        behavior: zod_1.z.string(),
        change: zod_1.z.string(),
    })).describe('Behaviors that increased this week'),
    behaviorsDecreased: zod_1.z.array(zod_1.z.object({
        behavior: zod_1.z.string(),
        change: zod_1.z.string(),
    })).describe('Behaviors that decreased this week'),
    // Day analysis
    strongestDays: zod_1.z.array(zod_1.z.object({
        day: zod_1.z.string(),
        reason: zod_1.z.string(),
    })).describe('Days with most positive signals'),
    weakestDays: zod_1.z.array(zod_1.z.object({
        day: zod_1.z.string(),
        reason: zod_1.z.string(),
    })).describe('Days with challenges'),
    // Pattern analysis
    emergingPatterns: zod_1.z.array(zod_1.z.object({
        description: zod_1.z.string(),
        evidence: zod_1.z.string(),
    })).describe('Patterns starting to form'),
    collapsingPatterns: zod_1.z.array(zod_1.z.object({
        patternId: zod_1.z.string().optional(),
        description: zod_1.z.string(),
        evidence: zod_1.z.string(),
    })).describe('Patterns losing strength'),
    // Habit stability
    habitStability: zod_1.z.object({
        stable: zod_1.z.array(zod_1.z.string()),
        inconsistent: zod_1.z.array(zod_1.z.string()),
        trending: zod_1.z.enum(['improving', 'stable', 'declining', 'mixed']),
    }).describe('Analysis of habit consistency'),
    // Comparison to previous week
    weekOverWeekChanges: zod_1.z.string().describe('Notable changes from previous week'),
});
// Monthly review structured content
exports.MonthlyStructuredContentSchema = zod_1.z.object({
    // Trajectory analysis
    overallTrajectory: zod_1.z.object({
        direction: zod_1.z.enum(['positive', 'neutral', 'negative', 'mixed']),
        description: zod_1.z.string(),
    }).describe('Overall direction of the month'),
    // Stability analysis
    stabilized: zod_1.z.array(zod_1.z.object({
        area: zod_1.z.string(),
        description: zod_1.z.string(),
    })).describe('What became more stable'),
    deteriorated: zod_1.z.array(zod_1.z.object({
        area: zod_1.z.string(),
        description: zod_1.z.string(),
    })).describe('What got worse'),
    // Progress tracking
    progressMade: zod_1.z.array(zod_1.z.object({
        area: zod_1.z.string(),
        achievement: zod_1.z.string(),
    })).describe('Concrete progress'),
    setbacks: zod_1.z.array(zod_1.z.object({
        area: zod_1.z.string(),
        issue: zod_1.z.string(),
    })).describe('Setbacks encountered'),
    // Comparison
    comparisonToEarlierMonths: zod_1.z.string().describe('How this month compares to earlier'),
    seasonalityHints: zod_1.z.array(zod_1.z.string()).optional().describe('Potential seasonal patterns'),
    // Key insights
    keyRealizations: zod_1.z.array(zod_1.z.string()).describe('Major insights from the month'),
});
// Union schema for structured content
exports.StructuredContentSchema = zod_1.z.union([
    exports.DailyStructuredContentSchema,
    exports.WeeklyStructuredContentSchema,
    exports.MonthlyStructuredContentSchema,
]);
// ============================================================================
// Review Output Schema (LLM response)
// ============================================================================
exports.ReviewOutputSchema = zod_1.z.object({
    summary: zod_1.z
        .string()
        .min(50, 'Summary must be at least 50 characters')
        .max(500, 'Summary must not exceed 500 characters')
        .describe('1-3 sentence summary of the period'),
    structuredContent: exports.StructuredContentSchema.describe('Type-specific structured analysis'),
    renderedMarkdown: zod_1.z
        .string()
        .min(200, 'Markdown must be at least 200 characters')
        .describe('Full review as markdown for display'),
    dataQuality: zod_1.z.object({
        hasAdequateData: zod_1.z.boolean(),
        limitations: zod_1.z.array(zod_1.z.string()),
        confidenceLevel: zod_1.z.enum(['high', 'medium', 'low']),
    }).describe('Assessment of data quality and limitations'),
    processingNotes: zod_1.z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('Optional notes about the generation process'),
});
