/**
 * Insight Generation User Message Formatter
 *
 * System prompt is now centralized in src/prompts.ts (INSIGHT_GENERATION_PROMPT)
 * This file contains only the user message formatting logic.
 */

/**
 * Formats the user message with all retrieved context
 */
export function formatInsightUserMessage(context: {
    userName: string;
    userBaseline: string;
    trigger: {
        type: string;
        eventId?: string;
        patternId?: string;
        interpretationId?: string;
    };
    patterns: Array<{
        id: string;
        description: string;
        status: string;
        eventCount: number;
        firstDetectedAt: Date;
        lastReinforcedAt: Date;
    }>;
    interpretations: Array<{
        id: string;
        eventId: string;
        content: string;
        createdAt: Date;
        source: string;
    }>;
    existingInsights: Array<{
        id: string;
        statement: string;
        explanation: string;
        confidence: string;
        status: string;
        category: string | null;
    }>;
    facts: {
        totalEvents: number;
        eventsLast7Days: number;
        eventsLast30Days: number;
        eventsLast90Days: number;
        totalActivePatterns: number;
        totalSupersededPatterns: number;
        totalDormantPatterns: number;
        earliestEventDate: Date | null;
        daysSinceFirstEvent: number;
        avgEventsPerWeek: number;
        totalInsights: number;
        confirmedInsights: number;
        likelyInsights: number;
        speculativeInsights: number;
        mostActiveDay: string | null;
        eventFrequencyTrend: string;
    };
}): string {
    // Format patterns for LLM
    const patternsForLLM = context.patterns.map((p) => ({
        id: p.id,
        description: p.description,
        status: p.status,
        eventCount: p.eventCount,
        firstDetectedAt: p.firstDetectedAt.toISOString(),
        lastReinforcedAt: p.lastReinforcedAt.toISOString(),
    }));

    // Format interpretations for LLM (truncate long content)
    const interpretationsForLLM = context.interpretations.map((i) => ({
        id: i.id,
        eventId: i.eventId,
        content: i.content.length > 1500 ? i.content.substring(0, 1500) + '...' : i.content,
        createdAt: i.createdAt.toISOString(),
        source: i.source,
    }));

    // Format existing insights for LLM
    const existingInsightsForLLM = context.existingInsights.map((i) => ({
        id: i.id,
        statement: i.statement,
        explanation: i.explanation.length > 500 ? i.explanation.substring(0, 500) + '...' : i.explanation,
        confidence: i.confidence,
        status: i.status,
        category: i.category,
    }));

    // Format facts for LLM
    const factsForLLM = {
        ...context.facts,
        earliestEventDate: context.facts.earliestEventDate?.toISOString() || null,
    };

    return JSON.stringify({
        userName: context.userName,
        userBaseline: context.userBaseline,
        trigger: context.trigger,
        patterns: patternsForLLM,
        interpretations: interpretationsForLLM,
        existingInsights: existingInsightsForLLM,
        facts: factsForLLM,
    }, null, 2);
}
