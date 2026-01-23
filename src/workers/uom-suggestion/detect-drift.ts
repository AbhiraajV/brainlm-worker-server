import prisma from '../../prisma';
import { openai } from '../../services/openai';
import {
  SuggestUOMUpdateInput,
  SuggestUOMUpdateInputSchema,
  SuggestUOMUpdateResult,
  UOMSuggestionOutputSchema,
} from './schema';
import { retrieveUOMSuggestionContext, checkRecentSimilarSuggestion } from './data-retrieval';
import { formatUOMSuggestionMessage, getSystemPrompt } from './prompt';

// ============================================================================
// Configuration
// ============================================================================

const MODEL_CONFIG = {
  model: 'gpt-4o-mini',
  temperature: 0.2, // Low temperature for consistent, reliable suggestions
  maxTokens: 1000,
};

// ============================================================================
// Error Class
// ============================================================================

export class UOMSuggestionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'UOMSuggestionError';
  }
}

// ============================================================================
// Main Function
// ============================================================================

export async function suggestUOMUpdate(
  input: SuggestUOMUpdateInput
): Promise<SuggestUOMUpdateResult> {
  // Validate input
  const parsed = SuggestUOMUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { userId, dailyPlanId } = parsed.data;

  console.log(`[UOMSuggestion] Analyzing drift for user ${userId}, plan ${dailyPlanId}`);

  try {
    // Retrieve context
    const context = await retrieveUOMSuggestionContext(userId, dailyPlanId);
    if (!context) {
      return {
        success: false,
        error: 'Failed to retrieve context (user or daily plan not found)',
      };
    }

    // Check cooldown - baseline updated too recently
    if (context.user.isInCooldown) {
      console.log(`[UOMSuggestion] Skipping - baseline updated ${context.user.baselineStaleDays} days ago (cooldown active)`);
      return {
        success: true,
        skipped: true,
        reason: `Baseline updated ${context.user.baselineStaleDays} days ago (7-day cooldown active)`,
      };
    }

    // Minimum data threshold - need patterns to detect drift
    if (context.patterns.length === 0) {
      console.log(`[UOMSuggestion] Skipping - no active patterns to analyze`);
      return {
        success: true,
        skipped: true,
        reason: 'No active patterns to analyze for drift',
      };
    }

    // Check if there are already pending suggestions
    const pendingSuggestions = context.pastSuggestions.filter(s => s.status === 'PENDING');
    if (pendingSuggestions.length >= 3) {
      console.log(`[UOMSuggestion] Skipping - too many pending suggestions (${pendingSuggestions.length})`);
      return {
        success: true,
        skipped: true,
        reason: `${pendingSuggestions.length} suggestions already pending - waiting for user action`,
      };
    }

    // Format messages
    const systemPrompt = getSystemPrompt(context.user.name || 'User');
    const userMessage = formatUOMSuggestionMessage(context);

    // Call OpenAI
    console.log(`[UOMSuggestion] Calling OpenAI...`);
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

    const validated = UOMSuggestionOutputSchema.safeParse(parsedResponse);
    if (!validated.success) {
      console.error(`[UOMSuggestion] Validation failed:`, validated.error.issues);
      return {
        success: false,
        error: `Output validation failed: ${validated.error.message}`,
      };
    }

    const output = validated.data;

    // If LLM decided not to suggest, return success with skip
    if (!output.shouldSuggest || !output.suggestion) {
      console.log(`[UOMSuggestion] LLM declined to suggest: ${output.skipReason || 'No reason given'}`);
      return {
        success: true,
        skipped: true,
        reason: output.skipReason || 'No significant drift detected',
      };
    }

    // Check for similar pending suggestion before creating (avoid duplicates)
    const existingSimilar = await checkRecentSimilarSuggestion(userId, output.suggestion.content);
    if (existingSimilar) {
      console.log(`[UOMSuggestion] Similar suggestion already pending: ${existingSimilar}`);
      return {
        success: true,
        skipped: true,
        reason: 'Similar suggestion already pending',
      };
    }

    // Store suggestion in database
    const suggestion = output.suggestion;

    // Calculate expiration (30 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const created = await prisma.uOMUpdateSuggestion.create({
      data: {
        userId,
        suggestion: suggestion.content,
        reasoning: suggestion.reasoning,
        driftType: suggestion.driftType,
        confidence: suggestion.confidence,
        patternRefs: suggestion.patternRefs,
        insightRefs: suggestion.insightRefs,
        reviewRefs: suggestion.reviewRefs,
        targetSection: suggestion.targetSection,
        expiresAt,
      },
      select: { id: true },
    });

    console.log(`[UOMSuggestion] Created suggestion: ${created.id} (${suggestion.driftType})`);

    return {
      success: true,
      suggestionId: created.id,
    };
  } catch (error) {
    console.error(`[UOMSuggestion] Error detecting drift:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
