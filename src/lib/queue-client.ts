import { PrismaClient, JobType, JobStatus, UOMSuggestionStatus, Prisma } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

export interface CreateEventWithProcessingInput {
  userId: string;
  content: string;
  occurredAt: Date;
}

export interface CreateEventWithProcessingResult {
  eventId: string;
  jobId: string;
}

// ============================================================================
// Event Creation + Processing Trigger
// ============================================================================

/**
 * Creates an event and enqueues it for processing.
 * This is the PRIMARY way the client triggers the processing chain.
 *
 * Flow triggered:
 * 1. INTERPRET_EVENT → creates interpretation
 * 2. DETECT_PATTERNS → detects/reinforces patterns
 * 3. GENERATE_INSIGHTS → generates insights (if pattern created/evolved)
 *
 * @param prisma - Prisma client instance
 * @param input - Event data
 * @returns Event ID and Job ID
 */
export async function createEventWithProcessing(
  prisma: PrismaClient,
  input: CreateEventWithProcessingInput
): Promise<CreateEventWithProcessingResult> {
  const { userId, content, occurredAt } = input;

  // Use transaction to ensure both event and job are created
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the event
    const event = await tx.event.create({
      data: {
        userId,
        content,
        occurredAt,
      },
      select: { id: true },
    });

    // 2. Enqueue interpretation job
    const job = await tx.workerJob.create({
      data: {
        type: JobType.INTERPRET_EVENT,
        payload: { eventId: event.id },
        status: JobStatus.PENDING,
        priority: 0,
        maxAttempts: 3,
        userId,
        idempotencyKey: `interpret:${event.id}`,
      },
      select: { id: true },
    });

    return { eventId: event.id, jobId: job.id };
  });

  console.log(`[Client] Created event ${result.eventId}, job ${result.jobId}`);
  return result;
}

// ============================================================================
// Manual Job Enqueueing (Advanced)
// ============================================================================

/**
 * Manually enqueue a review generation job.
 * Typically the cron handles this, but client can trigger manually.
 *
 * Uses try-catch with unique constraint handling to prevent race conditions.
 *
 * @param prisma - Prisma client instance
 * @param userId - User ID
 * @param type - Review type (DAILY, WEEKLY, MONTHLY)
 * @param periodKey - Period key (e.g., "2024-01-15", "2024-W03", "2024-01")
 * @param timezone - User's timezone
 */
export async function enqueueReviewGeneration(
  prisma: PrismaClient,
  userId: string,
  type: 'DAILY' | 'WEEKLY' | 'MONTHLY',
  periodKey: string,
  timezone: string
): Promise<string> {
  const idempotencyKey = `review:${userId}:${type}:${periodKey}`;

  try {
    // Attempt to create the job directly
    const job = await prisma.workerJob.create({
      data: {
        type: JobType.GENERATE_REVIEW,
        payload: { userId, type, periodKey, timezone },
        status: JobStatus.PENDING,
        priority: 0,
        maxAttempts: 3,
        userId,
        idempotencyKey,
      },
      select: { id: true },
    });

    console.log(`[Client] Enqueued ${type} review job ${job.id}`);
    return job.id;
  } catch (error) {
    // Handle unique constraint violation (concurrent insert)
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.workerJob.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });

      if (existing) {
        console.log(`[Client] Review job already exists: ${existing.id}`);
        return existing.id;
      }
    }
    throw error;
  }
}

// ============================================================================
// Job Status Checking
// ============================================================================

/**
 * Check the status of a job.
 * Useful for showing processing status in UI.
 */
export async function getJobStatus(
  prisma: PrismaClient,
  jobId: string
): Promise<{
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  completedAt: Date | null;
} | null> {
  const job = await prisma.workerJob.findUnique({
    where: { id: jobId },
    select: {
      status: true,
      attempts: true,
      lastError: true,
      completedAt: true,
    },
  });

  return job;
}

/**
 * Check if processing is complete for an event.
 * Looks for completed INTERPRET_EVENT job for this event.
 */
export async function isEventProcessed(
  prisma: PrismaClient,
  eventId: string
): Promise<boolean> {
  const job = await prisma.workerJob.findFirst({
    where: {
      type: JobType.INTERPRET_EVENT,
      idempotencyKey: `interpret:${eventId}`,
      status: JobStatus.COMPLETED,
    },
    select: { id: true },
  });

  return job !== null;
}

// ============================================================================
// UOM Suggestion Management
// ============================================================================

/**
 * Get pending UOM suggestions for a user.
 */
export async function getPendingUOMSuggestions(
  prisma: PrismaClient,
  userId: string
) {
  return prisma.uOMUpdateSuggestion.findMany({
    where: {
      userId,
      status: UOMSuggestionStatus.PENDING,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Accept a UOM suggestion and update the baseline.
 *
 * @param prisma - Prisma client instance
 * @param userId - User ID (for verification)
 * @param suggestionId - Suggestion ID to accept
 */
export async function acceptUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
    include: { user: { select: { baseline: true } } },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== UOMSuggestionStatus.PENDING) {
    return { success: false, error: `Cannot accept suggestion with status: ${suggestion.status}` };
  }

  const currentBaseline = suggestion.user.baseline || '';
  const timestamp = new Date().toISOString().split('T')[0];

  // Apply update based on drift type
  let newBaseline: string;
  switch (suggestion.driftType) {
    case 'ADDITION':
      newBaseline = currentBaseline
        ? `${currentBaseline.trimEnd()}\n\n---\n**Update (${timestamp}):**\n- ${suggestion.suggestion}`
        : `# User Baseline\n\n- ${suggestion.suggestion}\n\n*Added: ${timestamp}*`;
      break;
    case 'MODIFICATION':
      newBaseline = `${currentBaseline.trimEnd()}\n\n---\n**Modification (${timestamp}):**\n- ${suggestion.suggestion}`;
      break;
    case 'REMOVAL':
      newBaseline = `${currentBaseline.trimEnd()}\n\n---\n**Deprecated (${timestamp}):**\n- ~~${suggestion.suggestion}~~`;
      break;
    default:
      newBaseline = `${currentBaseline.trimEnd()}\n\n- ${suggestion.suggestion}`;
  }

  // Update in transaction with error handling
  try {
    await prisma.$transaction([
      prisma.uOMUpdateSuggestion.update({
        where: { id: suggestionId },
        data: {
          status: UOMSuggestionStatus.ACCEPTED,
          statusChangedAt: new Date(),
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: {
          baseline: newBaseline,
          lastBaselineUpdate: new Date(),
        },
      }),
    ]);

    return { success: true };
  } catch (error) {
    console.error('[Client] Failed to accept UOM suggestion:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update database',
    };
  }
}

/**
 * Reject a UOM suggestion.
 */
export async function rejectUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== UOMSuggestionStatus.PENDING) {
    return { success: false, error: `Cannot reject suggestion with status: ${suggestion.status}` };
  }

  try {
    await prisma.uOMUpdateSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: UOMSuggestionStatus.REJECTED,
        statusChangedAt: new Date(),
        reasoning: reason
          ? `${suggestion.reasoning}\n\n---\n**Rejected:** ${reason}`
          : suggestion.reasoning,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[Client] Failed to reject UOM suggestion:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update database',
    };
  }
}

/**
 * Ignore a UOM suggestion (dismiss without rejection).
 */
export async function ignoreUOMSuggestion(
  prisma: PrismaClient,
  userId: string,
  suggestionId: string
): Promise<{ success: boolean; error?: string }> {
  const suggestion = await prisma.uOMUpdateSuggestion.findFirst({
    where: { id: suggestionId, userId },
  });

  if (!suggestion) {
    return { success: false, error: 'Suggestion not found' };
  }

  if (suggestion.status !== UOMSuggestionStatus.PENDING) {
    return { success: false, error: `Cannot ignore suggestion with status: ${suggestion.status}` };
  }

  try {
    await prisma.uOMUpdateSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: UOMSuggestionStatus.IGNORED,
        statusChangedAt: new Date(),
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[Client] Failed to ignore UOM suggestion:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update database',
    };
  }
}
