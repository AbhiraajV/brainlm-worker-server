# Worker-1: Tagging & Interpretation

Worker-1 is the **Understanding Layer** of the memory pipeline. It transforms raw Events into structured knowledge by assigning hierarchical tags and generating interpretations.

---

## Position in Pipeline

```
Event (Fact)
     ↓
 WORKER-1 ← You are here
     ↓
Tags + Interpretations (Understanding)
     ↓
Context (Structure)
     ↓
Patterns (Long-term)
```

Worker-1 runs after Event creation and before Context building.

---

## What It Does

1. **Assigns 1-5 hierarchical tags** that categorize the event
2. **Generates 1-3 interpretations** explaining WHY this happened or what it reveals

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         enrichEvent(eventId)                     │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │ Idempotency  │───▶│ Fetch Event  │───▶│ Fetch User's     │   │
│  │ Check        │    │ + Validate   │    │ Existing Tags    │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│         │                                        │               │
│         │ (skip if already processed)            ▼               │
│         │                              ┌──────────────────┐      │
│         │                              │ Build LLM Input  │      │
│         │                              └──────────────────┘      │
│         │                                        │               │
│         │                                        ▼               │
│         │                              ┌──────────────────┐      │
│         │                              │ Call OpenAI      │      │
│         │                              │ (gpt-4o-mini)    │      │
│         │                              └──────────────────┘      │
│         │                                        │               │
│         │                                        ▼               │
│         │                              ┌──────────────────┐      │
│         │                              │ Validate Output  │      │
│         │                              │ (Zod Schema)     │      │
│         │                              └──────────────────┘      │
│         │                                        │               │
│         │                                        ▼               │
│         │                              ┌──────────────────┐      │
│         │                              │ DB Transaction   │      │
│         │                              │ - Create Tags    │      │
│         │                              │ - Create EventTag│      │
│         │                              │ - Create Interp  │      │
│         │                              └──────────────────┘      │
│         │                                        │               │
│         ▼                                        ▼               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Return Result                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Usage

### Basic Usage

```typescript
import { enrichEvent } from '@/workers/tagging';

const result = await enrichEvent(eventId);

if (result.success) {
  console.log(`Created ${result.tagsCreated} new tags`);
  console.log(`Reused ${result.tagsReused} existing tags`);
  console.log(`Created ${result.interpretationsCreated} interpretations`);
}
```

### Return Type

```typescript
interface EnrichEventResult {
  success: boolean;
  tagsCreated: number;      // New tags added to user's ontology
  tagsReused: number;       // Existing tags linked to event
  interpretationsCreated: number;
  skipped?: boolean;        // True if already processed
  reason?: string;          // Explanation if skipped
}
```

### Idempotency

Worker-1 is idempotent. Calling it multiple times on the same event is safe:

```typescript
await enrichEvent(eventId); // Processes event
await enrichEvent(eventId); // Returns { skipped: true, reason: 'Already processed' }
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for GPT-4o-mini |
| `DATABASE_URL` | Yes | PostgreSQL connection string |

### LLM Settings

| Setting | Value | Rationale |
|---------|-------|-----------|
| Model | `gpt-4o-mini` | Fast, cost-effective, good at structured output |
| Temperature | `0.3` | Low variance for consistent tagging |
| Response Format | `json_object` | Enforces valid JSON output |

---

## Tag System

### Hierarchical Structure

Tags use a hierarchical slug format with unbounded depth:

```
domain/subdomain/.../leaf
```

Examples:
- `health` (depth 1)
- `health/gym` (depth 2)
- `health/gym/chest` (depth 3)
- `health/gym/chest/bench-press` (depth 4)
- `emotion/anxiety/social` (depth 3)
- `habit/substance/smoking` (depth 3)

### Slug Rules

- Lowercase letters, numbers, hyphens, forward slashes only
- No trailing slashes
- No double slashes
- No spaces

Valid: `health/gym/chest-day`
Invalid: `Health/Gym/`, `health//gym`, `health gym`

### User-Scoped Ontology

Each user grows their own tag vocabulary. Tags are unique per user:

```
User A: health/gym, health/gym/chest, work/meetings
User B: health/gym, health/mental, family/kids
```

The LLM sees the user's existing tags and prefers reusing them when semantically appropriate.

### Slug Normalization

Raw LLM output is normalized before storage:

```typescript
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/[^a-z0-9\-\/]/g, '')  // remove invalid chars
    .replace(/\/+/g, '/')           // collapse multiple slashes
    .replace(/^\/|\/$/g, '')        // trim leading/trailing slashes
    .replace(/-+/g, '-');           // collapse multiple hyphens
}
```

---

## Interpretations

### What They Are

Interpretations answer ONE question: **"What might this single event indicate about the user's internal state at that moment?"**

They are hypotheses about the user's internal state during THIS event only. They are not pattern claims, judgments, or advice.

### Examples

Event: "Had a cigarette after dinner"

Good interpretations:
- "This may reflect short-term stress relief seeking."
- "This could indicate emotional regulation through consumption."
- "Possibly driven by fatigue or reduced impulse control."

Bad interpretations:
- "You do this because you are addicted" (pattern claim)
- "This always happens after work" (temporal aggregation)
- "You should stop doing this" (recommendation)
- "This is a bad habit" (judgment)

### Confidence Scores

| Range | Meaning |
|-------|---------|
| 0.9 - 1.0 | Very certain |
| 0.7 - 0.9 | Reasonably confident |
| 0.5 - 0.7 | Plausible but uncertain |
| < 0.5 | Speculative |

---

## Database Writes

### Tables Modified

| Table | Action | Description |
|-------|--------|-------------|
| `Tag` | INSERT (conditional) | Only if LLM creates new tag |
| `EventTag` | INSERT | Links event to all assigned tags |
| `Interpretation` | INSERT | All generated interpretations |

### Transaction Guarantee

All writes occur in a single transaction. Either everything succeeds or nothing is written:

```typescript
await prisma.$transaction(async (tx) => {
  // 1. Create new tags (if any)
  // 2. Create EventTags (always)
  // 3. Create Interpretations (always)
});
```

### Data Flow

```
Event exists
     │
     ▼
┌─────────────────┐
│ Worker-1 runs   │
└─────────────────┘
     │
     ├──▶ Tag (0-5 new rows)
     │
     ├──▶ EventTag (1-5 rows)
     │
     └──▶ Interpretation (1-3 rows, source=AUTOMATIC)
```

---

## Error Handling

Worker-1 uses fail-fast semantics. No retries are implemented at this layer.

### Error Types

| Error | Cause | Recovery |
|-------|-------|----------|
| `EnrichmentError` | Event not found | Check eventId |
| `EnrichmentError` | LLM returned empty response | Retry call |
| `EnrichmentError` | LLM returned invalid JSON | Retry call |
| `EnrichmentError` | Zod validation failed | Check LLM prompt |
| Prisma error | Database write failed | Transaction rolled back |

### Caller Responsibility

The caller decides whether to retry or log and continue:

```typescript
try {
  await enrichEvent(eventId);
} catch (error) {
  if (error instanceof EnrichmentError) {
    // Log and continue - event still exists
    logger.warn(`Enrichment failed for ${eventId}: ${error.message}`);
  } else {
    throw error;
  }
}
```

---

## File Structure

```
src/workers/tagging/
├── index.ts          # Public exports
├── enrich-event.ts   # Main function (207 lines)
├── prompt.ts         # LLM system prompt
└── schema.ts         # Zod validation schemas
```

### Exports

```typescript
// Functions
export { enrichEvent } from './enrich-event';

// Types
export { EnrichEventResult, EnrichmentError } from './enrich-event';
export type { LLMOutput, TagOutput, InterpretationOutput } from './schema';

// Schemas (for testing/validation)
export { LLMOutputSchema, TagOutputSchema, InterpretationOutputSchema } from './schema';

// Prompt (for inspection/testing)
export { TAGGING_SYSTEM_PROMPT } from './prompt';
```

---

## LLM Prompt

The system prompt instructs the LLM to:

1. Assign 1-5 hierarchical tags
2. Generate 1-3 interpretations
3. Prefer existing tags when appropriate
4. Create new tags only when needed
5. Output strict JSON with no markdown

Full prompt available at `src/workers/tagging/prompt.ts`

### Input Format

```json
{
  "event": {
    "content": "Did chest day at gym, hit a new PR on bench",
    "occurredAt": "2024-01-15T10:00:00.000Z"
  },
  "existingTags": [
    { "slug": "health/gym", "description": "Gym-related activities" },
    { "slug": "emotion/happy", "description": "Positive emotional states" }
  ]
}
```

### Output Format

```json
{
  "tags": [
    {
      "slug": "health/gym/chest/bench-press",
      "name": "Bench Press",
      "description": "Barbell bench press exercise for chest",
      "confidence": 0.95
    },
    {
      "slug": "health/gym",
      "name": "Gym",
      "description": "Gym-related activities",
      "confidence": 0.98
    }
  ],
  "interpretations": [
    {
      "content": "Hitting a new PR suggests consistent training and progressive overload. This may indicate the user is in a good training phase with adequate recovery.",
      "confidence": 0.85
    }
  ]
}
```

---

## Validation Schemas

### TagOutputSchema

```typescript
z.object({
  slug: z.string()
    .min(1, 'Slug cannot be empty')
    .regex(/^[a-z0-9]+(?:\/[a-z0-9-]+)*$/, 'Invalid slug format'),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
})
```

### InterpretationOutputSchema

```typescript
z.object({
  content: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
})
```

### LLMOutputSchema

```typescript
z.object({
  tags: z.array(TagOutputSchema).min(1).max(5),
  interpretations: z.array(InterpretationOutputSchema).min(1).max(3),
})
```

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM Provider | OpenAI (hardcoded) | MVP simplicity, abstract later |
| Execution | Synchronous function | Can be wrapped in queue later |
| Retries | None | Caller handles retry logic |
| Tag creation | LLM decides | Trust LLM to judge when new tags needed |
| Confidence filtering | LLM handles | No code-level threshold |

---

## Future Enhancements

These are intentionally NOT implemented yet:

- [ ] LLM provider abstraction (swap OpenAI for Anthropic, etc.)
- [ ] Retry logic with exponential backoff
- [ ] Queue-based async execution (BullMQ, pg-boss)
- [ ] Confidence threshold filtering
- [ ] Tag suggestion pre-validation
- [ ] Batch processing for multiple events

---

## Testing

### Unit Tests

```typescript
// Slug normalization
expect(normalizeSlug('Health/Gym ')).toBe('health/gym');
expect(normalizeSlug('health//gym')).toBe('health/gym');

// Depth calculation
expect(calculateDepth('health')).toBe(1);
expect(calculateDepth('health/gym/chest')).toBe(3);
```

### Integration Tests

1. **Happy path**: Event → Tags + Interpretations created
2. **Idempotency**: Same event twice → second call skipped
3. **New tag creation**: LLM invents new tag → Tag row created
4. **Existing tag reuse**: LLM uses existing tag → No duplicate Tag

### Manual Testing

```bash
# 1. Create an event first (via your API)

# 2. Call enrichEvent
npx ts-node -e "
  import { enrichEvent } from './src/workers/tagging';
  enrichEvent('EVENT_ID_HERE').then(console.log).catch(console.error);
"

# 3. Verify in database
npx prisma studio
# Check: Tag, EventTag, Interpretation tables
```

---

## Troubleshooting

### "Event not found"

The eventId doesn't exist in the database. Ensure the event was created before calling enrichEvent.

### "LLM returned empty response"

OpenAI returned no content. Check:
- API key is valid
- Account has credits
- Model name is correct

### "LLM returned invalid JSON"

The model didn't return valid JSON. This is rare with `response_format: { type: 'json_object' }`. Check:
- System prompt hasn't been corrupted
- Temperature isn't too high

### "Zod validation failed"

LLM output didn't match expected schema. Common causes:
- Slug format invalid (spaces, uppercase, etc.)
- Confidence outside 0-1 range
- Empty arrays

### "Already processed"

This is not an error. The event already has tags assigned. Worker-1 is idempotent by design.

---

## One-Paragraph Summary

Worker-1 transforms raw events into structured understanding by calling an LLM to assign hierarchical tags and generate interpretations. It's a pure, synchronous, idempotent function that writes to Tag, EventTag, and Interpretation tables in a single transaction. Tags are user-scoped and hierarchical (e.g., `health/gym/chest`), allowing each user to grow their own semantic ontology over time. The function fails fast with no internal retries, delegating error handling to the caller.
