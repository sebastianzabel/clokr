# Architecture

**Analysis Date:** 2026-03-30

## Pattern Overview

**Overall:** Multi-tenant monorepo SPA with REST API backend

**Key Characteristics:**

- Three-tier architecture: SvelteKit SPA (client-only rendering) -> Fastify REST API -> PostgreSQL via Prisma ORM
- Multi-tenant isolation via `tenantId` on every employee-scoped query
- Plugin-based API composition using Fastify's `register` + `decorate` pattern
- All data mutations produce audit log entries for compliance (Revisionssicherheit)
- Soft-delete on all core models (`deletedAt`) -- never hard-delete time/leave/absence data
- Background cron jobs run in-process via `node-cron` (no external job queue)

## Layers

**API Server (apps/api):**

- Purpose: REST API handling all business logic, authentication, validation, and data access
- Location: `apps/api/src/`
- Contains: Route handlers, Fastify plugins, middleware, utility functions, tests
- Depends on: `@clokr/db` (Prisma client), `@clokr/types` (shared types)
- Used by: Web frontend via HTTP proxy, NFC terminals, external API keys

**Web Frontend (apps/web):**

- Purpose: SvelteKit SPA serving the UI; no server-side data fetching, all API calls from browser
- Location: `apps/web/src/`
- Contains: Svelte 5 components (runes), stores, API client, route pages
- Depends on: `@clokr/types` (shared types)
- Used by: End users (employees, managers, admins) via browser

**Database Package (packages/db):**

- Purpose: Prisma schema, generated client, seed data
- Location: `packages/db/`
- Contains: `prisma/schema.prisma`, generated Prisma client, seed script
- Depends on: PostgreSQL (via `@prisma/adapter-pg`)
- Used by: API server (imports `@clokr/db` for all DB access)

**Types Package (packages/types):**

- Purpose: Shared TypeScript type definitions between API and web
- Location: `packages/types/src/index.ts`
- Contains: Role, Employee, TimeEntry, LeaveRequest, OvertimeAccount interfaces
- Used by: Both `@clokr/api` and `@clokr/web`

**MCP Package (packages/mcp):**

- Purpose: Model Context Protocol server for Claude Code dev tooling
- Location: `packages/mcp/src/index.ts`
- Contains: MCP tools for querying the Clokr API during development
- Used by: Claude Code during development only

**NFC Client (apps/nfc-client):**

- Purpose: Tauri desktop app for NFC card-based clock-in/out at physical terminals
- Location: `apps/nfc-client/`
- Contains: Tauri Rust shell + web frontend, communicates with API
- Used by: Physical NFC terminal hardware

**E2E Tests (apps/e2e):**

- Purpose: Playwright end-to-end tests
- Location: `apps/e2e/`
- Contains: Playwright test specs, config

## Data Flow

**Browser Request -> API:**

1. Browser makes fetch to `/api/v1/...` (relative URL)
2. SvelteKit server hook (`apps/web/src/hooks.server.ts`) intercepts `/api/*` paths
3. Hook proxies the request to the Fastify API backend (`http://api:4000` in Docker)
4. Fastify processes the request through middleware (auth, rate limit) and route handler
5. Response flows back through the proxy to the browser

**Authentication Flow:**

1. User submits credentials to `POST /api/v1/auth/login`
2. API validates credentials, optionally triggers 2FA OTP via email
3. On success: returns `accessToken` (JWT, 15min) + `refreshToken` (7d)
4. Frontend `authStore` (`apps/web/src/lib/stores/auth.ts`) persists tokens in localStorage
5. API client (`apps/web/src/lib/api/client.ts`) attaches `Authorization: Bearer` header to all requests
6. On 401: client automatically attempts refresh via `POST /api/v1/auth/refresh`
7. On refresh failure: redirects to `/login`

**Time Entry Creation:**

1. Frontend calls `api.post('/time-entries', { ... })` with Zod-validated body
2. API `requireAuth` middleware verifies JWT, extracts `tenantId` and `employeeId`
3. Route handler validates: locked month check, overlap check, leave conflict check, ArbZG compliance
4. Entry created in DB via `app.prisma.timeEntry.create()`
5. Audit log entry created via `app.audit()` with before/after values
6. ArbZG warnings returned in response (non-blocking, advisory only)

**State Management:**

- Client-side state uses Svelte writable stores (`$stores/auth.ts`, `$stores/toast.ts`, `$stores/theme.ts`)
- Page-level state uses Svelte 5 `$state` and `$derived` runes within each `+page.svelte`
- No global state management library; each page fetches its own data via `api.get()` in `onMount`
- Auth tokens persisted in `localStorage`

## Key Abstractions

**Fastify Plugins:**

- Purpose: Encapsulate cross-cutting concerns as decoratable services on the Fastify instance
- Examples: `apps/api/src/plugins/prisma.ts`, `apps/api/src/plugins/audit.ts`, `apps/api/src/plugins/mailer.ts`, `apps/api/src/plugins/notify.ts`, `apps/api/src/plugins/storage.ts`, `apps/api/src/plugins/scheduler.ts`
- Pattern: Each plugin uses `fastify-plugin` (`fp()`) to register, calls `app.decorate()` to add services, and augments the `FastifyInstance` type via `declare module "fastify"`. Accessed everywhere as `app.prisma`, `app.audit()`, `app.notify()`, `app.mailer`, `app.storage`.

**Route Modules:**

- Purpose: Group related API endpoints by domain
- Examples: `apps/api/src/routes/time-entries.ts`, `apps/api/src/routes/employees.ts`, `apps/api/src/routes/leave.ts`, `apps/api/src/routes/auth.ts`
- Pattern: Each exports an `async function xxxRoutes(app: FastifyInstance)` that registers GET/POST/PUT/DELETE handlers. Registered in `apps/api/src/app.ts` with URL prefix (e.g., `{ prefix: "/api/v1/time-entries" }`).

**Auth Middleware:**

- Purpose: JWT/API-key authentication and role-based authorization
- Location: `apps/api/src/middleware/auth.ts`
- Pattern: `requireAuth` verifies JWT or API key (`clk_` prefix). `requireRole(...roles)` combines auth + role check. Used as `preHandler` on routes.

**Background Schedulers:**

- Purpose: Cron-based background tasks running in the API process
- Plugins: `apps/api/src/plugins/attendance-checker.ts` (6 cron jobs), `apps/api/src/plugins/scheduler.ts` (Phorest sync), `apps/api/src/plugins/auto-close-month.ts` (monthly close), `apps/api/src/plugins/data-retention.ts` (annual archival)
- Pattern: Each plugin registers cron tasks via `node-cron`, starts in `onReady` hook, stops in `onClose` hook. Tasks are tenant-aware (loop over all tenants).

**API Client (Frontend):**

- Purpose: Typed HTTP client wrapping fetch with auth token injection and auto-refresh
- Location: `apps/web/src/lib/api/client.ts`
- Pattern: `api.get<T>()`, `api.post<T>()`, `api.put<T>()`, `api.patch<T>()`, `api.delete<T>()`. Auto-retries on 401 after token refresh. Throws `ApiError` with status code.

**SvelteKit Route Groups:**

- Purpose: Separate authenticated app pages from public auth pages via layout groups
- `(app)` group: `apps/web/src/routes/(app)/` -- requires auth, has sidebar/nav layout
- `(auth)` group: `apps/web/src/routes/(auth)/` -- public pages (login, registration, password reset)

## Entry Points

**API Server:**

- Location: `apps/api/src/index.ts`
- Triggers: `tsx watch src/index.ts` (dev) or `node dist/index.js` (prod)
- Responsibilities: Calls `buildApp()` from `apps/api/src/app.ts`, starts Fastify on configured port

**App Builder:**

- Location: `apps/api/src/app.ts`
- Triggers: Called by `index.ts` and by test setup
- Responsibilities: Creates Fastify instance, registers all plugins, middleware, and routes. Exports `buildApp()` for both production and test usage.

**Web Server:**

- Location: `apps/web/src/hooks.server.ts`
- Triggers: SvelteKit server startup
- Responsibilities: API proxy (forwards `/api/*` to Fastify backend), CSP headers, structured logging

**Root Page:**

- Location: `apps/web/src/routes/+page.svelte`
- Triggers: Navigation to `/`
- Responsibilities: Redirects to `/dashboard` (if authenticated) or `/login` (if not)

**Config Validation:**

- Location: `apps/api/src/config.ts`
- Triggers: API startup
- Responsibilities: Validates all environment variables via Zod schema, exits with error if invalid

## Error Handling

**Strategy:** Layered error handling with German user-facing messages

**Patterns:**

- **Zod validation errors**: Global Fastify error handler in `apps/api/src/app.ts` catches `ZodError`, returns 400 with German field-level messages (`"Validierungsfehler"`)
- **Auth errors**: Middleware returns 401/403 directly via `reply.code()`
- **Business logic errors**: Route handlers return specific HTTP codes (404, 409, 422) with German error messages
- **Client errors**: `apps/web/src/lib/api/client.ts` throws `ApiError` with status and message, consumed by page-level `try/catch`
- **Client-side logging**: `apps/web/src/lib/utils/logger.ts` captures `window.onerror` and `unhandledrejection`, sends to `POST /api/v1/logs/client`
- **Server errors**: Fastify logger (Pino) with structured JSON output; supports pretty (dev), JSON, and ECS (Elastic) formats

## Cross-Cutting Concerns

**Logging:**

- API: Pino via Fastify, configurable format (pretty/json/ecs), optional file output via `pino-roll`
- Web server: Structured JSON logging in `hooks.server.ts`
- Client: `clientLogger` in `apps/web/src/lib/utils/logger.ts` sends errors to API endpoint
- Request logging: `onResponse` hook logs method, URL, status, response time

**Validation:**

- All API input validated via Zod schemas defined at the top of each route file
- Environment variables validated via Zod in `apps/api/src/config.ts`
- Frontend relies on API-side validation; forms submit and display API error messages

**Authentication:**

- JWT-based with access/refresh token pair
- API key support (`clk_` prefix) for programmatic access
- Terminal API keys for NFC devices (separate model)
- Session timeout with client-side inactivity detection
- Account lockout after configurable failed attempts

**Multi-Tenancy:**

- Every employee belongs to a `Tenant` via `tenantId`
- JWT payload includes `tenantId`; all queries filter by it
- `TenantConfig` holds per-tenant settings (work hours, SMTP, compliance rules, etc.)
- Background jobs iterate over all tenants

**Audit Trail:**

- `app.audit()` plugin creates `AuditLog` entries with userId, action, entity, entityId, old/new values, IP, user agent
- Required for all create/update/delete operations on core models
- SYSTEM user ID used for automated actions (cron jobs)

---

_Architecture analysis: 2026-03-30_
