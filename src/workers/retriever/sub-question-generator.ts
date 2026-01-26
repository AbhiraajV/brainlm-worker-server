import { openai } from '../../services/openai';
import {
    GenerateSubQuestionsInput,
    GenerateSubQuestionsResult,
} from './schema';
import { getSubQuestionGenerationUserPrompt } from './prompt';
import { SUB_QUESTION_GENERATION_PROMPT } from '../../prompts';

// ============================================================================
// JSON Schema for Structured Output
// ============================================================================

// OpenAI Structured Output guarantees this schema - no Zod validation needed
const SUB_QUESTIONS_JSON_SCHEMA = {
    name: 'sub_questions_output',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            subQuestions: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of sub-questions derived from the main question',
            },
            reasoning: {
                type: ['string', 'null'],
                description: 'Brief explanation of why these sub-questions were chosen',
            },
        },
        required: ['subQuestions', 'reasoning'],
        additionalProperties: false,
    },
} as const;

/**
 * Default values for sub-question generation.
 * Model config is now in SUB_QUESTION_GENERATION_PROMPT but can be overridden via input.
 */
const DEFAULT_MAX_SUB_QUESTIONS = 5;

/**
 * Generates sub-questions from a main question and context using an LLM.
 *
 * Use this when you have rich context (e.g., conversation history, user profile)
 * and want to decompose the main question into more specific sub-questions
 * for better retrieval coverage.
 *
 * @param input - The input containing main question, context, and optional settings
 * @returns Generated sub-questions and optional reasoning
 *
 * @example
 * ```typescript
 * const result = await generateSubQuestions({
 *     mainQuestion: 'How can I improve my sleep?',
 *     context: `User has mentioned insomnia multiple times.
 *               Works late shifts. Has tried melatonin.`,
 *     maxSubQuestions: 4,
 * });
 * console.log(result.subQuestions);
 * // ['What time does the user typically go to bed...', ...]
 * ```
 */
export async function generateSubQuestions(
    input: GenerateSubQuestionsInput
): Promise<GenerateSubQuestionsResult> {
    const { modelConfig, systemPrompt } = SUB_QUESTION_GENERATION_PROMPT;
    const {
        mainQuestion,
        context,
        maxSubQuestions = DEFAULT_MAX_SUB_QUESTIONS,
        llmModel = modelConfig.model,
    } = input;

    console.log(
        `[Retriever] Generating sub-questions for: "${mainQuestion.substring(0, 50)}..." ` +
            `(max: ${maxSubQuestions}, model: ${llmModel})`
    );

    // Call OpenAI with Structured Output - JSON schema guarantees valid response
    const response = await openai.chat.completions.create({
        model: llmModel,
        temperature: modelConfig.temperature,
        response_format: {
            type: 'json_schema',
            json_schema: SUB_QUESTIONS_JSON_SCHEMA,
        },
        messages: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: getSubQuestionGenerationUserPrompt(mainQuestion, context, maxSubQuestions),
            },
        ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
        throw new Error('[Retriever] LLM returned empty response for sub-question generation');
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let parsed: { subQuestions: string[]; reasoning: string | null };
    try {
        parsed = JSON.parse(content);
    } catch (e) {
        console.error('[Retriever] Failed to parse LLM response:', content);
        throw new Error(`[Retriever] LLM returned invalid JSON: ${e}`);
    }

    // Enforce maxSubQuestions limit
    const subQuestions = parsed.subQuestions.slice(0, maxSubQuestions);

    console.log(
        `[Retriever] Generated ${subQuestions.length} sub-questions` +
            (parsed.reasoning ? ` (reasoning: ${parsed.reasoning.substring(0, 50)}...)` : '')
    );

    return {
        subQuestions,
        reasoning: parsed.reasoning ?? undefined,
    };
}
