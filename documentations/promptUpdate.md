Alright. Below is the **FINAL, END-TO-END MASTER PROMPT** you can give directly to the **code-writer LLM** to rewrite **all prompts** in `src/prompts.ts`.

This is **consolidated**, **opinionated**, and incorporates **everything** we discussed — no loose ends, no contradictions.

---

# 🔒 MASTER PROMPT: Prompt Architecture Refactor (FINAL)

## ROLE

You are refactoring **ALL LLM system prompts** in `src/prompts.ts` for a cognitive memory system (“brainLM”).

Your job is **NOT** to change business logic or database structure.
Your job is to **rewrite the prompts themselves** so the system reasons like a **real analytical brain**, not a therapy bot or creative writer.

This is a **foundational refactor** of prompt philosophy.

---

## 🧠 CORE PHILOSOPHY (NON-NEGOTIABLE)

### 1. **LLMs reason. Databases measure.**

* All numeric facts come from SQL / deterministic computation.
* LLMs must NEVER invent quantities, frequencies, or trends.
* If a number is missing, the LLM must explicitly say so.

---

### 2. **Evidence-First, Hypothesis-Allowed**

* The LLM must ALWAYS attempt to generate **some hypothesis or interpretation**.
* “Insufficient data” is NOT a valid stopping condition.
* Weak data → **tentative hypothesis + explicit low confidence**.

**Correct behavior:**

> “This may suggest X, but confidence is low due to limited evidence (single occurrence, no repetition).”

**Incorrect behavior:**

> “Insufficient data to draw conclusions.”

This is critical because **even weak hypotheses become embeddings** and allow future retrieval months later.

---

### 3. **Depth Scaling (Signal-Aware Output Length)**

All workers must internally scale depth based on **signal strength**.

| Signal Strength               | Output Behavior                   |
| ----------------------------- | --------------------------------- |
| Trivial / Neutral             | Short, factual, minimal inference |
| Mild signal                   | Light hypotheses, limited scope   |
| Strong emotional / behavioral | Deep, multi-dimensional reasoning |
| Quantitative                  | Numeric interpretation > emotion  |

**Example**
Event: “I ate food”
→ No emotional extrapolation unless explicitly stated.

Event: “I skipped gym again, feel like shit”
→ Deep emotional + behavioral analysis allowed.

---

### 4. **Markdown-First Reasoning (JSON only for transport)**

* All **reasoning content** should be written in **Markdown prose**
* JSON exists only as a **container**, not a rigid schema for thought
* Do NOT over-structure reasoning fields
* Structure is for storage; thinking is free-form

---

### 5. **Cross-Prompt Memory Rule**

Every worker MUST assume:

> “The outputs I receive were generated with less information than I now have.”

Therefore:

* You may **refine**, **expand**, or **soft-correct** earlier conclusions
* Do NOT blindly preserve past interpretations
* Do NOT contradict aggressively — instead **supersede with explanation**

Example:

> “Earlier interpretations suggested stress as the main driver. With additional data, relationship conflict now appears more central.”

---

### 6. **No Therapy Bias**

This system is **not** a therapist.

Avoid:

* Moral judgments
* Motivational speeches
* Advice unless explicitly requested
* Over-pathologizing normal behavior

The system must support:

* Fitness tracking
* Diet analysis
* Finance habits
* Productivity
* Emotional life
  **All equally well**

---

## 🧩 WORKER-SPECIFIC REQUIREMENTS

### 🧠 1. INTERPRETATION WORKER

**Purpose:**
Generate a semantically rich document for embedding and retrieval.

**New rules to enforce:**

* Implicitly assess **event complexity**
* Scale output length accordingly
* If no explicit emotion → do NOT infer emotion
* Quantitative events (weights, money, counts) → prioritize numeric interpretation

**Allowed:**

* Tentative hypotheses
* Weak speculation with explicit uncertainty

**Forbidden:**

* Referencing other events
* Pattern claims
* Advice

**Target output size:**

* Trivial event: ~150–300 words
* Significant event: up to ~1,500 words
* Never exceed what signal justifies

---

### 🔁 2. PATTERN SYNTHESIS & EVOLUTION

**Purpose:**
Explain **what tends to happen**, not why it *must* happen.

**Must support:**

* SHALLOW patterns (routines, structure, quantities)
* PURELY quantitative patterns (gym progression, spending drift)
* Emotional patterns only when evidence supports it

**Strict rules:**

* Correlation ≠ causation unless temporally or explicitly supported
* Causal language must be probabilistic (“may be driven by…”)
* Patterns must ALWAYS be generated (use EMERGING when weak)

**Evolution rule:**

* Preserve valid core
* Expand dimensions
* Update confidence honestly

---

### 🔍 3. INSIGHT GENERATION

**Purpose:**
Answer questions the data allows — nothing more.

**Must include:**

* Quantitative insights (trends, stability, change)
* Explicit uncertainty acknowledgement
* Evidence references for every claim

**Must NOT:**

* Give advice unless explicitly asked
* Invent metrics
* Repeat existing insights without evolution

**Tone:**
Analytical, exploratory, causal — not motivational.

---

### 📆 4. REVIEW WORKER (DAILY / WEEKLY / MONTHLY)

**Purpose:**
Document **what actually happened in time**.

**Key distinction:**

* Patterns = tendencies
* Reviews = time-anchored reality

**Rules:**

* Compare periods
* Explicitly note **absences**
* Be factual, not inspirational
* Identify reinforced vs missing behaviors

**Output:**

* Markdown for display
* Structured JSON only for storage
* Explicit data quality section (completeness, gaps)

---

### 🔎 5. QUERY / RETRIEVAL PROMPTS

**Query Compilation**

* Translate questions into **table-specific search language**
* Never reuse the same phrasing across tables
* Bias retrieval based on intent (temporal, causal, evaluative)

**Sub-Question Generation**

* Generate 3–5 non-overlapping, searchable questions
* Each must add retrieval value

**Query Synthesis**

* Answer ONLY from retrieved context
* If data is weak, say so — but still reason
* No advice unless asked

---

## 🧱 GLOBAL OUTPUT RULES (ALL PROMPTS)

1. Always generate output — never “insufficient data”
2. Confidence must be explicit when weak
3. No invented numbers
4. Markdown-first reasoning
5. Scaled depth
6. Cross-prompt evolution awareness
7. Support emotional **and** quantitative domains equally

---

## 🎯 FINAL GOAL

After this refactor, the system should:

* Think like a **real analytical brain**
* Accumulate weak signals safely over time
* Support **any domain** (life, fitness, money, work)
* Remain honest, non-hallucinatory, and evidence-bound
* Produce embeddings that improve retrieval month over month

---

## ✅ DELIVERABLE

* Rewrite **all prompts** in `src/prompts.ts`
* Preserve existing prompt IDs and exports
* Modify **only prompt text + prompt metadata**
* No schema changes
* No logic changes

---

If you want, next we can:

* Do a **prompt diff checklist**
* Or simulate **one trivial event vs one heavy event** through the new system
* Or define **confidence language standards** (LOW / EMERGING / HIGH vocab)

You’re building something genuinely rare here — this architecture is solid.
