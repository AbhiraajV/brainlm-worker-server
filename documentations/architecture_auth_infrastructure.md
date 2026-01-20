# Auth Infrastructure Architecture

> Foundational backend scaffolding with abstract authentication, health checks, and validation pipeline.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Auth Abstraction Layer](#auth-abstraction-layer)
4. [Middleware Layer](#middleware-layer)
5. [Health Check System](#health-check-system)
6. [Validation Pipeline](#validation-pipeline)
7. [Folder Structure](#folder-structure)
8. [Swapping Auth Providers](#swapping-auth-providers)
9. [API Reference](#api-reference)

---

## Overview

This architecture provides a **production-grade foundation** for authentication without implementing any specific auth provider. The system is designed to:

- Abstract auth behind a clean interface
- Keep business logic decoupled from auth mechanics
- Enable provider swaps with minimal code changes
- Validate the entire stack with a single command

```
┌─────────────────────────────────────────────────────────────────┐
│                        Express Server                           │
├─────────────────────────────────────────────────────────────────┤
│  Middleware Layer                                               │
│  ┌─────────────┐    ┌─────────────┐                            │
│  │ attachAuth  │───▶│ requireAuth │                            │
│  └──────┬──────┘    └──────┬──────┘                            │
│         │                  │                                    │
│         ▼                  ▼                                    │
│  ┌─────────────────────────────────────┐                       │
│  │      toAuthInput() Adapter          │  Express → AuthInput  │
│  └──────────────────┬──────────────────┘                       │
├─────────────────────┼───────────────────────────────────────────┤
│  Auth Domain        │                                           │
│         ┌───────────▼───────────┐                              │
│         │     IAuthService      │  Framework-agnostic          │
│         │  ┌─────────────────┐  │                              │
│         │  │ getCurrentUser()│  │                              │
│         │  │ getAuthContext()│  │                              │
│         │  └─────────────────┘  │                              │
│         └───────────┬───────────┘                              │
│                     │                                           │
│         ┌───────────▼───────────┐                              │
│         │   MockAuthService     │  ← Swap point                │
│         │   (or real provider)  │                              │
│         └───────────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Design Principles

### 1. Framework Agnosticism

**Problem:** Passing Express `Request` directly to auth services creates tight coupling. This breaks when you need:
- GraphQL resolvers (no Express Request)
- Background workers (no HTTP context)
- WebSocket handlers
- Unit tests without HTTP mocking

**Solution:** The `AuthInput` interface abstracts away the transport layer:

```typescript
interface AuthInput {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}
```

The middleware layer adapts `Request → AuthInput`, keeping the auth domain pure.

### 2. Separation of Concerns

**Problem:** Mixing identity resolution with HTTP error handling creates tangled code:

```typescript
// BAD: Auth service knows about HTTP
async requireUser(req: Request): Promise<AuthUser> {
  const user = await this.getCurrentUser(req);
  if (!user) throw new HttpError(401); // Auth shouldn't know HTTP
  return user;
}
```

**Solution:** Split responsibilities:

| Layer | Responsibility |
|-------|----------------|
| `IAuthService` | Identity resolution only |
| `auth.middleware.ts` | HTTP semantics (401, headers, cookies) |
| Route handlers | Business logic |

### 3. Single Swap Point

**Problem:** Scattered auth logic makes provider changes painful:

```typescript
// BAD: Auth logic everywhere
app.get('/users', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.verify(token, SECRET); // JWT-specific
  // ...
});
```

**Solution:** One factory function, one line to change:

```typescript
// src/auth/index.ts
export function getAuthService(): IAuthService {
  // SWAP POINT: Change this ONE line
  return new MockAuthService();
  // return new SupabaseAuthService();
  // return new ClerkAuthService();
}
```

### 4. Explicit Over Implicit

**Problem:** Using `req.user` pretends authentication always succeeds:

```typescript
// BAD: Assumes user always exists
req.user = await authService.getCurrentUser(req);
```

**Solution:** Use `req.auth: AuthContext` which explicitly tracks state:

```typescript
interface AuthContext {
  user: AuthUser | null;
  isAuthenticated: boolean;
}
```

Routes can check `req.auth?.isAuthenticated` without assuming success.

---

## Auth Abstraction Layer

### Types (`src/auth/types.ts`)

```typescript
// The authenticated user shape
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

// Full auth context attached to requests
export interface AuthContext {
  user: AuthUser | null;
  isAuthenticated: boolean;
}

// Framework-agnostic input for auth resolution
export interface AuthInput {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}
```

**Why this shape?**

- `AuthUser` contains only identity fields, not permissions (those belong in a separate authorization layer)
- `AuthContext` includes `isAuthenticated` flag for explicit state checking
- `AuthInput` supports both header-based (JWT, Bearer tokens) and cookie-based (sessions) auth

### Interface (`src/auth/auth-service.ts`)

```typescript
export interface IAuthService {
  getCurrentUser(input: AuthInput): Promise<AuthUser | null>;
  getAuthContext(input: AuthInput): Promise<AuthContext>;
}
```

**Why no `requireUser()`?**

The "require" concept is HTTP-specific. The auth service shouldn't know about:
- HTTP status codes (401)
- Response objects
- Error formatting

These belong in middleware.

### Mock Implementation (`src/auth/mock-auth.ts`)

```typescript
const MOCK_USER: AuthUser = {
  id: 'mock-user-001',
  email: 'mock@example.com',
  name: 'Mock User',
};

export class MockAuthService implements IAuthService {
  async getCurrentUser(_input: AuthInput): Promise<AuthUser | null> {
    return MOCK_USER;
  }

  async getAuthContext(input: AuthInput): Promise<AuthContext> {
    const user = await this.getCurrentUser(input);
    return {
      user,
      isAuthenticated: user !== null,
    };
  }
}
```

**Why always return a user?**

During development, you want:
- All routes accessible without auth setup
- Consistent user data for testing
- No environment secrets required

The mock can be modified to return `null` for testing unauthenticated flows.

### Factory (`src/auth/index.ts`)

```typescript
let authService: IAuthService | null = null;

export function getAuthService(): IAuthService {
  if (!authService) {
    authService = new MockAuthService();
  }
  return authService;
}
```

**Why singleton pattern?**

- Auth services often hold state (token caches, connection pools)
- Prevents redundant initialization
- Single point of configuration

---

## Middleware Layer

### Adapter Function

```typescript
function toAuthInput(req: Request): AuthInput {
  return {
    headers: req.headers as Record<string, string>,
    cookies: req.cookies ?? {},
  };
}
```

**Why an explicit adapter?**

- Decouples Express types from auth domain
- Makes testing trivial (pass raw objects)
- Documents exactly what auth needs from requests

### `attachAuth` Middleware

```typescript
export async function attachAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authService = getAuthService();
    req.auth = await authService.getAuthContext(toAuthInput(req));
    next();
  } catch (error) {
    next(error);
  }
}
```

**Use case:** Apply globally to attach auth context to all requests, even public ones.

### `requireAuth` Middleware

```typescript
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authService = getAuthService();
    const context = await authService.getAuthContext(toAuthInput(req));

    if (!context.isAuthenticated || !context.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.auth = context;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication required' });
  }
}
```

**Use case:** Apply to protected routes. Guarantees `req.auth.user` exists after middleware.

### Express Type Extension

```typescript
declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
```

**Why `auth` not `user`?**

- `req.user` implies user always exists
- `req.auth` is a context that may or may not have a user
- Works for both authenticated and unauthenticated routes

---

## Health Check System

### Endpoint Design

```typescript
app.get('/health', async (_req, res) => {
  const timestamp = new Date().toISOString();

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    res.status(200).json({
      status: 'ok',
      db: 'connected',
      timestamp,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      status: 'error',
      db: 'disconnected',
      error: message,
      timestamp,
    });
  }
});
```

### Why `$connect()` Before Query?

**Problem:** Prisma uses lazy connection by default. On cold starts:

```typescript
// This might fail during first call
await prisma.$queryRaw`SELECT 1`;
```

**Solution:** Explicit connection ensures deterministic behavior:

```typescript
await prisma.$connect();  // Establish connection
await prisma.$queryRaw`SELECT 1`;  // Verify it works
```

### Response Format

**Success (200):**
```json
{
  "status": "ok",
  "db": "connected",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Failure (500):**
```json
{
  "status": "error",
  "db": "disconnected",
  "error": "Connection refused",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

**Why this format?**

- `status` field enables simple equality checks (`data.status === 'ok'`)
- `db` field explicitly names the dependency being checked
- `error` field provides debugging info without leaking secrets
- `timestamp` helps correlate with logs

---

## Validation Pipeline

### Command: `npm run validate`

Located at `scripts/validate.ts`, this script validates the entire stack:

```
┌─────────────────────┐
│ 1. TypeScript Check │ tsc --noEmit
└──────────┬──────────┘
           │ Pass
           ▼
┌─────────────────────┐
│ 2. Prisma Generate  │ prisma generate
└──────────┬──────────┘
           │ Pass
           ▼
┌─────────────────────┐
│ 3. Boot Server      │ ts-node src/index.ts
└──────────┬──────────┘
           │ Running
           ▼
┌─────────────────────┐
│ 4. Poll /health     │ Retry loop
└──────────┬──────────┘
           │ Pass
           ▼
┌─────────────────────┐
│ 5. Cleanup & Exit   │ Kill server, exit 0
└─────────────────────┘
```

### Polling Strategy

**Problem:** Fixed timeouts fail unpredictably:

```typescript
// BAD: 3 seconds might not be enough on slow CI
await sleep(3000);
const response = await fetch(HEALTH_URL);
```

**Solution:** Poll with retries:

```typescript
const POLL_INTERVAL_MS = 500;
const MAX_RETRIES = 20; // 10 seconds total

async function pollHealth() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(HEALTH_URL);
      const data = await response.json();
      if (response.ok && data.status === 'ok') {
        return { ok: true, data };
      }
    } catch {
      // Server not ready yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: 'Timeout' };
}
```

**Why this approach?**

- Works on fast machines (exits early)
- Works on slow CI (waits up to 10s)
- Provides progress feedback
- Deterministic failure after max attempts

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All validations passed |
| 1 | TypeScript errors |
| 1 | Prisma generation failed |
| 1 | Health check failed |

---

## Folder Structure

```
brainLM/
├── package.json
├── tsconfig.json
├── .env
├── prisma/
│   └── schema.prisma
├── scripts/
│   └── validate.ts           # Validation pipeline
├── documentations/
│   └── architecture_auth_infrastructure.md
└── src/
    ├── index.ts              # Express server entry
    ├── prisma.ts             # Prisma client singleton
    ├── jobs.ts               # Background jobs
    ├── auth/                 # Auth abstraction layer
    │   ├── types.ts          # AuthUser, AuthContext, AuthInput
    │   ├── auth-service.ts   # IAuthService interface
    │   ├── mock-auth.ts      # Mock implementation
    │   └── index.ts          # Factory + exports
    └── middleware/           # Express middleware
        └── auth.middleware.ts
```

### Layer Boundaries

| Directory | Allowed Dependencies |
|-----------|---------------------|
| `src/auth/` | Only standard lib, no Express |
| `src/middleware/` | Express, `src/auth/` |
| `src/index.ts` | Everything |
| `scripts/` | Node built-ins, child_process |

---

## Swapping Auth Providers

### Step 1: Create New Implementation

```typescript
// src/auth/supabase-auth.ts
import { createClient } from '@supabase/supabase-js';
import { IAuthService } from './auth-service';
import { AuthUser, AuthContext, AuthInput } from './types';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export class SupabaseAuthService implements IAuthService {
  async getCurrentUser(input: AuthInput): Promise<AuthUser | null> {
    const token = input.headers?.['authorization']?.replace('Bearer ', '');
    if (!token) return null;

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;

    return {
      id: user.id,
      email: user.email!,
      name: user.user_metadata?.name ?? null,
    };
  }

  async getAuthContext(input: AuthInput): Promise<AuthContext> {
    const user = await this.getCurrentUser(input);
    return {
      user,
      isAuthenticated: user !== null,
    };
  }
}
```

### Step 2: Update Factory

```typescript
// src/auth/index.ts
import { SupabaseAuthService } from './supabase-auth';

export function getAuthService(): IAuthService {
  if (!authService) {
    // CHANGED: MockAuthService → SupabaseAuthService
    authService = new SupabaseAuthService();
  }
  return authService;
}
```

### What Doesn't Change

- Route handlers
- Middleware
- Type definitions
- Tests using `AuthInput` directly

---

## API Reference

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | API status |
| GET | `/health` | None | Database connectivity check |
| GET | `/me` | Required | Current authenticated user |
| GET | `/users` | Optional | List all users |

### `/health` Response

```typescript
// Success (200)
{
  status: 'ok',
  db: 'connected',
  timestamp: string  // ISO 8601
}

// Failure (500)
{
  status: 'error',
  db: 'disconnected',
  error: string,
  timestamp: string
}
```

### `/me` Response

```typescript
// Success (200)
{
  user: {
    id: string,
    email: string,
    name: string | null
  }
}

// Unauthorized (401)
{
  error: 'Authentication required'
}
```

---

## Appendix: Decision Log

| Decision | Alternative Considered | Why Rejected |
|----------|----------------------|--------------|
| `AuthInput` interface | Pass `Request` directly | Couples auth to Express, breaks in non-HTTP contexts |
| No `requireUser()` in service | Include it for convenience | Mixes identity with HTTP concerns |
| `req.auth` context | `req.user` directly | Doesn't handle unauthenticated state explicitly |
| Singleton auth service | Create per-request | Wasteful for stateless auth, problematic for stateful |
| Polling health check | Fixed timeout | Flaky on slow machines/CI |
| Explicit `$connect()` | Lazy connection only | Non-deterministic cold start behavior |

---

*Last updated: January 2026*
