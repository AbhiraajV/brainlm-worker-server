import OpenAI from 'openai';

/**
 * Singleton OpenAI client instance.
 * Avoids repeated instantiation across the codebase.
 */
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export default openai;
