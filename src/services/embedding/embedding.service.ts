import { openai } from '../openai';
import {
    EmbedTextInput,
    EmbedTextResult,
    DEFAULT_EMBEDDING_CONFIG,
} from './types';

/**
 * Generates an embedding vector for the given text.
 * 
 * This is the central embedding service used by:
 * - Interpretation worker (embed rich interpretations)
 * - Pattern worker (embed pattern descriptions)
 * - Query layer (embed user queries for retrieval)
 * 
 * @param input - The text to embed and optional model override
 * @returns The embedding vector with metadata
 */
export async function embedText(input: EmbedTextInput): Promise<EmbedTextResult> {
    const model = input.model ?? DEFAULT_EMBEDDING_CONFIG.defaultModel;

    const response = await openai.embeddings.create({
        model,
        input: input.text,
        dimensions: DEFAULT_EMBEDDING_CONFIG.defaultDimensions,
    });

    const embeddingData = response.data[0];

    return {
        embedding: embeddingData.embedding,
        model: response.model,
        dimensions: embeddingData.embedding.length,
        usage: {
            promptTokens: response.usage.prompt_tokens,
            totalTokens: response.usage.total_tokens,
        },
    };
}

/**
 * Computes cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
}
