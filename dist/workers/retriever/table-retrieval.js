"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBiasedLimits = void 0;
exports.retrieveFromAllTables = retrieveFromAllTables;
const prisma_1 = __importDefault(require("../../prisma"));
const embedding_1 = require("../../services/embedding");
const schema_1 = require("./schema");
Object.defineProperty(exports, "getBiasedLimits", { enumerable: true, get: function () { return schema_1.getBiasedLimits; } });
/**
 * Retrieves evidence from all 4 tables using table-specific embeddings.
 *
 * Steps 2-3 of the retriever pipeline:
 * - Step 2: Generate embeddings for each table's search intent
 * - Step 3: Execute parallel pgvector searches
 *
 * @param userId - User ID
 * @param compiledQueries - Compiled queries from step 1
 * @param config - Retriever configuration
 * @param timeRange - Optional time range filter
 * @returns Raw results from all tables
 */
async function retrieveFromAllTables(userId, compiledQueries, config, timeRange) {
    // Get biased limits based on intent type
    const limits = (0, schema_1.getBiasedLimits)(compiledQueries.intentType, config);
    // Step 2: Generate 4 embeddings in parallel (one per table)
    console.log('[Retriever] Step 2: Generating embeddings for 4 tables...');
    const [eventEmbed, interpEmbed, patternEmbed, insightEmbed] = await Promise.all([
        (0, embedding_1.embedText)({ text: compiledQueries.queries.Event.searchIntent }),
        (0, embedding_1.embedText)({ text: compiledQueries.queries.Interpretation.searchIntent }),
        (0, embedding_1.embedText)({ text: compiledQueries.queries.Pattern.searchIntent }),
        (0, embedding_1.embedText)({ text: compiledQueries.queries.Insight.searchIntent }),
    ]);
    // Convert embeddings to string format for pgvector
    const eventEmbedStr = `[${eventEmbed.embedding.join(',')}]`;
    const interpEmbedStr = `[${interpEmbed.embedding.join(',')}]`;
    const patternEmbedStr = `[${patternEmbed.embedding.join(',')}]`;
    const insightEmbedStr = `[${insightEmbed.embedding.join(',')}]`;
    // Time range defaults
    const fromDate = timeRange?.from ?? new Date(0);
    const toDate = timeRange?.to ?? new Date();
    // Step 3: Execute 4 pgvector searches in parallel
    console.log('[Retriever] Step 3: Retrieving from all tables in parallel...');
    const [events, interpretations, patterns, insights] = await Promise.all([
        retrieveEvents(userId, eventEmbedStr, limits.events, fromDate, toDate),
        retrieveInterpretations(userId, interpEmbedStr, limits.interpretations, fromDate, toDate),
        retrievePatterns(userId, patternEmbedStr, limits.patterns),
        retrieveInsights(userId, insightEmbedStr, limits.insights),
    ]);
    console.log(`[Retriever] Steps 2-3 complete: retrieved ${events.length} events, ` +
        `${interpretations.length} interpretations, ${patterns.length} patterns, ` +
        `${insights.length} insights`);
    return { events, interpretations, patterns, insights };
}
/**
 * Retrieve events via pgvector similarity search.
 */
async function retrieveEvents(userId, embeddingStr, limit, fromDate, toDate) {
    const results = await prisma_1.default.$queryRaw `
        SELECT
            id,
            content,
            "occurredAt",
            1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "Event"
        WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
            AND "occurredAt" >= ${fromDate}
            AND "occurredAt" <= ${toDate}
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
    `;
    return results.map(r => ({
        ...r,
        similarity: Number(r.similarity),
    }));
}
/**
 * Retrieve interpretations via pgvector similarity search.
 */
async function retrieveInterpretations(userId, embeddingStr, limit, fromDate, toDate) {
    const results = await prisma_1.default.$queryRaw `
        SELECT
            i.id,
            i."eventId",
            i.content,
            1 - (i.embedding <=> ${embeddingStr}::vector) as similarity,
            e."occurredAt" as "eventOccurredAt"
        FROM "Interpretation" i
        JOIN "Event" e ON e.id = i."eventId"
        WHERE i."userId" = ${userId}
            AND i.embedding IS NOT NULL
            AND e."occurredAt" >= ${fromDate}
            AND e."occurredAt" <= ${toDate}
        ORDER BY i.embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
    `;
    return results.map(r => ({
        ...r,
        similarity: Number(r.similarity),
    }));
}
/**
 * Retrieve active patterns via pgvector similarity search.
 */
async function retrievePatterns(userId, embeddingStr, limit) {
    const results = await prisma_1.default.$queryRaw `
        SELECT
            id,
            description,
            status,
            "firstDetectedAt",
            "lastReinforcedAt",
            1 - (embedding <=> ${embeddingStr}::vector) as similarity
        FROM "Pattern"
        WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
            AND status = 'ACTIVE'
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
    `;
    return results.map(r => ({
        ...r,
        similarity: Number(r.similarity),
    }));
}
/**
 * Retrieve non-superseded insights via pgvector similarity search.
 */
async function retrieveInsights(userId, embeddingStr, limit) {
    const results = await prisma_1.default.$queryRaw `
        SELECT
            id,
            statement,
            explanation,
            status,
            confidence,
            category,
            1 - (embedding <=> ${embeddingStr}::vector) as similarity,
            "firstDetectedAt"
        FROM "Insight"
        WHERE "userId" = ${userId}
            AND embedding IS NOT NULL
            AND status != 'SUPERSEDED'
        ORDER BY embedding <=> ${embeddingStr}::vector
        LIMIT ${limit}
    `;
    return results.map(r => ({
        ...r,
        similarity: Number(r.similarity),
    }));
}
