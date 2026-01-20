import { openai } from '../../services/openai';
import {
    CompiledQuery,
    CompiledQuerySchema,
    IntentType,
    RetrieverConfig,
} from './schema';
import { getQueryCompilationUserPrompt } from './prompt';
import { QUERY_COMPILATION_PROMPT } from '../../prompts';

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

    const response = await openai.chat.completions.create({
        model: config.llmModel,
        temperature: config.llmTemperature,
        response_format: { type: 'json_object' },
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

    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        console.error('[Retriever] Failed to parse LLM response:', content);
        throw new Error(`[Retriever] LLM returned invalid JSON: ${e}`);
    }

    // Validate with Zod schema
    const result = CompiledQuerySchema.safeParse(parsed);
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
function createFallbackQuery(question: string): CompiledQuery {
    console.warn('[Retriever] Using fallback query compilation');

    return {
        intentType: IntentType.EXPLORATORY,
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
