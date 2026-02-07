/**
 * Insight Generation User Message Formatter
 *
 * System prompt is now centralized in src/prompts.ts (INSIGHT_GENERATION_PROMPT)
 * This file contains only the user message formatting logic.
 */

/**
 * Extracts numbers from event and generates quantitative projections.
 * This pre-calculates so the LLM just needs to include it, not compute.
 */
function generateQuantitativeHint(eventContent: string | null): string | null {
    if (!eventContent) return null;
    const content = eventContent.toLowerCase();

    // Money patterns
    const moneyMatch = content.match(/(\d+)\s*dollars?/);
    if (moneyMatch) {
        const n = parseInt(moneyMatch[1]);
        if (content.includes('month')) return `$${n}/month = $${n * 12}/year`;
        if (content.includes('week')) return `$${n}/week = $${n * 4}/month`;
        return `$${n} spent. If monthly: $${n * 12}/year`;
    }

    // Time patterns
    const minMatch = content.match(/(\d+)\s*min/);
    if (minMatch) {
        const n = parseInt(minMatch[1]);
        return `${n} min/day = ${(n * 7 / 60).toFixed(1)} hours/week if daily`;
    }

    const hourMatch = content.match(/(\d+)\s*hour/);
    if (hourMatch) {
        const n = parseInt(hourMatch[1]);
        return `${n} hours/day = ${n * 7} hours/week if daily`;
    }

    // Distance
    const kmMatch = content.match(/(\d+)\s*(?:km|kilometer)/);
    if (kmMatch) {
        const n = parseInt(kmMatch[1]);
        return `${n}km this session. Next target: ${n + 1}km or faster pace`;
    }

    // Exercise counts (pushups, pullups, squats, reps, etc)
    const exerciseMatch = content.match(/(\d+)\s*(pushups?|pullups?|squats?|reps?|sets?|situps?|crunches?)/);
    if (exerciseMatch) {
        const n = parseInt(exerciseMatch[1]);
        const unit = exerciseMatch[2];
        return `${n} ${unit}/day = ${n * 7} ${unit}/week if daily. Next target: ${n + 5} ${unit}`;
    }

    // Weight
    const weightMatch = content.match(/(\d+)\s*(?:kg|lbs?|pounds?)/);
    if (weightMatch) {
        const n = parseInt(weightMatch[1]);
        return `Current: ${n}kg. Next target: ${n + 2.5}kg or +1 rep at current weight`;
    }

    // Pages/glasses/generic counts
    const countMatch = content.match(/(\d+)\s*(pages?|glasses?|chapters?)/);
    if (countMatch) {
        const n = parseInt(countMatch[1]);
        const unit = countMatch[2];
        return `${n} ${unit}/day = ${n * 7} ${unit}/week if daily`;
    }

    // Steps
    const stepsMatch = content.match(/(\d+)\s*steps?/);
    if (stepsMatch) {
        const n = parseInt(stepsMatch[1]);
        return `${n} steps/day = ${n * 7} steps/week. Target: 10,000 steps/day`;
    }

    return null;
}

/**
 * Formats the user message with all retrieved context.
 *
 * CRITICAL: The message is structured EVENT-CENTRIC:
 * 1. currentEvent comes FIRST - this is what the LLM should focus on
 * 2. user context provides WHO this person is
 * 3. background provides historical patterns and interpretations
 */
export function formatInsightUserMessage(context: {
    userName: string;
    userBaseline: string;
    triggerEvent: { id: string; content: string; occurredAt: Date; trackedType?: string | null } | null;
    triggerInterpretation: { id: string; content: string } | null;
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
    dayEvents?: { [trackedType: string]: Array<{ id: string; content: string; occurredAt: Date; trackedType: string | null }> };
    trackTypeHistory?: Array<{ id: string; content: string; occurredAt: Date; trackedType: string | null }>;
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

    // Generate quantitative projection hint if event has numbers
    const quantitativeHint = generateQuantitativeHint(context.triggerEvent?.content || null);

    // Format day events grouped by track type
    const dayEventsForLLM: Record<string, Array<{ content: string; occurredAt: string }>> = {};
    if (context.dayEvents) {
        for (const [trackType, events] of Object.entries(context.dayEvents)) {
            dayEventsForLLM[trackType] = events.map(e => ({
                content: e.content.length > 300 ? e.content.substring(0, 300) + '...' : e.content,
                occurredAt: e.occurredAt.toISOString(),
            }));
        }
    }

    // Format track type history chronologically
    const trackTypeHistoryForLLM = (context.trackTypeHistory || []).map(e => ({
        content: e.content.length > 300 ? e.content.substring(0, 300) + '...' : e.content,
        occurredAt: e.occurredAt.toISOString(),
    }));

    // Build EVENT-CENTRIC message structure
    // The currentEvent comes FIRST so the LLM focuses on it
    return JSON.stringify({
        // CURRENT EVENT FIRST - This is what the LLM should focus on
        currentEvent: {
            rawContent: context.triggerEvent?.content || null,
            interpretation: context.triggerInterpretation?.content || null,
            occurredAt: context.triggerEvent?.occurredAt?.toISOString() || null,
            eventId: context.triggerEvent?.id || null,
            trackedType: context.triggerEvent?.trackedType || 'GENERAL',
            triggerType: context.trigger.type,
            quantitativeProjection: quantitativeHint,
        },

        // USER CONTEXT - Who this person is
        user: {
            name: context.userName,
            baseline: context.userBaseline,
        },

        // ALL EVENTS FROM TODAY - grouped by track type for cross-domain analysis
        dayEvents: dayEventsForLLM,

        // SAME TRACK TYPE HISTORY - for progression comparison
        trackTypeHistory: trackTypeHistoryForLLM,

        // BACKGROUND - For understanding, not for regenerating
        background: {
            existingPatterns: patternsForLLM,
            historicalInterpretations: interpretationsForLLM,
            existingInsights: existingInsightsForLLM,
            facts: factsForLLM,
        },
    }, null, 2);
}
