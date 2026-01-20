import {
    RetrieverInput,
    RetrieverResult,
    RetrieverConfig,
    QuestionResult,
    DEFAULT_RETRIEVER_CONFIG,
} from './schema';
import { compileSemanticQueries } from './query-compiler';
import { retrieveFromAllTables } from './table-retrieval';
import { expandEvents } from './event-expansion';
import { normalizeEvidence } from './normalization';
import { deduplicateAndControl } from './deduplication';

/**
 * Main retrieval function - orchestrates the 7-step pipeline.
 *
 * Pipeline:
 * 1. Compile semantic queries (LLM)
 * 2. Embed queries per table
 * 3. Retrieve from all tables in parallel
 * 4. Expand events into knowledge graphs
 * 5. Normalize all evidence
 * 6. Deduplicate and control coverage
 * 7. Return structured context (NO synthesis)
 *
 * @param input - Retriever input
 * @returns Structured evidence for downstream synthesis
 */
export async function retrieve(input: RetrieverInput): Promise<RetrieverResult> {
    const startTime = Date.now();

    // Merge config with defaults
    const config: RetrieverConfig = {
        ...DEFAULT_RETRIEVER_CONFIG,
        ...input.config,
    };

    // Collect all questions (main + sub-questions)
    const allQuestions = [input.mainQuestion, ...(input.subQuestions ?? [])];
    console.log(`[Retriever] Starting retrieval for ${allQuestions.length} question(s)`);

    // Process each question
    const results: QuestionResult[] = [];
    for (const question of allQuestions) {
        const questionResult = await processQuestion(
            input.userId,
            question,
            config,
            input.timeRange
        );
        results.push(questionResult);
    }

    const processingTimeMs = Date.now() - startTime;
    console.log(`[Retriever] Complete. Total time: ${processingTimeMs}ms`);

    return {
        userId: input.userId,
        results,
        processingTimeMs,
    };
}

/**
 * Process a single question through the pipeline.
 */
async function processQuestion(
    userId: string,
    question: string,
    config: RetrieverConfig,
    timeRange?: { from?: Date; to?: Date }
): Promise<QuestionResult> {
    console.log(`[Retriever] Processing: "${question.substring(0, 50)}..."`);

    // Step 1: Compile semantic queries
    const compiledQueries = await compileSemanticQueries(question, config);

    // Steps 2-3: Embed and retrieve from all tables
    const rawResults = await retrieveFromAllTables(
        userId,
        compiledQueries,
        config,
        timeRange
    );

    // Step 4: Expand events into knowledge graphs
    const expandedEvents = await expandEvents(userId, rawResults.events);

    // Step 5: Normalize all evidence
    const normalizedEvidence = normalizeEvidence(rawResults, expandedEvents, compiledQueries);

    // Step 6: Deduplicate and control coverage
    const finalEvidence = await deduplicateAndControl(normalizedEvidence, config, userId);

    return {
        question,
        intentType: compiledQueries.intentType,
        retrievedContext: finalEvidence,
        compiledQueries,
    };
}

/**
 * Simplified retrieval for single question (convenience wrapper).
 */
export async function retrieveSingle(
    userId: string,
    question: string,
    config?: Partial<RetrieverConfig>
): Promise<QuestionResult> {
    const result = await retrieve({
        userId,
        mainQuestion: question,
        config,
    });

    return result.results[0];
}
