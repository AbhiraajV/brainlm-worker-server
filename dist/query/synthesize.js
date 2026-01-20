"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.answerQuery = answerQuery;
const openai_1 = require("../services/openai");
const retrieval_1 = require("./retrieval");
const prompts_1 = require("../prompts");
// Prompt is now centralized in src/prompts.ts via QUERY_SYNTHESIS_PROMPT
// ============================================================================
// Main Function
// ============================================================================
/**
 * Answers a user question using RAG - retrieve + synthesize.
 *
 * This is the main query interface that:
 * 1. Retrieves relevant context via semantic search
 * 2. Synthesizes an answer via LLM
 * 3. Returns answer with source attribution
 */
async function answerQuery(input) {
    const { userId, question, timeRange, contextLimit = 10 } = input;
    // 1. Retrieve relevant context
    const context = await (0, retrieval_1.retrieve)({
        userId,
        query: question,
        limit: contextLimit,
        timeRange,
    });
    // 2. Format context for LLM
    const formattedContext = formatContextForLLM(context);
    // 3. Synthesize answer
    const { modelConfig, systemPrompt } = prompts_1.QUERY_SYNTHESIS_PROMPT;
    const completion = await openai_1.openai.chat.completions.create({
        model: modelConfig.model,
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: `## USER QUESTION\n${question}\n\n${formattedContext}`,
            },
        ],
        temperature: modelConfig.temperature,
    });
    const answer = completion.choices[0]?.message?.content ?? 'Unable to generate answer.';
    return {
        answer,
        context: {
            interpretationsUsed: context.interpretations.length,
            patternsUsed: context.patterns.length,
        },
        sources: {
            eventIds: context.interpretations.map((i) => i.eventId),
            patternIds: context.patterns.map((p) => p.id),
        },
    };
}
// ============================================================================
// Helpers
// ============================================================================
function formatContextForLLM(context) {
    const parts = [];
    if (context.interpretations.length > 0) {
        parts.push('## RELEVANT EVENTS AND INTERPRETATIONS\n');
        for (const interp of context.interpretations) {
            parts.push(`### Event (${interp.eventOccurredAt.toISOString().split('T')[0]})`);
            parts.push(`Original: "${interp.eventContent}"`);
            parts.push(`Analysis:\n${interp.content}\n`);
        }
    }
    if (context.patterns.length > 0) {
        parts.push('## DETECTED PATTERNS\n');
        for (const pattern of context.patterns) {
            parts.push(`### Pattern (detected ${pattern.firstDetectedAt.toISOString().split('T')[0]}, ${pattern.supportingEventCount} events)`);
            parts.push(pattern.description);
            parts.push('');
        }
    }
    if (parts.length === 0) {
        return '## CONTEXT\nNo relevant events or patterns found in memory.';
    }
    return parts.join('\n');
}
