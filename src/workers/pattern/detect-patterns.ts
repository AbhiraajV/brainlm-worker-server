import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText, cosineSimilarity } from '../../services/embedding';
import { PATTERN_SYNTHESIS_PROMPT, PATTERN_EVOLUTION_PROMPT } from '../../prompts';
import { PatternOutputSchema, PatternOutcome, InterpretationWithEmbedding } from './schema';
import {
    clusterInterpretations,
    findSimilarPatterns,
    DEFAULT_CLUSTERING_CONFIG,
    ClusteringConfig,
} from './similarity';
import {
    selectRepresentativeEvidence,
    DEFAULT_EVIDENCE_CONFIG,
    EvidenceSelectionConfig,
    ScoredInterpretation,
} from './evidence-selection';

// ============================================================================
// Thresholds
// ============================================================================

const REINFORCE_THRESHOLD = 0.75;  // ≥ 0.75 = reinforce (no LLM call)
const EVOLVE_THRESHOLD = 0.60;     // ≥ 0.60 = evolve (LLM re-synthesizes)
// < 0.60 = create new pattern

// ============================================================================
// Types
// ============================================================================

export interface DetectPatternsInput {
    userId: string;
    lookbackDays?: number; // default: 30 (kept for backward compat, but now uses full timeline)
    clusteringConfig?: ClusteringConfig;
}

export interface DetectPatternsForEventInput {
    userId: string;
    triggerEventId: string;
    interpretationId?: string;
    evidenceConfig?: EvidenceSelectionConfig;
}

export interface DetectPatternsResult {
    success: boolean;
    outcome: PatternOutcome;
    patternId: string;
    patternsCreated: number;
    patternsReinforced: number;
    patternsEvolved: number;
    clustersFound: number;
}

export class PatternDetectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'PatternDetectionError';
    }
}

// ============================================================================
// Event-Triggered Pattern Detection (NEW - Pipeline Mode)
// ============================================================================

/**
 * Detects patterns triggered by a specific event.
 *
 * This is the pipeline-mode pattern detection that:
 * 1. Gets the new interpretation's embedding
 * 2. Uses intelligent full-timeline evidence selection
 * 3. Checks if it matches/reinforces existing patterns
 * 4. Or evolves/creates a pattern via LLM synthesis
 *
 * Key difference from batch mode:
 * - Triggered per-event (pipeline chain)
 * - Uses full-timeline retrieval with intelligent sampling
 * - ALWAYS produces an outcome (REINFORCED, EVOLVED, or CREATED)
 * - Never silently exits without a pattern
 *
 * Outcome Contract:
 * - ≥ 0.75 similarity: REINFORCED_PATTERN (no LLM call)
 * - ≥ 0.60 similarity: EVOLVED_PATTERN (LLM re-synthesizes)
 * - < 0.60 similarity: CREATED_NEW_PATTERN
 */
export async function detectPatternsForEvent(
    input: DetectPatternsForEventInput
): Promise<DetectPatternsResult> {
    const { userId, triggerEventId, evidenceConfig = DEFAULT_EVIDENCE_CONFIG } = input;

    console.log(`[PatternDetection] Processing for user ${userId}, triggered by event ${triggerEventId}`);

    // 1. Get the triggering interpretation's embedding
    const triggerInterpretation = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT id, "eventId", content, embedding::text, "createdAt"
        FROM "Interpretation"
        WHERE "eventId" = ${triggerEventId}
          AND embedding IS NOT NULL
        LIMIT 1
    `;

    // FALLBACK 1: No interpretation found → reinforce most recent or create singleton
    if (triggerInterpretation.length === 0) {
        console.log(`[PatternDetection] No interpretation found for event ${triggerEventId}, using fallback`);

        const mostRecent = await getMostRecentActivePattern(userId);
        if (mostRecent) {
            await reinforcePattern(mostRecent.id, [triggerEventId]);
            console.log(`[PatternDetection] REINFORCED_PATTERN ${mostRecent.id} (fallback - no interpretation)`);
            return {
                success: true,
                outcome: PatternOutcome.REINFORCED_PATTERN,
                patternId: mostRecent.id,
                patternsCreated: 0,
                patternsReinforced: 1,
                patternsEvolved: 0,
                clustersFound: 0,
            };
        }

        // No patterns exist → create singleton
        const patternId = await createSingletonPattern(userId, triggerEventId);
        console.log(`[PatternDetection] CREATED_NEW_PATTERN ${patternId} (singleton - no interpretation)`);
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId,
            patternsCreated: 1,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: 0,
        };
    }

    const trigger = triggerInterpretation[0];
    const triggerEmbedding = parseEmbedding(trigger.embedding);

    // 2. Get existing patterns with similarity scores
    const patternsWithSimilarity = await getExistingPatternsWithSimilarity(userId, triggerEmbedding);

    // 3. Select representative evidence
    console.log(`[PatternDetection] Selecting representative evidence (full timeline)`);
    const evidence = await selectRepresentativeEvidence(userId, triggerEmbedding, evidenceConfig);
    console.log(`[PatternDetection] Retrieved ${evidence.length} representative interpretations`);

    const eventIds = [triggerEventId, ...evidence.map((e) => e.interpretation.eventId)];
    const uniqueEventIds = [...new Set(eventIds)];

    // 4. Determine outcome based on best match
    if (patternsWithSimilarity.length > 0) {
        const bestMatch = patternsWithSimilarity[0];

        // ≥ 0.75: REINFORCE (no LLM call)
        if (bestMatch.similarity >= REINFORCE_THRESHOLD) {
            await reinforcePattern(bestMatch.id, uniqueEventIds);
            console.log(`[PatternDetection] REINFORCED_PATTERN ${bestMatch.id} (similarity=${bestMatch.similarity.toFixed(3)})`);
            return {
                success: true,
                outcome: PatternOutcome.REINFORCED_PATTERN,
                patternId: bestMatch.id,
                patternsCreated: 0,
                patternsReinforced: 1,
                patternsEvolved: 0,
                clustersFound: 1,
            };
        }

        // ≥ 0.60: EVOLVE (LLM re-synthesizes)
        if (bestMatch.similarity >= EVOLVE_THRESHOLD) {
            // FALLBACK 2: Insufficient evidence for evolution → reinforce instead
            if (evidence.length < 2) {
                await reinforcePattern(bestMatch.id, uniqueEventIds);
                console.log(`[PatternDetection] REINFORCED_PATTERN ${bestMatch.id} (insufficient evidence for evolution)`);
                return {
                    success: true,
                    outcome: PatternOutcome.REINFORCED_PATTERN,
                    patternId: bestMatch.id,
                    patternsCreated: 0,
                    patternsReinforced: 1,
                    patternsEvolved: 0,
                    clustersFound: 1,
                };
            }

            const newPatternId = await evolvePattern(userId, bestMatch.id, bestMatch.description, evidence, uniqueEventIds);
            console.log(`[PatternDetection] EVOLVED_PATTERN ${bestMatch.id} → ${newPatternId} (similarity=${bestMatch.similarity.toFixed(3)})`);
            return {
                success: true,
                outcome: PatternOutcome.EVOLVED_PATTERN,
                patternId: newPatternId,
                patternsCreated: 0,
                patternsReinforced: 0,
                patternsEvolved: 1,
                clustersFound: 1,
            };
        }
    }

    // < 0.60 or no patterns: CREATE NEW
    // FALLBACK 3: Insufficient evidence → create singleton pattern
    if (evidence.length < 2) {
        const patternId = await createSingletonPatternFromInterpretation(userId, trigger, triggerEventId);
        console.log(`[PatternDetection] CREATED_NEW_PATTERN ${patternId} (singleton - insufficient evidence)`);
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId,
            patternsCreated: 1,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: 0,
        };
    }

    // Normal case: create new pattern from evidence via LLM
    const patternId = await createPatternFromEvidence(userId, evidence, uniqueEventIds);
    console.log(`[PatternDetection] CREATED_NEW_PATTERN ${patternId}`);
    return {
        success: true,
        outcome: PatternOutcome.CREATED_NEW_PATTERN,
        patternId,
        patternsCreated: 1,
        patternsReinforced: 0,
        patternsEvolved: 0,
        clustersFound: 1,
    };
}

// ============================================================================
// Batch Pattern Detection (Legacy - kept for backward compatibility)
// ============================================================================

/**
 * Detects patterns from recent interpretations via embedding clustering.
 *
 * This is the batch/periodic pattern detection that:
 * 1. Fetches recent interpretations with embeddings
 * 2. Clusters semantically similar interpretations
 * 3. For each significant cluster:
 *    - Check if it matches an existing pattern (reinforce)
 *    - Or create a new pattern via LLM synthesis
 * 4. Links PatternEvents for audit trail
 *
 * @deprecated Use detectPatternsForEvent for pipeline mode.
 * This function is kept for backfills, debugging, and recovery only.
 * It should never be auto-scheduled.
 */
export async function detectPatterns(
    input: DetectPatternsInput
): Promise<DetectPatternsResult> {
    const { userId, lookbackDays = 30, clusteringConfig = DEFAULT_CLUSTERING_CONFIG } = input;

    // 1. Calculate lookback date
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

    // 2. Fetch recent interpretations with embeddings
    const rawInterpretations = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            userId: string;
            content: string;
            embedding: string;
            createdAt: Date;
        }>
    >`
        SELECT
            id,
            "eventId",
            "userId",
            content,
            embedding::text,
            "createdAt"
        FROM "Interpretation"
        WHERE "userId" = ${userId}
          AND "createdAt" >= ${lookbackDate}
          AND embedding IS NOT NULL
        ORDER BY "createdAt" DESC
    `;

    // Parse embeddings from string to number[]
    const interpretations: InterpretationWithEmbedding[] = rawInterpretations.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        userId: row.userId,
        content: row.content,
        embedding: parseEmbedding(row.embedding),
        createdAt: row.createdAt,
    }));

    if (interpretations.length < clusteringConfig.minClusterSize) {
        return {
            success: true,
            outcome: PatternOutcome.CREATED_NEW_PATTERN,
            patternId: '',
            patternsCreated: 0,
            patternsReinforced: 0,
            patternsEvolved: 0,
            clustersFound: 0,
        };
    }

    // 3. Cluster interpretations
    const clusters = clusterInterpretations(interpretations, clusteringConfig);

    // 4. Fetch existing patterns for matching
    const existingPatterns = await prisma.$queryRaw<
        Array<{ id: string; embedding: string }>
    >`
        SELECT id, embedding::text
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND status = 'ACTIVE'
          AND embedding IS NOT NULL
    `;

    const patternEmbeddings = existingPatterns.map((p) => ({
        id: p.id,
        embedding: parseEmbedding(p.embedding),
    }));

    // 5. Process each cluster
    let patternsCreated = 0;
    let patternsReinforced = 0;
    let lastPatternId = '';

    for (const cluster of clusters) {
        // Check for matching existing patterns
        const matchingPatternIds = findSimilarPatterns(
            cluster.centroid,
            patternEmbeddings,
            0.8
        );

        const eventIds = cluster.interpretations.map((i) => i.eventId);

        if (matchingPatternIds.length > 0) {
            // Reinforce existing pattern
            const patternId = matchingPatternIds[0];
            await reinforcePattern(patternId, eventIds);
            patternsReinforced++;
            lastPatternId = patternId;
        } else {
            // Create new pattern
            const newPatternId = await createNewPattern(userId, cluster, eventIds);
            patternsCreated++;
            lastPatternId = newPatternId;
        }
    }

    // Determine primary outcome for batch mode
    const outcome = patternsCreated > 0
        ? PatternOutcome.CREATED_NEW_PATTERN
        : PatternOutcome.REINFORCED_PATTERN;

    return {
        success: true,
        outcome,
        patternId: lastPatternId,
        patternsCreated,
        patternsReinforced,
        patternsEvolved: 0,
        clustersFound: clusters.length,
    };
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseEmbedding(embeddingStr: string): number[] {
    // Format: "[0.1,0.2,0.3,...]"
    const cleaned = embeddingStr.replace(/[\[\]]/g, '');
    return cleaned.split(',').map((s) => parseFloat(s.trim()));
}

interface PatternWithSimilarity {
    id: string;
    description: string;
    embedding: number[];
    similarity: number;
}

/**
 * Gets the most recent active pattern for a user.
 * Used as fallback when no interpretation exists.
 */
async function getMostRecentActivePattern(userId: string): Promise<{ id: string } | null> {
    const pattern = await prisma.pattern.findFirst({
        where: {
            userId,
            status: 'ACTIVE',
        },
        orderBy: { lastReinforcedAt: 'desc' },
        select: { id: true },
    });
    return pattern;
}

/**
 * Creates a singleton "emerging" pattern from just the event content.
 * Used when no interpretation is available.
 */
async function createSingletonPattern(userId: string, eventId: string): Promise<string> {
    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { content: true },
    });

    const description = `## EMERGING PATTERN\n\n## OBSERVATION\nSingle event observed. Pattern emerging.\n\n## SUPPORTING EVIDENCE\n- ${event?.content || 'Event content unavailable'}\n\n## INTERPRETATION\nThis is an emerging pattern based on a single observation. As more similar events occur, this pattern will evolve and develop clearer characteristics.\n\n## TEMPORAL CHARACTERISTICS\nInsufficient data for temporal analysis.\n\n## POTENTIAL IMPLICATIONS\nTo be determined as pattern develops.`;

    const embeddingResult = await embedText({ text: description });

    const pattern = await prisma.$transaction(async (tx) => {
        const created = await tx.pattern.create({
            data: {
                userId,
                description,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        await tx.patternEvent.create({
            data: {
                patternId: created.id,
                eventId,
            },
        });

        return created;
    });

    return pattern.id;
}

/**
 * Creates a singleton pattern from an interpretation.
 * Used when we have interpretation but insufficient similar evidence.
 */
async function createSingletonPatternFromInterpretation(
    userId: string,
    interpretation: { id: string; content: string; embedding: string },
    eventId: string
): Promise<string> {
    const description = `## EMERGING PATTERN\n\n## OBSERVATION\nSingle event observed. Pattern emerging.\n\n## SUPPORTING EVIDENCE\n${interpretation.content}\n\n## INTERPRETATION\nThis is an emerging pattern based on a single observation. As more similar events occur, this pattern will evolve and develop clearer characteristics.\n\n## TEMPORAL CHARACTERISTICS\nInsufficient data for temporal analysis.\n\n## POTENTIAL IMPLICATIONS\nTo be determined as pattern develops.`;

    const embeddingResult = await embedText({ text: description });

    const pattern = await prisma.$transaction(async (tx) => {
        const created = await tx.pattern.create({
            data: {
                userId,
                description,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        await tx.patternEvent.create({
            data: {
                patternId: created.id,
                eventId,
            },
        });

        return created;
    });

    return pattern.id;
}

/**
 * Gets all existing patterns for a user with similarity scores.
 * Returns sorted by similarity (highest first).
 */
async function getExistingPatternsWithSimilarity(
    userId: string,
    targetEmbedding: number[]
): Promise<PatternWithSimilarity[]> {
    const patterns = await prisma.$queryRaw<
        Array<{ id: string; description: string; embedding: string }>
    >`
        SELECT id, description, embedding::text
        FROM "Pattern"
        WHERE "userId" = ${userId}
          AND status = 'ACTIVE'
          AND embedding IS NOT NULL
    `;

    const withSimilarity: PatternWithSimilarity[] = patterns.map((p) => {
        const embedding = parseEmbedding(p.embedding);
        const similarity = cosineSimilarity(targetEmbedding, embedding);
        return {
            id: p.id,
            description: p.description,
            embedding,
            similarity,
        };
    });

    // Sort by similarity descending
    withSimilarity.sort((a, b) => b.similarity - a.similarity);

    return withSimilarity;
}

/**
 * Fetches user context (name and baseline) for personalization.
 */
async function getUserContext(userId: string): Promise<{ userName: string; userBaseline: string }> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, baseline: true },
    });
    return {
        userName: user?.name || 'User',
        userBaseline: user?.baseline || 'No baseline available yet.',
    };
}

/**
 * Evolves an existing pattern by archiving it and creating a new evolved version.
 * The old pattern is marked as SUPERSEDED for audit trail.
 */
async function evolvePattern(
    userId: string,
    oldPatternId: string,
    oldDescription: string,
    evidence: ScoredInterpretation[],
    eventIds: string[]
): Promise<string> {
    // Fetch user context for personalization
    const { userName, userBaseline } = await getUserContext(userId);

    // Build LLM input for evolution
    const evidenceSummary = evidence.map((e) => ({
        content: e.interpretation.content,
        createdAt: e.interpretation.createdAt.toISOString(),
        isFromExistingPattern: !!e.fromPatternId,
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        mode: 'EVOLVE',
        existingPattern: oldDescription,
        eventCount: evidence.length,
        interpretations: evidenceSummary,
    });

    // Call LLM for pattern evolution
    const { modelConfig: evolveConfig, systemPrompt: evolvePrompt } = PATTERN_EVOLUTION_PROMPT;
    const completion = await openai.chat.completions.create({
        model: evolveConfig.model,
        messages: [
            { role: 'system', content: evolvePrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: evolveConfig.temperature,
        response_format: { type: evolveConfig.responseFormat ?? 'json_object' },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new PatternDetectionError('LLM returned empty response for pattern evolution');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new PatternDetectionError('LLM returned invalid JSON for evolved pattern', e);
    }

    const validated = PatternOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new PatternDetectionError(
            `Evolved pattern validation failed: ${validated.error.message}`
        );
    }

    const newDescription = validated.data.pattern;
    const embeddingResult = await embedText({ text: newDescription });

    // Transaction: archive old pattern, create new one
    const newPatternId = await prisma.$transaction(async (tx) => {
        // Archive old pattern
        await tx.pattern.update({
            where: { id: oldPatternId },
            data: { status: 'SUPERSEDED' },
        });

        // Create new evolved pattern
        const created = await tx.pattern.create({
            data: {
                userId,
                description: newDescription,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Update with embedding
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            created.id
        );

        // Create PatternEvents for new pattern
        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: created.id,
                eventId,
            })),
            skipDuplicates: true,
        });

        return created.id;
    });

    return newPatternId;
}

async function reinforcePattern(patternId: string, eventIds: string[]): Promise<void> {
    await prisma.$transaction(async (tx) => {
        // Update lastReinforcedAt
        await tx.pattern.update({
            where: { id: patternId },
            data: { lastReinforcedAt: new Date() },
        });

        // Add new PatternEvents (ignore duplicates)
        for (const eventId of eventIds) {
            await tx.patternEvent.upsert({
                where: {
                    patternId_eventId: { patternId, eventId },
                },
                create: {
                    patternId,
                    eventId,
                },
                update: {},
            });
        }
    });
}

/**
 * Creates a new pattern from scored evidence.
 * Used by event-triggered detection.
 */
async function createPatternFromEvidence(
    userId: string,
    evidence: ScoredInterpretation[],
    eventIds: string[]
): Promise<string> {
    // Fetch user context for personalization
    const { userName, userBaseline } = await getUserContext(userId);

    // Build LLM input from evidence
    const evidenceSummary = evidence.map((e) => ({
        content: e.interpretation.content,
        createdAt: e.interpretation.createdAt.toISOString(),
        isFromExistingPattern: !!e.fromPatternId,
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        mode: 'CREATE',
        eventCount: evidence.length,
        interpretations: evidenceSummary,
    });

    // Call LLM for pattern synthesis
    const { modelConfig: synthConfig, systemPrompt: synthPrompt } = PATTERN_SYNTHESIS_PROMPT;
    const completion = await openai.chat.completions.create({
        model: synthConfig.model,
        messages: [
            { role: 'system', content: synthPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: synthConfig.temperature,
        response_format: { type: synthConfig.responseFormat ?? 'json_object' },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new PatternDetectionError('LLM returned empty response for pattern synthesis');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new PatternDetectionError('LLM returned invalid JSON for pattern', e);
    }

    const validated = PatternOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new PatternDetectionError(
            `Pattern validation failed: ${validated.error.message}`
        );
    }

    const patternDescription = validated.data.pattern;

    // Embed the pattern
    const embeddingResult = await embedText({ text: patternDescription });

    // Store pattern with embedding
    const patternId = await prisma.$transaction(async (tx) => {
        const pattern = await tx.pattern.create({
            data: {
                userId,
                description: patternDescription,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Update with embedding
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            pattern.id
        );

        // Create PatternEvents
        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: pattern.id,
                eventId,
            })),
            skipDuplicates: true,
        });

        return pattern.id;
    });

    return patternId;
}

/**
 * Creates a new pattern from a cluster.
 * Used by batch detection (legacy).
 */
async function createNewPattern(
    userId: string,
    cluster: { interpretations: InterpretationWithEmbedding[]; centroid: number[] },
    eventIds: string[]
): Promise<string> {
    // Fetch user context for personalization
    const { userName, userBaseline } = await getUserContext(userId);

    // Build LLM input from cluster interpretations
    const clusterSummary = cluster.interpretations.map((i) => ({
        content: i.content,
        createdAt: i.createdAt.toISOString(),
    }));

    const userMessage = JSON.stringify({
        userName,
        userBaseline,
        mode: 'CREATE',
        eventCount: cluster.interpretations.length,
        interpretations: clusterSummary,
    });

    // Call LLM for pattern synthesis
    const { modelConfig: synthConfig, systemPrompt: synthPrompt } = PATTERN_SYNTHESIS_PROMPT;
    const completion = await openai.chat.completions.create({
        model: synthConfig.model,
        messages: [
            { role: 'system', content: synthPrompt },
            { role: 'user', content: userMessage },
        ],
        temperature: synthConfig.temperature,
        response_format: { type: synthConfig.responseFormat ?? 'json_object' },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
        throw new PatternDetectionError('LLM returned empty response for pattern synthesis');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawResponse);
    } catch (e) {
        throw new PatternDetectionError('LLM returned invalid JSON for pattern', e);
    }

    const validated = PatternOutputSchema.safeParse(parsed);
    if (!validated.success) {
        throw new PatternDetectionError(
            `Pattern validation failed: ${validated.error.message}`
        );
    }

    const patternDescription = validated.data.pattern;

    // Embed the pattern
    const embeddingResult = await embedText({ text: patternDescription });

    // Store pattern with embedding
    const patternId = await prisma.$transaction(async (tx) => {
        const pattern = await tx.pattern.create({
            data: {
                userId,
                description: patternDescription,
                status: 'ACTIVE',
            },
            select: { id: true },
        });

        // Update with embedding
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
            `UPDATE "Pattern" SET embedding = $1::vector WHERE id = $2`,
            embeddingStr,
            pattern.id
        );

        // Create PatternEvents
        await tx.patternEvent.createMany({
            data: eventIds.map((eventId) => ({
                patternId: pattern.id,
                eventId,
            })),
        });

        return pattern.id;
    });

    return patternId;
}
