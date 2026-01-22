# Phase 3: Tomorrow Planner Worker

## Overview

The Tomorrow Planner Worker transforms a reflective daily review into a forward-looking, actionable plan for the next day. It runs automatically after each daily review is generated.

---

## Prerequisites

- **Phase 1 completed:** Queue infrastructure working
- **Phase 2 completed:** Daily flow integration working
- **Prisma schema already includes:** `DailyPlan` model (added in Phase 1)

---

## Business Logic Doctrine

### Purpose

Transform reflective daily review into forward-looking, actionable plan.

### Input Sources

| Source | Description | Required |
|--------|-------------|----------|
| Daily Review | The just-generated review (full structured content) | Yes |
| User Baseline (UOM) | User's self-description, routines, goals | Yes |
| Active Patterns | Current patterns with ACTIVE status | Yes |
| Recent Insights | Insights from last 7 days | Yes |
| Day-of-Week Context | What day tomorrow is (Mon, Tue, etc.) | Yes |

### Output Constraints

| Constraint | Rationale |
|------------|-----------|
| Max 3 focus areas | Prevents overwhelm, ensures actionability |
| Must reference pattern/insight IDs | Grounds suggestions in observed data |
| Frame as observations, NOT prescriptions | Respect autonomy, avoid therapeutic language |
| Acknowledge uncertainty for new patterns | Maintain intellectual honesty |
| Flag stale baseline (>30 days) | Prompt user to update UOM |

### Rules

| Rule | Type |
|------|------|
| MUST ground suggestions in observed patterns | Mandatory |
| MUST NOT be therapeutic/prescriptive | Mandatory |
| SHOULD consider day-of-week patterns | Recommended |
| SHOULD include pattern-based warnings | Recommended |

### Model Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Model | `gpt-4o-mini` | Cost-efficient for planning |
| Temperature | 0.4 | Deterministic but creative |
| Max Tokens | 2000 | Sufficient for comprehensive plan |
| Response Format | `json_object` | Structured output |

---

## Files to Create

### Directory Structure

```
/src/workers/tomorrow-plan/
├── index.ts              # Public exports
├── schema.ts             # Zod schemas
├── data-retrieval.ts     # Context gathering
├── generate-plan.ts      # Main worker function
└── prompt.ts             # LLM message formatting
```

---

### 1. `/src/workers/tomorrow-plan/schema.ts`

**Purpose:** Zod validation schemas for input and output

```typescript
import { z } from 'zod';

// ============================================================================
// Input Schema
// ============================================================================

export const GenerateTomorrowPlanInputSchema = z.object({
  userId: z.string().min(1),
  reviewId: z.string().min(1),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
});

export type GenerateTomorrowPlanInput = z.infer<typeof GenerateTomorrowPlanInputSchema>;

// ============================================================================
// Output Schema (LLM Response)
// ============================================================================

export const FocusAreaSchema = z.object({
  area: z.string().min(5).max(100),
  reasoning: z.string().min(20).max(500),
  patternRef: z.string().optional(),
  insightRef: z.string().optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']),
});

export const SessionSchema = z.object({
  timeSlot: z.string().min(3).max(50), // e.g., "Morning (6-9am)", "Evening"
  activity: z.string().min(5).max(200),
  reasoning: z.string().min(20).max(500),
  patternRef: z.string().optional(),
  optional: z.boolean().default(false),
});

export const WarningSchema = z.object({
  warning: z.string().min(10).max(300),
  patternId: z.string().optional(),
  insightId: z.string().optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']),
});

export const CTASchema = z.object({
  action: z.string().min(5).max(200),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  reasoning: z.string().min(20).max(300),
  patternRef: z.string().optional(),
});

export const TomorrowPlanOutputSchema = z.object({
  focusAreas: z.array(FocusAreaSchema).min(1).max(3),
  sessions: z.array(SessionSchema).min(1).max(6),
  warnings: z.array(WarningSchema).max(3),
  ctas: z.array(CTASchema).min(1).max(3),
  baselineStale: z.boolean(),
  baselineStaleDays: z.number().optional(),
  renderedMarkdown: z.string().min(100).max(5000),
});

export type TomorrowPlanOutput = z.infer<typeof TomorrowPlanOutputSchema>;

// ============================================================================
// Result Schema
// ============================================================================

export const GenerateTomorrowPlanResultSchema = z.object({
  success: z.boolean(),
  dailyPlanId: z.string().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

export type GenerateTomorrowPlanResult = z.infer<typeof GenerateTomorrowPlanResultSchema>;
```

---

### 2. `/src/workers/tomorrow-plan/data-retrieval.ts`

**Purpose:** Gather all context needed for plan generation

```typescript
import prisma from '../../prisma';
import { addDays, subDays, format, differenceInDays } from 'date-fns';

// ============================================================================
// Types
// ============================================================================

export interface TomorrowPlanContext {
  user: {
    id: string;
    name: string | null;
    baseline: string | null;
    lastBaselineUpdate: Date | null;
    baselineStaleDays: number | null;
  };
  review: {
    id: string;
    structuredContent: unknown;
    renderedMarkdown: string;
    summary: string;
    periodKey: string;
  };
  patterns: Array<{
    id: string;
    description: string;
    status: string;
    lastReinforcedAt: Date;
  }>;
  insights: Array<{
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    category: string | null;
    temporalScope: string | null;
  }>;
  dayOfWeek: {
    name: string;        // "Monday", "Tuesday", etc.
    shortName: string;   // "Mon", "Tue", etc.
    isWeekend: boolean;
  };
  targetDate: string;
}

// ============================================================================
// Main Retrieval Function
// ============================================================================

export async function retrieveTomorrowPlanContext(
  userId: string,
  reviewId: string,
  targetDate: string
): Promise<TomorrowPlanContext | null> {
  const targetDateObj = new Date(targetDate);
  const sevenDaysAgo = subDays(new Date(), 7);

  // Parallel fetch
  const [user, review, patterns, insights] = await Promise.all([
    // User with baseline
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        baseline: true,
        lastBaselineUpdate: true,
      },
    }),

    // The daily review we're planning from
    prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        structuredContent: true,
        renderedMarkdown: true,
        summary: true,
        periodKey: true,
        type: true,
      },
    }),

    // Active patterns
    prisma.pattern.findMany({
      where: {
        userId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        description: true,
        status: true,
        lastReinforcedAt: true,
      },
      orderBy: { lastReinforcedAt: 'desc' },
      take: 20, // Limit for context window
    }),

    // Recent insights (last 7 days)
    prisma.insight.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'LIKELY', 'SPECULATIVE'] },
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        id: true,
        statement: true,
        explanation: true,
        confidence: true,
        category: true,
        temporalScope: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 15, // Limit for context window
    }),
  ]);

  if (!user || !review) {
    return null;
  }

  // Verify review is DAILY type
  if (review.type !== 'DAILY') {
    console.warn(`[TomorrowPlan] Review ${reviewId} is ${review.type}, not DAILY`);
    return null;
  }

  // Calculate baseline staleness
  let baselineStaleDays: number | null = null;
  if (user.lastBaselineUpdate) {
    baselineStaleDays = differenceInDays(new Date(), user.lastBaselineUpdate);
  } else if (user.baseline) {
    // If baseline exists but no update date, assume very stale
    baselineStaleDays = 90;
  }

  // Calculate day of week for target date
  const dayIndex = targetDateObj.getDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const dayOfWeek = {
    name: dayNames[dayIndex],
    shortName: shortDayNames[dayIndex],
    isWeekend: dayIndex === 0 || dayIndex === 6,
  };

  return {
    user: {
      id: user.id,
      name: user.name,
      baseline: user.baseline,
      lastBaselineUpdate: user.lastBaselineUpdate,
      baselineStaleDays,
    },
    review: {
      id: review.id,
      structuredContent: review.structuredContent,
      renderedMarkdown: review.renderedMarkdown,
      summary: review.summary,
      periodKey: review.periodKey,
    },
    patterns,
    insights,
    dayOfWeek,
    targetDate,
  };
}

// ============================================================================
// Check for Existing Plan
// ============================================================================

export async function checkExistingPlan(
  userId: string,
  targetDate: string
): Promise<string | null> {
  const existing = await prisma.dailyPlan.findFirst({
    where: {
      userId,
      targetDate: new Date(targetDate),
    },
    select: { id: true },
  });

  return existing?.id ?? null;
}
```

---

### 3. `/src/workers/tomorrow-plan/prompt.ts`

**Purpose:** Format user message and system prompt

```typescript
import { TomorrowPlanContext } from './data-retrieval';

// ============================================================================
// System Prompt
// ============================================================================

export const TOMORROW_PLAN_SYSTEM_PROMPT = `You are a personal planning assistant for {userName}. Your job is to create a forward-looking plan for tomorrow based on their daily review and behavioral patterns.

## Your Role
- Observe and organize, don't prescribe
- Ground all suggestions in evidence (patterns, insights)
- Respect user autonomy - present options, not mandates
- Acknowledge uncertainty where it exists

## Output Format
Respond with valid JSON containing:
{
  "focusAreas": [
    {
      "area": "Brief focus area name (5-100 chars)",
      "reasoning": "Why this matters based on patterns/review (20-500 chars)",
      "patternRef": "pattern-id-if-applicable",
      "insightRef": "insight-id-if-applicable",
      "confidence": "HIGH|MEDIUM|EMERGING"
    }
  ],
  "sessions": [
    {
      "timeSlot": "Morning (6-9am)",
      "activity": "Suggested activity",
      "reasoning": "Based on pattern X, you tend to...",
      "patternRef": "pattern-id",
      "optional": false
    }
  ],
  "warnings": [
    {
      "warning": "Pattern-based warning (e.g., 'You tend to skip gym after late nights')",
      "patternId": "pattern-id",
      "confidence": "HIGH|MEDIUM|EMERGING"
    }
  ],
  "ctas": [
    {
      "action": "Specific actionable suggestion",
      "priority": "HIGH|MEDIUM|LOW",
      "reasoning": "Why this matters",
      "patternRef": "pattern-id"
    }
  ],
  "baselineStale": true/false,
  "baselineStaleDays": 45,
  "renderedMarkdown": "# Tomorrow's Plan\\n\\n..."
}

## Rules

### MUST
- Include 1-3 focus areas (no more - prevents overwhelm)
- Reference specific pattern or insight IDs when making suggestions
- Use the user's name naturally in the markdown
- Consider day-of-week patterns (is tomorrow a Monday? Weekend?)

### MUST NOT
- Use therapeutic language ("you should feel", "try to relax")
- Give unsolicited life advice
- Invent patterns not present in the data
- Be overly prescriptive ("you must", "you have to")

### SHOULD
- Phrase as observations: "Based on your pattern of X, you might consider Y"
- Include warnings for known anti-patterns (e.g., "Late nights correlate with skipped workouts")
- Flag if baseline is stale (>30 days since update)
- Consider temporal patterns (morning person? Night owl?)

### Confidence Levels
- HIGH: Pattern seen 5+ times, consistent
- MEDIUM: Pattern seen 2-4 times
- EMERGING: Pattern seen 1-2 times, tentative

## Markdown Format
The renderedMarkdown should include:
1. Brief intro addressing user by name
2. Focus Areas section with bullet points
3. Suggested Schedule section
4. Warnings section (if any)
5. Key Actions section
6. Optional: Note about stale baseline`;

// ============================================================================
// Format User Message
// ============================================================================

export function formatTomorrowPlanMessage(context: TomorrowPlanContext): string {
  const {
    user,
    review,
    patterns,
    insights,
    dayOfWeek,
    targetDate,
  } = context;

  const message = {
    userName: user.name || 'User',
    userBaseline: user.baseline || 'No baseline set.',
    baselineStaleDays: user.baselineStaleDays,

    targetDate: targetDate,
    dayOfWeek: dayOfWeek.name,
    isWeekend: dayOfWeek.isWeekend,

    dailyReview: {
      summary: review.summary,
      structuredContent: review.structuredContent,
      renderedMarkdown: review.renderedMarkdown,
    },

    activePatterns: patterns.map(p => ({
      id: p.id,
      description: p.description,
      lastReinforcedAt: p.lastReinforcedAt.toISOString(),
    })),

    recentInsights: insights.map(i => ({
      id: i.id,
      statement: i.statement,
      explanation: i.explanation,
      confidence: i.confidence,
      category: i.category,
      temporalScope: i.temporalScope,
    })),
  };

  return JSON.stringify(message, null, 2);
}

// ============================================================================
// Get Complete System Prompt
// ============================================================================

export function getSystemPrompt(userName: string): string {
  return TOMORROW_PLAN_SYSTEM_PROMPT.replace('{userName}', userName || 'User');
}
```

---

### 4. `/src/workers/tomorrow-plan/generate-plan.ts`

**Purpose:** Main worker function

```typescript
import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText } from '../../services/embedding';
import {
  GenerateTomorrowPlanInput,
  GenerateTomorrowPlanInputSchema,
  GenerateTomorrowPlanResult,
  TomorrowPlanOutputSchema,
} from './schema';
import {
  retrieveTomorrowPlanContext,
  checkExistingPlan,
} from './data-retrieval';
import { formatTomorrowPlanMessage, getSystemPrompt } from './prompt';

// ============================================================================
// Configuration
// ============================================================================

const MODEL_CONFIG = {
  model: 'gpt-4o-mini',
  temperature: 0.4,
  maxTokens: 2000,
};

// ============================================================================
// Main Function
// ============================================================================

export async function generateTomorrowPlan(
  input: GenerateTomorrowPlanInput
): Promise<GenerateTomorrowPlanResult> {
  // Validate input
  const parsed = GenerateTomorrowPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { userId, reviewId, targetDate } = parsed.data;

  console.log(`[TomorrowPlan] Generating plan for user ${userId}, date ${targetDate}`);

  // Check for existing plan (idempotency)
  const existingPlanId = await checkExistingPlan(userId, targetDate);
  if (existingPlanId) {
    console.log(`[TomorrowPlan] Plan already exists: ${existingPlanId}`);
    return {
      success: true,
      dailyPlanId: existingPlanId,
      skipped: true,
      reason: 'Plan already exists for this date',
    };
  }

  // Retrieve context
  const context = await retrieveTomorrowPlanContext(userId, reviewId, targetDate);
  if (!context) {
    return {
      success: false,
      error: 'Failed to retrieve context (user or review not found)',
    };
  }

  // Format messages
  const systemPrompt = getSystemPrompt(context.user.name || 'User');
  const userMessage = formatTomorrowPlanMessage(context);

  // Call OpenAI
  console.log(`[TomorrowPlan] Calling OpenAI...`);
  const completion = await openai.chat.completions.create({
    model: MODEL_CONFIG.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: MODEL_CONFIG.temperature,
    max_tokens: MODEL_CONFIG.maxTokens,
    response_format: { type: 'json_object' },
  });

  const rawResponse = completion.choices[0].message.content;
  if (!rawResponse) {
    return {
      success: false,
      error: 'Empty response from OpenAI',
    };
  }

  // Parse and validate
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(rawResponse);
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse JSON response: ${e instanceof Error ? e.message : 'Unknown error'}`,
    };
  }

  const validated = TomorrowPlanOutputSchema.safeParse(parsedResponse);
  if (!validated.success) {
    console.error(`[TomorrowPlan] Validation failed:`, validated.error.errors);
    return {
      success: false,
      error: `Output validation failed: ${validated.error.message}`,
    };
  }

  const output = validated.data;

  // Generate embedding for the plan
  const embeddingResult = await embedText({
    text: `${output.focusAreas.map(f => f.area).join('. ')}. ${output.renderedMarkdown.substring(0, 500)}`,
  });

  // Store in database
  const dailyPlan = await prisma.$transaction(async (tx) => {
    const created = await tx.dailyPlan.create({
      data: {
        userId,
        reviewId,
        targetDate: new Date(targetDate),
        focusAreas: output.focusAreas,
        sessions: output.sessions,
        warnings: output.warnings,
        ctas: output.ctas,
        renderedMarkdown: output.renderedMarkdown,
      },
      select: { id: true },
    });

    // Store embedding if generated
    if (embeddingResult.success && embeddingResult.embedding) {
      const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
      await tx.$executeRawUnsafe(
        `UPDATE "DailyPlan" SET embedding = $1::vector WHERE id = $2`,
        embeddingStr,
        created.id
      );
    }

    return created;
  });

  console.log(`[TomorrowPlan] Created plan: ${dailyPlan.id}`);

  return {
    success: true,
    dailyPlanId: dailyPlan.id,
  };
}
```

---

### 5. `/src/workers/tomorrow-plan/index.ts`

**Purpose:** Public exports

```typescript
export { generateTomorrowPlan } from './generate-plan';
export {
  GenerateTomorrowPlanInput,
  GenerateTomorrowPlanResult,
  TomorrowPlanOutput,
} from './schema';
export { retrieveTomorrowPlanContext, TomorrowPlanContext } from './data-retrieval';
```

---

## Update Queue Handler

### Modify `/src/queue/handlers.ts`

Update the `handleGenerateTomorrowPlan` function:

```typescript
// At the top, add import:
import { generateTomorrowPlan } from '../workers/tomorrow-plan';

// Replace the placeholder handler:
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
```

---

## Add Prompt to `/src/prompts.ts`

Add the Tomorrow Plan prompt configuration to the prompts file:

```typescript
export const TOMORROW_PLAN_PROMPT: PromptConfig = {
  id: 'tomorrow-plan',
  name: 'Tomorrow Plan Generation',
  description: 'Generates a forward-looking plan for the next day based on daily review and patterns',
  systemPrompt: `You are a personal planning assistant...`, // Use the full prompt from prompt.ts
  inputSources: [
    'Daily review (structuredContent, renderedMarkdown, summary)',
    'User baseline (UOM)',
    'Active patterns (description, lastReinforcedAt)',
    'Recent insights (last 7 days)',
    'Day of week context',
  ],
  expectedOutput: {
    format: 'json',
    schema: 'TomorrowPlanOutputSchema',
    fields: [
      'focusAreas: Array<{ area, reasoning, patternRef?, insightRef?, confidence }>',
      'sessions: Array<{ timeSlot, activity, reasoning, patternRef?, optional }>',
      'warnings: Array<{ warning, patternId?, insightId?, confidence }>',
      'ctas: Array<{ action, priority, reasoning, patternRef? }>',
      'baselineStale: boolean',
      'renderedMarkdown: string',
    ],
  },
  modelConfig: {
    model: 'gpt-4o-mini',
    temperature: 0.4,
    maxTokens: 2000,
    responseFormat: 'json_object',
  },
  notes: [
    'Max 3 focus areas to prevent overwhelm',
    'All suggestions must reference pattern/insight IDs',
    'Frame as observations, not prescriptions',
    'Consider day-of-week patterns (Monday vs Friday vs Weekend)',
    'Flag baseline if >30 days stale',
  ],
};
```

---

## Testing Phase 3

### 1. Unit Test: Context Retrieval

```typescript
import { retrieveTomorrowPlanContext } from './workers/tomorrow-plan';

const context = await retrieveTomorrowPlanContext(
  'user-id',
  'review-id',
  '2024-01-16'
);

console.log('User:', context?.user.name);
console.log('Patterns:', context?.patterns.length);
console.log('Insights:', context?.insights.length);
console.log('Day of week:', context?.dayOfWeek.name);
```

### 2. Unit Test: Plan Generation

```typescript
import { generateTomorrowPlan } from './workers/tomorrow-plan';

const result = await generateTomorrowPlan({
  userId: 'real-user-id',
  reviewId: 'real-review-id',
  targetDate: '2024-01-16',
});

console.log('Success:', result.success);
console.log('Plan ID:', result.dailyPlanId);

// Verify in database
const plan = await prisma.dailyPlan.findUnique({
  where: { id: result.dailyPlanId },
});
console.log('Focus areas:', plan?.focusAreas);
console.log('Warnings:', plan?.warnings);
```

### 3. Integration Test: Full Chain

```typescript
import { enqueueGenerateReview, startWorker, stopWorker, registerAllHandlers } from './queue';

// Setup
registerAllHandlers();
startWorker();

// Enqueue daily review (will chain to tomorrow plan)
const jobId = await enqueueGenerateReview({
  userId: 'real-user-id',
  type: 'DAILY',
  periodKey: '2024-01-15',
  timezone: 'America/New_York',
});

// Wait for full chain
await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes

// Verify plan was created
const plan = await prisma.dailyPlan.findFirst({
  where: {
    userId: 'real-user-id',
    targetDate: new Date('2024-01-16'),
  },
});

console.log('Plan created:', !!plan);
console.log('Plan ID:', plan?.id);

stopWorker();
```

---

## Expected Output Example

```json
{
  "focusAreas": [
    {
      "area": "Morning productivity window",
      "reasoning": "Based on pattern #abc123, your most productive hours are consistently 7-10am. Today's review showed high energy in the morning.",
      "patternRef": "abc123",
      "confidence": "HIGH"
    },
    {
      "area": "Social connection",
      "reasoning": "Insight #xyz789 noted you feel better after social interactions. Tomorrow is Friday - good day for plans.",
      "insightRef": "xyz789",
      "confidence": "MEDIUM"
    }
  ],
  "sessions": [
    {
      "timeSlot": "Morning (7-9am)",
      "activity": "Deep work on high-priority tasks",
      "reasoning": "Pattern shows peak focus during this window",
      "patternRef": "abc123",
      "optional": false
    },
    {
      "timeSlot": "Lunch (12-1pm)",
      "activity": "Consider lunch with a colleague",
      "reasoning": "Social interaction correlates with afternoon energy",
      "insightRef": "xyz789",
      "optional": true
    }
  ],
  "warnings": [
    {
      "warning": "You tend to skip gym on Fridays after busy weeks. Today's review noted high workload.",
      "patternId": "gym456",
      "confidence": "MEDIUM"
    }
  ],
  "ctas": [
    {
      "action": "Block 7-9am for deep work before meetings",
      "priority": "HIGH",
      "reasoning": "Protect your peak productivity window",
      "patternRef": "abc123"
    }
  ],
  "baselineStale": true,
  "baselineStaleDays": 45,
  "renderedMarkdown": "# Tomorrow's Plan for Friday\n\nHi Alex! Based on your Thursday review...\n\n## Focus Areas\n- **Morning productivity window**: Your peak hours are 7-10am...\n\n## Suggested Schedule\n- **7-9am**: Deep work on high-priority tasks\n...\n\n## Heads Up\n⚠️ You tend to skip gym on Fridays after busy weeks...\n\n---\n*Note: Your baseline hasn't been updated in 45 days. Consider reviewing it.*"
}
```

---

---

## Next Phase

After completing Phase 3, proceed to **Phase 4: UOM Suggestion Worker** (`04-uom-suggestion-worker.md`) to implement baseline drift detection.

> **Note:** No REST APIs are needed. The client reads `DailyPlan` records directly via Prisma.
