import prisma from '../prisma';
import { processNewEvent } from '../jobs';

export interface CreateEventInput {
  userId: string;
  content: string;
  occurredAt: Date;
}

export interface CreateEventResult {
  eventId: string;
}

/**
 * Creates a new event and triggers async interpretation.
 * 
 * Layer 1 of the pipeline:
 * - Event is stored immediately (no blocking on LLM)
 * - Interpretation is triggered async
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const event = await prisma.event.create({
    data: {
      userId: input.userId,
      content: input.content,
      occurredAt: input.occurredAt,
    },
    select: { id: true },
  });

  // Trigger async interpretation (non-blocking)
  // In production, this would be a queue job
  setImmediate(() => {
    processNewEvent(event.id).catch((err) => {
      console.error(`[CreateEvent] Failed to process event ${event.id}:`, err);
    });
  });

  return { eventId: event.id };
}
