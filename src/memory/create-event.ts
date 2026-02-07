import prisma from '../prisma';
import { JobType, JobStatus, TrackedType } from '@prisma/client';

export interface CreateEventInput {
  userId: string;
  content: string;
  occurredAt: Date;
  trackedType?: TrackedType;
  rawJson?: any;
}

export interface CreateEventResult {
  eventId: string;
  jobId: string;
}

/**
 * Creates an event and enqueues it for interpretation atomically.
 *
 * Uses a transaction to ensure both event and job are created together,
 * preventing orphaned events if job creation fails.
 *
 * This function is used by the server. For client usage, see:
 * /src/lib/queue-client.ts → createEventWithProcessing()
 *
 * Flow triggered:
 * 1. INTERPRET_EVENT → creates interpretation
 * 2. DETECT_PATTERNS → detects/reinforces patterns (chained by handler)
 * 3. GENERATE_INSIGHTS → generates insights if pattern created/evolved (chained by handler)
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const { userId, content, occurredAt, trackedType, rawJson } = input;

  // Use transaction to ensure atomicity - both event and job created together
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the event
    const event = await tx.event.create({
      data: {
        userId,
        content,
        occurredAt,
        ...(trackedType && { trackedType }),
        ...(rawJson !== undefined && { rawJson }),
      },
      select: { id: true },
    });

    // 2. Create the interpretation job in the same transaction
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

  console.log(`[CreateEvent] Created event ${result.eventId}, enqueued job ${result.jobId}`);

  return result;
}
