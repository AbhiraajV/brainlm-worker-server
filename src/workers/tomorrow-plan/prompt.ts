import { TomorrowPlanContext } from './data-retrieval';

// ============================================================================
// Constants
// ============================================================================

// Token limits to prevent context overflow (gpt-4o-mini has ~128k context)
// But we want to be efficient and keep costs low
const MAX_BASELINE_CHARS = 3000;       // ~750 tokens
const MAX_REVIEW_MARKDOWN_CHARS = 4000; // ~1000 tokens
const MAX_PATTERNS = 15;               // Most relevant patterns
const MAX_INSIGHTS = 10;               // Most recent insights

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
      "sessionType": "gym|diet|work|reflection|social|custom",
      "intent": "What this session is for (10-200 chars)",
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
      "ctaType": "TRACK|NOTICE|REFLECT",
      "priority": "HIGH|MEDIUM|LOW",
      "reasoning": "Why this matters",
      "patternRef": "pattern-id"
    }
  ],
  "baselineStale": true/false,
  "baselineStaleDays": 45,
  "baselineStaleReason": "Why staleness matters (50-200 chars, optional)",
  "renderedMarkdown": "# Tomorrow's Plan\\n\\n..."
}

### CTA Types
- TRACK: Log this event if it happens (opens event composer)
- NOTICE: Watch for this pattern/behavior
- REFLECT: Think about this at end of day

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
- Introduce goals or sessions not grounded in the review, patterns, or baseline

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
3. Suggested Schedule section (USE TABLE FORMAT)
4. Warnings section (if any)
5. Key Actions section
6. Optional: Note about stale baseline (include reason if stale)

### Markdown Rendering Rules
- Use tables for schedules and time-based plans (2-4 columns max)
- Use bullet points for focus areas and warnings
- Keep tables simple and scannable

Example schedule table:
| Time | Session | Intent |
|------|---------|--------|
| Morning (6-9am) | Gym | Consistency-focused workout |
| Evening (7-9pm) | Review | Short reflection on energy |`;

// ============================================================================
// Format User Message
// ============================================================================

/**
 * Truncates a string to a maximum length, adding ellipsis if truncated
 */
function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function formatTomorrowPlanMessage(context: TomorrowPlanContext): string {
  const {
    user,
    review,
    patterns,
    insights,
    dayOfWeek,
    targetDate,
  } = context;

  // Truncate large fields to prevent token overflow
  const truncatedBaseline = truncate(user.baseline, MAX_BASELINE_CHARS);
  const truncatedReviewMarkdown = truncate(review.renderedMarkdown, MAX_REVIEW_MARKDOWN_CHARS);

  // Limit arrays to most relevant items (already sorted by recency in data-retrieval)
  const limitedPatterns = patterns.slice(0, MAX_PATTERNS);
  const limitedInsights = insights.slice(0, MAX_INSIGHTS);

  const message = {
    userName: user.name || 'User',
    userBaseline: truncatedBaseline || 'No baseline set.',
    baselineStaleDays: user.baselineStaleDays,

    targetDate: targetDate,
    dayOfWeek: dayOfWeek.name,
    isWeekend: dayOfWeek.isWeekend,

    dailyReview: {
      summary: review.summary,
      structuredContent: review.structuredContent,
      renderedMarkdown: truncatedReviewMarkdown,
    },

    activePatterns: limitedPatterns.map(p => ({
      id: p.id,
      description: p.description,
      lastReinforcedAt: p.lastReinforcedAt.toISOString(),
    })),

    recentInsights: limitedInsights.map(i => ({
      id: i.id,
      statement: i.statement,
      explanation: i.explanation,
      confidence: i.confidence,
      category: i.category,
      temporalScope: i.temporalScope,
    })),

    // Metadata for transparency
    _truncated: {
      baselineWasTruncated: user.baseline ? user.baseline.length > MAX_BASELINE_CHARS : false,
      reviewWasTruncated: review.renderedMarkdown.length > MAX_REVIEW_MARKDOWN_CHARS,
      totalPatterns: patterns.length,
      includedPatterns: limitedPatterns.length,
      totalInsights: insights.length,
      includedInsights: limitedInsights.length,
    },
  };

  return JSON.stringify(message, null, 2);
}

// ============================================================================
// Get Complete System Prompt
// ============================================================================

export function getSystemPrompt(userName: string): string {
  return TOMORROW_PLAN_SYSTEM_PROMPT.replace('{userName}', userName || 'User');
}
