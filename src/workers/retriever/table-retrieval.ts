import prisma from '../../prisma';
import { embedText } from '../../services/embedding';
import {
    AllTablesResult,
    BiasedLimits,
    CompiledQuery,
    RawEvent,
    RawInsight,
    RawInterpretation,
    RawPattern,
    RetrieverConfig,
    getBiasedLimits,
} from './schema';

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
export async function retrieveFromAllTables(
    userId: string,
    compiledQueries: CompiledQuery,
    config: RetrieverConfig,
    timeRange?: { from?: Date; to?: Date }
): Promise<AllTablesResult> {
    // Get biased limits based on intent type
    const limits = getBiasedLimits(compiledQueries.intentType, config);

    // Step 2: Generate 4 embeddings in parallel (one per table)
    console.log('[Retriever] Step 2: Generating embeddings for 4 tables...');
    const [eventEmbed, interpEmbed, patternEmbed, insightEmbed] = await Promise.all([
        embedText({ text: compiledQueries.queries.Event.searchIntent }),
        embedText({ text: compiledQueries.queries.Interpretation.searchIntent }),
        embedText({ text: compiledQueries.queries.Pattern.searchIntent }),
        embedText({ text: compiledQueries.queries.Insight.searchIntent }),
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

    console.log(
        `[Retriever] Steps 2-3 complete: retrieved ${events.length} events, ` +
        `${interpretations.length} interpretations, ${patterns.length} patterns, ` +
        `${insights.length} insights`
    );

    return { events, interpretations, patterns, insights };
}

/**
 * Retrieve events via pgvector similarity search.
 */
async function retrieveEvents(
    userId: string,
    embeddingStr: string,
    limit: number,
    fromDate: Date,
    toDate: Date
): Promise<RawEvent[]> {
    const results = await prisma.$queryRaw<
        Array<{
            id: string;
            content: string;
            occurredAt: Date;
            similarity: number;
        }>
    >`
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
async function retrieveInterpretations(
    userId: string,
    embeddingStr: string,
    limit: number,
    fromDate: Date,
    toDate: Date
): Promise<RawInterpretation[]> {
    const results = await prisma.$queryRaw<
        Array<{
            id: string;
            eventId: string;
            content: string;
            similarity: number;
            eventOccurredAt: Date;
        }>
    >`
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
async function retrievePatterns(
    userId: string,
    embeddingStr: string,
    limit: number
): Promise<RawPattern[]> {
    const results = await prisma.$queryRaw<
        Array<{
            id: string;
            description: string;
            status: string;
            firstDetectedAt: Date;
            lastReinforcedAt: Date;
            similarity: number;
        }>
    >`
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
async function retrieveInsights(
    userId: string,
    embeddingStr: string,
    limit: number
): Promise<RawInsight[]> {
    const results = await prisma.$queryRaw<
        Array<{
            id: string;
            statement: string;
            explanation: string;
            status: string;
            confidence: string;
            category: string | null;
            similarity: number;
            firstDetectedAt: Date;
        }>
    >`
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

/**
 * Get biased limits for retrieval based on intent type.
 * Re-exported for use in other modules.
 */
export { getBiasedLimits };
export type { BiasedLimits };
