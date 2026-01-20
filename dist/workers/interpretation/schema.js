"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InterpretationOutputSchema = void 0;
const zod_1 = require("zod");
/**
 * Schema for LLM interpretation output.
 * Validates the rich interpretation document.
 */
exports.InterpretationOutputSchema = zod_1.z.object({
    interpretation: zod_1.z
        .string()
        .min(200, 'Interpretation must be at least 200 characters')
        .max(15000, 'Interpretation must not exceed 15000 characters'),
});
