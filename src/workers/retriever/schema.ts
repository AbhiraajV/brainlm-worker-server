import { z } from 'zod';

// ============================================================================
// Enums
// ============================================================================

/**
 * Source of evidence in the retrieval results.
 */
export enum EvidenceSource {
    EVENT = 'EVENT',
    INTERPRETATION = 'INTERPRETATION',
    PATTERN = 'PATTERN',
    INSIGHT = 'INSIGHT',
}

/**
 * Reason why this evidence was retrieved.
 */
export enum RetrievalReason {
    DIRECT_MATCH = 'DIRECT_MATCH',           // Directly matched the search intent
    EVENT_EXPANSION = 'EVENT_EXPANSION',     // Retrieved via event expansion
    PATTERN_LINK = 'PATTERN_LINK',           // Linked to a retrieved event via PatternEvent
    INSIGHT_LINK = 'INSIGHT_LINK',           // Linked to a retrieved event via InsightEvent
    COVERAGE_CONTROL = 'COVERAGE_CONTROL',   // Added for temporal coverage
}

/**
 * Intent type for retrieval biasing.
 * LLM classifies the question type to bias retrieval limits.
 */
export enum IntentType {
    TEMPORAL = 'TEMPORAL',         // "when did this happen?" -> bias Events
    CAUSAL = 'CAUSAL',             // "why did this happen?" -> bias Patterns
    EVALUATIVE = 'EVALUATIVE',     // "is this good/bad?" -> bias Insights
    COMPARATIVE = 'COMPARATIVE',   // "has this increased?" -> bias temporal Events + Patterns
    EXPLORATORY = 'EXPLORATORY',   // general questions -> balanced
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the retriever.
 */
export interface RetrieverConfig {
    // Retrieval limits per table
    eventLimit: number;
    interpretationLimit: number;
    patternLimit: number;
    insightLimit: number;

    // Deduplication
    dedupeThreshold: number;        // Cosine similarity threshold for deduplication
    maxTotalPerQuestion: number;    // Maximum total evidence items per question

    // Coverage control
    minRecentItems: number;         // Minimum items from last 7 days
    minHistoricalItems: number;     // Minimum items from >30 days ago

    // LLM settings for query compilation
    llmModel: string;
    llmTemperature: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_RETRIEVER_CONFIG: RetrieverConfig = {
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
// Input/Output Types
// ============================================================================

/**
 * Input for the retriever.
 */
export interface RetrieverInput {
    userId: string;
    mainQuestion: string;
    subQuestions?: string[];
    timeRange?: {
        from?: Date;
        to?: Date;
    };
    config?: Partial<RetrieverConfig>;
}

/**
 * Retrieved context for a single question.
 */
export interface RetrievedContext {
    events: NormalizedEvidence[];
    interpretations: NormalizedEvidence[];
    patterns: NormalizedEvidence[];
    insights: NormalizedEvidence[];
}

/**
 * Result for a single question.
 */
export interface QuestionResult {
    question: string;
    intentType: IntentType;
    retrievedContext: RetrievedContext;
    compiledQueries: CompiledQuery;
}

/**
 * Output from the retriever.
 */
export interface RetrieverResult {
    userId: string;
    results: QuestionResult[];
    processingTimeMs: number;
}

// ============================================================================
// Compiled Query Types (LLM Output)
// ============================================================================

/**
 * Search intent for a single table.
 */
export const TableSearchIntentSchema = z.object({
    searchIntent: z
        .string()
        .min(10, 'Search intent must be at least 10 characters')
        .max(500, 'Search intent must not exceed 500 characters')
        .describe('Natural language description of what to search for'),
    keywords: z
        .array(z.string())
        .max(10, 'Maximum 10 keywords')
        .optional()
        .describe('Optional keywords to boost retrieval'),
});

export type TableSearchIntent = z.infer<typeof TableSearchIntentSchema>;

/**
 * Compiled queries for all 4 tables.
 */
export const CompiledQuerySchema = z.object({
    intentType: z.nativeEnum(IntentType).describe('Classified intent type for retrieval biasing'),
    queries: z.object({
        Event: TableSearchIntentSchema.describe('Search intent for Event table'),
        Interpretation: TableSearchIntentSchema.describe('Search intent for Interpretation table'),
        Pattern: TableSearchIntentSchema.describe('Search intent for Pattern table'),
        Insight: TableSearchIntentSchema.describe('Search intent for Insight table'),
    }),
});

export type CompiledQuery = z.infer<typeof CompiledQuerySchema>;

// ============================================================================
// Evidence Types
// ============================================================================

/**
 * Normalized evidence item - common structure for all evidence types.
 */
export interface NormalizedEvidence {
    source: EvidenceSource;
    id: string;
    content: string;
    relatedEventId: string | null;
    timestamp: Date;
    whyThisWasRetrieved: string;    // Explainability
    relevanceScore: number;
    retrievalReason: RetrievalReason;
    metadata?: Record<string, unknown>;
}

/**
 * Expanded event with linked interpretation, patterns, and insights.
 */
export interface ExpandedEvent {
    event: {
        id: string;
        content: string;
        occurredAt: Date;
        similarity: number;
    };
    interpretation: {
        id: string;
        content: string;
    } | null;
    linkedPatterns: Array<{
        id: string;
        description: string;
        status: string;
    }>;
    linkedInsights: Array<{
        id: string;
        statement: string;
        explanation: string;
        relevance: string;
    }>;
}

// ============================================================================
// Raw Retrieval Results (from database)
// ============================================================================

/**
 * Raw event from database.
 */
export interface RawEvent {
    id: string;
    content: string;
    occurredAt: Date;
    similarity: number;
}

/**
 * Raw interpretation from database.
 */
export interface RawInterpretation {
    id: string;
    eventId: string;
    content: string;
    similarity: number;
    eventOccurredAt: Date;
}

/**
 * Raw pattern from database.
 */
export interface RawPattern {
    id: string;
    description: string;
    status: string;
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
    similarity: number;
}

/**
 * Raw insight from database.
 */
export interface RawInsight {
    id: string;
    statement: string;
    explanation: string;
    status: string;
    confidence: string;
    category: string | null;
    similarity: number;
    firstDetectedAt: Date;
}

/**
 * All raw results from table retrieval.
 */
export interface AllTablesResult {
    events: RawEvent[];
    interpretations: RawInterpretation[];
    patterns: RawPattern[];
    insights: RawInsight[];
}

// ============================================================================
// Biased Limits
// ============================================================================

/**
 * Biased limits based on intent type.
 */
export interface BiasedLimits {
    events: number;
    interpretations: number;
    patterns: number;
    insights: number;
}

// ============================================================================
// Sub-Question Generation Types
// ============================================================================

/**
 * Input for sub-question generation.
 */
export interface GenerateSubQuestionsInput {
    mainQuestion: string;
    context: string;           // Can be very large (conversation history, user profile, etc.)
    maxSubQuestions?: number;  // Default: 5
    llmModel?: string;         // Default: 'gpt-4o-mini'
}

/**
 * Result from sub-question generation.
 */
export interface GenerateSubQuestionsResult {
    subQuestions: string[];
    reasoning?: string;        // Optional: why these sub-questions were generated
}

/**
 * Zod schema for validating LLM output for sub-question generation.
 */
export const SubQuestionsOutputSchema = z.object({
    subQuestions: z
        .array(z.string().min(5, 'Sub-question must be at least 5 characters'))
        .min(1, 'At least 1 sub-question required')
        .max(10, 'Maximum 10 sub-questions'),
    reasoning: z
        .string()
        .optional()
        .describe('Brief explanation of why these sub-questions were chosen'),
});

export type SubQuestionsOutput = z.infer<typeof SubQuestionsOutputSchema>;

// ============================================================================
// Biased Limits
// ============================================================================

/**
 * Get biased limits based on intent type.
 */
export function getBiasedLimits(intentType: IntentType, config: RetrieverConfig): BiasedLimits {
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
