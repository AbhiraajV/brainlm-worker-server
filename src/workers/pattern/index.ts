export {
    detectPatterns,
    detectPatternsForEvent,
    DetectPatternsInput,
    DetectPatternsForEventInput,
    DetectPatternsResult,
    PatternDetectionError,
} from './detect-patterns';
// System prompts now in src/prompts.ts (PATTERN_SYNTHESIS_PROMPT, PATTERN_EVOLUTION_PROMPT)
export {
    PatternOutputSchema,
    PatternOutcome,
    InterpretationWithEmbedding,
    InterpretationCluster,
} from './schema';
export type { PatternOutput } from './schema';
export {
    clusterInterpretations,
    computeSimilarityMatrix,
    findSimilarPatterns,
    ClusteringConfig,
    DEFAULT_CLUSTERING_CONFIG,
} from './similarity';
