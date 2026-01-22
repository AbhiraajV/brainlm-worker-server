import prisma from '../../prisma';
import { openai } from '../../services/openai';
import { embedText } from '../../services/embedding';
import {
  GenerateTomorrowPlanInput,
  GenerateTomorrowPlanInputSchema,
  GenerateTomorrowPlanResult,
  TomorrowPlanOutputSchema,
} from './schema';
import {
  retrieveTomorrowPlanContext,
  checkExistingPlan,
} from './data-retrieval';
import { formatTomorrowPlanMessage, getSystemPrompt } from './prompt';

// ============================================================================
// Configuration
// ============================================================================

const MODEL_CONFIG = {
  model: 'gpt-4o-mini',
  temperature: 0.4,
  maxTokens: 2000,
};

// ============================================================================
// Error Class
// ============================================================================

export class TomorrowPlanError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'TomorrowPlanError';
  }
}

// ============================================================================
// Main Function
// ============================================================================

export async function generateTomorrowPlan(
  input: GenerateTomorrowPlanInput
): Promise<GenerateTomorrowPlanResult> {
  // Validate input
  const parsed = GenerateTomorrowPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { userId, reviewId, targetDate } = parsed.data;

  console.log(`[TomorrowPlan] Generating plan for user ${userId}, date ${targetDate}`);

  try {
    // Check for existing plan (idempotency)
    const existingPlanId = await checkExistingPlan(userId, targetDate);
    if (existingPlanId) {
      console.log(`[TomorrowPlan] Plan already exists: ${existingPlanId}`);
      return {
        success: true,
        dailyPlanId: existingPlanId,
        skipped: true,
        reason: 'Plan already exists for this date',
      };
    }

    // Retrieve context
    const context = await retrieveTomorrowPlanContext(userId, reviewId, targetDate);
    if (!context) {
      return {
        success: false,
        error: 'Failed to retrieve context (user or review not found)',
      };
    }

    // Minimum data threshold check - ensure we have enough context for a meaningful plan
    const hasBaseline = !!context.user.baseline && context.user.baseline.trim().length > 0;
    const hasPatterns = context.patterns.length > 0;
    const hasInsights = context.insights.length > 0;

    if (!hasBaseline && !hasPatterns && !hasInsights) {
      console.log(`[TomorrowPlan] Insufficient data for user ${userId}: no baseline, patterns, or insights`);
      return {
        success: false,
        error: 'Insufficient data to generate a meaningful plan. User needs baseline, patterns, or recent insights.',
      };
    }

    // Warn if data is minimal but proceed
    if (!hasBaseline && !hasPatterns) {
      console.warn(`[TomorrowPlan] Limited data for user ${userId}: only ${context.insights.length} insights available`);
    }

    // Format messages
    const systemPrompt = getSystemPrompt(context.user.name || 'User');
    const userMessage = formatTomorrowPlanMessage(context);

    // Call OpenAI
    console.log(`[TomorrowPlan] Calling OpenAI...`);
    const completion = await openai.chat.completions.create({
      model: MODEL_CONFIG.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: MODEL_CONFIG.temperature,
      max_tokens: MODEL_CONFIG.maxTokens,
      response_format: { type: 'json_object' },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
      return {
        success: false,
        error: 'Empty response from OpenAI',
      };
    }

    // Parse and validate
    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(rawResponse);
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse JSON response: ${e instanceof Error ? e.message : 'Unknown error'}`,
      };
    }

    const validated = TomorrowPlanOutputSchema.safeParse(parsedResponse);
    if (!validated.success) {
      console.error(`[TomorrowPlan] Validation failed:`, validated.error.issues);
      return {
        success: false,
        error: `Output validation failed: ${validated.error.message}`,
      };
    }

    const output = validated.data;

    // Generate embedding for the plan
    const embeddingText = `${output.focusAreas.map(f => f.area).join('. ')}. ${output.renderedMarkdown.substring(0, 500)}`;
    let embeddingResult: { embedding: number[] } | null = null;
    try {
      embeddingResult = await embedText({ text: embeddingText });
    } catch (e) {
      console.warn(`[TomorrowPlan] Failed to generate embedding:`, e);
      // Continue without embedding - it's not critical
    }

    // Store in database
    const dailyPlan = await prisma.$transaction(async (tx) => {
      const created = await tx.dailyPlan.create({
        data: {
          userId,
          reviewId,
          targetDate: new Date(targetDate),
          focusAreas: output.focusAreas,
          sessions: output.sessions,
          warnings: output.warnings,
          ctas: output.ctas,
          renderedMarkdown: output.renderedMarkdown,
        },
        select: { id: true },
      });

      // Store embedding if generated
      if (embeddingResult?.embedding) {
        const embeddingStr = `[${embeddingResult.embedding.join(',')}]`;
        await tx.$executeRawUnsafe(
          `UPDATE "DailyPlan" SET embedding = $1::vector WHERE id = $2`,
          embeddingStr,
          created.id
        );
      }

      return created;
    });

    console.log(`[TomorrowPlan] Created plan: ${dailyPlan.id}`);

    return {
      success: true,
      dailyPlanId: dailyPlan.id,
    };
  } catch (error) {
    console.error(`[TomorrowPlan] Error generating plan:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
