import prisma from '../../prisma';
import { differenceInDays, subDays } from 'date-fns';

// ============================================================================
// Types
// ============================================================================

export interface TomorrowPlanContext {
  user: {
    id: string;
    name: string | null;
    baseline: string | null;
    lastBaselineUpdate: Date | null;
    baselineStaleDays: number | null;
  };
  review: {
    id: string;
    structuredContent: unknown;
    renderedMarkdown: string;
    summary: string;
    periodKey: string;
  };
  patterns: Array<{
    id: string;
    description: string;
    status: string;
    lastReinforcedAt: Date;
  }>;
  insights: Array<{
    id: string;
    statement: string;
    explanation: string;
    confidence: string;
    category: string | null;
    temporalScope: string | null;
  }>;
  dayOfWeek: {
    name: string;        // "Monday", "Tuesday", etc.
    shortName: string;   // "Mon", "Tue", etc.
    isWeekend: boolean;
  };
  targetDate: string;
}

// ============================================================================
// Main Retrieval Function
// ============================================================================

export async function retrieveTomorrowPlanContext(
  userId: string,
  reviewId: string,
  targetDate: string
): Promise<TomorrowPlanContext | null> {
  // Parse targetDate as UTC noon to avoid timezone edge cases
  // targetDate format: "YYYY-MM-DD"
  const targetDateObj = new Date(`${targetDate}T12:00:00Z`);
  const sevenDaysAgo = subDays(new Date(), 7);

  // Parallel fetch
  const [user, review, patterns, insights] = await Promise.all([
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

    // The daily review we're planning from
    prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        id: true,
        structuredContent: true,
        renderedMarkdown: true,
        summary: true,
        periodKey: true,
        type: true,
      },
    }),

    // Active patterns
    prisma.pattern.findMany({
      where: {
        userId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        description: true,
        status: true,
        lastReinforcedAt: true,
      },
      orderBy: { lastReinforcedAt: 'desc' },
      take: 20, // Limit for context window
    }),

    // Recent insights (last 7 days)
    prisma.insight.findMany({
      where: {
        userId,
        status: { in: ['CONFIRMED', 'LIKELY', 'SPECULATIVE'] },
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        id: true,
        statement: true,
        explanation: true,
        confidence: true,
        category: true,
        temporalScope: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 15, // Limit for context window
    }),
  ]);

  if (!user || !review) {
    return null;
  }

  // Verify review is DAILY type
  if (review.type !== 'DAILY') {
    console.warn(`[TomorrowPlan] Review ${reviewId} is ${review.type}, not DAILY`);
    return null;
  }

  // Calculate baseline staleness
  let baselineStaleDays: number | null = null;
  if (user.lastBaselineUpdate) {
    baselineStaleDays = differenceInDays(new Date(), user.lastBaselineUpdate);
  } else if (user.baseline) {
    // If baseline exists but no update date, assume very stale
    baselineStaleDays = 90;
  }

  // Calculate day of week for target date (using UTC to match the parsed date)
  const dayIndex = targetDateObj.getUTCDay();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const shortDayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const dayOfWeek = {
    name: dayNames[dayIndex],
    shortName: shortDayNames[dayIndex],
    isWeekend: dayIndex === 0 || dayIndex === 6,
  };

  return {
    user: {
      id: user.id,
      name: user.name,
      baseline: user.baseline,
      lastBaselineUpdate: user.lastBaselineUpdate,
      baselineStaleDays,
    },
    review: {
      id: review.id,
      structuredContent: review.structuredContent,
      renderedMarkdown: review.renderedMarkdown,
      summary: review.summary,
      periodKey: review.periodKey,
    },
    patterns,
    insights,
    dayOfWeek,
    targetDate,
  };
}

// ============================================================================
// Check for Existing Plan
// ============================================================================

export async function checkExistingPlan(
  userId: string,
  targetDate: string
): Promise<string | null> {
  const existing = await prisma.dailyPlan.findFirst({
    where: {
      userId,
      targetDate: new Date(targetDate),
    },
    select: { id: true },
  });

  return existing?.id ?? null;
}
