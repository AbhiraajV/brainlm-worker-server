import prisma from '../../prisma';
import { differenceInDays, subDays } from 'date-fns';

// ============================================================================
// Types
// ============================================================================

export interface UOMSuggestionContext {
  user: {
    id: string;
    name: string | null;
    baseline: string | null;
    lastBaselineUpdate: Date | null;
    baselineStaleDays: number | null;
    isInCooldown: boolean; // True if baseline updated in last 7 days
  };
  dailyPlan: {
    id: string;
    targetDate: Date;
    focusAreas: unknown;
    renderedMarkdown: string;
  };
  patterns: Array<{
    id: string;
    description: string;
    status: string;
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
    daysSinceFirstDetected: number;
    daysSinceLastReinforced: number;
    eventCount: number;
    isDormant: boolean;
    dormantDays: number | null;
  }>;
  insights: Array<{
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    status: string;
    category: string | null;
  }>;
  recentReviews: Array<{
    id: string;
    type: string;
    periodKey: string;
    summary: string;
    createdAt: Date;
  }>;
  pastSuggestions: Array<{
    id: string;
    suggestion: string;
    driftType: string;
    status: string;
    createdAt: Date;
  }>;
  stats: {
    totalPatterns: number;
    activePatterns: number;
    dormantPatterns: number;
    confirmedInsights: number;
    likelyInsights: number;
  };
}

// ============================================================================
// Configuration
// ============================================================================

const COOLDOWN_DAYS = 7; // Don't suggest if baseline updated within this period
const INSIGHTS_LOOKBACK_DAYS = 30;
const REVIEWS_LOOKBACK_DAYS = 30;
const PAST_SUGGESTIONS_LOOKBACK_DAYS = 60;
const MAX_PATTERNS = 20;
const MAX_INSIGHTS = 15;
const MAX_REVIEWS = 10;
const MAX_PAST_SUGGESTIONS = 10;

// ============================================================================
// Main Retrieval Function
// ============================================================================

export async function retrieveUOMSuggestionContext(
  userId: string,
  dailyPlanId: string
): Promise<UOMSuggestionContext | null> {
  const now = new Date();
  const insightsLookback = subDays(now, INSIGHTS_LOOKBACK_DAYS);
  const reviewsLookback = subDays(now, REVIEWS_LOOKBACK_DAYS);
  const suggestionsLookback = subDays(now, PAST_SUGGESTIONS_LOOKBACK_DAYS);

  // Parallel fetch
  const [user, dailyPlan, patterns, insights, recentReviews, pastSuggestions, stats] = await Promise.all([
    // User with baseline
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        baseline: true,
        lastBaselineUpdate: true,
      },
    }),

    // The daily plan that triggered this
    prisma.dailyPlan.findUnique({
      where: { id: dailyPlanId },
      select: {
        id: true,
        targetDate: true,
        focusAreas: true,
        renderedMarkdown: true,
      },
    }),

    // Active AND Dormant patterns with event counts
    // Dormant patterns needed for REMOVAL suggestions (baseline says X but pattern dormant 30+ days)
    prisma.pattern.findMany({
      where: {
        userId,
        status: { in: ['ACTIVE', 'DORMANT'] },
      },
      select: {
        id: true,
        description: true,
        status: true,
        firstDetectedAt: true,
        lastReinforcedAt: true,
        _count: {
          select: { patternEvents: true },
        },
      },
      orderBy: { lastReinforcedAt: 'desc' },
      take: MAX_PATTERNS,
    }),

    // High-confidence insights from last 30 days
    prisma.insight.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'LIKELY'] },
        createdAt: { gte: insightsLookback },
      },
      select: {
        id: true,
        statement: true,
        explanation: true,
        confidence: true,
        status: true,
        category: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_INSIGHTS,
    }),

    // Recent reviews
    prisma.review.findMany({
      where: {
        userId,
        createdAt: { gte: reviewsLookback },
      },
      select: {
        id: true,
        type: true,
        periodKey: true,
        summary: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_REVIEWS,
    }),

    // Past UOM suggestions (to avoid duplicates)
    prisma.uOMUpdateSuggestion.findMany({
      where: {
        userId,
        createdAt: { gte: suggestionsLookback },
      },
      select: {
        id: true,
        suggestion: true,
        driftType: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_PAST_SUGGESTIONS,
    }),

    // Aggregate stats
    Promise.all([
      prisma.pattern.count({ where: { userId } }),
      prisma.pattern.count({ where: { userId, status: 'ACTIVE' } }),
      prisma.pattern.count({ where: { userId, status: 'DORMANT' } }),
      prisma.insight.count({ where: { userId, status: 'CONFIRMED' } }),
      prisma.insight.count({ where: { userId, status: 'LIKELY' } }),
    ]),
  ]);

  if (!user || !dailyPlan) {
    return null;
  }

  // Calculate baseline staleness and cooldown
  let baselineStaleDays: number | null = null;
  let isInCooldown = false;

  if (user.lastBaselineUpdate) {
    baselineStaleDays = differenceInDays(now, user.lastBaselineUpdate);
    isInCooldown = baselineStaleDays < COOLDOWN_DAYS;
  } else if (user.baseline) {
    // Baseline exists but no update date - assume very stale
    baselineStaleDays = 90;
    isInCooldown = false;
  }

  // Format patterns with computed fields
  const formattedPatterns = patterns.map(p => {
    const daysSinceLastReinforced = differenceInDays(now, p.lastReinforcedAt);
    const isDormant = p.status === 'DORMANT';

    return {
      id: p.id,
      description: p.description,
      status: p.status,
      firstDetectedAt: p.firstDetectedAt,
      lastReinforcedAt: p.lastReinforcedAt,
      daysSinceFirstDetected: differenceInDays(now, p.firstDetectedAt),
      daysSinceLastReinforced,
      eventCount: p._count.patternEvents,
      // For REMOVAL suggestions - track how long pattern has been dormant
      isDormant,
      dormantDays: isDormant ? daysSinceLastReinforced : null,
    };
  });

  return {
    user: {
      id: user.id,
      name: user.name,
      baseline: user.baseline,
      lastBaselineUpdate: user.lastBaselineUpdate,
      baselineStaleDays,
      isInCooldown,
    },
    dailyPlan: {
      id: dailyPlan.id,
      targetDate: dailyPlan.targetDate,
      focusAreas: dailyPlan.focusAreas,
      renderedMarkdown: dailyPlan.renderedMarkdown,
    },
    patterns: formattedPatterns,
    insights,
    recentReviews,
    pastSuggestions,
    stats: {
      totalPatterns: stats[0],
      activePatterns: stats[1],
      dormantPatterns: stats[2],
      confirmedInsights: stats[3],
      likelyInsights: stats[4],
    },
  };
}

// ============================================================================
// Check for Recent Similar Suggestion
// ============================================================================

/**
 * Check if a similar suggestion was already made recently.
 * Returns the suggestion ID if found, null otherwise.
 */
export async function checkRecentSimilarSuggestion(
  userId: string,
  suggestionContent: string
): Promise<string | null> {
  const lookback = subDays(new Date(), PAST_SUGGESTIONS_LOOKBACK_DAYS);

  // Simple check: look for pending suggestions with similar content
  // In production, you might want to use embedding similarity
  const recent = await prisma.uOMUpdateSuggestion.findFirst({
    where: {
      userId,
      status: 'PENDING',
      createdAt: { gte: lookback },
    },
    select: { id: true },
  });

  return recent?.id ?? null;
}
