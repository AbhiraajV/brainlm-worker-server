# Phase 4: UOM Update Suggestion Worker

## Overview

The UOM (User's Operational Model) Update Suggestion Worker detects behavioral drift between the user's stated baseline and their observed patterns. It generates suggestions for updating the baseline to keep it accurate and relevant.

---

## Prerequisites

- **Phase 1 completed:** Queue infrastructure working
- **Phase 2 completed:** Daily flow integration working
- **Phase 3 completed:** Tomorrow Planner Worker implemented
- **Prisma schema already includes:** `UOMUpdateSuggestion` model (added in Phase 1)

---

## Business Logic Doctrine

### Purpose

Keep User's Operational Model (baseline) accurate by detecting behavioral drift and suggesting updates.

### Input Sources

| Source | Description | Required |
|--------|-------------|----------|
| Current Baseline | User's self-description document | Yes |
| Active Patterns | Patterns with LIKELY/CONFIRMED confidence | Yes |
| Recent Insights | Insights from last 30 days | Yes |
| Recent Reviews | Daily/Weekly reviews from last 30 days | Yes |
| Past Suggestions | Previous UOM suggestions (avoid duplicates) | Yes |
| Daily Plan | The plan that triggered this worker | Yes |

### Output Constraints

| Constraint | Rationale |
|------------|-----------|
| At most ONE suggestion per run | Prevents suggestion fatigue |
| Require LIKELY+ confidence pattern | Ensures evidence-based suggestions |
| 7-day cooldown after baseline update | Prevents over-suggestion |
| No removals unless DORMANT >30 days | Preserves useful baseline info |

### Rules

| Rule | Type |
|------|------|
| MUST have strong evidence | Mandatory |
| MUST reference specific pattern/insight IDs | Mandatory |
| Frame as observation, not prescription | Mandatory |
| Prioritize high-confidence, long-running patterns | Recommended |
| NEVER suggest if cooldown active | Mandatory |

### Model Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Model | `gpt-4o` | Higher quality for baseline changes |
| Temperature | 0.2 | Consistent, low creativity |
| Max Tokens | 1000 | Focused, concise suggestions |
| Response Format | `json_object` | Structured output |

---

## Files to Create

### Directory Structure

```
/src/workers/uom-suggestion/
├── index.ts              # Public exports
├── schema.ts             # Zod schemas
├── data-retrieval.ts     # Context gathering
└── detect-drift.ts       # Main worker function
```

---

### 1. `/src/workers/uom-suggestion/schema.ts`

**Purpose:** Zod validation schemas for input and output

```typescript
import { z } from 'zod';

// ============================================================================
// Input Schema
// ============================================================================

export const SuggestUOMUpdateInputSchema = z.object({
  userId: z.string().min(1),
  dailyPlanId: z.string().min(1),
});

export type SuggestUOMUpdateInput = z.infer<typeof SuggestUOMUpdateInputSchema>;

// ============================================================================
// Output Schema (LLM Response)
// ============================================================================

export const DriftTypeSchema = z.enum(['ADDITION', 'MODIFICATION', 'REMOVAL']);

export const UOMSuggestionOutputSchema = z.object({
  shouldSuggest: z.boolean(),
  noSuggestionReason: z.string().optional(),

  // Only present if shouldSuggest is true
  suggestion: z.string().min(10).max(1000).optional(),
  reasoning: z.string().min(50).max(2000).optional(),
  driftType: DriftTypeSchema.optional(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'EMERGING']).optional(),
  targetSection: z.string().optional(),

  // Evidence references
  patternRefs: z.array(z.string()).optional(),
  insightRefs: z.array(z.string()).optional(),
  reviewRefs: z.array(z.string()).optional(),
});

export type UOMSuggestionOutput = z.infer<typeof UOMSuggestionOutputSchema>;

// ============================================================================
// Result Schema
// ============================================================================

export const SuggestUOMUpdateResultSchema = z.object({
  success: z.boolean(),
  suggestionId: z.string().optional(),
  suggestionGenerated: z.boolean(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

export type SuggestUOMUpdateResult = z.infer<typeof SuggestUOMUpdateResultSchema>;
```

---

### 2. `/src/workers/uom-suggestion/data-retrieval.ts`

**Purpose:** Gather all context needed for drift detection

```typescript
import prisma from '../../prisma';
import { subDays, differenceInDays } from 'date-fns';
import { ConfidenceLevel, UOMSuggestionStatus, PatternStatus } from '@prisma/client';

// ============================================================================
// Types
// ============================================================================

export interface UOMSuggestionContext {
  user: {
    id: string;
    name: string | null;
    baseline: string | null;
    lastBaselineUpdate: Date | null;
    daysSinceUpdate: number | null;
  };
  dailyPlan: {
    id: string;
    targetDate: Date;
    focusAreas: unknown;
    warnings: unknown;
  };
  patterns: Array<{
    id: string;
    description: string;
    status: string;
    confidence: string;
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
    daysSinceFirst: number;
    reinforcementCount: number;
  }>;
  insights: Array<{
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    category: string | null;
  }>;
  recentReviews: Array<{
    id: string;
    type: string;
    periodKey: string;
    summary: string;
  }>;
  pastSuggestions: Array<{
    id: string;
    suggestion: string;
    driftType: string;
    status: string;
    createdAt: Date;
  }>;
  cooldownActive: boolean;
  cooldownDaysRemaining: number | null;
}

// ============================================================================
// Configuration
// ============================================================================

const COOLDOWN_DAYS = 7;
const INSIGHT_LOOKBACK_DAYS = 30;
const REVIEW_LOOKBACK_DAYS = 30;
const SUGGESTION_LOOKBACK_DAYS = 60;
const DORMANT_THRESHOLD_DAYS = 30;

// ============================================================================
// Main Retrieval Function
// ============================================================================

export async function retrieveUOMSuggestionContext(
  userId: string,
  dailyPlanId: string
): Promise<UOMSuggestionContext | null> {
  const now = new Date();
  const insightCutoff = subDays(now, INSIGHT_LOOKBACK_DAYS);
  const reviewCutoff = subDays(now, REVIEW_LOOKBACK_DAYS);
  const suggestionCutoff = subDays(now, SUGGESTION_LOOKBACK_DAYS);

  // Parallel fetch
  const [user, dailyPlan, patterns, insights, recentReviews, pastSuggestions] = await Promise.all([
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

    // Daily plan that triggered this
    prisma.dailyPlan.findUnique({
      where: { id: dailyPlanId },
      select: {
        id: true,
        targetDate: true,
        focusAreas: true,
        warnings: true,
      },
    }),

    // Active patterns with high confidence
    // Also include dormant patterns for potential removal suggestions
    prisma.pattern.findMany({
      where: {
        userId,
        status: { in: [PatternStatus.ACTIVE, PatternStatus.DORMANT] },
      },
      select: {
        id: true,
        description: true,
        status: true,
        firstDetectedAt: true,
        lastReinforcedAt: true,
        _count: {
          select: { patternEvents: true },
        },
      },
      orderBy: { lastReinforcedAt: 'desc' },
      take: 30,
    }),

    // Recent insights
    prisma.insight.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'LIKELY'] },
        createdAt: { gte: insightCutoff },
      },
      select: {
        id: true,
        statement: true,
        explanation: true,
        confidence: true,
        category: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),

    // Recent reviews
    prisma.review.findMany({
      where: {
        userId,
        createdAt: { gte: reviewCutoff },
      },
      select: {
        id: true,
        type: true,
        periodKey: true,
        summary: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),

    // Past suggestions (to avoid duplicates)
    prisma.uOMUpdateSuggestion.findMany({
      where: {
        userId,
        createdAt: { gte: suggestionCutoff },
      },
      select: {
        id: true,
        suggestion: true,
        driftType: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  if (!user || !dailyPlan) {
    return null;
  }

  // Calculate cooldown
  let cooldownActive = false;
  let cooldownDaysRemaining: number | null = null;
  let daysSinceUpdate: number | null = null;

  if (user.lastBaselineUpdate) {
    daysSinceUpdate = differenceInDays(now, user.lastBaselineUpdate);
    if (daysSinceUpdate < COOLDOWN_DAYS) {
      cooldownActive = true;
      cooldownDaysRemaining = COOLDOWN_DAYS - daysSinceUpdate;
    }
  }

  // Enrich patterns with computed fields
  const enrichedPatterns = patterns.map(p => {
    const daysSinceFirst = differenceInDays(now, p.firstDetectedAt);
    const daysSinceLast = differenceInDays(now, p.lastReinforcedAt);

    // Infer confidence based on reinforcement count and age
    let confidence: string;
    if (p._count.patternEvents >= 5 && daysSinceFirst >= 14) {
      confidence = 'CONFIRMED';
    } else if (p._count.patternEvents >= 3) {
      confidence = 'LIKELY';
    } else {
      confidence = 'EMERGING';
    }

    return {
      id: p.id,
      description: p.description,
      status: p.status,
      confidence,
      firstDetectedAt: p.firstDetectedAt,
      lastReinforcedAt: p.lastReinforcedAt,
      daysSinceFirst,
      reinforcementCount: p._count.patternEvents,
      isDormant: p.status === PatternStatus.DORMANT,
      dormantDays: p.status === PatternStatus.DORMANT ? daysSinceLast : null,
    };
  });

  return {
    user: {
      id: user.id,
      name: user.name,
      baseline: user.baseline,
      lastBaselineUpdate: user.lastBaselineUpdate,
      daysSinceUpdate,
    },
    dailyPlan: {
      id: dailyPlan.id,
      targetDate: dailyPlan.targetDate,
      focusAreas: dailyPlan.focusAreas,
      warnings: dailyPlan.warnings,
    },
    patterns: enrichedPatterns,
    insights,
    recentReviews,
    pastSuggestions,
    cooldownActive,
    cooldownDaysRemaining,
  };
}

// ============================================================================
// Check for Similar Pending Suggestion
// ============================================================================

export async function hasSimilarPendingSuggestion(
  userId: string,
  suggestion: string
): Promise<boolean> {
  // Simple check - look for pending suggestions with similar text
  const pending = await prisma.uOMUpdateSuggestion.findMany({
    where: {
      userId,
      status: UOMSuggestionStatus.PENDING,
    },
    select: { suggestion: true },
  });

  // Basic similarity check (could be enhanced with embeddings)
  const normalizedNew = suggestion.toLowerCase().trim();
  for (const p of pending) {
    const normalizedExisting = p.suggestion.toLowerCase().trim();
    // Check for high overlap (simple heuristic)
    if (
      normalizedNew.includes(normalizedExisting.substring(0, 50)) ||
      normalizedExisting.includes(normalizedNew.substring(0, 50))
    ) {
      return true;
    }
  }

  return false;
}
```

---

### 3. `/src/workers/uom-suggestion/detect-drift.ts`

**Purpose:** Main worker function

```typescript
import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { UOMDriftType, ConfidenceLevel, UOMSuggestionStatus } from '@prisma/client';
import {
  SuggestUOMUpdateInput,
  SuggestUOMUpdateInputSchema,
  SuggestUOMUpdateResult,
  UOMSuggestionOutputSchema,
} from './schema';
import {
  retrieveUOMSuggestionContext,
  hasSimilarPendingSuggestion,
} from './data-retrieval';

// ============================================================================
// Configuration
// ============================================================================

const MODEL_CONFIG = {
  model: 'gpt-4o',
  temperature: 0.2,
  maxTokens: 1000,
};

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are analyzing a user's behavioral patterns to detect drift from their stated baseline (self-description).

## Your Role
- Compare observed patterns/insights with the user's stated baseline
- Identify significant, evidence-based discrepancies
- Suggest updates ONLY when there's strong evidence

## Output Format
Respond with valid JSON:
{
  "shouldSuggest": true/false,
  "noSuggestionReason": "Why no suggestion is needed (if shouldSuggest=false)",

  // Only include these if shouldSuggest=true:
  "suggestion": "The specific update to the baseline",
  "reasoning": "Detailed explanation of the evidence supporting this suggestion",
  "driftType": "ADDITION|MODIFICATION|REMOVAL",
  "confidence": "HIGH|MEDIUM|EMERGING",
  "targetSection": "Which section of the baseline this affects",
  "patternRefs": ["pattern-id-1", "pattern-id-2"],
  "insightRefs": ["insight-id-1"],
  "reviewRefs": ["review-id-1"]
}

## Drift Types
- ADDITION: New behavior/routine not in baseline (e.g., "Started meditating daily")
- MODIFICATION: Existing behavior changed (e.g., "Now wakes at 6am instead of 7am")
- REMOVAL: Baseline states something no longer true (e.g., "No longer running weekly")

## Rules

### MUST
- Have at least one LIKELY or CONFIRMED confidence pattern as evidence
- Reference specific pattern/insight IDs
- Be specific about what to add/change/remove
- Frame as observation: "Based on patterns X and Y, consider adding..."

### MUST NOT
- Suggest if evidence is weak (EMERGING only)
- Suggest removals unless pattern DORMANT >30 days
- Duplicate recently rejected/ignored suggestions
- Be prescriptive ("you should", "you need to")

### SHOULD
- Prioritize high-confidence, long-running patterns
- Consider multiple supporting insights
- Note if this aligns with recent reviews

### Return shouldSuggest=false if:
- No significant drift detected
- All patterns already reflected in baseline
- Evidence is too weak (only EMERGING patterns)
- Similar pending suggestion exists
- Baseline was recently updated (cooldown note provided)`;

// ============================================================================
// Format User Message
// ============================================================================

function formatUserMessage(context: any): string {
  return JSON.stringify({
    userName: context.user.name || 'User',
    currentBaseline: context.user.baseline || 'No baseline set.',
    daysSinceBaselineUpdate: context.user.daysSinceUpdate,
    cooldownActive: context.cooldownActive,

    patterns: context.patterns.map((p: any) => ({
      id: p.id,
      description: p.description,
      status: p.status,
      confidence: p.confidence,
      daysSinceFirst: p.daysSinceFirst,
      reinforcementCount: p.reinforcementCount,
      isDormant: p.isDormant,
      dormantDays: p.dormantDays,
    })),

    insights: context.insights.map((i: any) => ({
      id: i.id,
      statement: i.statement,
      explanation: i.explanation,
      confidence: i.confidence,
      category: i.category,
    })),

    recentReviews: context.recentReviews.map((r: any) => ({
      id: r.id,
      type: r.type,
      periodKey: r.periodKey,
      summary: r.summary,
    })),

    pastSuggestions: context.pastSuggestions.map((s: any) => ({
      suggestion: s.suggestion,
      driftType: s.driftType,
      status: s.status,
      daysAgo: Math.floor((Date.now() - new Date(s.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
    })),

    dailyPlan: {
      focusAreas: context.dailyPlan.focusAreas,
      warnings: context.dailyPlan.warnings,
    },
  }, null, 2);
}

// ============================================================================
// Main Function
// ============================================================================

export async function suggestUOMUpdate(
  input: SuggestUOMUpdateInput
): Promise<SuggestUOMUpdateResult> {
  // Validate input
  const parsed = SuggestUOMUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      suggestionGenerated: false,
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { userId, dailyPlanId } = parsed.data;

  console.log(`[UOMSuggestion] Processing for user ${userId}, plan ${dailyPlanId}`);

  // Retrieve context
  const context = await retrieveUOMSuggestionContext(userId, dailyPlanId);
  if (!context) {
    return {
      success: false,
      suggestionGenerated: false,
      error: 'Failed to retrieve context (user or plan not found)',
    };
  }

  // Check cooldown
  if (context.cooldownActive) {
    console.log(`[UOMSuggestion] Cooldown active, ${context.cooldownDaysRemaining} days remaining`);
    return {
      success: true,
      suggestionGenerated: false,
      skipped: true,
      reason: `Baseline updated recently, cooldown active (${context.cooldownDaysRemaining} days remaining)`,
    };
  }

  // Check for high-confidence patterns
  const hasHighConfidence = context.patterns.some(
    p => p.confidence === 'CONFIRMED' || p.confidence === 'LIKELY'
  );

  if (!hasHighConfidence) {
    console.log(`[UOMSuggestion] No high-confidence patterns, skipping`);
    return {
      success: true,
      suggestionGenerated: false,
      skipped: true,
      reason: 'No high-confidence patterns to suggest from',
    };
  }

  // Call OpenAI
  console.log(`[UOMSuggestion] Calling OpenAI...`);
  const completion = await openai.chat.completions.create({
    model: MODEL_CONFIG.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: formatUserMessage(context) },
    ],
    temperature: MODEL_CONFIG.temperature,
    max_tokens: MODEL_CONFIG.maxTokens,
    response_format: { type: 'json_object' },
  });

  const rawResponse = completion.choices[0].message.content;
  if (!rawResponse) {
    return {
      success: false,
      suggestionGenerated: false,
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
      suggestionGenerated: false,
      error: `Failed to parse JSON response: ${e instanceof Error ? e.message : 'Unknown error'}`,
    };
  }

  const validated = UOMSuggestionOutputSchema.safeParse(parsedResponse);
  if (!validated.success) {
    console.error(`[UOMSuggestion] Validation failed:`, validated.error.errors);
    return {
      success: false,
      suggestionGenerated: false,
      error: `Output validation failed: ${validated.error.message}`,
    };
  }

  const output = validated.data;

  // Check if suggestion should be made
  if (!output.shouldSuggest) {
    console.log(`[UOMSuggestion] No suggestion needed: ${output.noSuggestionReason}`);
    return {
      success: true,
      suggestionGenerated: false,
      reason: output.noSuggestionReason || 'No significant drift detected',
    };
  }

  // Check for similar pending suggestion
  if (output.suggestion) {
    const hasSimilar = await hasSimilarPendingSuggestion(userId, output.suggestion);
    if (hasSimilar) {
      console.log(`[UOMSuggestion] Similar suggestion already pending`);
      return {
        success: true,
        suggestionGenerated: false,
        reason: 'Similar suggestion already pending',
      };
    }
  }

  // Map confidence to ConfidenceLevel enum
  const confidenceMap: Record<string, ConfidenceLevel> = {
    HIGH: ConfidenceLevel.HIGH,
    MEDIUM: ConfidenceLevel.MEDIUM,
    EMERGING: ConfidenceLevel.EMERGING,
  };

  // Map driftType to UOMDriftType enum
  const driftTypeMap: Record<string, UOMDriftType> = {
    ADDITION: UOMDriftType.ADDITION,
    MODIFICATION: UOMDriftType.MODIFICATION,
    REMOVAL: UOMDriftType.REMOVAL,
  };

  // Store suggestion
  const suggestion = await prisma.uOMUpdateSuggestion.create({
    data: {
      userId,
      suggestion: output.suggestion!,
      reasoning: output.reasoning!,
      driftType: driftTypeMap[output.driftType!],
      confidence: confidenceMap[output.confidence!],
      targetSection: output.targetSection,
      patternRefs: output.patternRefs || [],
      insightRefs: output.insightRefs || [],
      reviewRefs: output.reviewRefs || [],
      status: UOMSuggestionStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    },
    select: { id: true },
  });

  console.log(`[UOMSuggestion] Created suggestion: ${suggestion.id}`);

  return {
    success: true,
    suggestionId: suggestion.id,
    suggestionGenerated: true,
  };
}
```

---

### 4. `/src/workers/uom-suggestion/index.ts`

**Purpose:** Public exports

```typescript
export { suggestUOMUpdate } from './detect-drift';
export {
  SuggestUOMUpdateInput,
  SuggestUOMUpdateResult,
  UOMSuggestionOutput,
} from './schema';
export { retrieveUOMSuggestionContext, UOMSuggestionContext } from './data-retrieval';
```

---

## Update Queue Handler

### Modify `/src/queue/handlers.ts`

Update the `handleSuggestUOMUpdate` function:

```typescript
// At the top, add import:
import { suggestUOMUpdate } from '../workers/uom-suggestion';

// Replace the placeholder handler:
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

    // Even if no suggestion generated, it's a success
    return {
      success: true,
      data: {
        suggestionId: result.suggestionId,
        suggestionGenerated: result.suggestionGenerated,
        skipped: result.skipped,
        reason: result.reason,
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
```

---

## Add Prompt to `/src/prompts.ts`

Add the UOM Suggestion prompt configuration:

```typescript
export const UOM_SUGGESTION_PROMPT: PromptConfig = {
  id: 'uom-suggestion',
  name: 'UOM Update Suggestion',
  description: 'Detects behavioral drift and suggests updates to user baseline',
  systemPrompt: `You are analyzing...`, // Use the full SYSTEM_PROMPT
  inputSources: [
    'Current baseline (user.baseline)',
    'Active patterns (LIKELY/CONFIRMED confidence)',
    'Recent insights (last 30 days)',
    'Recent reviews (last 30 days)',
    'Past suggestions (to avoid duplicates)',
    'Daily plan (context)',
  ],
  expectedOutput: {
    format: 'json',
    schema: 'UOMSuggestionOutputSchema',
    fields: [
      'shouldSuggest: boolean',
      'noSuggestionReason?: string',
      'suggestion?: string',
      'reasoning?: string',
      'driftType?: ADDITION | MODIFICATION | REMOVAL',
      'confidence?: HIGH | MEDIUM | EMERGING',
      'targetSection?: string',
      'patternRefs?: string[]',
      'insightRefs?: string[]',
      'reviewRefs?: string[]',
    ],
  },
  modelConfig: {
    model: 'gpt-4o',
    temperature: 0.2,
    maxTokens: 1000,
    responseFormat: 'json_object',
  },
  notes: [
    'At most ONE suggestion per run',
    'Require LIKELY+ confidence pattern',
    '7-day cooldown after baseline update',
    'No removals unless DORMANT >30 days',
    'Check for similar pending suggestions',
  ],
};
```

---

## Testing Phase 4

### 1. Unit Test: Context Retrieval

```typescript
import { retrieveUOMSuggestionContext } from './workers/uom-suggestion';

const context = await retrieveUOMSuggestionContext('user-id', 'daily-plan-id');

console.log('User baseline length:', context?.user.baseline?.length);
console.log('Patterns:', context?.patterns.length);
console.log('Insights:', context?.insights.length);
console.log('Past suggestions:', context?.pastSuggestions.length);
console.log('Cooldown active:', context?.cooldownActive);
```

### 2. Unit Test: Drift Detection

```typescript
import { suggestUOMUpdate } from './workers/uom-suggestion';

const result = await suggestUOMUpdate({
  userId: 'real-user-id',
  dailyPlanId: 'real-daily-plan-id',
});

console.log('Success:', result.success);
console.log('Suggestion generated:', result.suggestionGenerated);
console.log('Suggestion ID:', result.suggestionId);
console.log('Reason:', result.reason);

// If suggestion was generated, verify in database
if (result.suggestionId) {
  const suggestion = await prisma.uOMUpdateSuggestion.findUnique({
    where: { id: result.suggestionId },
  });
  console.log('Suggestion:', suggestion?.suggestion);
  console.log('Drift type:', suggestion?.driftType);
  console.log('Confidence:', suggestion?.confidence);
}
```

### 3. Integration Test: Full Chain

```typescript
import { enqueueGenerateReview, startWorker, stopWorker, registerAllHandlers } from './queue';

// Setup
registerAllHandlers();
startWorker();

// Trigger full chain from daily review
const jobId = await enqueueGenerateReview({
  userId: 'user-with-patterns',
  type: 'DAILY',
  periodKey: '2024-01-15',
  timezone: 'America/New_York',
});

// Wait for full chain (review → tomorrow plan → uom suggestion)
await new Promise(resolve => setTimeout(resolve, 180000)); // 3 minutes

// Verify UOM suggestion was created (if conditions met)
const suggestions = await prisma.uOMUpdateSuggestion.findMany({
  where: { userId: 'user-with-patterns' },
  orderBy: { createdAt: 'desc' },
  take: 1,
});

console.log('Suggestion created:', suggestions.length > 0);
if (suggestions.length > 0) {
  console.log('Suggestion:', suggestions[0].suggestion);
}

stopWorker();
```

---

## Expected Output Examples

### Example 1: Addition Suggested

```json
{
  "shouldSuggest": true,
  "suggestion": "Add morning meditation routine (10-15 minutes daily)",
  "reasoning": "Pattern #abc123 shows consistent meditation practice over the past 3 weeks (18 of 21 days). This routine is not currently reflected in your baseline but appears to be an established habit based on 23 supporting events. Insight #xyz789 notes improved focus on days with morning meditation.",
  "driftType": "ADDITION",
  "confidence": "HIGH",
  "targetSection": "Morning Routine",
  "patternRefs": ["abc123"],
  "insightRefs": ["xyz789"],
  "reviewRefs": ["review456"]
}
```

### Example 2: Modification Suggested

```json
{
  "shouldSuggest": true,
  "suggestion": "Update work hours from '9-5' to '8-4' reflecting earlier schedule",
  "reasoning": "Your baseline states work hours as 9am-5pm, but pattern #work123 shows consistent 8am starts over the past month. 15 events confirm this shift, and recent daily reviews mention 'early morning productivity' frequently.",
  "driftType": "MODIFICATION",
  "confidence": "MEDIUM",
  "targetSection": "Work Schedule",
  "patternRefs": ["work123"],
  "insightRefs": [],
  "reviewRefs": ["rev1", "rev2"]
}
```

### Example 3: No Suggestion

```json
{
  "shouldSuggest": false,
  "noSuggestionReason": "Current baseline accurately reflects observed patterns. No significant drift detected. All major behaviors (exercise routine, work hours, sleep schedule) align with stated baseline."
}
```

---

---

## Next Phase

After completing Phase 4, proceed to **Phase 5: Verification Checklist** (`05-verification-checklist.md`) to validate the complete implementation.

> **Note:** No REST APIs are needed. The client manages `UOMUpdateSuggestion` records directly via Prisma using the helper functions defined in `02-daily-flow-integration.md`.
