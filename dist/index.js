"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const prisma_1 = __importDefault(require("./prisma"));
const dotenv_1 = __importDefault(require("dotenv"));
const jobs_1 = require("./jobs");
const auth_middleware_1 = require("./middleware/auth.middleware");
const memory_1 = require("./memory");
const retriever_1 = require("./workers/retriever");
const review_1 = require("./workers/review");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Attach auth context to all requests (optional auth)
app.use(auth_middleware_1.attachAuth);
app.get('/', (req, res) => {
    res.json({ message: 'API is running' });
});
app.get('/health', async (_req, res) => {
    const timestamp = new Date().toISOString();
    try {
        // Explicitly connect first (handles cold Prisma client)
        await prisma_1.default.$connect();
        // Then verify with lightweight query
        await prisma_1.default.$queryRaw `SELECT 1`;
        res.status(200).json({
            status: 'ok',
            db: 'connected',
            timestamp,
        });
    }
    catch (error) {
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
        const users = await prisma_1.default.user.findMany();
        res.json(users);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});
// Example protected route - uses req.auth.user
app.get('/me', auth_middleware_1.requireAuth, (req, res) => {
    // req.auth is guaranteed to exist and have user after requireAuth
    res.json({ user: req.auth.user });
});
// POST /memory - Create a new event
app.post('/memory', auth_middleware_1.requireAuth, async (req, res) => {
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
        const result = await (0, memory_1.createEvent)({
            userId: req.auth.user.id,
            content: content.trim(),
            occurredAt: parsedDate,
        });
        res.status(200).json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create event' });
    }
});
// GET /memory - Search events with full context
// Query params: q (search query), limit, offset, startDate, endDate
app.get('/memory', auth_middleware_1.requireAuth, async (req, res) => {
    const { q, limit = '20', offset = '0', startDate, endDate, } = req.query;
    try {
        const result = await (0, memory_1.searchEvents)({
            userId: req.auth.user.id,
            query: q,
            limit: Math.min(parseInt(limit, 10) || 20, 100),
            offset: parseInt(offset, 10) || 0,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
        });
        res.status(200).json(result);
    }
    catch (error) {
        console.error('[GET /memory] Error:', error);
        res.status(500).json({ error: 'Failed to search events' });
    }
});
// GET /memory/:id - Get single event with full context
app.get('/memory/:id', auth_middleware_1.requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await (0, memory_1.getEventWithContext)(id, req.auth.user.id);
        if (!result) {
            res.status(404).json({ error: 'Event not found' });
            return;
        }
        res.status(200).json(result);
    }
    catch (error) {
        console.error('[GET /memory/:id] Error:', error);
        res.status(500).json({ error: 'Failed to get event' });
    }
});
// POST /retrieve - Retrieve context for a question
// Body: { mainQuestion, generateSubQuestions?, context?, maxSubQuestions?, subQuestions?, timeRange? }
app.post('/retrieve', auth_middleware_1.requireAuth, async (req, res) => {
    const { mainQuestion, generateSubQuestions: shouldGenerateSubQuestions, context, maxSubQuestions, subQuestions: providedSubQuestions, timeRange, } = req.body;
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
        let subQuestions = providedSubQuestions;
        // Generate sub-questions if requested
        if (shouldGenerateSubQuestions === true) {
            const generated = await (0, retriever_1.generateSubQuestions)({
                mainQuestion: mainQuestion.trim(),
                context: context.trim(),
                maxSubQuestions: maxSubQuestions ?? 5,
            });
            subQuestions = generated.subQuestions;
        }
        // Parse timeRange if provided
        let parsedTimeRange;
        if (timeRange) {
            parsedTimeRange = {
                from: timeRange.from ? new Date(timeRange.from) : undefined,
                to: timeRange.to ? new Date(timeRange.to) : undefined,
            };
        }
        // Execute retrieval
        const result = await (0, retriever_1.retrieve)({
            userId: req.auth.user.id,
            mainQuestion: mainQuestion.trim(),
            subQuestions,
            timeRange: parsedTimeRange,
        });
        res.status(200).json({
            ...result,
            subQuestionsGenerated: shouldGenerateSubQuestions === true,
            subQuestions,
        });
    }
    catch (error) {
        console.error('[POST /retrieve] Error:', error);
        res.status(500).json({ error: 'Failed to retrieve context' });
    }
});
// ============================================================================
// Review Endpoints
// ============================================================================
// GET /reviews - List reviews with optional filters
app.get('/reviews', auth_middleware_1.requireAuth, async (req, res) => {
    const { type, startDate, endDate, limit = '20', offset = '0', } = req.query;
    try {
        const where = {
            userId: req.auth.user.id,
        };
        if (type && typeof type === 'string') {
            const upperType = type.toUpperCase();
            if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(upperType)) {
                res.status(400).json({ error: 'type must be DAILY, WEEKLY, or MONTHLY' });
                return;
            }
            where.type = upperType;
        }
        if (startDate || endDate) {
            where.periodStart = {};
            if (startDate) {
                where.periodStart.gte = new Date(startDate);
            }
            if (endDate) {
                where.periodStart.lte = new Date(endDate);
            }
        }
        const reviews = await prisma_1.default.review.findMany({
            where,
            orderBy: { periodStart: 'desc' },
            take: Math.min(parseInt(limit, 10) || 20, 100),
            skip: parseInt(offset, 10) || 0,
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
        const total = await prisma_1.default.review.count({ where });
        res.status(200).json({
            reviews,
            total,
            limit: parseInt(limit, 10) || 20,
            offset: parseInt(offset, 10) || 0,
        });
    }
    catch (error) {
        console.error('[GET /reviews] Error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});
// GET /reviews/latest - Get most recent review of each type
app.get('/reviews/latest', auth_middleware_1.requireAuth, async (req, res) => {
    try {
        const userId = req.auth.user.id;
        const [daily, weekly, monthly] = await Promise.all([
            prisma_1.default.review.findFirst({
                where: { userId, type: 'DAILY' },
                orderBy: { periodStart: 'desc' },
            }),
            prisma_1.default.review.findFirst({
                where: { userId, type: 'WEEKLY' },
                orderBy: { periodStart: 'desc' },
            }),
            prisma_1.default.review.findFirst({
                where: { userId, type: 'MONTHLY' },
                orderBy: { periodStart: 'desc' },
            }),
        ]);
        res.status(200).json({
            daily: daily || null,
            weekly: weekly || null,
            monthly: monthly || null,
        });
    }
    catch (error) {
        console.error('[GET /reviews/latest] Error:', error);
        res.status(500).json({ error: 'Failed to fetch latest reviews' });
    }
});
// GET /reviews/:id - Get single review by ID
app.get('/reviews/:id', auth_middleware_1.requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const review = await prisma_1.default.review.findUnique({
            where: { id },
        });
        if (!review) {
            res.status(404).json({ error: 'Review not found' });
            return;
        }
        // Verify ownership
        if (review.userId !== req.auth.user.id) {
            res.status(404).json({ error: 'Review not found' });
            return;
        }
        res.status(200).json(review);
    }
    catch (error) {
        console.error('[GET /reviews/:id] Error:', error);
        res.status(500).json({ error: 'Failed to fetch review' });
    }
});
// POST /reviews/generate - Manually trigger review generation
app.post('/reviews/generate', auth_middleware_1.requireAuth, async (req, res) => {
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
    let parsedDate;
    if (targetDate) {
        parsedDate = new Date(targetDate);
        if (isNaN(parsedDate.getTime())) {
            res.status(400).json({ error: 'targetDate must be a valid ISO date' });
            return;
        }
    }
    else {
        parsedDate = new Date();
        parsedDate.setUTCDate(parsedDate.getUTCDate() - 1);
    }
    parsedDate.setUTCHours(12, 0, 0, 0); // Normalize to noon UTC
    try {
        const result = await (0, review_1.generateReview)({
            userId: req.auth.user.id,
            reviewType: upperType,
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
        const review = await prisma_1.default.review.findUnique({
            where: { id: result.reviewId },
        });
        res.status(201).json(review);
    }
    catch (error) {
        console.error('[POST /reviews/generate] Error:', error);
        res.status(500).json({ error: 'Failed to generate review' });
    }
});
// POST /reviews/generate-all - Generate all applicable reviews for a date
app.post('/reviews/generate-all', auth_middleware_1.requireAuth, async (req, res) => {
    const { targetDate } = req.body;
    // Parse target date (default to yesterday)
    let parsedDate;
    if (targetDate) {
        parsedDate = new Date(targetDate);
        if (isNaN(parsedDate.getTime())) {
            res.status(400).json({ error: 'targetDate must be a valid ISO date' });
            return;
        }
    }
    else {
        parsedDate = new Date();
        parsedDate.setUTCDate(parsedDate.getUTCDate() - 1);
    }
    parsedDate.setUTCHours(12, 0, 0, 0); // Normalize to noon UTC
    try {
        const results = await (0, review_1.generateAllReviewsForDate)(req.auth.user.id, parsedDate);
        res.status(200).json({
            results,
            summary: {
                generated: results.filter((r) => r.success && !r.skipped).length,
                skipped: results.filter((r) => r.skipped).length,
                failed: results.filter((r) => !r.success && !r.skipped).length,
            },
        });
    }
    catch (error) {
        console.error('[POST /reviews/generate-all] Error:', error);
        res.status(500).json({ error: 'Failed to generate reviews' });
    }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    (0, jobs_1.startBackgroundJobs)();
});
