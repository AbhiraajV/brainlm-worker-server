/**
 * Review Generation User Message Formatters
 *
 * System prompts are now centralized in src/prompts.ts
 * (DAILY_REVIEW_PROMPT, WEEKLY_REVIEW_PROMPT, MONTHLY_REVIEW_PROMPT)
 *
 * This file contains only the user message formatting logic.
 */

import {
    ReviewType,
    DailyReviewData,
    WeeklyReviewData,
    MonthlyReviewData,
    ReviewDeterministicFacts,
    EventWithInterpretation,
    PatternSummary,
    InsightSummary,
    PriorReview,
} from './schema';
import { formatDateForReview, formatDateRange } from './temporal-utils';

// ============================================================================
// User Message Formatters
// ============================================================================

function formatEvents(events: EventWithInterpretation[]): string {
    if (events.length === 0) {
        return 'No events recorded for this period.';
    }

    // Group events by track type
    const grouped: Record<string, EventWithInterpretation[]> = {};
    for (const e of events) {
        const type = e.trackedType || 'GENERAL';
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(e);
    }

    const sections: string[] = [];
    for (const [trackType, trackEvents] of Object.entries(grouped)) {
        const eventLines = trackEvents.map((e) => {
            const time = e.occurredAt.toISOString();
            const interpretation = e.interpretation
                ? `\n   Interpretation: ${e.interpretation.content.substring(0, 500)}${e.interpretation.content.length > 500 ? '...' : ''}`
                : '';
            return `  - [${time}] ${e.content}${interpretation}`;
        }).join('\n');
        sections.push(`### ${trackType} (${trackEvents.length} events)\n${eventLines}`);
    }

    return sections.join('\n\n');
}

function formatPatterns(patterns: PatternSummary[]): string {
    if (patterns.length === 0) {
        return 'No patterns available.';
    }

    return patterns.map((p) => {
        return `- [${p.id}] ${p.description} (status: ${p.status}, events: ${p.eventCount}, last reinforced: ${p.lastReinforcedAt.toISOString().split('T')[0]})`;
    }).join('\n');
}

function formatInsights(insights: InsightSummary[]): string {
    if (insights.length === 0) {
        return 'No insights available.';
    }

    return insights.map((i) => {
        return `- [${i.id}] ${i.statement} (confidence: ${i.confidence}, status: ${i.status}, category: ${i.category || 'uncategorized'})`;
    }).join('\n');
}

function formatPriorReviews(reviews: PriorReview[]): string {
    if (reviews.length === 0) {
        return 'No prior reviews available for comparison.';
    }

    return reviews.map((r) => {
        return `### ${r.type} Review: ${r.periodKey}\n${r.summary}`;
    }).join('\n\n');
}

function formatFacts(facts: ReviewDeterministicFacts): string {
    let factsStr = `## Period Facts (Pre-computed)
- Events in period: ${facts.eventCount}
- Interpretations: ${facts.interpretationCount}
- Patterns reinforced: ${facts.patternsReinforced}
- Patterns created: ${facts.patternsCreated}`;

    if (facts.eventsPerTrackType && Object.keys(facts.eventsPerTrackType).length > 0) {
        factsStr += '\n\n## Events Per Track Type';
        for (const [trackType, count] of Object.entries(facts.eventsPerTrackType)) {
            factsStr += `\n- ${trackType}: ${count} events`;
        }
    }

    factsStr += `\n\n## Overall Context
- Total events (all time): ${facts.totalEvents}
- Active patterns: ${facts.totalPatterns}
- Active insights: ${facts.totalInsights}
- Days since first event: ${facts.daysSinceFirstEvent}`;

    if (facts.eventsPerDay) {
        factsStr += '\n\n## Events Per Day';
        for (const [day, count] of Object.entries(facts.eventsPerDay)) {
            factsStr += `\n- ${day}: ${count} events`;
        }
    }

    if (facts.mostActiveDay) {
        factsStr += `\n\nMost active day: ${facts.mostActiveDay}`;
    }
    if (facts.leastActiveDay) {
        factsStr += `\nLeast active day: ${facts.leastActiveDay}`;
    }

    return factsStr;
}

// ============================================================================
// Main Formatter Functions
// ============================================================================

/**
 * Formats the user message for a daily review.
 */
export function formatDailyReviewMessage(
    data: DailyReviewData,
    targetDate: Date,
    userName: string,
    userBaseline: string
): string {
    const dateStr = formatDateForReview(targetDate);

    return `# Daily Review Request: ${dateStr}

## User Context
**Name:** ${userName}

**Baseline:**
${userBaseline}

## Events Today
${formatEvents(data.events)}

## Active & Relevant Patterns
${formatPatterns(data.patterns)}

## Recent Insights
${formatInsights(data.insights)}

## Prior Daily Reviews (This Week)
${formatPriorReviews(data.priorDailyReviews)}

${formatFacts(data.facts)}

---

Generate a daily review for ${userName}'s ${dateStr}. Follow the structured content schema exactly. Refer to ${userName} by name throughout the review.`;
}

/**
 * Formats the user message for a weekly review.
 */
export function formatWeeklyReviewMessage(
    data: WeeklyReviewData,
    periodStart: Date,
    periodEnd: Date,
    userName: string,
    userBaseline: string
): string {
    const dateRange = formatDateRange(periodStart, periodEnd);

    return `# Weekly Review Request: ${dateRange}

## User Context
**Name:** ${userName}

**Baseline:**
${userBaseline}

## Events This Week
${formatEvents(data.events)}

## Active & Relevant Patterns
${formatPatterns(data.patterns)}

## Insights from This Week
${formatInsights(data.insights)}

## Daily Reviews This Week
${formatPriorReviews(data.dailyReviews)}

## Previous Week's Review
${data.previousWeeklyReview ? formatPriorReviews([data.previousWeeklyReview]) : 'No previous weekly review available.'}

${formatFacts(data.facts)}

---

Generate a weekly review for ${userName}'s week (${dateRange}). Follow the structured content schema exactly. Refer to ${userName} by name throughout the review.`;
}

/**
 * Formats the user message for a monthly review.
 */
export function formatMonthlyReviewMessage(
    data: MonthlyReviewData,
    periodStart: Date,
    periodEnd: Date,
    userName: string,
    userBaseline: string
): string {
    const monthYear = periodStart.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });

    return `# Monthly Review Request: ${monthYear}

## User Context
**Name:** ${userName}

**Baseline:**
${userBaseline}

## Events This Month
${formatEvents(data.events)}

## Active & Relevant Patterns
${formatPatterns(data.patterns)}

## Insights from This Month
${formatInsights(data.insights)}

## Weekly Reviews This Month
${formatPriorReviews(data.weeklyReviews)}

## Previous Month's Review
${data.previousMonthlyReview ? formatPriorReviews([data.previousMonthlyReview]) : 'No previous monthly review available.'}

## Earlier Months This Year
${formatPriorReviews(data.earlierMonthlyReviews)}

${formatFacts(data.facts)}

---

Generate a monthly review for ${userName}'s ${monthYear}. Follow the structured content schema exactly. Refer to ${userName} by name throughout the review.`;
}

/**
 * Formats the user message based on review type.
 */
export function formatReviewUserMessage(
    reviewType: ReviewType,
    data: DailyReviewData | WeeklyReviewData | MonthlyReviewData,
    periodStart: Date,
    periodEnd: Date,
    userName: string,
    userBaseline: string
): string {
    switch (reviewType) {
        case ReviewType.DAILY:
            return formatDailyReviewMessage(data as DailyReviewData, periodStart, userName, userBaseline);

        case ReviewType.WEEKLY:
            return formatWeeklyReviewMessage(data as WeeklyReviewData, periodStart, periodEnd, userName, userBaseline);

        case ReviewType.MONTHLY:
            return formatMonthlyReviewMessage(data as MonthlyReviewData, periodStart, periodEnd, userName, userBaseline);
    }
}
