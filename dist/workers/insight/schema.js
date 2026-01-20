"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InsightOutputSchema = exports.QuestionExploredSchema = exports.InsightItemSchema = exports.EvidenceRefSchema = exports.EvidenceRelevance = exports.InsightCategory = exports.ConfidenceLevel = exports.InsightStatus = void 0;
const zod_1 = require("zod");
// ============================================================================
// Enums (matching Prisma schema)
// ============================================================================
var InsightStatus;
(function (InsightStatus) {
    InsightStatus["CONFIRMED"] = "CONFIRMED";
    InsightStatus["LIKELY"] = "LIKELY";
    InsightStatus["SPECULATIVE"] = "SPECULATIVE";
    InsightStatus["SUPERSEDED"] = "SUPERSEDED";
    InsightStatus["WEAKENED"] = "WEAKENED";
})(InsightStatus || (exports.InsightStatus = InsightStatus = {}));
var ConfidenceLevel;
(function (ConfidenceLevel) {
    ConfidenceLevel["HIGH"] = "HIGH";
    ConfidenceLevel["MEDIUM"] = "MEDIUM";
    ConfidenceLevel["EMERGING"] = "EMERGING";
})(ConfidenceLevel || (exports.ConfidenceLevel = ConfidenceLevel = {}));
var InsightCategory;
(function (InsightCategory) {
    InsightCategory["STRUCTURAL"] = "STRUCTURAL";
    InsightCategory["BEHAVIORAL"] = "BEHAVIORAL";
    InsightCategory["PREFERENCE"] = "PREFERENCE";
    InsightCategory["EMOTIONAL"] = "EMOTIONAL";
    InsightCategory["CROSS_DOMAIN"] = "CROSS_DOMAIN";
    InsightCategory["PROGRESS"] = "PROGRESS";
    InsightCategory["META"] = "META";
    InsightCategory["SHALLOW_PATTERNS"] = "SHALLOW_PATTERNS";
})(InsightCategory || (exports.InsightCategory = InsightCategory = {}));
var EvidenceRelevance;
(function (EvidenceRelevance) {
    EvidenceRelevance["PRIMARY"] = "PRIMARY";
    EvidenceRelevance["SUPPORTING"] = "SUPPORTING";
    EvidenceRelevance["CONTEXTUAL"] = "CONTEXTUAL";
})(EvidenceRelevance || (exports.EvidenceRelevance = EvidenceRelevance = {}));
// ============================================================================
// Evidence Reference Schema
// ============================================================================
exports.EvidenceRefSchema = zod_1.z.object({
    type: zod_1.z.enum(['pattern', 'interpretation', 'event', 'insight']),
    id: zod_1.z.string().min(1),
    relevance: zod_1.z.enum(['primary', 'supporting', 'contextual']),
    excerpt: zod_1.z.string().nullable().optional(), // Brief excerpt for human readability
});
// ============================================================================
// Individual Insight Schema
// ============================================================================
exports.InsightItemSchema = zod_1.z.object({
    statement: zod_1.z
        .string()
        .min(20, 'Statement must be at least 20 characters')
        .max(500, 'Statement must not exceed 500 characters')
        .describe('A clear, specific insight statement'),
    explanation: zod_1.z
        .string()
        .min(100, 'Explanation must be at least 100 characters')
        .max(2000, 'Explanation must not exceed 2000 characters')
        .describe('Detailed reasoning and evidence for this insight'),
    confidence: zod_1.z.nativeEnum(ConfidenceLevel).describe('Confidence level based on evidence strength'),
    status: zod_1.z.nativeEnum(InsightStatus).describe('Current status of the insight'),
    category: zod_1.z.nativeEnum(InsightCategory).describe('Primary category of the insight'),
    temporalScope: zod_1.z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe('When this insight applies: e.g., "mornings", "weekends", "stressful periods"'),
    evidenceRefs: zod_1.z
        .array(exports.EvidenceRefSchema)
        .min(1, 'At least one evidence reference required')
        .max(10, 'Maximum 10 evidence references')
        .describe('References to supporting evidence'),
    derivedFromQuestion: zod_1.z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe('The question this insight answers'),
    supersedesInsightId: zod_1.z
        .string()
        .nullable()
        .optional()
        .describe('ID of older insight this supersedes, if any'),
});
// ============================================================================
// Question Explored Schema
// ============================================================================
exports.QuestionExploredSchema = zod_1.z.object({
    question: zod_1.z.string().min(10).max(300),
    category: zod_1.z.nativeEnum(InsightCategory),
    answerable: zod_1.z.boolean(),
    reasonIfUnanswerable: zod_1.z.string().max(200).nullable().optional(),
});
// ============================================================================
// Full LLM Output Schema
// ============================================================================
exports.InsightOutputSchema = zod_1.z.object({
    questionsExplored: zod_1.z
        .array(exports.QuestionExploredSchema)
        .min(3, 'Must explore at least 3 questions')
        .max(15, 'Maximum 15 questions')
        .describe('Questions the LLM explored based on the data'),
    insights: zod_1.z
        .array(exports.InsightItemSchema)
        .max(10, 'Maximum 10 insights per generation')
        .describe('Generated insights (only for answerable questions)'),
    processingNotes: zod_1.z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('Optional notes about the generation process'),
});
