"use strict";
/**
 * Retriever User Prompt Formatters
 *
 * System prompts are now centralized in src/prompts.ts
 * (QUERY_COMPILATION_PROMPT, SUB_QUESTION_GENERATION_PROMPT)
 *
 * This file contains only the user prompt formatting logic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getQueryCompilationUserPrompt = getQueryCompilationUserPrompt;
exports.getSubQuestionGenerationUserPrompt = getSubQuestionGenerationUserPrompt;
/**
 * User prompt template for query compilation.
 */
function getQueryCompilationUserPrompt(question) {
    return `Translate this question into table-specific search intents:

"${question}"

Respond with valid JSON only.`;
}
/**
 * User prompt template for sub-question generation.
 */
function getSubQuestionGenerationUserPrompt(mainQuestion, context, maxSubQuestions) {
    return `Generate sub-questions for the following:

**Main Question**: "${mainQuestion}"

**Context**:
${context}

**Maximum sub-questions**: ${maxSubQuestions}

Respond with valid JSON only.`;
}
