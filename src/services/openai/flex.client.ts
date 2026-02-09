import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FLEX_MODEL = 'gpt-5-mini';
const FLEX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;

/**
 * OpenAI chat completion wrapper for background/async workers.
 *
 * - Forces gpt-5-mini with flex pricing tier (50% cheaper, higher latency)
 * - Retries up to 3 times with linear backoff (2s, 4s, 6s)
 * - 5-minute timeout per attempt to accommodate flex queue latency
 *
 * Do NOT use for user-facing realtime/chat endpoints.
 */
export async function flexCompletion(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            return await openai.chat.completions.create(
                { ...params, model: FLEX_MODEL, service_tier: 'flex' },
                { timeout: FLEX_TIMEOUT_MS }
            );
        } catch (err) {
            if (attempt === MAX_RETRIES - 1) throw err;
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
    }

    // Unreachable — final attempt rethrows above
    throw new Error('flexCompletion: exhausted retries');
}
