"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieve = retrieve;
const prisma_1 = __importDefault(require("../prisma"));
const embedding_1 = require("../services/embedding");
// ============================================================================
// Main Function
// ============================================================================
/**
 * Retrieves relevant interpretations and patterns based on semantic similarity.
 *
 * This is the core retrieval layer for RAG:
 * 1. Embeds the user's query
 * 2. Performs vector similarity search on interpretations
 * 3. Performs vector similarity search on patterns
 * 4. Returns ranked results for synthesis
 */
async function retrieve(input) {
    const { userId, query, limit = 10, timeRange } = input;
    // 1. Embed the query
    const queryEmbeddingResult = await (0, embedding_1.embedText)({ text: query });
    const queryEmbeddingStr = `[${queryEmbeddingResult.embedding.join(',')}]`;
    // 2. Build time range conditions
    const fromDate = timeRange?.from ?? new Date(0);
    const toDate = timeRange?.to ?? new Date();
    // 3. Retrieve similar interpretations via pgvector
    const interpretations = await prisma_1.default.$queryRaw `
    SELECT 
      i.id,
      i."eventId",
      i.content,
      1 - (i.embedding <=> ${queryEmbeddingStr}::vector) as similarity,
      i."createdAt",
      e.content as "eventContent",
      e."occurredAt" as "eventOccurredAt"
    FROM "Interpretation" i
    JOIN "Event" e ON e.id = i."eventId"
    WHERE i."userId" = ${userId}
      AND i.embedding IS NOT NULL
      AND e."occurredAt" >= ${fromDate}
      AND e."occurredAt" <= ${toDate}
    ORDER BY i.embedding <=> ${queryEmbeddingStr}::vector
    LIMIT ${limit}
  `;
    // 4. Retrieve similar patterns via pgvector
    const patterns = await prisma_1.default.$queryRaw `
    SELECT 
      p.id,
      p.description,
      1 - (p.embedding <=> ${queryEmbeddingStr}::vector) as similarity,
      p.status,
      p."firstDetectedAt",
      p."lastReinforcedAt",
      COUNT(pe.id) as "supportingEventCount"
    FROM "Pattern" p
    LEFT JOIN "PatternEvent" pe ON pe."patternId" = p.id
    WHERE p."userId" = ${userId}
      AND p.embedding IS NOT NULL
      AND p.status = 'ACTIVE'
    GROUP BY p.id
    ORDER BY p.embedding <=> ${queryEmbeddingStr}::vector
    LIMIT ${Math.ceil(limit / 2)}
  `;
    return {
        interpretations: interpretations.map((i) => ({
            ...i,
            similarity: Number(i.similarity),
        })),
        patterns: patterns.map((p) => ({
            ...p,
            similarity: Number(p.similarity),
            supportingEventCount: Number(p.supportingEventCount),
        })),
        queryEmbedding: queryEmbeddingResult.embedding,
    };
}
