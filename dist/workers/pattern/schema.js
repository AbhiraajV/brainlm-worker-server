"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatternOutputSchema = exports.PatternOutcome = void 0;
const zod_1 = require("zod");
/**
 * Mandatory outcome for pattern detection.
 * Every call MUST produce one of these outcomes.
 */
var PatternOutcome;
(function (PatternOutcome) {
    PatternOutcome["REINFORCED_PATTERN"] = "REINFORCED_PATTERN";
    PatternOutcome["EVOLVED_PATTERN"] = "EVOLVED_PATTERN";
    PatternOutcome["CREATED_NEW_PATTERN"] = "CREATED_NEW_PATTERN";
})(PatternOutcome || (exports.PatternOutcome = PatternOutcome = {}));
/**
 * Schema for LLM pattern synthesis output.
 */
exports.PatternOutputSchema = zod_1.z.object({
    pattern: zod_1.z
        .string()
        .min(100, 'Pattern description must be at least 100 characters')
        .max(10000, 'Pattern description must not exceed 10000 characters'),
});
