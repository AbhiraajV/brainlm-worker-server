import prisma from '../prisma';
import { interpretEvent } from '../workers/interpretation';
import { detectPatternsForEvent, PatternOutcome } from '../workers/pattern';
import { generateInsights, TriggerContext } from '../workers/insight';
import { PipelineResult } from './types';

// ============================================================================
// Pipeline Configuration
// ============================================================================

const ENABLE_PATTERN_DETECTION = true;
const ENABLE_INSIGHTS = true;  // Enable Insight Worker (Worker 3)
const ENABLE_INSIGHTS_ON_PATTERN_CHANGE = true;  // Generate insights when pattern created/evolved
const ENABLE_INSIGHTS_ON_EVERY_EVENT = false;    // Too expensive - disable by default
const ENABLE_RECOMMENDATIONS = false; // Future: enable when Worker 4 is ready

// ============================================================================
// Main Pipeline
// ============================================================================

/**
 * Processes a new event through the full memory pipeline.
 *
 * Pipeline stages:
 * 1. Interpretation (Worker 1) - Generate rich semantic understanding
 * 2. Pattern Detection (Worker 2) - Detect/reinforce patterns
 * 3. Recommendation (Worker 3) - Future: pre-compute reasoning artifacts
 *
 * Currently synchronous. When we add a queue, each stage will enqueue the next.
 *
 * @param eventId - The event ID to process
 * @returns Pipeline execution result with stage outcomes
 */
export async function processMemoryPipeline(eventId: string): Promise<PipelineResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    const result: PipelineResult = {
        success: false,
        eventId,
        stages: {},
        errors,
        durationMs: 0,
    };

    console.log(`[Pipeline] Starting for event ${eventId}`);

    // ========================================================================
    // Stage 1: Interpretation
    // ========================================================================

    try {
        console.log(`[Pipeline] Stage 1: Interpretation`);
        const interpretResult = await interpretEvent({ eventId });
        result.stages.interpret = interpretResult;

        if (!interpretResult.success) {
            errors.push('Interpretation failed');
            result.durationMs = Date.now() - startTime;
            return result;
        }

        if (interpretResult.skipped) {
            console.log(`[Pipeline] Interpretation skipped: ${interpretResult.reason}`);
        } else {
            console.log(`[Pipeline] Interpretation created: ${interpretResult.interpretationId}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown interpretation error';
        errors.push(`Interpretation error: ${message}`);
        console.error(`[Pipeline] Interpretation failed:`, error);
        result.durationMs = Date.now() - startTime;
        return result;
    }

    // ========================================================================
    // Stage 2: Pattern Detection
    // ========================================================================

    if (ENABLE_PATTERN_DETECTION) {
        try {
            console.log(`[Pipeline] Stage 2: Pattern Detection`);

            // Get userId from event
            const event = await prisma.event.findUnique({
                where: { id: eventId },
                select: { userId: true },
            });

            if (!event) {
                errors.push('Event not found for pattern detection');
            } else {
                const patternResult = await detectPatternsForEvent({
                    userId: event.userId,
                    triggerEventId: eventId,
                    interpretationId: result.stages.interpret?.interpretationId,
                });
                result.stages.patternDetect = patternResult;

                console.log(
                    `[Pipeline] Pattern detection: created=${patternResult.patternsCreated}, ` +
                    `reinforced=${patternResult.patternsReinforced}, clusters=${patternResult.clustersFound}`
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown pattern detection error';
            errors.push(`Pattern detection error: ${message}`);
            console.error(`[Pipeline] Pattern detection failed:`, error);
            // Continue - pattern detection failure shouldn't fail the whole pipeline
        }
    }

    // ========================================================================
    // Stage 3: Insight Generation
    // ========================================================================

    if (ENABLE_INSIGHTS) {
        // Determine if we should generate insights based on pattern outcome
        const patternResult = result.stages.patternDetect;
        const shouldGenerateInsights =
            ENABLE_INSIGHTS_ON_EVERY_EVENT ||
            (ENABLE_INSIGHTS_ON_PATTERN_CHANGE &&
                patternResult &&
                (patternResult.outcome === PatternOutcome.CREATED_NEW_PATTERN ||
                    patternResult.outcome === PatternOutcome.EVOLVED_PATTERN));

        if (shouldGenerateInsights) {
            try {
                console.log(`[Pipeline] Stage 3: Insight Generation`);

                // Get userId from event
                const eventForInsight = await prisma.event.findUnique({
                    where: { id: eventId },
                    select: { userId: true },
                });

                if (eventForInsight) {
                    // Determine trigger type based on pattern outcome
                    let triggerType: TriggerContext['type'] = 'new_event';
                    if (patternResult) {
                        switch (patternResult.outcome) {
                            case PatternOutcome.CREATED_NEW_PATTERN:
                                triggerType = 'pattern_created';
                                break;
                            case PatternOutcome.EVOLVED_PATTERN:
                                triggerType = 'pattern_evolved';
                                break;
                            case PatternOutcome.REINFORCED_PATTERN:
                                triggerType = 'pattern_reinforced';
                                break;
                        }
                    }

                    const trigger: TriggerContext = {
                        type: triggerType,
                        eventId,
                        interpretationId: result.stages.interpret?.interpretationId,
                        patternId: patternResult?.patternId,
                    };

                    const insightResult = await generateInsights({
                        userId: eventForInsight.userId,
                        trigger,
                    });

                    result.stages.insight = insightResult;

                    console.log(
                        `[Pipeline] Insight generation: created=${insightResult.insightsCreated}`
                    );
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown insight generation error';
                errors.push(`Insight generation error: ${message}`);
                console.error(`[Pipeline] Insight generation failed:`, error);
                // Continue - insight generation failure shouldn't fail the whole pipeline
            }
        } else {
            console.log(`[Pipeline] Stage 3: Insight Generation (skipped - pattern only reinforced)`);
        }
    }

    // ========================================================================
    // Stage 4: Recommendation (Future)
    // ========================================================================

    if (ENABLE_RECOMMENDATIONS) {
        // TODO: Implement when Worker 4 is ready
        // const recommendResult = await generateRecommendations({ ... });
        // result.stages.recommend = recommendResult;
        console.log(`[Pipeline] Stage 4: Recommendations (not yet implemented)`);
    }

    // ========================================================================
    // Complete
    // ========================================================================

    result.success = errors.length === 0;
    result.durationMs = Date.now() - startTime;

    console.log(
        `[Pipeline] Completed for event ${eventId} in ${result.durationMs}ms ` +
        `(success=${result.success}, errors=${errors.length})`
    );

    return result;
}
