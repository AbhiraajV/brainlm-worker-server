"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEvent = createEvent;
const prisma_1 = __importDefault(require("../prisma"));
const jobs_1 = require("../jobs");
/**
 * Creates a new event and triggers async interpretation.
 *
 * Layer 1 of the pipeline:
 * - Event is stored immediately (no blocking on LLM)
 * - Interpretation is triggered async
 */
async function createEvent(input) {
    const event = await prisma_1.default.event.create({
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
        (0, jobs_1.processNewEvent)(event.id).catch((err) => {
            console.error(`[CreateEvent] Failed to process event ${event.id}:`, err);
        });
    });
    return { eventId: event.id };
}
