/**
 * Input for embedding text.
 */
export interface EmbedTextInput {
    text: string;
    model?: string; // default: "text-embedding-3-small"
}

/**
 * Result from embedding text.
 */
export interface EmbedTextResult {
    embedding: number[];
    model: string;
    dimensions: number;
    usage: {
        promptTokens: number;
        totalTokens: number;
    };
}

/**
 * Configuration for embedding service.
 */
export interface EmbeddingConfig {
    defaultModel: string;
    defaultDimensions: number;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
    defaultModel: 'text-embedding-3-small',
    defaultDimensions: 1536,
};
