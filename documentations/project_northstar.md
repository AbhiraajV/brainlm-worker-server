Cognitive Memory System
Memory Creation Flow & Hard Rules
Purpose of this document

This document defines how memories are created, what guarantees the system must always uphold, and what must never be violated, regardless of future features, refactors, or model changes.

This system is not a chat app, not a journal, and not a simple database.
It is a long-lived cognitive memory system designed to support reasoning about a user’s life over years.

Core Philosophy (North Stars)
1. Facts are sacred

If a user reports something happened, that fact must be preserved permanently.

The system may misunderstand meaning, but it must never lose or rewrite what happened.

2. Understanding evolves

Interpretations, explanations, and insights are hypotheses, not truth.

New understanding is added, never overwritten.

3. Structure ≠ meaning

Context and linkage describe relationships, not causality or judgment.

Meaning lives in interpretations, not in links.

4. Intelligence is layered

No single step “understands everything”.

Memory is built in layers: facts → understanding → structure → patterns → advice.

5. Failure is acceptable, loss is not

LLMs can fail. Jobs can retry. Intelligence can be wrong.

Losing a user’s memory is unacceptable.

Hard Rules (Non-Negotiable)

These rules must never be violated, even if future features seem to demand it.

Rule 1: Events are append-only

Events are never updated

Events are never deleted (except full user deletion)

Corrections are new events, not edits

Why:
You cannot reason about change if the past mutates.

Rule 2: Interpretations are additive

Multiple interpretations may exist per event

Interpretations are never edited or replaced

Confidence can vary, but history remains

Why:
Human understanding changes. Systems must reflect that.

Rule 3: Context has no semantics

EventContext only links events

Context types are structural (PRECEDED_BY, SIMILAR_TO)

No causal or moral meaning is stored in context

Why:
Causality is a hypothesis, not a fact.

Rule 4: Patterns evolve via reinforcement

Patterns summarize repetition

Patterns are strengthened, superseded, or go dormant

Patterns are never silently mutated

Why:
Long-term insights must be auditable.

Rule 5: Recommendations are advice, not truth

Recommendations may be ignored or dismissed

They do not rewrite memory

They are optional and ephemeral

Why:
Advice should never pollute memory.

Rule 6: Memory creation must succeed even if intelligence fails

Event creation is the only blocking step

All enrichment steps must be retryable

Partial memory is acceptable; lost memory is not