import prisma from '../../prisma';
import { openai } from '../../services/openai';
import {
  SuggestUOMUpdateInput,
  SuggestUOMUpdateInputSchema,
  SuggestUOMUpdateResult,
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
// JSON Schema for Structured Output
// ============================================================================

// OpenAI Structured Output guarantees this schema - no Zod validation needed
const UOM_SUGGESTION_JSON_SCHEMA = {
  name: 'uom_suggestion_output',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      shouldSuggest: { type: 'boolean' },
      skipReason: { type: ['string', 'null'] },
      suggestion: {
        type: ['object', 'null'],
        properties: {
          content: { type: 'string' },
          reasoning: { type: 'string' },
          driftType: { type: 'string', enum: ['ADDITION', 'MODIFICATION', 'REMOVAL'] },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'EMERGING'] },
          targetSection: { type: ['string', 'null'] },
          patternRefs: { type: 'array', items: { type: 'string' } },
          insightRefs: { type: 'array', items: { type: 'string' } },
          reviewRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['content', 'reasoning', 'driftType', 'confidence', 'patternRefs', 'insightRefs', 'reviewRefs'],
        additionalProperties: false,
      },
      processingNotes: { type: ['string', 'null'] },
    },
    required: ['shouldSuggest', 'skipReason', 'suggestion', 'processingNotes'],
    additionalProperties: false,
  },
} as const;

// Type for the parsed output - matches JSON schema exactly
interface UOMSuggestionOutput {
  shouldSuggest: boolean;
  skipReason: string | null;
  suggestion: {
    content: string;
    reasoning: string;
    driftType: 'ADDITION' | 'MODIFICATION' | 'REMOVAL';
    confidence: 'HIGH' | 'MEDIUM' | 'EMERGING';
    targetSection?: string | null;
    patternRefs: string[];
    insightRefs: string[];
    reviewRefs: string[];
  } | null;
  processingNotes: string | null;
}

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

    // Call OpenAI with Structured Output - JSON schema guarantees valid response
    console.log(`[UOMSuggestion] Calling OpenAI with structured output...`);
    const completion = await openai.chat.completions.create({
      model: MODEL_CONFIG.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: MODEL_CONFIG.temperature,
      max_tokens: MODEL_CONFIG.maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: UOM_SUGGESTION_JSON_SCHEMA,
      },
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
      return {
        success: false,
        error: 'Empty response from OpenAI',
      };
    }

    // Parse LLM output - Structured Output guarantees schema compliance
    let output: UOMSuggestionOutput;
    try {
      output = JSON.parse(rawResponse);
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse JSON response: ${e instanceof Error ? e.message : 'Unknown error'}`,
      };
    }

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
