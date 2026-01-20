"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubQuestionsOutputSchema = exports.CompiledQuerySchema = exports.TableSearchIntentSchema = exports.DEFAULT_RETRIEVER_CONFIG = exports.IntentType = exports.RetrievalReason = exports.EvidenceSource = void 0;
exports.getBiasedLimits = getBiasedLimits;
const zod_1 = require("zod");
// ============================================================================
// Enums
// ============================================================================
/**
 * Source of evidence in the retrieval results.
 */
var EvidenceSource;
(function (EvidenceSource) {
    EvidenceSource["EVENT"] = "EVENT";
    EvidenceSource["INTERPRETATION"] = "INTERPRETATION";
    EvidenceSource["PATTERN"] = "PATTERN";
    EvidenceSource["INSIGHT"] = "INSIGHT";
})(EvidenceSource || (exports.EvidenceSource = EvidenceSource = {}));
/**
 * Reason why this evidence was retrieved.
 */
var RetrievalReason;
(function (RetrievalReason) {
    RetrievalReason["DIRECT_MATCH"] = "DIRECT_MATCH";
    RetrievalReason["EVENT_EXPANSION"] = "EVENT_EXPANSION";
    RetrievalReason["PATTERN_LINK"] = "PATTERN_LINK";
    RetrievalReason["INSIGHT_LINK"] = "INSIGHT_LINK";
    RetrievalReason["COVERAGE_CONTROL"] = "COVERAGE_CONTROL";
})(RetrievalReason || (exports.RetrievalReason = RetrievalReason = {}));
/**
 * Intent type for retrieval biasing.
 * LLM classifies the question type to bias retrieval limits.
 */
var IntentType;
(function (IntentType) {
    IntentType["TEMPORAL"] = "TEMPORAL";
    IntentType["CAUSAL"] = "CAUSAL";
    IntentType["EVALUATIVE"] = "EVALUATIVE";
    IntentType["COMPARATIVE"] = "COMPARATIVE";
    IntentType["EXPLORATORY"] = "EXPLORATORY";
})(IntentType || (exports.IntentType = IntentType = {}));
/**
 * Default configuration values.
 */
exports.DEFAULT_RETRIEVER_CONFIG = {
    eventLimit: 20,
    interpretationLimit: 15,
    patternLimit: 10,
    insightLimit: 10,
    dedupeThreshold: 0.95,
    maxTotalPerQuestion: 40,
    minRecentItems: 5,
    minHistoricalItems: 3,
    llmModel: 'gpt-4o-mini',
    llmTemperature: 0.3,
};
// ============================================================================
// Compiled Query Types (LLM Output)
// ============================================================================
/**
 * Search intent for a single table.
 */
exports.TableSearchIntentSchema = zod_1.z.object({
    searchIntent: zod_1.z
        .string()
        .min(10, 'Search intent must be at least 10 characters')
        .max(500, 'Search intent must not exceed 500 characters')
        .describe('Natural language description of what to search for'),
    keywords: zod_1.z
        .array(zod_1.z.string())
        .max(10, 'Maximum 10 keywords')
        .optional()
        .describe('Optional keywords to boost retrieval'),
});
/**
 * Compiled queries for all 4 tables.
 */
exports.CompiledQuerySchema = zod_1.z.object({
    intentType: zod_1.z.nativeEnum(IntentType).describe('Classified intent type for retrieval biasing'),
    queries: zod_1.z.object({
        Event: exports.TableSearchIntentSchema.describe('Search intent for Event table'),
        Interpretation: exports.TableSearchIntentSchema.describe('Search intent for Interpretation table'),
        Pattern: exports.TableSearchIntentSchema.describe('Search intent for Pattern table'),
        Insight: exports.TableSearchIntentSchema.describe('Search intent for Insight table'),
    }),
});
/**
 * Zod schema for validating LLM output for sub-question generation.
 */
exports.SubQuestionsOutputSchema = zod_1.z.object({
    subQuestions: zod_1.z
        .array(zod_1.z.string().min(5, 'Sub-question must be at least 5 characters'))
        .min(1, 'At least 1 sub-question required')
        .max(10, 'Maximum 10 sub-questions'),
    reasoning: zod_1.z
        .string()
        .optional()
        .describe('Brief explanation of why these sub-questions were chosen'),
});
// ============================================================================
// Biased Limits
// ============================================================================
/**
 * Get biased limits based on intent type.
 */
function getBiasedLimits(intentType, config) {
    const base = {
        events: config.eventLimit,
        interpretations: config.interpretationLimit,
        patterns: config.patternLimit,
        insights: config.insightLimit,
    };
    switch (intentType) {
        case IntentType.TEMPORAL:
            // Bias Events for temporal questions
            return {
                ...base,
                events: Math.round(base.events * 1.5),
                patterns: Math.round(base.patterns * 0.7),
            };
        case IntentType.CAUSAL:
            // Bias Patterns for causal questions
            return {
                ...base,
                patterns: Math.round(base.patterns * 1.5),
                events: Math.round(base.events * 0.8),
            };
        case IntentType.EVALUATIVE:
            // Bias Insights for evaluative questions
            return {
                ...base,
                insights: Math.round(base.insights * 1.5),
            };
        case IntentType.COMPARATIVE:
            // Bias Events + Patterns for comparative questions
            return {
                ...base,
                events: Math.round(base.events * 1.3),
                patterns: Math.round(base.patterns * 1.3),
            };
        case IntentType.EXPLORATORY:
        default:
            // Balanced for exploratory questions
            return base;
    }
}
