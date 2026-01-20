# Level-1 Memory Creation

> The foundational layer for storing user memories as immutable events.

---

## Overview

Level-1 is the **minimal viable memory ingestion layer**. It accepts raw user input and persists it as an `Event` record. No processing, no enrichment, no side effects.

```
User Input → POST /memory → Event (stored) → eventId (returned)
```

This layer is intentionally primitive. Future levels will add:
- Tagging and categorization
- Interpretation and meaning extraction
- Pattern detection
- Contextual linking
- Embeddings for semantic search

Level-1 does **none of that**. It only stores.

---

## API Specification

### Endpoint

```
POST /memory
```

### Authentication

**Required.** Uses the `requireAuth` middleware.

- Extracts user identity from `req.auth.user.id`
- Returns `401 Unauthorized` if not authenticated

### Request

**Headers:**
```
Content-Type: application/json
Authorization: Bearer <token>  (when real auth is implemented)
```

**Body:**
```json
{
  "content": "I went for a morning run today",
  "occurredAt": "2024-01-15T08:30:00.000Z"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | The memory content. Non-empty after trimming. |
| `occurredAt` | string (ISO 8601) | Yes | When the event occurred. Must be valid date. |

### Response

**Success (200):**
```json
{
  "eventId": "cmkfolqf90001zjiifd7e1c6d"
}
```

**Errors:**

| Status | Condition | Response |
|--------|-----------|----------|
| 400 | Missing or empty `content` | `{ "error": "content is required" }` |
| 400 | Missing `occurredAt` | `{ "error": "occurredAt is required" }` |
| 400 | Invalid date format | `{ "error": "occurredAt must be valid ISO date" }` |
| 401 | Not authenticated | `{ "error": "Authentication required" }` |
| 500 | Database error | `{ "error": "Failed to create event" }` |

---

## Data Model

### Event Table

The endpoint writes to the `Event` table with the following fields:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `id` | string (cuid) | Auto-generated | Unique event identifier |
| `userId` | string | `req.auth.user.id` | Owner of this memory |
| `content` | string | Request body | The memory text |
| `occurredAt` | DateTime | Request body | When the event happened |
| `createdAt` | DateTime | Auto (now) | When the record was created |
| `audioRef` | string? | Not set | Reserved for future audio attachments |
| `embedding` | vector? | Not set | Reserved for future semantic embeddings |

### What is NOT Written

Level-1 deliberately ignores:
- `Tag` - No categorization
- `EventTag` - No tagging
- `Interpretation` - No meaning extraction
- `EventContext` - No linking to other events
- `Pattern` - No pattern detection
- `Recommendation` - No suggestions

These will be handled by higher levels.

---

## Architecture

### Separation of Concerns

The implementation separates HTTP handling from business logic:

```
src/
├── index.ts              # HTTP handler (validation, response)
└── memory/
    ├── create-event.ts   # Pure function (no Express dependency)
    └── index.ts          # Barrel export
```

### HTTP Handler (`src/index.ts`)

Responsibilities:
1. Extract `content` and `occurredAt` from request body
2. Validate inputs (type checks, non-empty, valid date)
3. Extract `userId` from authenticated context
4. Call `createEvent()` with plain types
5. Return JSON response

```typescript
app.post('/memory', requireAuth, async (req, res) => {
  const { content, occurredAt } = req.body;

  // Validation...

  const result = await createEvent({
    userId: req.auth!.user!.id,
    content: content.trim(),
    occurredAt: parsedDate,
  });

  res.status(200).json(result);
});
```

### Business Logic (`src/memory/create-event.ts`)

Responsibilities:
1. Accept plain TypeScript types (no Express objects)
2. Write to database
3. Return event ID

```typescript
export interface CreateEventInput {
  userId: string;
  content: string;
  occurredAt: Date;
}

export interface CreateEventResult {
  eventId: string;
}

export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const event = await prisma.event.create({
    data: {
      userId: input.userId,
      content: input.content,
      occurredAt: input.occurredAt,
    },
    select: { id: true },
  });

  return { eventId: event.id };
}
```

### Why This Separation?

| Benefit | Explanation |
|---------|-------------|
| Testability | `createEvent()` can be unit tested without HTTP mocking |
| Reusability | Same function usable from CLI, background jobs, GraphQL |
| Clarity | HTTP concerns stay in handlers, data logic stays pure |
| Type Safety | Input interface documents exactly what's needed |

---

## Design Decisions

### 1. Atomic Writes Only

Each request creates exactly one `Event` record. No transactions spanning multiple tables. No partial failures to handle.

**Why:** Simplicity. Level-1 is a foundation, not a feature.

### 2. No Side Effects

The endpoint:
- Does NOT trigger background jobs
- Does NOT emit events to queues
- Does NOT call external services
- Does NOT update other tables

**Why:** Predictability. The caller knows exactly what happens.

### 3. Immutable Events

Events are append-only. There is no `PUT /memory/:id` or `DELETE /memory/:id`.

**Why:** Events represent facts. Facts don't change. Interpretations of facts can change (handled by higher levels).

### 4. No Retry Logic

If the database write fails, the request fails. No automatic retries.

**Why:** The caller can retry. Hidden retries complicate debugging and can cause duplicate writes.

### 5. Content is Opaque

The endpoint does not parse, validate, or interpret the `content` field beyond checking it's non-empty.

**Why:** Level-1 doesn't know what content means. It just stores bytes. Meaning extraction is Level-2+.

---

## Testing

### Scripts

```bash
# Create a test user (required once)
npx ts-node scripts/create-test-user.ts

# Test the endpoint
npx ts-node scripts/test-memory.ts
```

### Manual Testing

```bash
# Start server
npm run dev

# Create event
curl -X POST http://localhost:3000/memory \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Had coffee with Sarah",
    "occurredAt": "2024-01-15T09:00:00.000Z"
  }'

# Expected response
{"eventId":"cmk..."}
```

### Validation Tests

```bash
# Missing content → 400
curl -X POST http://localhost:3000/memory \
  -H "Content-Type: application/json" \
  -d '{"occurredAt": "2024-01-15T09:00:00.000Z"}'

# Invalid date → 400
curl -X POST http://localhost:3000/memory \
  -H "Content-Type: application/json" \
  -d '{"content": "test", "occurredAt": "not-a-date"}'
```

---

## Future Levels

| Level | Responsibility |
|-------|----------------|
| Level-1 | Store raw events (this document) |
| Level-2 | Auto-tag events, extract entities |
| Level-3 | Generate interpretations |
| Level-4 | Link events to context |
| Level-5 | Detect patterns |
| Level-6 | Generate recommendations |
| Level-7 | Semantic search via embeddings |

Each level builds on the previous. Level-1 is the immutable foundation.

---

## File Reference

| File | Purpose |
|------|---------|
| `src/memory/create-event.ts` | Pure event creation function |
| `src/memory/index.ts` | Barrel export |
| `src/index.ts` | HTTP route handler |
| `scripts/create-test-user.ts` | Test user setup |
| `scripts/test-memory.ts` | Endpoint test |

---

*Last updated: January 2026*
