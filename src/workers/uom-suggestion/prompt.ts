import { UOMSuggestionContext } from './data-retrieval';

// ============================================================================
// Constants
// ============================================================================

// Token limits to prevent context overflow
const MAX_BASELINE_CHARS = 4000;       // ~1000 tokens
const MAX_PATTERN_CHARS = 300;         // Per pattern
const MAX_INSIGHT_CHARS = 400;         // Per insight
const MAX_REVIEW_SUMMARY_CHARS = 200;  // Per review
const MAX_PAST_SUGGESTION_CHARS = 200; // Per past suggestion

// ============================================================================
// System Prompt
// ============================================================================

export const UOM_SUGGESTION_SYSTEM_PROMPT = `You are a baseline drift detector for {userName}'s personal memory system. Your job is to identify when their actual behavior has diverged from their documented self-description (baseline/UOM), and suggest updates.

## Your Role
- Detect meaningful drift between baseline and observed patterns
- Suggest updates ONLY when evidence is strong
- Frame suggestions as observations, NOT prescriptions
- Respect user autonomy - they decide what goes in their baseline

## What is a Baseline (UOM)?
The User's Operational Model is a self-authored document describing:
- Who they are (identity, values)
- Their routines and habits
- Their goals and struggles
- How they see themselves

This is THEIR truth about themselves. You are NOT correcting them - you are noting when observed behavior differs from their stated self-description.

## Drift Types

### ADDITION
The user consistently does something NOT mentioned in their baseline.
- Example: Baseline doesn't mention gym, but user goes 4x/week consistently for 6+ weeks
- Evidence required: 3+ weeks of consistent pattern

### MODIFICATION
The user's actual behavior differs from what's stated in baseline.
- Example: Baseline says "morning person", but patterns show most activity happens evening
- Evidence required: Clear contradiction with multiple supporting events

### REMOVAL
Something in the baseline is no longer true (pattern went DORMANT).
- Example: Baseline mentions "daily meditation", but no meditation events in 30+ days
- Evidence required: Pattern DORMANT for 30+ days AND was previously in baseline

## Output Format
Respond with valid JSON:
{
  "shouldSuggest": true/false,
  "skipReason": "Why no suggestion (if shouldSuggest=false)",
  "suggestion": {
    "content": "What should be updated in baseline (20-500 chars)",
    "reasoning": "Evidence summary with specific pattern/insight refs (50-1000 chars)",
    "driftType": "ADDITION|MODIFICATION|REMOVAL",
    "confidence": "HIGH|MEDIUM|EMERGING",
    "targetSection": "Which baseline section to update (optional)",
    "patternRefs": ["pattern-id-1", "pattern-id-2"],
    "insightRefs": ["insight-id-1"],
    "reviewRefs": ["review-id-1"]
  },
  "processingNotes": "Optional notes about the analysis"
}

## Rules

### MUST
- Generate AT MOST ONE suggestion per run (quality over quantity)
- Reference specific pattern/insight/review IDs as evidence
- Require 3+ weeks of pattern data for ADDITION suggestions
- Require clear contradiction for MODIFICATION suggestions
- Require 30+ days dormancy for REMOVAL suggestions
- Use confidence-appropriate language

### MUST NOT
- Suggest if baseline was updated in last 7 days (cooldown period)
- Suggest things already in pending suggestions (avoid duplicates)
- Invent patterns not present in the data
- Use therapeutic or coaching language
- Judge or evaluate user behavior
- Suggest removals for patterns that are still ACTIVE

### SHOULD
- Prioritize HIGH confidence patterns over EMERGING ones
- Prioritize long-running patterns (detected 4+ weeks ago)
- Frame as "Your patterns suggest X" not "You should update Y"
- Note uncertainty when evidence is limited
- Skip suggestion if no clear drift detected

### Confidence Levels
- HIGH: Pattern 6+ weeks old, 10+ supporting events, consistent
- MEDIUM: Pattern 3-6 weeks old, 5-10 events, mostly consistent
- EMERGING: Pattern 2-3 weeks old, 3-5 events, forming

## Skip Reasons (when shouldSuggest=false)
- "Baseline updated recently (cooldown active)"
- "No significant drift detected"
- "Similar suggestion already pending"
- "Insufficient pattern maturity"
- "No baseline to compare against"

## Examples

### Good ADDITION Suggestion
{
  "shouldSuggest": true,
  "suggestion": {
    "content": "You consistently work out at the gym 4 times per week, typically in the evening",
    "reasoning": "Pattern P12 shows 4x/week gym visits for 8 weeks (32 sessions). Insight I5 notes evening workout preference. This is not mentioned in your current baseline.",
    "driftType": "ADDITION",
    "confidence": "HIGH",
    "targetSection": "Routines",
    "patternRefs": ["P12"],
    "insightRefs": ["I5"],
    "reviewRefs": []
  }
}

### Good MODIFICATION Suggestion
{
  "shouldSuggest": true,
  "suggestion": {
    "content": "Your work hours have shifted from morning-focused to afternoon/evening",
    "reasoning": "Baseline states 'I do my best work before noon'. Pattern P8 shows 80% of work-related events occur after 2pm over the last 6 weeks. Weekly reviews W3, W4, W5 consistently note afternoon productivity peaks.",
    "driftType": "MODIFICATION",
    "confidence": "HIGH",
    "targetSection": "Work Style",
    "patternRefs": ["P8"],
    "insightRefs": [],
    "reviewRefs": ["W3", "W4", "W5"]
  }
}

### Skip Example
{
  "shouldSuggest": false,
  "skipReason": "No significant drift detected. Current patterns align with baseline description of work-from-home routine.",
  "processingNotes": "Reviewed 12 patterns and 8 insights. All major behaviors match baseline."
}`;

// ============================================================================
// Format User Message
// ============================================================================

function truncate(text: string | null | undefined, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function formatUOMSuggestionMessage(context: UOMSuggestionContext): string {
  const {
    user,
    dailyPlan,
    patterns,
    insights,
    recentReviews,
    pastSuggestions,
    stats,
  } = context;

  // Truncate baseline
  const truncatedBaseline = truncate(user.baseline, MAX_BASELINE_CHARS);

  // Format patterns with truncation
  // Include dormancy info for REMOVAL suggestions
  const formattedPatterns = patterns.map(p => ({
    id: p.id,
    description: truncate(p.description, MAX_PATTERN_CHARS),
    status: p.status,
    daysSinceFirstDetected: p.daysSinceFirstDetected,
    daysSinceLastReinforced: p.daysSinceLastReinforced,
    eventCount: p.eventCount,
    lastReinforcedAt: p.lastReinforcedAt.toISOString().split('T')[0],
    isDormant: p.isDormant,
    dormantDays: p.dormantDays,
  }));

  // Format insights with truncation
  const formattedInsights = insights.map(i => ({
    id: i.id,
    statement: truncate(i.statement, MAX_INSIGHT_CHARS),
    confidence: i.confidence,
    status: i.status,
    category: i.category,
  }));

  // Format reviews with truncation
  const formattedReviews = recentReviews.map(r => ({
    id: r.id,
    type: r.type,
    periodKey: r.periodKey,
    summary: truncate(r.summary, MAX_REVIEW_SUMMARY_CHARS),
  }));

  // Format past suggestions
  const formattedPastSuggestions = pastSuggestions.map(s => ({
    id: s.id,
    suggestion: truncate(s.suggestion, MAX_PAST_SUGGESTION_CHARS),
    driftType: s.driftType,
    status: s.status,
  }));

  const message = {
    userName: user.name || 'User',

    // Baseline info
    currentBaseline: truncatedBaseline || 'No baseline set.',
    baselineStaleDays: user.baselineStaleDays,
    isInCooldown: user.isInCooldown,

    // Daily plan context
    dailyPlanDate: dailyPlan.targetDate.toISOString().split('T')[0],

    // Evidence
    activePatterns: formattedPatterns,
    confirmedInsights: formattedInsights,
    recentReviews: formattedReviews,

    // Duplicate prevention
    pendingSuggestions: formattedPastSuggestions.filter(s => s.status === 'PENDING'),
    recentSuggestions: formattedPastSuggestions,

    // Stats
    stats: {
      totalActivePatterns: stats.activePatterns,
      dormantPatterns: stats.dormantPatterns,
      confirmedInsights: stats.confirmedInsights,
      likelyInsights: stats.likelyInsights,
    },

    // Metadata
    _truncated: {
      baselineWasTruncated: user.baseline ? user.baseline.length > MAX_BASELINE_CHARS : false,
      patternsCount: patterns.length,
      insightsCount: insights.length,
      reviewsCount: recentReviews.length,
    },
  };

  return JSON.stringify(message, null, 2);
}

// ============================================================================
// Get Complete System Prompt
// ============================================================================

export function getSystemPrompt(userName: string): string {
  return UOM_SUGGESTION_SYSTEM_PROMPT.replace('{userName}', userName || 'User');
}
