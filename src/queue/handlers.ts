import { JobType } from '@prisma/client';
import {
  JobHandler,
  JobResult,
  InterpretEventPayload,
  DetectPatternsPayload,
  GenerateInsightsPayload,
  GenerateReviewPayload,
  GenerateTomorrowPlanPayload,
  SuggestUOMUpdatePayload,
} from './types';

// Import workers
import { interpretEvent } from '../workers/interpretation';
import { detectPatternsForEvent, PatternOutcome } from '../workers/pattern';
import { generateInsights, TriggerContext } from '../workers/insight';
import { generateReview, ReviewType } from '../workers/review';
import { generateTomorrowPlan } from '../workers/tomorrow-plan';
import { suggestUOMUpdate } from '../workers/uom-suggestion';

// Import queue service for chaining
import {
  enqueueDetectPatterns,
  enqueueGenerateInsights,
  enqueueGenerateTomorrowPlan,
  enqueueSuggestUOMUpdate,
} from './queue.service';

import prisma from '../prisma';

// ============================================================================
// Handler Registry
// ============================================================================

const handlers: Partial<Record<JobType, JobHandler>> = {};

/**
 * Register a handler for a job type
 */
export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers[type] = handler;
  console.log(`[Handlers] Registered handler for ${type}`);
}

/**
 * Get handler for a job type
 */
export function getHandler(type: string): JobHandler | undefined {
  return handlers[type as JobType];
}

// ============================================================================
// INTERPRET_EVENT Handler
// ============================================================================

const handleInterpretEvent: JobHandler<InterpretEventPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { eventId } = payload;

  try {
    const result = await interpretEvent({ eventId });

    if (!result.success) {
      return {
        success: false,
        error: 'Interpretation failed',
        shouldRetry: true,
      };
    }

    // Chain: enqueue pattern detection
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { userId: true },
    });

    if (event) {
      await enqueueDetectPatterns({
        userId: event.userId,
        triggerEventId: eventId,
        interpretationId: result.interpretationId,
      });
    }

    return {
      success: true,
      data: { interpretationId: result.interpretationId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// DETECT_PATTERNS Handler
// ============================================================================

const handleDetectPatterns: JobHandler<DetectPatternsPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, triggerEventId, interpretationId } = payload;

  try {
    const result = await detectPatternsForEvent({
      userId,
      triggerEventId,
      interpretationId,
    });

    // Chain: always enqueue insight generation for every event
    // LLM decides 1-3 insights per event (even if just acknowledging existing coverage)
    await enqueueGenerateInsights({
      userId,
      triggerType: result.outcome === PatternOutcome.CREATED_NEW_PATTERN
        ? 'pattern_created'
        : 'pattern_reinforced',
      eventId: triggerEventId,
      interpretationId,
      patternId: result.patternId,
    });

    return {
      success: true,
      data: {
        outcome: result.outcome,
        patternId: result.patternId,
        patternsCreated: result.patternsCreated,
        patternsReinforced: result.patternsReinforced,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// GENERATE_INSIGHTS Handler
// ============================================================================

const handleGenerateInsights: JobHandler<GenerateInsightsPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, triggerType, eventId, interpretationId, patternId } = payload;

  try {
    const trigger: TriggerContext = {
      type: triggerType,
      eventId,
      interpretationId,
      patternId,
    };

    const result = await generateInsights({ userId, trigger });

    // Propagate failure from generateInsights (triggers retry)
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Insight generation failed',
        shouldRetry: true,
      };
    }

    // Also fail if no insights created (shouldn't happen with schema min constraint)
    if (result.insightsCreated === 0) {
      return {
        success: false,
        error: 'No insights generated',
        shouldRetry: true,
      };
    }

    return {
      success: true,
      data: {
        insightsCreated: result.insightsCreated,
        questionsExplored: result.questionsExplored,
        questionsAnswerable: result.questionsAnswerable,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// GENERATE_REVIEW Handler
// ============================================================================

const handleGenerateReview: JobHandler<GenerateReviewPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, type, periodKey, timezone } = payload;

  try {
    // Convert periodKey to targetDate (using UTC to avoid timezone issues)
    // periodKey formats: "2024-01-15" (daily), "2024-W03" (weekly), "2024-01" (monthly)
    let targetDate: Date;

    if (type === 'DAILY') {
      // Daily: periodKey is "YYYY-MM-DD" - parse as UTC noon to avoid timezone edge cases
      targetDate = new Date(`${periodKey}T12:00:00Z`);
    } else if (type === 'WEEKLY') {
      // Weekly: periodKey is "YYYY-WXX" (e.g., "2024-W03")
      const match = periodKey.match(/^(\d{4})-W(\d{2})$/);
      if (match) {
        const year = parseInt(match[1]);
        const week = parseInt(match[2]);
        // Get first day of the ISO week (UTC)
        targetDate = getDateFromISOWeek(year, week);
      } else {
        throw new Error(`Invalid weekly periodKey format: ${periodKey}. Expected format: YYYY-WXX (e.g., 2024-W03)`);
      }
    } else if (type === 'MONTHLY') {
      // Monthly: periodKey is "YYYY-MM" - parse as UTC noon
      targetDate = new Date(`${periodKey}-15T12:00:00Z`);
    } else {
      throw new Error(`Unknown review type: ${type}`);
    }

    const result = await generateReview({
      userId,
      reviewType: type as ReviewType,
      targetDate,
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Review generation failed',
        shouldRetry: !result.skipped, // Don't retry if skipped intentionally
      };
    }

    // Chain: if DAILY review, enqueue tomorrow planner
    if (type === 'DAILY' && result.reviewId) {
      // Calculate target date (tomorrow from the reviewed day)
      // Parse periodKey as UTC to avoid timezone issues
      const [year, month, day] = periodKey.split('-').map(Number);
      const reviewedDateUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      const tomorrowUTC = new Date(reviewedDateUTC);
      tomorrowUTC.setUTCDate(tomorrowUTC.getUTCDate() + 1);

      // Format as YYYY-MM-DD
      const targetDateStr = tomorrowUTC.toISOString().split('T')[0];

      await enqueueGenerateTomorrowPlan({
        userId,
        reviewId: result.reviewId,
        targetDate: targetDateStr,
      });
    }

    return {
      success: true,
      data: { reviewId: result.reviewId, skipped: result.skipped },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

/**
 * Get the first day (Monday) of an ISO week in UTC
 * Uses UTC to avoid timezone-related date shifts
 */
function getDateFromISOWeek(year: number, week: number): Date {
  // Jan 4th is always in week 1 of ISO calendar
  const jan4 = new Date(Date.UTC(year, 0, 4, 12, 0, 0));
  const dayOfWeek = jan4.getUTCDay() || 7; // Convert Sunday (0) to 7
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);

  const targetDate = new Date(firstMonday);
  targetDate.setUTCDate(firstMonday.getUTCDate() + (week - 1) * 7);

  return targetDate;
}

// ============================================================================
// GENERATE_TOMORROW_PLAN Handler
// ============================================================================

const handleGenerateTomorrowPlan: JobHandler<GenerateTomorrowPlanPayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, reviewId, targetDate } = payload;

  try {
    const result = await generateTomorrowPlan({ userId, reviewId, targetDate });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Tomorrow plan generation failed',
        shouldRetry: true,
      };
    }

    // If skipped (already exists), still succeed
    if (result.skipped) {
      return {
        success: true,
        data: {
          dailyPlanId: result.dailyPlanId,
          skipped: true,
          reason: result.reason,
        },
      };
    }

    // Chain: enqueue UOM suggestion
    if (result.dailyPlanId) {
      await enqueueSuggestUOMUpdate({
        userId,
        dailyPlanId: result.dailyPlanId,
      });
    }

    return {
      success: true,
      data: { dailyPlanId: result.dailyPlanId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// SUGGEST_UOM_UPDATE Handler
// ============================================================================

const handleSuggestUOMUpdate: JobHandler<SuggestUOMUpdatePayload> = async (
  payload,
  jobId
): Promise<JobResult> => {
  const { userId, dailyPlanId } = payload;

  try {
    const result = await suggestUOMUpdate({ userId, dailyPlanId });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'UOM suggestion generation failed',
        shouldRetry: true,
      };
    }

    // If skipped (cooldown, no drift, etc.), still succeed
    if (result.skipped) {
      return {
        success: true,
        data: {
          skipped: true,
          reason: result.reason,
        },
      };
    }

    return {
      success: true,
      data: { suggestionId: result.suggestionId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      shouldRetry: true,
    };
  }
};

// ============================================================================
// Register All Handlers
// ============================================================================

export function registerAllHandlers(): void {
  registerHandler(JobType.INTERPRET_EVENT, handleInterpretEvent as JobHandler);
  registerHandler(JobType.DETECT_PATTERNS, handleDetectPatterns as JobHandler);
  registerHandler(JobType.GENERATE_INSIGHTS, handleGenerateInsights as JobHandler);
  registerHandler(JobType.GENERATE_REVIEW, handleGenerateReview as JobHandler);
  registerHandler(JobType.GENERATE_TOMORROW_PLAN, handleGenerateTomorrowPlan as JobHandler);
  registerHandler(JobType.SUGGEST_UOM_UPDATE, handleSuggestUOMUpdate as JobHandler);

  console.log('[Handlers] All handlers registered');
}
