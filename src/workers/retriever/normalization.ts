import {
    AllTablesResult,
    CompiledQuery,
    EvidenceSource,
    ExpandedEvent,
    NormalizedEvidence,
    RetrievalReason,
} from './schema';

/**
 * Normalizes all retrieved evidence to a common structure.
 *
 * Step 5 of the retriever pipeline.
 *
 * Converts raw results from all tables + expanded event data into
 * a unified NormalizedEvidence format with explainability.
 *
 * @param rawResults - Raw results from table retrieval
 * @param expandedEvents - Events expanded with linked knowledge
 * @param compiledQueries - Compiled queries (for whyThisWasRetrieved)
 * @returns Normalized evidence grouped by source
 */
export function normalizeEvidence(
    rawResults: AllTablesResult,
    expandedEvents: ExpandedEvent[],
    compiledQueries: CompiledQuery
): {
    events: NormalizedEvidence[];
    interpretations: NormalizedEvidence[];
    patterns: NormalizedEvidence[];
    insights: NormalizedEvidence[];
} {
    console.log('[Retriever] Step 5: Normalizing evidence...');

    // Track seen IDs to avoid duplicates from expansion
    const seenPatternIds = new Set<string>();
    const seenInsightIds = new Set<string>();
    const seenInterpretationIds = new Set<string>();

    // Normalize direct results first
    const events = normalizeEvents(rawResults.events, compiledQueries);
    const interpretations = normalizeInterpretations(rawResults.interpretations, compiledQueries);
    const patterns = normalizePatterns(rawResults.patterns, compiledQueries);
    const insights = normalizeInsights(rawResults.insights, compiledQueries);

    // Track what we already have from direct retrieval
    interpretations.forEach(i => seenInterpretationIds.add(i.id));
    patterns.forEach(p => seenPatternIds.add(p.id));
    insights.forEach(i => seenInsightIds.add(i.id));

    // Add expanded items (interpretation, patterns, insights from event expansion)
    const expandedInterpretations: NormalizedEvidence[] = [];
    const expandedPatterns: NormalizedEvidence[] = [];
    const expandedInsights: NormalizedEvidence[] = [];

    for (const expanded of expandedEvents) {
        // Add interpretation from expansion (if not already retrieved)
        if (expanded.interpretation && !seenInterpretationIds.has(expanded.interpretation.id)) {
            seenInterpretationIds.add(expanded.interpretation.id);
            expandedInterpretations.push({
                source: EvidenceSource.INTERPRETATION,
                id: expanded.interpretation.id,
                content: expanded.interpretation.content,
                relatedEventId: expanded.event.id,
                timestamp: expanded.event.occurredAt,
                whyThisWasRetrieved: `Interpretation of event: "${expanded.event.content.substring(0, 100)}..."`,
                relevanceScore: expanded.event.similarity * 0.9, // Slightly lower since indirect
                retrievalReason: RetrievalReason.EVENT_EXPANSION,
            });
        }

        // Add linked patterns from expansion (if not already retrieved)
        for (const pattern of expanded.linkedPatterns) {
            if (!seenPatternIds.has(pattern.id)) {
                seenPatternIds.add(pattern.id);
                expandedPatterns.push({
                    source: EvidenceSource.PATTERN,
                    id: pattern.id,
                    content: pattern.description,
                    relatedEventId: expanded.event.id,
                    timestamp: expanded.event.occurredAt,
                    whyThisWasRetrieved: `Pattern linked to event: "${expanded.event.content.substring(0, 100)}..."`,
                    relevanceScore: expanded.event.similarity * 0.85,
                    retrievalReason: RetrievalReason.PATTERN_LINK,
                    metadata: { status: pattern.status },
                });
            }
        }

        // Add linked insights from expansion (if not already retrieved)
        for (const insight of expanded.linkedInsights) {
            if (!seenInsightIds.has(insight.id)) {
                seenInsightIds.add(insight.id);
                expandedInsights.push({
                    source: EvidenceSource.INSIGHT,
                    id: insight.id,
                    content: `${insight.statement}\n\n${insight.explanation}`,
                    relatedEventId: expanded.event.id,
                    timestamp: expanded.event.occurredAt,
                    whyThisWasRetrieved: `Insight linked to event (${insight.relevance}): "${expanded.event.content.substring(0, 100)}..."`,
                    relevanceScore: expanded.event.similarity * 0.8,
                    retrievalReason: RetrievalReason.INSIGHT_LINK,
                    metadata: { relevance: insight.relevance },
                });
            }
        }
    }

    // Merge direct and expanded results
    const allInterpretations = [...interpretations, ...expandedInterpretations];
    const allPatterns = [...patterns, ...expandedPatterns];
    const allInsights = [...insights, ...expandedInsights];

    console.log(
        `[Retriever] Step 5 complete: normalized ${events.length} events, ` +
        `${allInterpretations.length} interpretations (${expandedInterpretations.length} from expansion), ` +
        `${allPatterns.length} patterns (${expandedPatterns.length} from expansion), ` +
        `${allInsights.length} insights (${expandedInsights.length} from expansion)`
    );

    return {
        events,
        interpretations: allInterpretations,
        patterns: allPatterns,
        insights: allInsights,
    };
}

/**
 * Normalize events to common structure.
 */
function normalizeEvents(
    events: AllTablesResult['events'],
    compiledQueries: CompiledQuery
): NormalizedEvidence[] {
    return events.map(event => ({
        source: EvidenceSource.EVENT,
        id: event.id,
        content: event.content,
        relatedEventId: event.id,
        timestamp: event.occurredAt,
        whyThisWasRetrieved: `Matched search: "${compiledQueries.queries.Event.searchIntent.substring(0, 100)}..."`,
        relevanceScore: event.similarity,
        retrievalReason: RetrievalReason.DIRECT_MATCH,
    }));
}

/**
 * Normalize interpretations to common structure.
 */
function normalizeInterpretations(
    interpretations: AllTablesResult['interpretations'],
    compiledQueries: CompiledQuery
): NormalizedEvidence[] {
    return interpretations.map(interp => ({
        source: EvidenceSource.INTERPRETATION,
        id: interp.id,
        content: interp.content,
        relatedEventId: interp.eventId,
        timestamp: interp.eventOccurredAt,
        whyThisWasRetrieved: `Matched search: "${compiledQueries.queries.Interpretation.searchIntent.substring(0, 100)}..."`,
        relevanceScore: interp.similarity,
        retrievalReason: RetrievalReason.DIRECT_MATCH,
    }));
}

/**
 * Normalize patterns to common structure.
 */
function normalizePatterns(
    patterns: AllTablesResult['patterns'],
    compiledQueries: CompiledQuery
): NormalizedEvidence[] {
    return patterns.map(pattern => ({
        source: EvidenceSource.PATTERN,
        id: pattern.id,
        content: pattern.description,
        relatedEventId: null,
        timestamp: pattern.lastReinforcedAt,
        whyThisWasRetrieved: `Matched search: "${compiledQueries.queries.Pattern.searchIntent.substring(0, 100)}..."`,
        relevanceScore: pattern.similarity,
        retrievalReason: RetrievalReason.DIRECT_MATCH,
        metadata: {
            status: pattern.status,
            firstDetectedAt: pattern.firstDetectedAt,
        },
    }));
}

/**
 * Normalize insights to common structure.
 */
function normalizeInsights(
    insights: AllTablesResult['insights'],
    compiledQueries: CompiledQuery
): NormalizedEvidence[] {
    return insights.map(insight => ({
        source: EvidenceSource.INSIGHT,
        id: insight.id,
        content: `${insight.statement}\n\n${insight.explanation}`,
        relatedEventId: null,
        timestamp: insight.firstDetectedAt,
        whyThisWasRetrieved: `Matched search: "${compiledQueries.queries.Insight.searchIntent.substring(0, 100)}..."`,
        relevanceScore: insight.similarity,
        retrievalReason: RetrievalReason.DIRECT_MATCH,
        metadata: {
            status: insight.status,
            confidence: insight.confidence,
            category: insight.category,
        },
    }));
}
