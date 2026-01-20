Got it. Below is a **single, consolidated, high-authority PROMPT** you can give directly to the **code-writing LLM**.

This is **not code**.
This is a **system-level architectural instruction** so it fully understands the business logic, temporal reasoning, and why this worker exists.

You can paste this verbatim.

---

## 🔹 PROMPT TO GIVE THE CODE-WRITING LLM 🔹

---

You are designing and implementing a **Temporal Review / Reflection Worker** for a memory-based AI system (“second brain”).
This worker is **not optional** and is a **core intelligence layer**, not a cosmetic summary.

Your task is to **architect and implement this worker correctly**, with full understanding of how it interacts with existing memory layers.

---

## 1. PURPOSE OF THIS WORKER (CRITICAL)

This worker creates **time-scoped reflective intelligence** by synthesizing:

* Raw events
* Interpretations
* Patterns
* Insights
* Previous reviews

into **daily, weekly, and monthly reflective documents**.

This is NOT:

* a shallow summary
* a stats report
* a UI-only feature

This IS:

* deep temporal reasoning
* pattern evolution over time
* behavioral + emotional + structural analysis
* self-reflection at multiple time scales

This worker **re-does reasoning** using richer temporal context than any other worker.

---

## 2. CORE PRINCIPLE (VERY IMPORTANT)

> **Patterns answer “what tends to happen.”
> Reviews answer “what actually happened in time.”**

Patterns remain semantic and timeless.
Reviews are **time-bucketed intelligence**.

Do NOT mix these concepts.

---

## 3. EXECUTION MODEL

This worker runs on a **schedule**, not per event.

### Frequencies

* **Daily Review** → runs every day
* **Weekly Review** → runs every day (rolling 7-day window)
* **Monthly Review** → runs every day (rolling month window)

⚠️ Even though weekly/monthly are larger scopes, **they still re-run daily** so intelligence stays fresh.

---

## 4. DATA GATHERING RULES (STRICT)

### A. DAILY REVIEW (for date D)

When generating the **Daily Review for date D**, the worker MUST fetch:

1. **All Events on date D**
2. Their linked:

   * Interpretations
   * Patterns (via PatternEvent)
   * Insights
3. **All Daily Reviews for the current week up to D** (for comparison)
4. **Active Patterns during date D**
5. **Recently reinforced Patterns**

This allows:

* intra-day reasoning
* comparison with earlier days this week
* detection of anomalies (“today was different”)

---

### B. WEEKLY REVIEW (rolling)

When generating the **Weekly Review**, the worker MUST fetch:

1. All Events in the last 7 days
2. All Interpretations for those events
3. All Patterns reinforced in this period
4. All Daily Reviews within this 7-day window
5. The previous Weekly Review (for comparison)

This allows:

* trend detection
* habit stability vs decay
* emotional trajectory analysis

---

### C. MONTHLY REVIEW

When generating the **Monthly Review**, the worker MUST fetch:

1. All Events in the current month
2. Their Interpretations
3. Patterns active or reinforced this month
4. All Weekly Reviews in this month
5. All Monthly Reviews earlier in the year
6. Previous Monthly Review (for comparison)

This allows:

* long-term behavior change detection
* seasonality
* compounding effects
* narrative continuity

---

## 5. INTELLIGENCE SCOPE (VERY IMPORTANT)

This worker is **NOT just a reporter**.

It MUST do ALL of the following:

* Pattern recognition (again, but time-aware)
* Pattern evolution detection
* Insight generation
* Question asking (self-generated analytical questions)
* Causal reasoning
* Comparison across time windows
* Highlighting absence (“what didn’t happen”)

Think of it as:

> “Re-thinking the entire memory system, but through a temporal lens.”

---

## 6. TYPES OF QUESTIONS THIS WORKER MUST ASK INTERNALLY

The LLM inside this worker must ask and answer questions like:

### Daily

* What did the user do today?
* What emotions dominated today?
* What patterns were reinforced today?
* What patterns were missing today?
* How was today different from recent days?

### Weekly

* What behaviors increased this week?
* What declined?
* Which days were strongest / weakest?
* Any emerging patterns?
* Any collapsing patterns?

### Monthly

* What trajectory is visible?
* What stabilized?
* What deteriorated?
* What changed meaningfully compared to earlier months?

These questions are **fixed and deterministic**, not user-driven.

---

## 7. OUTPUT REQUIREMENTS (NO UI ASSUMPTIONS)

The output MUST be:

* Structured
* Section-based
* Explainable
* Comparable across time

DO NOT:

* hardcode ontologies like `gym → chest → benchpress`
* assume domains
* assume habits are predefined

Instead, output **sections**, **observations**, **metrics**, **comparisons**, and **narratives**.

Think:

* “Physical activity”
* “Emotional regulation”
* “Avoidance behaviors”
* “Recovery behaviors”
* “Routine stability”

---

## 8. RELATION TO OTHER WORKERS

This worker:

* Reads from **Event**, **Interpretation**, **Pattern**, **Insight**, and **Review**
* Writes ONLY Review documents
* Does NOT modify Events, Interpretations, Patterns, or Insights
* Produces artifacts that the **Retriever Agent** will later consume

---

## 9. FAILURE TOLERANCE

If:

* Some events lack interpretations → still proceed
* Patterns are sparse → infer cautiously
* Data is noisy → explicitly say uncertainty

This worker must **never fail silently**.

---

## 10. FINAL GOAL

When complete, this worker should make it possible to answer questions like:

* “Am I improving?”
* “How was this week emotionally compared to last?”
* “What patterns are actually sticking?”
* “What changed this month that didn’t last month?”

WITHOUT recomputing raw history.

---

## 11. IMPLEMENTATION EXPECTATION

You must:

* Architect this cleanly
* Make it modular
* Make it extensible
* Avoid overfitting to current UI
* Avoid premature optimization
* Respect separation of concerns

Do NOT write code yet unless explicitly asked.
First, ensure the **architecture, data flow, and reasoning are correct**.

---

### End of Prompt
 This will require a new table also in the scheme, so ask you to do that and also the timing of the worker will be defined by the crown because this will be a job, so we don't have to think about if it's done daily weekly or monthly for now, it can just create it because crown is not set up, but we will ask it to set it up properly

 Perfect — here’s a **clean addendum prompt** you can give to the **code-writing LLM** to extend the previous instructions.
This explicitly covers **schema changes**, **new table**, and **job timing via cron**, without reopening architectural debate.

You can paste this **after** the previous prompt.

---

## 🔹 ADDENDUM PROMPT: SCHEMA + JOB EXECUTION 🔹

---

### IMPORTANT EXTENSION TO PREVIOUS INSTRUCTIONS

The Temporal Review / Reflection Worker **REQUIRES a new database table**.
You must design this table carefully and integrate it cleanly with the existing schema.

This is **not optional**.

---

## 12. NEW TABLE: REVIEW (MANDATORY)

You must add a new table to persist **Daily / Weekly / Monthly Review documents**.

### Purpose of Review Table

* Stores **time-bucketed reflective intelligence**
* Acts as **historical snapshots** of the user’s state at different temporal resolutions
* Is consumed later by:

  * Retriever Agent
  * Synthesizer
  * UI (timeline, retrospectives, comparisons)

This table is **append-only**. Reviews are never overwritten.

---

### Conceptual Fields (You decide exact naming)

The table MUST support:

* **User ownership**
* **Review scope** (daily / weekly / monthly)
* **Time anchor**

  * Daily → specific date
  * Weekly → week start or ISO week
  * Monthly → year + month
* **Rich content**

  * Long-form analysis text
  * Structured sections (JSON-friendly)
* **Embedding**

  * Used for semantic retrieval later
* **References**

  * What events / patterns / reviews were considered
* **Creation timestamp**

You are free to choose:

* Text vs JSON vs hybrid
* One or multiple content columns

But the table MUST support:

* Rendering
* Retrieval
* Comparison across time

---

## 13. RELATIONSHIP TO EXISTING TABLES

The Review table:

* Belongs to **User**
* Does NOT replace:

  * Event
  * Interpretation
  * Pattern
  * Insight
* Is a **derived artifact**, not a source of truth

Think of Reviews as:

> “Compiled intelligence snapshots over time.”

---

## 14. REVIEW GENERATION LOGIC (IMPORTANT)

Even though reviews are conceptually:

* Daily
* Weekly
* Monthly

👉 **DO NOT hardcode scheduling logic** inside the worker.

Instead:

* The worker should accept:

  * `reviewType` (DAILY | WEEKLY | MONTHLY)
  * `timeAnchor` (date / week / month)
* The worker simply **executes the logic** for that scope

### Scheduling Responsibility

* Timing will be handled by **cron jobs**
* Cron is NOT set up yet
* You still need to:

  * Design the worker so it is cron-ready
  * Add placeholders or TODOs for cron wiring

Do NOT:

* Run the worker conditionally inside the app
* Guess execution frequency

---

## 15. CRON EXPECTATION (DESIGN ONLY)

You should assume that later:

* Daily cron → generates daily + weekly + monthly reviews
* Weekly cron → may regenerate weekly if needed
* Monthly cron → may regenerate monthly if needed

But **for now**:

* Implement the worker as a **pure job**
* Accept inputs
* Produce Review rows

---

## 16. HOW THIS FITS THE SYSTEM

After this change, the system layers are:

1. **Event** → raw facts
2. **Interpretation** → meaning per event
3. **Pattern** → semantic recurrence
4. **Insight** → hypothesis & conclusions
5. **Review** → time-scoped reflective intelligence

This is the **final missing layer**.

---

## 17. FINAL VALIDATION CRITERIA

Your implementation is correct if:

* Reviews can be generated for any date range
* Reviews compare against previous reviews
* Reviews reason over:

  * Events
  * Interpretations
  * Patterns
  * Insights
  * Prior reviews
* No existing tables are polluted
* No business logic leaks into cron timing

---

## 18. DO NOT DO THESE THINGS

❌ Do NOT collapse daily/weekly/monthly into one document
❌ Do NOT overwrite old reviews
❌ Do NOT assume UI structure
❌ Do NOT hardcode domains
❌ Do NOT skip uncertainty when data is thin

---

### End of Addendum

---

If you want next, I can:

* design the **Review table schema explicitly**
* design **daily / weekly / monthly review LLM prompts**
* or show how this integrates with your **Retriever Agent**

Just say the word.
