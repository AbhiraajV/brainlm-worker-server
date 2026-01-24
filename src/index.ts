import express from 'express';
import prisma from './prisma';
import dotenv from 'dotenv';
import { startBackgroundJobs } from './jobs';
import { attachAuth, requireAuth } from './middleware/auth.middleware';
import { createEvent, searchEvents, getEventWithContext } from './memory';
import { retrieve, generateSubQuestions } from './workers/retriever';
import {
    generateReview,
    generateAllReviewsForDate,
    ReviewType,
    getPeriodKey,
    getPeriodBounds,
} from './workers/review';

dotenv.config();

const app = express();
app.use(express.json());

// Attach auth context to all requests (optional auth)
app.use(attachAuth);

app.get('/', (req, res) => {
    res.json({ message: 'API is running' });
});

app.get('/health', async (_req, res) => {
    const timestamp = new Date().toISOString();

    try {
        // Explicitly connect first (handles cold Prisma client)
        await prisma.$connect();
        // Then verify with lightweight query
        await prisma.$queryRaw`SELECT 1`;

        res.status(200).json({
            status: 'ok',
            db: 'connected',
            timestamp,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({
            status: 'error',
            db: 'disconnected',
            error: message,
            timestamp,
        });
    }
});

app.get('/users', async (req, res) => {
    try {
        const users = await prisma.user.findMany();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Example protected route - uses req.auth.user
app.get('/me', requireAuth, (req, res) => {
    // req.auth is guaranteed to exist and have user after requireAuth
    res.json({ user: req.auth!.user });
});

// POST /memory - Create a new event
app.post('/memory', requireAuth, async (req, res) => {
    const { content, occurredAt } = req.body;

    // Validate required fields
    if (!content || typeof content !== 'string' || content.trim() === '') {
        res.status(400).json({ error: 'content is required' });
        return;
    }

    if (!occurredAt || typeof occurredAt !== 'string') {
        res.status(400).json({ error: 'occurredAt is required' });
        return;
    }

    const parsedDate = new Date(occurredAt);
    if (isNaN(parsedDate.getTime())) {
        res.status(400).json({ error: 'occurredAt must be valid ISO date' });
        return;
    }

    try {
        const result = await createEvent({
            userId: req.auth!.user!.id,
            content: content.trim(),
            occurredAt: parsedDate,
        });

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// GET /memory - Search events with full context
// Query params: q (search query), limit, offset, startDate, endDate
app.get('/memory', requireAuth, async (req, res) => {
    const {
        q,
        limit = '20',
        offset = '0',
        startDate,
        endDate,
    } = req.query;

    try {
        const result = await searchEvents({
            userId: req.auth!.user!.id,
            query: q as string | undefined,
            limit: Math.min(parseInt(limit as string, 10) || 20, 100),
            offset: parseInt(offset as string, 10) || 0,
            startDate: startDate ? new Date(startDate as string) : undefined,
            endDate: endDate ? new Date(endDate as string) : undefined,
        });

        res.status(200).json(result);
    } catch (error) {
        console.error('[GET /memory] Error:', error);
        res.status(500).json({ error: 'Failed to search events' });
    }
});

// GET /memory/:id - Get single event with full context
app.get('/memory/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await getEventWithContext(id, req.auth!.user!.id);

        if (!result) {
            res.status(404).json({ error: 'Event not found' });
            return;
        }

        res.status(200).json(result);
    } catch (error) {
        console.error('[GET /memory/:id] Error:', error);
        res.status(500).json({ error: 'Failed to get event' });
    }
});

// POST /retrieve - Retrieve context for a question
// Body: { mainQuestion, generateSubQuestions?, context?, maxSubQuestions?, subQuestions?, timeRange? }
app.post('/retrieve', requireAuth, async (req, res) => {
    const {
        mainQuestion,
        generateSubQuestions: shouldGenerateSubQuestions,
        context,
        maxSubQuestions,
        subQuestions: providedSubQuestions,
        timeRange,
    } = req.body;

    // Validate mainQuestion
    if (!mainQuestion || typeof mainQuestion !== 'string' || mainQuestion.trim() === '') {
        res.status(400).json({ error: 'mainQuestion is required' });
        return;
    }

    // Validate: if generateSubQuestions is true, context is required
    if (shouldGenerateSubQuestions === true) {
        if (!context || typeof context !== 'string' || context.trim() === '') {
            res.status(400).json({
                error: 'context is required when generateSubQuestions is true',
            });
            return;
        }
    }

    try {
        let subQuestions: string[] | undefined = providedSubQuestions;

        // Generate sub-questions if requested
        if (shouldGenerateSubQuestions === true) {
            const generated = await generateSubQuestions({
                mainQuestion: mainQuestion.trim(),
                context: context.trim(),
                maxSubQuestions: maxSubQuestions ?? 5,
            });
            subQuestions = generated.subQuestions;
        }

        // Parse timeRange if provided
        let parsedTimeRange: { from?: Date; to?: Date } | undefined;
        if (timeRange) {
            parsedTimeRange = {
                from: timeRange.from ? new Date(timeRange.from) : undefined,
                to: timeRange.to ? new Date(timeRange.to) : undefined,
            };
        }

        // Execute retrieval
        const result = await retrieve({
            userId: req.auth!.user!.id,
            mainQuestion: mainQuestion.trim(),
            subQuestions,
            timeRange: parsedTimeRange,
        });

        res.status(200).json({
            ...result,
            subQuestionsGenerated: shouldGenerateSubQuestions === true,
            subQuestions,
        });
    } catch (error) {
        console.error('[POST /retrieve] Error:', error);
        res.status(500).json({ error: 'Failed to retrieve context' });
    }
});

// ============================================================================
// Review Endpoints
// ============================================================================

// GET /reviews - List reviews with optional filters
app.get('/reviews', requireAuth, async (req, res) => {
    const {
        type,
        startDate,
        endDate,
        limit = '20',
        offset = '0',
    } = req.query;

    try {
        const where: {
            userId: string;
            type?: ReviewType;
            periodStart?: { gte?: Date; lte?: Date };
        } = {
            userId: req.auth!.user!.id,
        };

        if (type && typeof type === 'string') {
            const upperType = type.toUpperCase();
            if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(upperType)) {
                res.status(400).json({ error: 'type must be DAILY, WEEKLY, or MONTHLY' });
                return;
            }
            where.type = upperType as ReviewType;
        }

        if (startDate || endDate) {
            where.periodStart = {};
            if (startDate) {
                where.periodStart.gte = new Date(startDate as string);
            }
            if (endDate) {
                where.periodStart.lte = new Date(endDate as string);
            }
        }

        const reviews = await prisma.review.findMany({
            where,
            orderBy: { periodStart: 'desc' },
            take: Math.min(parseInt(limit as string, 10) || 20, 100),
            skip: parseInt(offset as string, 10) || 0,
            select: {
                id: true,
                type: true,
                periodKey: true,
                periodStart: true,
                periodEnd: true,
                summary: true,
                createdAt: true,
            },
        });

        const total = await prisma.review.count({ where });

        res.status(200).json({
            reviews,
            total,
            limit: parseInt(limit as string, 10) || 20,
            offset: parseInt(offset as string, 10) || 0,
        });
    } catch (error) {
        console.error('[GET /reviews] Error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// GET /reviews/latest - Get most recent review of each type
app.get('/reviews/latest', requireAuth, async (req, res) => {
    try {
        const userId = req.auth!.user!.id;

        const [daily, weekly, monthly] = await Promise.all([
            prisma.review.findFirst({
                where: { userId, type: 'DAILY' },
                orderBy: { periodStart: 'desc' },
            }),
            prisma.review.findFirst({
                where: { userId, type: 'WEEKLY' },
                orderBy: { periodStart: 'desc' },
            }),
            prisma.review.findFirst({
                where: { userId, type: 'MONTHLY' },
                orderBy: { periodStart: 'desc' },
            }),
        ]);

        res.status(200).json({
            daily: daily || null,
            weekly: weekly || null,
            monthly: monthly || null,
        });
    } catch (error) {
        console.error('[GET /reviews/latest] Error:', error);
        res.status(500).json({ error: 'Failed to fetch latest reviews' });
    }
});

// GET /reviews/:id - Get single review by ID
app.get('/reviews/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const review = await prisma.review.findUnique({
            where: { id },
        });

        if (!review) {
            res.status(404).json({ error: 'Review not found' });
            return;
        }

        // Verify ownership
        if (review.userId !== req.auth!.user!.id) {
            res.status(404).json({ error: 'Review not found' });
            return;
        }

        res.status(200).json(review);
    } catch (error) {
        console.error('[GET /reviews/:id] Error:', error);
        res.status(500).json({ error: 'Failed to fetch review' });
    }
});

// POST /reviews/generate - Manually trigger review generation
app.post('/reviews/generate', requireAuth, async (req, res) => {
    const { type, targetDate, force } = req.body;

    // Validate type
    if (!type || typeof type !== 'string') {
        res.status(400).json({ error: 'type is required (DAILY, WEEKLY, or MONTHLY)' });
        return;
    }

    const upperType = type.toUpperCase();
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(upperType)) {
        res.status(400).json({ error: 'type must be DAILY, WEEKLY, or MONTHLY' });
        return;
    }

    // Parse target date (default to yesterday)
    let parsedDate: Date;
    if (targetDate) {
        parsedDate = new Date(targetDate);
        if (isNaN(parsedDate.getTime())) {
            res.status(400).json({ error: 'targetDate must be a valid ISO date' });
            return;
        }
    } else {
        parsedDate = new Date();
        parsedDate.setUTCDate(parsedDate.getUTCDate() - 1);
    }
    parsedDate.setUTCHours(12, 0, 0, 0); // Normalize to noon UTC

    try {
        const result = await generateReview({
            userId: req.auth!.user!.id,
            reviewType: upperType as ReviewType,
            targetDate: parsedDate,
            force: force === true,
        });

        if (result.skipped) {
            res.status(200).json({
                message: result.skipReason,
                skipped: true,
                periodKey: result.periodKey,
            });
            return;
        }

        if (!result.success) {
            res.status(500).json({
                error: result.error || 'Review generation failed',
                periodKey: result.periodKey,
            });
            return;
        }

        // Fetch the created review
        const review = await prisma.review.findUnique({
            where: { id: result.reviewId },
        });

        res.status(201).json(review);
    } catch (error) {
        console.error('[POST /reviews/generate] Error:', error);
        res.status(500).json({ error: 'Failed to generate review' });
    }
});

// POST /reviews/generate-all - Generate all applicable reviews for a date
app.post('/reviews/generate-all', requireAuth, async (req, res) => {
    const { targetDate } = req.body;

    // Parse target date (default to yesterday)
    let parsedDate: Date;
    if (targetDate) {
        parsedDate = new Date(targetDate);
        if (isNaN(parsedDate.getTime())) {
            res.status(400).json({ error: 'targetDate must be a valid ISO date' });
            return;
        }
    } else {
        parsedDate = new Date();
        parsedDate.setUTCDate(parsedDate.getUTCDate() - 1);
    }
    parsedDate.setUTCHours(12, 0, 0, 0); // Normalize to noon UTC

    try {
        const results = await generateAllReviewsForDate(
            req.auth!.user!.id,
            parsedDate
        );

        res.status(200).json({
            results,
            summary: {
                generated: results.filter((r) => r.success && !r.skipped).length,
                skipped: results.filter((r) => r.skipped).length,
                failed: results.filter((r) => !r.success && !r.skipped).length,
            },
        });
    } catch (error) {
        console.error('[POST /reviews/generate-all] Error:', error);
        res.status(500).json({ error: 'Failed to generate reviews' });
    }
});

// API layer disabled - server runs as worker-only process
// To re-enable APIs, uncomment the app.listen block below
//
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server running on http://localhost:${PORT}`);
//     startBackgroundJobs();
// });

// Start worker + cron only (no HTTP server)
startBackgroundJobs();

// Graceful shutdown
process.on('SIGTERM', async () => {
    const { stopBackgroundJobs } = await import('./jobs');
    await stopBackgroundJobs();
    process.exit(0);
});
