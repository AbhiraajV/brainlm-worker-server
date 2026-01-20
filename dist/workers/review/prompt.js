"use strict";
/**
 * Review Generation User Message Formatters
 *
 * System prompts are now centralized in src/prompts.ts
 * (DAILY_REVIEW_PROMPT, WEEKLY_REVIEW_PROMPT, MONTHLY_REVIEW_PROMPT)
 *
 * This file contains only the user message formatting logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDailyReviewMessage = formatDailyReviewMessage;
exports.formatWeeklyReviewMessage = formatWeeklyReviewMessage;
exports.formatMonthlyReviewMessage = formatMonthlyReviewMessage;
exports.formatReviewUserMessage = formatReviewUserMessage;
const schema_1 = require("./schema");
const temporal_utils_1 = require("./temporal-utils");
// ============================================================================
// User Message Formatters
// ============================================================================
function formatEvents(events) {
    if (events.length === 0) {
        return 'No events recorded for this period.';
    }
    return events.map((e) => {
        const time = e.occurredAt.toISOString();
        const interpretation = e.interpretation
            ? `\n   Interpretation: ${e.interpretation.content.substring(0, 500)}${e.interpretation.content.length > 500 ? '...' : ''}`
            : '';
        return `- [${time}] ${e.content}${interpretation}`;
    }).join('\n');
}
function formatPatterns(patterns) {
    if (patterns.length === 0) {
        return 'No patterns available.';
    }
    return patterns.map((p) => {
        return `- [${p.id}] ${p.description} (status: ${p.status}, events: ${p.eventCount}, last reinforced: ${p.lastReinforcedAt.toISOString().split('T')[0]})`;
    }).join('\n');
}
function formatInsights(insights) {
    if (insights.length === 0) {
        return 'No insights available.';
    }
    return insights.map((i) => {
        return `- [${i.id}] ${i.statement} (confidence: ${i.confidence}, status: ${i.status}, category: ${i.category || 'uncategorized'})`;
    }).join('\n');
}
function formatPriorReviews(reviews) {
    if (reviews.length === 0) {
        return 'No prior reviews available for comparison.';
    }
    return reviews.map((r) => {
        return `### ${r.type} Review: ${r.periodKey}\n${r.summary}`;
    }).join('\n\n');
}
function formatFacts(facts) {
    let factsStr = `## Period Facts (Pre-computed)
- Events in period: ${facts.eventCount}
- Interpretations: ${facts.interpretationCount}
- Patterns reinforced: ${facts.patternsReinforced}
- Patterns created: ${facts.patternsCreated}

## Overall Context
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
function formatDailyReviewMessage(data, targetDate) {
    const dateStr = (0, temporal_utils_1.formatDateForReview)(targetDate);
    return `# Daily Review Request: ${dateStr}

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

Generate a daily review for ${dateStr}. Follow the structured content schema exactly.`;
}
/**
 * Formats the user message for a weekly review.
 */
function formatWeeklyReviewMessage(data, periodStart, periodEnd) {
    const dateRange = (0, temporal_utils_1.formatDateRange)(periodStart, periodEnd);
    return `# Weekly Review Request: ${dateRange}

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

Generate a weekly review for ${dateRange}. Follow the structured content schema exactly.`;
}
/**
 * Formats the user message for a monthly review.
 */
function formatMonthlyReviewMessage(data, periodStart, periodEnd) {
    const monthYear = periodStart.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
    return `# Monthly Review Request: ${monthYear}

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

Generate a monthly review for ${monthYear}. Follow the structured content schema exactly.`;
}
/**
 * Formats the user message based on review type.
 */
function formatReviewUserMessage(reviewType, data, periodStart, periodEnd) {
    switch (reviewType) {
        case schema_1.ReviewType.DAILY:
            return formatDailyReviewMessage(data, periodStart);
        case schema_1.ReviewType.WEEKLY:
            return formatWeeklyReviewMessage(data, periodStart, periodEnd);
        case schema_1.ReviewType.MONTHLY:
            return formatMonthlyReviewMessage(data, periodStart, periodEnd);
    }
}
