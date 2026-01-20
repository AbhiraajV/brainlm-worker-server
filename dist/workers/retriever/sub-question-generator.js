"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSubQuestions = generateSubQuestions;
const openai_1 = require("../../services/openai");
const schema_1 = require("./schema");
const prompt_1 = require("./prompt");
const prompts_1 = require("../../prompts");
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
async function generateSubQuestions(input) {
    const { modelConfig, systemPrompt } = prompts_1.SUB_QUESTION_GENERATION_PROMPT;
    const { mainQuestion, context, maxSubQuestions = DEFAULT_MAX_SUB_QUESTIONS, llmModel = modelConfig.model, } = input;
    console.log(`[Retriever] Generating sub-questions for: "${mainQuestion.substring(0, 50)}..." ` +
        `(max: ${maxSubQuestions}, model: ${llmModel})`);
    const response = await openai_1.openai.chat.completions.create({
        model: llmModel,
        temperature: modelConfig.temperature,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: systemPrompt,
            },
            {
                role: 'user',
                content: (0, prompt_1.getSubQuestionGenerationUserPrompt)(mainQuestion, context, maxSubQuestions),
            },
        ],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) {
        throw new Error('[Retriever] LLM returned empty response for sub-question generation');
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
    const result = schema_1.SubQuestionsOutputSchema.safeParse(parsed);
    if (!result.success) {
        console.error('[Retriever] Schema validation failed:', result.error.issues);
        console.error('[Retriever] Raw response:', content);
        // Return fallback with main question as the only sub-question
        return createFallbackResult(mainQuestion);
    }
    // Enforce maxSubQuestions limit
    const subQuestions = result.data.subQuestions.slice(0, maxSubQuestions);
    console.log(`[Retriever] Generated ${subQuestions.length} sub-questions` +
        (result.data.reasoning ? ` (reasoning: ${result.data.reasoning.substring(0, 50)}...)` : ''));
    return {
        subQuestions,
        reasoning: result.data.reasoning,
    };
}
/**
 * Creates a fallback result when LLM response is invalid.
 * Returns the main question as the only sub-question.
 */
function createFallbackResult(mainQuestion) {
    console.warn('[Retriever] Using fallback sub-question generation');
    return {
        subQuestions: [mainQuestion],
        reasoning: 'Fallback: LLM response was invalid, using main question directly',
    };
}
