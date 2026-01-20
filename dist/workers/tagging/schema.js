"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMOutputSchema = exports.InterpretationOutputSchema = exports.TagOutputSchema = void 0;
const zod_1 = require("zod");
// Slug format: lowercase letters, numbers, hyphens, forward slashes
// Examples: "health", "health/gym", "health/gym/chest/bench-press"
const slugRegex = /^[a-z0-9]+(?:\/[a-z0-9-]+)*$/;
exports.TagOutputSchema = zod_1.z.object({
    slug: zod_1.z
        .string()
        .min(1, 'Slug cannot be empty')
        .regex(slugRegex, 'Invalid slug format'),
    name: zod_1.z.string().min(1).max(100),
    description: zod_1.z.string().min(1).max(500),
    confidence: zod_1.z.number().min(0).max(1),
});
exports.InterpretationOutputSchema = zod_1.z.object({
    content: zod_1.z.string().min(1).max(2000),
    confidence: zod_1.z.number().min(0).max(1),
});
exports.LLMOutputSchema = zod_1.z.object({
    tags: zod_1.z.array(exports.TagOutputSchema).min(1).max(5),
    interpretations: zod_1.z.array(exports.InterpretationOutputSchema).min(1).max(3),
});
