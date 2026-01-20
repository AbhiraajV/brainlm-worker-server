import { z } from 'zod';

// ============================================================================
// Enums (matching Prisma schema)
// ============================================================================

export enum InsightStatus {
    CONFIRMED = 'CONFIRMED',
    LIKELY = 'LIKELY',
    SPECULATIVE = 'SPECULATIVE',
    SUPERSEDED = 'SUPERSEDED',
    WEAKENED = 'WEAKENED',
}

export enum ConfidenceLevel {
    HIGH = 'HIGH',
    MEDIUM = 'MEDIUM',
    EMERGING = 'EMERGING',
}

export enum InsightCategory {
    STRUCTURAL = 'STRUCTURAL',       // Life structure, routines, organization
    BEHAVIORAL = 'BEHAVIORAL',       // Actions, habits, patterns of behavior
    PREFERENCE = 'PREFERENCE',       // Likes, dislikes, choices
    EMOTIONAL = 'EMOTIONAL',         // Emotional patterns, triggers, responses
    CROSS_DOMAIN = 'CROSS_DOMAIN',   // Connections across life areas
    PROGRESS = 'PROGRESS',           // Growth, change over time
    META = 'META',                   // Self-awareness, meta-cognition
    SHALLOW_PATTERNS = 'SHALLOW_PATTERNS', // Simple observations, early signals
}

export enum EvidenceRelevance {
    PRIMARY = 'PRIMARY',
    SUPPORTING = 'SUPPORTING',
    CONTEXTUAL = 'CONTEXTUAL',
}

// ============================================================================
// Evidence Reference Schema
// ============================================================================

export const EvidenceRefSchema = z.object({
    type: z.enum(['pattern', 'interpretation', 'event', 'insight']),
    id: z.string().min(1),
    relevance: z.enum(['primary', 'supporting', 'contextual']),
    excerpt: z.string().nullable().optional(), // Brief excerpt for human readability
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ============================================================================
// Individual Insight Schema
// ============================================================================

export const InsightItemSchema = z.object({
    statement: z
        .string()
        .min(20, 'Statement must be at least 20 characters')
        .max(500, 'Statement must not exceed 500 characters')
        .describe('A clear, specific insight statement'),

    explanation: z
        .string()
        .min(100, 'Explanation must be at least 100 characters')
        .max(2000, 'Explanation must not exceed 2000 characters')
        .describe('Detailed reasoning and evidence for this insight'),

    confidence: z.nativeEnum(ConfidenceLevel).describe('Confidence level based on evidence strength'),

    status: z.nativeEnum(InsightStatus).describe('Current status of the insight'),

    category: z.nativeEnum(InsightCategory).describe('Primary category of the insight'),

    temporalScope: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe('When this insight applies: e.g., "mornings", "weekends", "stressful periods"'),

    evidenceRefs: z
        .array(EvidenceRefSchema)
        .min(1, 'At least one evidence reference required')
        .max(10, 'Maximum 10 evidence references')
        .describe('References to supporting evidence'),

    derivedFromQuestion: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe('The question this insight answers'),

    supersedesInsightId: z
        .string()
        .nullable()
        .optional()
        .describe('ID of older insight this supersedes, if any'),
});

export type InsightItem = z.infer<typeof InsightItemSchema>;

// ============================================================================
// Question Explored Schema
// ============================================================================

export const QuestionExploredSchema = z.object({
    question: z.string().min(10).max(300),
    category: z.nativeEnum(InsightCategory),
    answerable: z.boolean(),
    reasonIfUnanswerable: z.string().max(200).nullable().optional(),
});

export type QuestionExplored = z.infer<typeof QuestionExploredSchema>;

// ============================================================================
// Full LLM Output Schema
// ============================================================================

export const InsightOutputSchema = z.object({
    questionsExplored: z
        .array(QuestionExploredSchema)
        .min(3, 'Must explore at least 3 questions')
        .max(15, 'Maximum 15 questions')
        .describe('Questions the LLM explored based on the data'),

    insights: z
        .array(InsightItemSchema)
        .max(10, 'Maximum 10 insights per generation')
        .describe('Generated insights (only for answerable questions)'),

    processingNotes: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('Optional notes about the generation process'),
});

export type InsightOutput = z.infer<typeof InsightOutputSchema>;

// ============================================================================
// Trigger Context
// ============================================================================

export interface TriggerContext {
    type: 'new_event' | 'pattern_reinforced' | 'pattern_evolved' | 'pattern_created' | 'scheduled';
    eventId?: string;
    patternId?: string;
    interpretationId?: string;
}

// ============================================================================
// Existing Insight (for comparison/supersession)
// ============================================================================

export interface ExistingInsight {
    id: string;
    statement: string;
    explanation: string;
    confidence: ConfidenceLevel;
    status: InsightStatus;
    category: string | null;
    embedding: number[];
    firstDetectedAt: Date;
    lastReinforcedAt: Date;
}
