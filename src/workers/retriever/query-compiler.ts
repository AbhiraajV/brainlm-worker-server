import { openai } from '../../services/openai';
import {
    CompiledQuery,
    RetrieverConfig,
} from './schema';
import { getQueryCompilationUserPrompt } from './prompt';
import { QUERY_COMPILATION_PROMPT } from '../../prompts';

// ============================================================================
// JSON Schema for Structured Output
// ============================================================================

// OpenAI Structured Output guarantees this schema - no Zod validation needed
const COMPILED_QUERY_JSON_SCHEMA = {
    name: 'compiled_query',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            intentType: {
                type: 'string',
                enum: ['TEMPORAL', 'CAUSAL', 'EVALUATIVE', 'COMPARATIVE', 'EXPLORATORY'],
                description: 'Classified intent type for retrieval biasing',
            },
            queries: {
                type: 'object',
                properties: {
                    Event: {
                        type: 'object',
                        properties: {
                            searchIntent: { type: 'string' },
                            keywords: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['searchIntent', 'keywords'],
                        additionalProperties: false,
                    },
                    Interpretation: {
                        type: 'object',
                        properties: {
                            searchIntent: { type: 'string' },
                            keywords: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['searchIntent', 'keywords'],
                        additionalProperties: false,
                    },
                    Pattern: {
                        type: 'object',
                        properties: {
                            searchIntent: { type: 'string' },
                            keywords: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['searchIntent', 'keywords'],
                        additionalProperties: false,
                    },
                    Insight: {
                        type: 'object',
                        properties: {
                            searchIntent: { type: 'string' },
                            keywords: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['searchIntent', 'keywords'],
                        additionalProperties: false,
                    },
                },
                required: ['Event', 'Interpretation', 'Pattern', 'Insight'],
                additionalProperties: false,
            },
        },
        required: ['intentType', 'queries'],
        additionalProperties: false,
    },
} as const;

/**
 * Compiles a user's question into table-specific search intents using an LLM.
 *
 * Step 1 of the retriever pipeline.
 *
 * @param question - The user's question
 * @param config - Retriever configuration
 * @returns Compiled queries for all 4 tables
 */
export async function compileSemanticQueries(
    question: string,
    config: RetrieverConfig
): Promise<CompiledQuery> {
    console.log(`[Retriever] Compiling semantic queries for: "${question.substring(0, 50)}..."`);

    // Call OpenAI with Structured Output - JSON schema guarantees valid response
    const response = await openai.chat.completions.create({
        model: config.llmModel,
        temperature: config.llmTemperature,
        response_format: {
            type: 'json_schema',
            json_schema: COMPILED_QUERY_JSON_SCHEMA,
        },
        messages: [
            {
                role: 'system',
                content: QUERY_COMPILATION_PROMPT.systemPrompt,
            },
            {
                role: 'user',
                content: getQueryCompilationUserPrompt(question),
            },
        ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
        throw new Error('[Retriever] LLM returned empty response for query compilation');
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let parsed: CompiledQuery;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        console.error('[Retriever] Failed to parse LLM response:', content);
        throw new Error(`[Retriever] LLM returned invalid JSON: ${e}`);
    }

    console.log(`[Retriever] Step 1 complete: compiled 4 table queries (intent: ${parsed.intentType})`);
    return parsed;
}
