/**
 * Pipeline Types
 *
 * Queue-ready interfaces for the memory processing pipeline.
 * Currently synchronous, but structured for easy queue migration.
 */

import { PatternOutcome } from '../workers/pattern/schema';

// ============================================================================
// Pipeline Job Types (Queue-Ready)
// ============================================================================

/**
 * Base interface for all pipeline jobs.
 * When we add a queue, jobs will implement this.
 */
export interface PipelineJob {
    type: string;
    payload: unknown;
}

export interface InterpretJob extends PipelineJob {
    type: 'interpret';
    payload: {
        eventId: string;
    };
}

export interface PatternDetectJob extends PipelineJob {
    type: 'pattern-detect';
    payload: {
        userId: string;
        triggerEventId: string;
        interpretationId: string;
    };
}

export interface RecommendJob extends PipelineJob {
    type: 'recommend';
    payload: {
        userId: string;
        patternId?: string;
        triggerEventId: string;
    };
}

export type MemoryPipelineJob = InterpretJob | PatternDetectJob | RecommendJob;

// ============================================================================
// Pipeline Results
// ============================================================================

export interface InterpretResult {
    success: boolean;
    interpretationId?: string;
    skipped?: boolean;
    reason?: string;
}

export interface PatternDetectResult {
    success: boolean;
    outcome: PatternOutcome;      // Mandatory outcome
    patternId: string;            // The affected pattern
    patternsCreated: number;
    patternsReinforced: number;
    patternsEvolved: number;      // NEW
    clustersFound: number;
}

export interface RecommendResult {
    success: boolean;
    // Future: recommendation artifacts created
}

export interface InsightResult {
    success: boolean;
    insightsCreated: number;
    insightsReinforced: number;
    insightsSuperseded: number;
    createdInsightIds: string[];
    error?: string;
}

export interface PipelineResult {
    success: boolean;
    eventId: string;
    stages: {
        interpret?: InterpretResult;
        patternDetect?: PatternDetectResult;
        insight?: InsightResult;
        recommend?: RecommendResult;
    };
    errors: string[];
    durationMs: number;
}

// ============================================================================
// Job Dispatch (Queue-Ready Abstraction)
// ============================================================================

/**
 * Abstraction for job dispatch.
 * Currently executes synchronously.
 * When queue is added, this becomes an enqueue operation.
 */
export interface JobDispatcher {
    dispatch(job: MemoryPipelineJob): Promise<void>;
}
