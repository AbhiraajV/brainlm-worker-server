// Main exports
export {
    generateInsights,
    GenerateInsightsInput,
    GenerateInsightsResult,
    InsightGenerationError,
} from './generate-insights';

// Schema exports
export {
    InsightStatus,
    ConfidenceLevel,
    InsightCategory,
    EvidenceRelevance,
    EvidenceRefSchema,
    InsightItemSchema,
    InsightOutputSchema,
    TriggerContext,
    ExistingInsight,
} from './schema';
export type {
    EvidenceRef,
    InsightItem,
    InsightOutput,
} from './schema';

// Data retrieval exports
export {
    retrieveInsightContext,
    DEFAULT_RETRIEVAL_CONFIG,
} from './data-retrieval';
export type {
    InsightRetrievalConfig,
    PatternWithEmbedding,
    InterpretationWithEmbedding,
    DeterministicFacts,
    InsightDataContext,
} from './data-retrieval';

// Prompt formatter exports (system prompts now in src/prompts.ts)
export { formatInsightUserMessage } from './prompt';
