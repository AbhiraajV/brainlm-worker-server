"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieve = retrieve;
exports.retrieveSingle = retrieveSingle;
const schema_1 = require("./schema");
const query_compiler_1 = require("./query-compiler");
const table_retrieval_1 = require("./table-retrieval");
const event_expansion_1 = require("./event-expansion");
const normalization_1 = require("./normalization");
const deduplication_1 = require("./deduplication");
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
async function retrieve(input) {
    const startTime = Date.now();
    // Merge config with defaults
    const config = {
        ...schema_1.DEFAULT_RETRIEVER_CONFIG,
        ...input.config,
    };
    // Collect all questions (main + sub-questions)
    const allQuestions = [input.mainQuestion, ...(input.subQuestions ?? [])];
    console.log(`[Retriever] Starting retrieval for ${allQuestions.length} question(s)`);
    // Process each question
    const results = [];
    for (const question of allQuestions) {
        const questionResult = await processQuestion(input.userId, question, config, input.timeRange);
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
async function processQuestion(userId, question, config, timeRange) {
    console.log(`[Retriever] Processing: "${question.substring(0, 50)}..."`);
    // Step 1: Compile semantic queries
    const compiledQueries = await (0, query_compiler_1.compileSemanticQueries)(question, config);
    // Steps 2-3: Embed and retrieve from all tables
    const rawResults = await (0, table_retrieval_1.retrieveFromAllTables)(userId, compiledQueries, config, timeRange);
    // Step 4: Expand events into knowledge graphs
    const expandedEvents = await (0, event_expansion_1.expandEvents)(userId, rawResults.events);
    // Step 5: Normalize all evidence
    const normalizedEvidence = (0, normalization_1.normalizeEvidence)(rawResults, expandedEvents, compiledQueries);
    // Step 6: Deduplicate and control coverage
    const finalEvidence = await (0, deduplication_1.deduplicateAndControl)(normalizedEvidence, config, userId);
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
async function retrieveSingle(userId, question, config) {
    const result = await retrieve({
        userId,
        mainQuestion: question,
        config,
    });
    return result.results[0];
}
