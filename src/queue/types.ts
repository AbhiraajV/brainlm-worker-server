import { JobType, JobStatus } from '@prisma/client';

// ============================================================================
// Job Payload Types
// ============================================================================

export interface InterpretEventPayload {
  eventId: string;
}

export interface DetectPatternsPayload {
  userId: string;
  triggerEventId: string;
  interpretationId?: string;
}

export interface GenerateInsightsPayload {
  userId: string;
  triggerType: 'new_event' | 'pattern_reinforced' | 'pattern_evolved' | 'pattern_created' | 'scheduled';
  eventId?: string;
  interpretationId?: string;
  patternId?: string;
}

export interface GenerateReviewPayload {
  userId: string;
  type: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  periodKey: string;
  timezone: string;
}

export interface GenerateTomorrowPlanPayload {
  userId: string;
  reviewId: string;
  targetDate: string; // ISO date string
}

export interface SuggestUOMUpdatePayload {
  userId: string;
  dailyPlanId: string;
}

// Union type for all payloads
export type JobPayload =
  | InterpretEventPayload
  | DetectPatternsPayload
  | GenerateInsightsPayload
  | GenerateReviewPayload
  | GenerateTomorrowPlanPayload
  | SuggestUOMUpdatePayload;

// ============================================================================
// Enqueue Options
// ============================================================================

export interface EnqueueOptions {
  priority?: number;           // Higher = processed first (default: 0)
  delayMs?: number;            // Delay before job is available (default: 0)
  maxAttempts?: number;        // Max retry attempts (default: 3)
  idempotencyKey?: string;     // Prevent duplicate jobs
  userId?: string;             // Associate job with user
}

// ============================================================================
// Job Result Types
// ============================================================================

export interface JobResult {
  success: boolean;
  error?: string;
  data?: unknown;
  shouldRetry?: boolean;  // Override default retry behavior
}

// ============================================================================
// Handler Types
// ============================================================================

export type JobHandler<T extends JobPayload = JobPayload> = (
  payload: T,
  jobId: string
) => Promise<JobResult>;

export type JobHandlerMap = {
  [K in JobType]: JobHandler;
};

// ============================================================================
// Worker Configuration
// ============================================================================

export interface WorkerConfig {
  workerId?: string;           // Unique identifier for this worker instance
  pollIntervalMin?: number;    // Minimum poll interval in ms (default: 100)
  pollIntervalMax?: number;    // Maximum poll interval in ms (default: 2000)
  pollIntervalStep?: number;   // How much to increase on empty poll (default: 100)
  stuckJobTimeout?: number;    // Minutes before a job is considered stuck (default: 10)
  batchSize?: number;          // Jobs to fetch per poll (default: 1)
}

// ============================================================================
// Queue Statistics
// ============================================================================

export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  deadLetter: number;
  byType: Record<JobType, number>;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export { JobType, JobStatus };
