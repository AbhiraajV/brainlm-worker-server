// Main exports
export {
    generateReview,
    generateAllReviewsForDate,
} from './generate-review';

// Schema exports
export {
    ReviewType,
    DailyStructuredContentSchema,
    WeeklyStructuredContentSchema,
    MonthlyStructuredContentSchema,
    StructuredContentSchema,
    ReviewOutputSchema,
} from './schema';
export type {
    GenerateReviewInput,
    GenerateReviewResult,
    ReviewOutput,
    DailyStructuredContent,
    WeeklyStructuredContent,
    MonthlyStructuredContent,
    StructuredContent,
    EventWithInterpretation,
    PatternSummary,
    InsightSummary,
    PriorReview,
    DailyReviewData,
    WeeklyReviewData,
    MonthlyReviewData,
    ReviewDeterministicFacts,
    ReviewData,
} from './schema';

// Data retrieval exports
export {
    retrieveReviewData,
    retrieveDailyReviewData,
    retrieveWeeklyReviewData,
    retrieveMonthlyReviewData,
    reviewExists,
    DEFAULT_RETRIEVAL_CONFIG,
    DEFAULT_ENHANCED_CONFIG,
} from './data-retrieval';
export type {
    ReviewRetrievalConfig,
    EnhancedRetrievalConfig,
    HybridWeights,
} from './data-retrieval';

// Temporal utils exports
export {
    getPeriodKey,
    getPeriodBounds,
    getDayBounds,
    getWeekBounds,
    getMonthBounds,
    getISOWeekNumber,
    formatDateForReview,
    formatDateRange,
    getDayName,
    getPreviousPeriodDate,
    getDatesInPeriod,
    canGenerateReview,
    isDateInPeriod,
    parsePeriodKey,
    // Timezone-aware functions
    getUserYesterday,
    getUserLastCompletedWeek,
    getUserLastCompletedMonth,
    hasPeriodCompletedForUser,
    getTimezonesAtMidnight,
    getTimezoneScheduleInfo,
    getLocalDateParts,
    COMMON_TIMEZONES,
} from './temporal-utils';

// Prompt formatter exports (system prompts now in src/prompts.ts)
export {
    formatReviewUserMessage,
    formatDailyReviewMessage,
    formatWeeklyReviewMessage,
    formatMonthlyReviewMessage,
} from './prompt';
