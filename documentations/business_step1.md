You are a senior backend architect designing the database schema for a long-lived, AI-driven personal memory + therapist system.

This is NOT a chat app.
This is NOT a journaling app.
This is a cognitive memory system where:
- Facts are immutable
- Interpretations evolve
- Intelligence is layered, not overwritten

The system must support:
1. Audio → text → event ingestion
2. LLM-based tagging and interpretation at write time
3. Deterministic retrieval at read time
4. Planner → Retriever → Synthesizer architecture
5. Long-term reasoning over years of data

You must design a relational schema (Postgres-friendly) suitable for Prisma ORM.

DO NOT include frontend concerns.
DO NOT include authentication logic beyond a User table.
DO NOT invent unnecessary tables.
DO NOT embed “chat history” as a concept.

–––––––––––––––––
CORE BUSINESS LOGIC
–––––––––––––––––

The system operates on these principles:

1. EVENTS ARE FACTS
   - An event is something the user said or did.
   - Events are append-only and never edited.
   - Example: “I smoked”, “I fought with my girlfriend”, “Gym felt weak today”.

2. INTERPRETATIONS ARE HYPOTHESES
   - Interpretations explain events.
   - Multiple interpretations can exist per event.
   - Interpretations have confidence scores.
   - Interpretations may come from:
     - automatic LLM inference
     - therapist reasoning
     - user reflection
   - Interpretations can be revised by adding new ones, never overwriting old ones.

3. CONTEXT IS STRUCTURAL, NOT INTELLIGENT
   - For every event, the system captures bounded context:
     - what happened shortly before
     - the last similar event
   - Context is stored as references to other events.
   - Context has no “meaning”, only linkage.

4. PATTERNS ARE DERIVED KNOWLEDGE
   - Patterns summarize repeated behavior over time.
   - Patterns are generated in background jobs.
   - Patterns reference supporting events.
   - Patterns evolve via reinforcement, not mutation.

5. RECOMMENDATIONS ARE ADVICE, NOT FACT
   - Recommendations suggest improvements or alternatives.
   - They are NOT tied to a single event as truth.
   - They can apply across events and domains (habits, gym, relationships).

6. TAGS ARE CONTROLLED CONCEPTS
   - Tags are assigned by an LLM at write time.
   - Tags are used for deterministic retrieval.
   - Tags come from a controlled ontology (not free-text).
   - Tags must be stored in a way that supports filtering and indexing.

–––––––––––––––––
SYSTEM REQUIREMENTS
–––––––––––––––––

The schema MUST support:

- Multiple users
- Time-based queries (day, ranges)
- Tag-based retrieval
- Event → interpretations → patterns linkage
- Planner-driven deterministic queries
- Long-term scalability (years of data)
- Future support for embeddings (but NOT required now)

–––––––––––––––––
YOUR TASK
–––––––––––––––––

1. Design the **complete relational schema** for this system.
2. For EACH TABLE:
   - Explain its purpose
   - List every column
   - Explain what each column is used for
   - Explain relationships to other tables
3. Keep the schema minimal but complete.
4. Use clear, professional naming.
5. Assume Prisma ORM + PostgreSQL.
6. Do NOT write application code.
7. Do NOT write migrations.
8. Do NOT invent features not described above.

Your output should be:
- A clear table-by-table breakdown
- With business logic justification
- That a senior engineer could directly implement.

Accuracy and correctness matter more than creativity.
