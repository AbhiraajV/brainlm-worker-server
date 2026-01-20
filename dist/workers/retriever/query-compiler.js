"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compileSemanticQueries = compileSemanticQueries;
const openai_1 = require("../../services/openai");
const schema_1 = require("./schema");
const prompt_1 = require("./prompt");
const prompts_1 = require("../../prompts");
/**
 * Compiles a user's question into table-specific search intents using an LLM.
 *
 * Step 1 of the retriever pipeline.
 *
 * @param question - The user's question
 * @param config - Retriever configuration
 * @returns Compiled queries for all 4 tables
 */
async function compileSemanticQueries(question, config) {
    console.log(`[Retriever] Compiling semantic queries for: "${question.substring(0, 50)}..."`);
    const response = await openai_1.openai.chat.completions.create({
        model: config.llmModel,
        temperature: config.llmTemperature,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: prompts_1.QUERY_COMPILATION_PROMPT.systemPrompt,
            },
            {
                role: 'user',
                content: (0, prompt_1.getQueryCompilationUserPrompt)(question),
            },
        ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) {
        throw new Error('[Retriever] LLM returned empty response for query compilation');
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (e) {
        console.error('[Retriever] Failed to parse LLM response:', content);
        throw new Error(`[Retriever] LLM returned invalid JSON: ${e}`);
    }
    // Validate with Zod schema
    const result = schema_1.CompiledQuerySchema.safeParse(parsed);
    if (!result.success) {
        console.error('[Retriever] Schema validation failed:', result.error.issues);
        console.error('[Retriever] Raw response:', content);
        // Attempt to use fallback with exploratory intent
        return createFallbackQuery(question);
    }
    console.log(`[Retriever] Step 1 complete: compiled 4 table queries (intent: ${result.data.intentType})`);
    return result.data;
}
/**
 * Creates a fallback query when LLM response is invalid.
 * Uses the original question as the search intent for all tables.
 */
function createFallbackQuery(question) {
    console.warn('[Retriever] Using fallback query compilation');
    return {
        intentType: schema_1.IntentType.EXPLORATORY,
        queries: {
            Event: {
                searchIntent: `Events related to: ${question}`,
                keywords: [],
            },
            Interpretation: {
                searchIntent: `Emotional and psychological aspects of: ${question}`,
                keywords: [],
            },
            Pattern: {
                searchIntent: `Recurring patterns related to: ${question}`,
                keywords: [],
            },
            Insight: {
                searchIntent: `Insights and conclusions about: ${question}`,
                keywords: [],
            },
        },
    };
}
