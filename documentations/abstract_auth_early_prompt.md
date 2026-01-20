You are a senior backend engineer designing the foundational server architecture for an AI-first application.

GOAL:
Build a backend that:
- Has an authentication layer that is abstract and swappable
- Uses Prisma + Node.js + TypeScript
- Does NOT implement real authentication yet
- Can later support any auth system (JWT, Supabase Auth, Clerk, Auth0, custom, etc.)
- Has a health check endpoint that verifies:
  1) server is running
  2) database connectivity works
- Has a single command that validates the entire repo:
  - TypeScript errors
  - missing imports
  - Prisma client validity
  - server boot
  - health endpoint response

DO NOT build business logic.
DO NOT build user flows.
DO NOT add auth providers.
This is infrastructure scaffolding only.

–––––––––––––––––
AUTH ARCHITECTURE REQUIREMENTS
–––––––––––––––––

1. Auth must be **abstracted behind an interface**.
2. Application code must NEVER directly depend on:
   - JWT
   - cookies
   - headers
   - session logic
3. There must be a single AuthService (or equivalent) with methods like:
   - getCurrentUser()
   - requireUser()
4. For now:
   - Auth always returns a mock user
   - No security checks
   - No environment secrets required
5. Later:
   - Auth implementation must be replaceable WITHOUT changing route handlers
   - Only the AuthService implementation should change

The code must clearly indicate:
- where fake auth lives
- where real auth will plug in later

–––––––––––––––––
SERVER REQUIREMENTS
–––––––––––––––––

1. Use Node.js + TypeScript
2. Use a simple HTTP server (Express or Fastify — choose one and justify briefly)
3. Prisma must be initialized correctly
4. Database connection should be lazy-safe (no crash loops)
5. Errors must be explicit and readable

–––––––––––––––––
HEALTH CHECK REQUIREMENTS
–––––––––––––––––

Implement a pingable route, e.g.:
GET /health

It must:
- Return HTTP 200 if server is up
- Attempt a lightweight Prisma query (e.g. `SELECT 1`)
- Return structured JSON like:
  {
    "status": "ok",
    "db": "connected",
    "timestamp": "..."
  }

If DB is NOT connected:
- Return HTTP 500
- Include error info (safe, not secrets)

–––––––––––––––––
VALIDATION COMMAND REQUIREMENTS
–––––––––––––––––

Provide ONE command (e.g. `npm run validate`) that:

1. Type-checks the entire project
2. Verifies Prisma client generation
3. Boots the server
4. Calls the /health endpoint
5. Fails loudly if ANY step fails

This command must be suitable for:
- local dev
- CI pipelines

–––––––––––––––––
OUTPUT REQUIREMENTS
–––––––––––––––––

1. Show folder structure
2. Show key files only (no unnecessary boilerplate)
3. Explain:
   - where auth abstraction lives
   - how it will be replaced later
   - how health check works
   - how validation command works
4. Keep code minimal but production-grade
5. Use clear TypeScript types everywhere
6. Do NOT overengineer

This code is the foundation of a long-lived system.
Prioritize clarity, separation of concerns, and future extensibility over cleverness.
