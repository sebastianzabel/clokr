# Clokr – Project Rules

## Tech Stack

- **Monorepo**: pnpm workspaces (`apps/api`, `apps/web`, `packages/db`)
- **API**: Fastify + TypeScript, Zod validation, Prisma ORM (PostgreSQL)
- **Web**: SvelteKit + Svelte 5 (runes: `$state`, `$derived`, `$effect`, `$props`)
- **DB**: PostgreSQL 18, Prisma schema at `packages/db/prisma/schema.prisma`
- **Docker**: `docker compose up --build -d` for full stack

## Commands

- `pnpm dev` — start all dev servers
- `pnpm --filter @clokr/api dev` — API only
- `pnpm --filter @clokr/web dev` — Web only
- `pnpm --filter @clokr/db exec prisma db push` — sync schema to DB
- `pnpm --filter @clokr/db exec prisma generate` — regenerate Prisma client
- `docker compose up --build -d` — rebuild and restart all containers

## Path Aliases (SvelteKit)

- `$stores` → `src/lib/stores/`
- `$api` → `src/lib/api/`

## Language

- UI labels and user-facing text: **German**
- Code, comments, commit messages, docs: **English**
- API descriptions (Swagger): English

## Audit-Proof / Revisionssicherheit

Clokr MUST be audit-proof (revisionssicher). All data relevant to working time, leave, and payroll must be tamper-proof and traceable:

- **No hard deletes** of time entries, leave requests, or employee records — use soft delete (`deletedAt`) or status changes instead
- **Soft delete queries**: ALL queries on soft-deletable models (TimeEntry, LeaveRequest, Absence) MUST include `deletedAt: null` in the where clause
- **Audit trail**: Every create, update, and delete must be logged with userId, timestamp, IP, and before/after values (via `app.audit()`)
- **Immutability after lock**: Once a month is closed (`isLocked`), entries MUST NOT be editable or deletable — not even by admins. Always check `isLocked` before UPDATE/DELETE.
- **No silent overwrites**: Any correction to a locked/finalized entry must create a new correction entry with reference to the original, not modify it in place
- **Traceability**: It must always be possible to reconstruct who changed what, when, and why
- **CASCADE = Restrict**: Critical relations (Employee→TimeEntry/LeaveRequest/Absence) use `onDelete: Restrict` to prevent silent cascade deletion

These rules apply to ALL code changes touching time entries, leave, overtime, and employee data. When in doubt, prefer creating an audit log entry over skipping it.

### DSGVO Employee Deletion = Anonymization

When an employee is "deleted" (DSGVO Art. 17), the system **anonymizes** instead of hard-deleting:

- **Employee**: firstName → "Gelöscht", lastName/employeeNumber → "GELÖSCHT-XXX", nfcCardId → null
- **User**: email → anonymized, passwordHash → "ANONYMIZED", isActive → false
- **Notes**: All notes in TimeEntries, LeaveRequests, Absences are set to null
- **Documents**: Absence documentPath → null
- **Auth tokens**: Invitations, OTP, RefreshTokens are hard-deleted (not retention-relevant)
- **Preserved**: TimeEntries, LeaveRequests, Absences, Schedules, OvertimeAccount (for retention compliance)
- **AuditLog**: userId → null (anonymized, not deleted)

## Data Retention (Aufbewahrungsfristen)

Legal retention periods (Germany):

| Basis                             | Retention                              | Reference            |
| --------------------------------- | -------------------------------------- | -------------------- |
| Arbeitszeitnachweis               | 2 years                                | § 16 Abs. 2 ArbZG    |
| Lohnkonten                        | 6 years                                | § 41 EStG            |
| Buchungsbelege (payroll-relevant) | 10 years                               | § 147 AO / § 257 HGB |
| DSGVO                             | Delete after longest retention expires | Art. 17 DSGVO        |

**Default retention: 10 years** (configurable per tenant, minimum 2 years). Retention period starts at end of calendar year of record creation. Deletion is NOT rolling — it happens annually (Stichtag), e.g., on Jan 1st for records whose retention expired on Dec 31st.

## Saldo Calculation & Monatsabschluss (planned)

**Current state**: Saldo is recalculated from hire date on every request. This does not scale.

**Target architecture** (see issue #6):

- **Monatsabschluss**: Monthly `SaldoSnapshot` freezes worked/expected/balance/carryOver per employee
- **Current saldo** = last snapshot `carryOver` + entries since snapshot date
- **Jahresübertrag**: Yearly snapshot at Dec 31st, configurable carry-over rules (FULL / CAPPED / RESET)
- **Archival**: After retention period, old entries can be soft-deleted/archived because snapshots preserve saldo integrity
- Corrections to closed months: unlock → correct → re-close (new snapshot with audit trail)

## CVE / Security Vulnerability Handling

When Trivy or Dependabot reports a CVE, follow this process strictly:

1. **If a fix exists**: Update the dependency immediately.
   - Direct dependency → `pnpm update <pkg>`
   - Transitive dependency → add/update `pnpm.overrides` in root `package.json`
   - Docker base image → update Dockerfile + rebuild
2. **If no fix exists**: Add the CVE to `.trivyignore` with a comment explaining:
   - Why it's not exploitable in our context (e.g., build-only tool, not user-facing)
   - When to revisit (e.g., "remove when upstream releases fix")
3. **Never lower Trivy severity** (e.g., removing HIGH from scan) to make builds pass.
4. **Never use `--ignore-scripts` globally** just to avoid CVE-related build failures — find the specific package causing the issue.
5. All CVE fixes and exceptions MUST be documented in the commit message.

Files:

- `.trivyignore` — exceptions with justification comments
- `package.json` → `pnpm.overrides` — transitive dependency version pins
- `.github/workflows/build-push.yml` — Trivy scan configuration

## Time Entry Rules

- **One entry per day** per employee (multiple breaks allowed within that entry)
- Break model: `Break[]` records with startTime/endTime (legacy: `breakMinutes` integer)
- `openAdd()` on frontend redirects to edit if entry already exists for that day
- API POST rejects with 409 if entry already exists for employee+date

## ArbZG (Arbeitszeitgesetz) Rules

These rules MUST be followed when implementing or modifying ArbZG compliance checks:

- **§ 3 Daily max: 10h absolute limit** — this is the hard daily cap, never exceeded
- **§ 3 The 8h rule is a 24-week/6-month AVERAGE, NOT a daily limit!**
  - A 4-day week with 39h (= 9.75h/day) is perfectly legal
  - Only warn/error when the 24-week rolling average exceeds 8h per workday
  - Do NOT show warnings for individual days between 8h and 10h
- **§ 3 Weekly max: 48h** — hard weekly cap (Mo-Sa = 6 Werktage)
- **§ 4 Breaks**: >6h work = min 30min break; >9h work = min 45min break
- **§ 5 Rest period**: min 11h between end of work and start of next day
- **§ 8 BUrlG**: Leave and time tracking interaction rules:
  - **APPROVED leave**: Time entry creation is BLOCKED. Employee must request cancellation first.
  - **CANCELLATION_REQUESTED leave**: Time entries ARE allowed but created as `isInvalid: true`
    with reason "Urlaubsstornierung ausstehend". These entries don't count in saldo.
  - **When cancellation is approved** (→ CANCELLED): Invalid entries are automatically revalidated.
  - **When cancellation is rejected**: Entries stay invalid (manager can manually handle).
  - Cancellation always requires approval by a DIFFERENT manager (self-approval blocked).
  - Leave remains active (shown in calendar, counts for saldo) until cancellation is approved.

## Leave Cancellation Flow

1. Employee/Manager requests cancellation → status = `CANCELLATION_REQUESTED`
2. Leave remains active: shown in calendar (special styling), blocks regular time tracking
3. Time entries during this period: allowed but marked `isInvalid` (needs cancellation approval first)
4. Another manager approves cancellation → status = `CANCELLED`, time entries auto-revalidated
5. If cancellation rejected → status reverts to `APPROVED`, time entries stay invalid

## Vacation Carry-Over & Cross-Year Booking (see #58)

These rules MUST be followed when implementing or modifying vacation/leave carry-over logic:

### BUrlG (Bundesurlaubsgesetz) Rules

- **§ 3 Gesetzlicher Mindesturlaub**: `Arbeitstage/Woche × 4` (5-day week = 20 days, 6-day week = 24 days)
- **§ 7 Abs. 3 Übertragung**: Vacation MUST be taken in the current calendar year. Carry-over to the next year ONLY with valid reason (illness, operational necessity). Carried-over days expire by **March 31** of the following year (configurable per tenant).
- **Langzeitkrankheit**: Carry-over up to 15 months (EuGH C-214/10 "KHS")
- **Hinweispflicht** (EuGH C-684/16): Employer must proactively warn employees about expiring vacation. Without warning, vacation does NOT expire automatically.

### Cross-Year Booking

- Vacation spanning Dec 30 → Jan 5 MUST be split across both years (2 days from year 1, 3 days from year 2)
- Each year's entitlement is checked and booked separately
- Cancellation reverses both years

### Dynamic Carry-Over

- Carry-over is recalculated on every booking/cancellation
- Advance booking into next year: uses projected carry-over first, then new year entitlement
- New booking in current year after advance booking: carry-over to next year is reduced, next year's entitlement adjusted
- **Carry-over priority**: Always use carried-over days before new entitlement (FIFO)

### Carry-Over Validation

- If employee has not taken the statutory minimum (§ 3 BUrlG) in the current year, carry-over beyond `totalDays - statutoryMinimum` requires a documented reason (ILLNESS, OPERATIONAL, OTHER)
- Reminders starting in October (configurable) when vacation is at risk of expiring
- Escalation to manager in November, final warning in December

## Overtime Saldo Calculation (current)

- **Saldo = Worked hours − Expected hours** (both calculated for the same date range)
- **Date range**: From hire date (or month start) up to today (if entries exist) or yesterday
- Leave, holidays, and absences within this range reduce expected hours
- Leave/holidays are clamped to the effective range (no over-deduction from pre-hire leave)
- Saldo recalculates on every GET /overtime/:employeeId request
- **Note**: This will be replaced by snapshot-based calculation (see "Saldo Calculation & Monatsabschluss" above)

## Schedule Types

- `FIXED_WEEKLY` — fixed weekly hours with per-day allocation (e.g., 40h, Mo-Fr 8h)
- `MONTHLY_HOURS` — monthly hour budget for Minijobber/flexible workers
  - `monthlyHours` is optional — when null/0, pure time tracking without Soll comparison
  - No daily targets, no daily +/- display in calendar
  - Holiday/absence deductions do NOT apply (flexible schedule)

## Svelte 5 Gotchas

- `{@const}` can only be used inside `{#if}`, `{#each}`, `{#snippet}` — NOT inside `<div>`
- Use `$derived` for computed values instead of `{@const}` in templates
- Use `preventDefault` from `svelte/legacy` for form handlers

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

<!-- GSD:project-start source:PROJECT.md -->

## Project

**Clokr — Production Readiness**

Clokr is a German-language, audit-proof time tracking and leave management SaaS for small to mid-size companies. It handles time entries, breaks, overtime saldo, leave requests with BUrlG-compliant carry-over, ArbZG compliance checks, NFC terminal integration, and multi-tenant administration. The app is feature-complete for v1 — this milestone focuses on making it production-ready.

**Core Value:** The app must be reliable, secure, and legally compliant enough to go live with real customers — no silent failures, no untested edge cases, no broken mobile experience.

### Constraints

- **Legal**: Must comply with ArbZG, BUrlG, DSGVO, and German retention requirements (§147 AO: 10 years)
- **Tech stack**: Existing stack (Fastify + SvelteKit + Prisma + PostgreSQL) — no migrations
- **Language**: UI in German, code/docs in English
- **Audit-proof**: No hard deletes, all mutations logged, locked months immutable
- **Docker**: Development and deployment via docker compose
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 6.0.2 - All backend and frontend source code
- Svelte 5.55.0 - UI components with runes syntax (`$state`, `$derived`, `$effect`, `$props`)
- JavaScript/Node.js - Runtime, build scripts
- SQL - Executed via Prisma

## Runtime

- Node.js 24-alpine - Container runtime for both API and web
- pnpm 10.33.0 - Workspaces package manager
- pnpm 10.33.0
- Lockfile: `pnpm-lock.yaml` (present)
- Workspace structure: `pnpm-workspace.yaml`

## Frameworks

- Fastify 5.8.4 - HTTP server for API (`apps/api`)
- SvelteKit 2.55.0 - Web framework with SSR/SSG for `apps/web`
- @sveltejs/adapter-node 5.5.4 - Node.js adapter for SvelteKit
- Prisma 7.6.0 - ORM layer
- @prisma/client 7.6.0 - Runtime client
- @prisma/adapter-pg 7.6.0 - PostgreSQL adapter
- PostgreSQL 18-alpine - Primary database
- Vitest 4.1.2 - Unit/integration test runner
- @vitest/coverage-v8 4.1.1 - Code coverage
- @playwright/test 1.58.2 - End-to-end testing (apps/e2e)
- @axe-core/playwright 4.11.1 - Accessibility testing
- Turbo 2.8.20 - Monorepo task runner
- Vite 8.0.2 - Frontend build tool
- @sveltejs/vite-plugin-svelte 7.0.0 - Svelte compilation
- TypeScript compiler (tsc) - Type checking
- tsx 4.21.0 - TypeScript Node runner for dev
- ESLint 10.1.0 - Linting (ES and TypeScript)
- @typescript-eslint/eslint-plugin 8.57.2 - TS linting rules
- eslint-plugin-svelte 3.16.0 - Svelte linting
- svelte-eslint-parser 1.6.0 - Svelte parsing
- Prettier 3.8.1 - Code formatting
- prettier-plugin-svelte 3.5.1 - Svelte formatting
- husky 9.1.7 - Git hooks
- lint-staged 16.4.0 - Pre-commit linting

## Key Dependencies

- @fastify/jwt 10.0.0 - JWT handling for API
- bcryptjs 3.0.3 - Password hashing
- @fastify/helmet 13.0.2 - Security headers
- @fastify/cors 11.2.0 - CORS middleware
- @fastify/rate-limit 10.3.0 - Rate limiting (500 req/min default)
- @fastify/swagger 9.7.0 - OpenAPI/Swagger documentation
- @fastify/swagger-ui 5.2.5 - Swagger UI at `/docs`
- @fastify/multipart 9.4.0 - File upload handling
- minio 8.0.7 - S3-compatible object storage client
- sharp 0.34.5 - Image processing (avatars)
- pdfkit 0.18.0 - PDF generation
- nodemailer 8.0.4 - SMTP email sending
- zod 4.3.6 - Schema validation
- date-fns 4.1.0 - Date utilities (web)
- date-fns-tz 3.2.0 - Timezone support (API)
- node-cron 4.2.1 - Scheduled tasks (monthly close, data retention, sync)
- chart.js 4.5.1 - Chart rendering
- @tanstack/svelte-query 6.1.10 - Server state management
- tailwindcss 4.2.2 - CSS framework
- postcss 8.5.8 - CSS processing
- autoprefixer 10.4.27 - CSS vendor prefixes
- pino - JSON logging (included via fastify)
- pino-pretty 13.1.3 - Pretty console output (dev)
- pino-roll 4.0.0 - Log file rotation
- @elastic/ecs-pino-format 1.5.0 - Elastic Common Schema formatting
- pg 8.20.0 - PostgreSQL driver

## Configuration

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection (configured but not actively used in core)
- `JWT_SECRET`, `JWT_REFRESH_SECRET` - Auth tokens (min 32 chars)
- `ENCRYPTION_KEY` - Field-level encryption (min 32 chars)
- `CORS_ORIGIN` - Web app URL for CORS
- `APP_URL` - Frontend URL for email links
- `API_PORT`, `API_HOST` - API server binding (default 4000)
- `NODE_ENV` - development|production|test
- `SMTP_*` - Email server config (optional, can be set per-tenant in DB)
- `MINIO_*` - Object storage credentials
- `LOG_LEVEL` - Logging verbosity
- `LOG_FORMAT` - json|ecs|pretty
- `LOG_FILE` - Optional log file path with daily rotation
- `POOL_MIN`, `POOL_MAX` - Database connection pool
- `SEED_DEMO_DATA` - Bootstrap demo data on startup
- `tsconfig.json` - Present in all packages
- `vite.config.ts` - SvelteKit Vite config
- `.prettierrc` - 2-space indent, trailing commas, 100 char width
- `eslint.config.js` - Flat config with TypeScript, Svelte, Prettier

## Platform Requirements

- Node.js 24+ (uses ES modules)
- pnpm 10.33.0
- Docker & Docker Compose (for services: PostgreSQL, Redis, MinIO)
- Git with Husky hooks
- Docker/Kubernetes with Node.js 24-alpine base
- PostgreSQL 18
- Redis 7 (optional, configured but unused)
- MinIO (S3-compatible object storage)
- SMTP server (optional, configurable per tenant)
- PostgreSQL 18-alpine:5432
- Redis 7-alpine:6379
- MinIO:9000,9001 (S3 API + console)
- Optional backup service (pg_dump daily, 7-day retention)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- API route files: kebab-case, singular noun — `time-entries.ts`, `company-shutdowns.ts`, `audit-logs.ts`
- API utility files: kebab-case — `vacation-calc.ts`, `password-policy.ts`, `timezone.ts`
- API plugin files: kebab-case — `prisma.ts`, `audit.ts`, `auto-close-month.ts`
- Svelte pages: SvelteKit convention — `+page.svelte`, `+layout.svelte`
- Svelte components: PascalCase — `Toast.svelte`, `EmptyState.svelte`, `CommandPalette.svelte`, `Breadcrumb.svelte`
- Svelte stores: camelCase — `auth.ts`, `toast.ts`, `theme.ts`
- Test files: `{name}.test.ts` in `__tests__/` directories
- camelCase for all functions — `requireAuth`, `seedTestData`, `checkArbZG`, `calcBreakMinutes`
- Route registrations: `async function {domain}Routes(app: FastifyInstance)` — e.g., `employeeRoutes`, `timeEntryRoutes`, `leaveRoutes`
- Utility exports: named exports of pure functions — `getHolidays()`, `todayInTz()`, `validatePassword()`
- Helper functions in route files: module-scoped, private (not exported) — `calcBreakMinutes()`, `validateBreakSlots()`, `checkOverlap()`
- camelCase for all variables — `adminToken`, `empUser`, `vacationType`
- Constants: UPPER_SNAKE_CASE for domain constants — `TYPE_CODES`, `LEAVE_TYPE_DEFS`, `LEGACY_ALIASES`, `CACHE_TTL_MS`
- State variables in Svelte: `let varName = $state(initialValue)` — `let loading = $state(false)`, `let entries: TimeEntry[] = $state([])`
- PascalCase for all types and interfaces — `JwtPayload`, `ArbZGWarning`, `CalDay`, `AuthState`
- Prefix `Props` for Svelte component props interfaces
- Zod schemas: camelCase with `Schema` suffix — `createEmployeeSchema`, `idParamSchema`, `loginSchema`, `manualEntrySchema`

## Code Style

- Prettier (v3.8+) with `prettier-plugin-svelte`
- No explicit Prettier config file found (uses defaults: double quotes, trailing commas, semicolons)
- Pre-commit hook via Husky runs `lint-staged` which applies `eslint --fix` and `prettier --write`
- ESLint v10 with flat config at `/eslint.config.js`
- TypeScript ESLint recommended rules
- Svelte ESLint plugin (flat/recommended)
- Key rules:
- Strict mode enabled in both `apps/api/tsconfig.json` and `apps/web/tsconfig.json`
- Target: ES2022 (API), extended from SvelteKit (Web)
- `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`

## Language Conventions

- All user-facing strings, error messages, and labels are in German
- Examples: `"Mitarbeiter nicht gefunden"`, `"Ungültige Anmeldedaten"`, `"Konto temporär gesperrt"`
- Comments in route files mix German and English (German for domain terms, English for technical comments)
- All variable names, function names, type names in English
- Domain-specific German terms kept where they are proper nouns: `Monatsabschluss`, `Sonderurlaub`, `Betriebsurlaub`, `ArbZG`

## Import Organization

- `$lib` -> `src/lib`
- `$components` -> `src/lib/components`
- `$stores` -> `src/lib/stores`
- `$api` -> `src/lib/api`

## Error Handling

- Global error handler in `apps/api/src/app.ts` catches ZodErrors and converts them to `{ error: string, message: string, details: [] }` with HTTP 400
- All other errors return `{ error: string }` with appropriate status code
- German error messages for user-facing responses: `"Validierungsfehler"`, `"Interner Serverfehler"`
- Return early with `reply.code(XXX).send({ error: "German message" })` — no `throw`
- Common HTTP codes used:
- `ApiError` class in `apps/web/src/lib/api/client.ts` wraps fetch errors with `status`, `message`, `data`
- Automatic 401 handling: tries token refresh, redirects to `/login` on failure
- Toast notifications for user-visible errors via `toasts.error("message")`
- Client-side error logging via `apps/web/src/lib/utils/logger.ts` which sends errors to `/api/v1/logs/client`

## Logging

- Structured JSON logging in production, `pino-pretty` in development
- ECS (Elastic Common Schema) format available via `LOG_FORMAT=ecs`
- Optional file logging via `LOG_FILE` env var with daily rotation (`pino-roll`)
- Request context enrichment: `userId`, `tenantId`, `role` added via `onRequest` hook
- Request completion logged via `onResponse` hook with method, URL, status, response time
- `clientLogger` at `apps/web/src/lib/utils/logger.ts` batches and sends errors to `/api/v1/logs/client`
- `console.error` and `console.warn` allowed by ESLint config
- `console.log` produces lint warnings

## Comments

- Section separators: `// ── Section Name ──────────────────` used throughout route files and app.ts to visually separate logical blocks
- JSDoc-style comments for utility functions that have non-obvious behavior — see `apps/api/src/utils/timezone.ts`
- German domain context comments where business rules apply: `// Einladung nur erstellen wenn kein Passwort gesetzt`
- TODO comments for known future work: `// TODO: separate test DB for CI`
- Used sparingly — mainly on exported utility functions and plugin interfaces
- Declare module augmentation blocks use JSDoc for plugin-decorated properties:

## Function/Route Design

- Each route file exports a single async function: `export async function fooRoutes(app: FastifyInstance)`
- Zod schemas defined at module top as `const` — `createSchema`, `updateSchema`, `idParamSchema`
- Route definition uses `app.method(path, { schema, preHandler, handler })` inline object syntax
- Validation: `schema.parse(req.body)` or `schema.parse(req.params)` inside handler (throws ZodError caught by global handler)
- Swagger tags use German domain names: `tags: ["Mitarbeiter"]`, `tags: ["Auth"]`
- Use `fastify-plugin` (`fp`) wrapper for plugins that decorate the app instance
- Declare module augmentation for type safety
- Example at `apps/api/src/plugins/audit.ts`, `apps/api/src/plugins/prisma.ts`

## Svelte 5 Patterns

- Use `$state()` for component-local reactive state: `let loading = $state(false)`
- Use `$derived()` for computed values: `let visible = $derived(items.slice(-5))`
- Use `$effect()` sparingly — prefer `onMount` for initialization
- Stores use `svelte/store` writable pattern (not Svelte 5 runes) for cross-component state: `apps/web/src/lib/stores/auth.ts`
- Define `interface Props` then destructure: `let { children }: Props = $props()`
- Use default values in destructuring: `let { icon = "inbox", title, description }: Props = $props()`
- Snippet-based children: `children?: import("svelte").Snippet`
- Direct `api.get()` / `api.post()` calls inside `onMount` or event handlers
- `@tanstack/svelte-query` is listed as a dependency but not currently used in routes (direct fetch pattern prevalent)
- Loading/error state managed locally per page
- Scoped `<style>` blocks in each component — no Tailwind utility classes in markup (Tailwind v4 installed but CSS is primarily custom)
- CSS custom properties for theming: `var(--color-brand)`, `var(--color-text)`, `var(--color-surface)`
- Global styles in `apps/web/src/app.css` (~1476 lines) with theme system (`data-theme` attribute)
- Four themes: `pflaume` (default), `nacht`, `wald`, `schiefer`
- BEM-like class naming: `.admin-tab`, `.admin-tab--active`, `.toast-container`, `.empty-state-title`
- Responsive via `@media` queries in component styles

## Module Design

- Route files: single named export — `export async function fooRoutes(app: FastifyInstance)`
- Utility files: multiple named exports of pure functions
- Plugin files: single named export — `export const fooPlugin = fp(async (app) => { ... })`
- Store files: single named export — `export const authStore = createAuthStore()`
- `@clokr/db`: Prisma client + generated types — imported as `import { PrismaClient } from "@clokr/db"`
- `@clokr/types`: Shared TypeScript interfaces — imported as `import { Role } from "@clokr/types"`

## Configuration Pattern

- Validated with Zod schema at startup in `apps/api/src/config.ts`
- Fails fast with detailed error output if validation fails
- Exported as typed `config` object: `export const config = parsed.data`
- Never accessed via `process.env` in route/plugin code — always through `config`

## Soft Delete Convention

- Models with `deletedAt` field (TimeEntry, LeaveRequest, Absence) use soft delete
- All queries on soft-deletable models MUST include `deletedAt: null` in the where clause
- Example: `where: { employeeId, deletedAt: null }`

## Multi-Tenancy Convention

- All data-access queries filter by `tenantId` from `req.user.tenantId`
- Employee lookups always scoped to tenant
- Tenant-specific config accessed via `TenantConfig` model
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## Pattern Overview

- Three-tier architecture: SvelteKit SPA (client-only rendering) -> Fastify REST API -> PostgreSQL via Prisma ORM
- Multi-tenant isolation via `tenantId` on every employee-scoped query
- Plugin-based API composition using Fastify's `register` + `decorate` pattern
- All data mutations produce audit log entries for compliance (Revisionssicherheit)
- Soft-delete on all core models (`deletedAt`) -- never hard-delete time/leave/absence data
- Background cron jobs run in-process via `node-cron` (no external job queue)

## Layers

- Purpose: REST API handling all business logic, authentication, validation, and data access
- Location: `apps/api/src/`
- Contains: Route handlers, Fastify plugins, middleware, utility functions, tests
- Depends on: `@clokr/db` (Prisma client), `@clokr/types` (shared types)
- Used by: Web frontend via HTTP proxy, NFC terminals, external API keys
- Purpose: SvelteKit SPA serving the UI; no server-side data fetching, all API calls from browser
- Location: `apps/web/src/`
- Contains: Svelte 5 components (runes), stores, API client, route pages
- Depends on: `@clokr/types` (shared types)
- Used by: End users (employees, managers, admins) via browser
- Purpose: Prisma schema, generated client, seed data
- Location: `packages/db/`
- Contains: `prisma/schema.prisma`, generated Prisma client, seed script
- Depends on: PostgreSQL (via `@prisma/adapter-pg`)
- Used by: API server (imports `@clokr/db` for all DB access)
- Purpose: Shared TypeScript type definitions between API and web
- Location: `packages/types/src/index.ts`
- Contains: Role, Employee, TimeEntry, LeaveRequest, OvertimeAccount interfaces
- Used by: Both `@clokr/api` and `@clokr/web`
- Purpose: Model Context Protocol server for Claude Code dev tooling
- Location: `packages/mcp/src/index.ts`
- Contains: MCP tools for querying the Clokr API during development
- Used by: Claude Code during development only
- Purpose: Tauri desktop app for NFC card-based clock-in/out at physical terminals
- Location: `apps/nfc-client/`
- Contains: Tauri Rust shell + web frontend, communicates with API
- Used by: Physical NFC terminal hardware
- Purpose: Playwright end-to-end tests
- Location: `apps/e2e/`
- Contains: Playwright test specs, config

## Data Flow

- Client-side state uses Svelte writable stores (`$stores/auth.ts`, `$stores/toast.ts`, `$stores/theme.ts`)
- Page-level state uses Svelte 5 `$state` and `$derived` runes within each `+page.svelte`
- No global state management library; each page fetches its own data via `api.get()` in `onMount`
- Auth tokens persisted in `localStorage`

## Key Abstractions

- Purpose: Encapsulate cross-cutting concerns as decoratable services on the Fastify instance
- Examples: `apps/api/src/plugins/prisma.ts`, `apps/api/src/plugins/audit.ts`, `apps/api/src/plugins/mailer.ts`, `apps/api/src/plugins/notify.ts`, `apps/api/src/plugins/storage.ts`, `apps/api/src/plugins/scheduler.ts`
- Pattern: Each plugin uses `fastify-plugin` (`fp()`) to register, calls `app.decorate()` to add services, and augments the `FastifyInstance` type via `declare module "fastify"`. Accessed everywhere as `app.prisma`, `app.audit()`, `app.notify()`, `app.mailer`, `app.storage`.
- Purpose: Group related API endpoints by domain
- Examples: `apps/api/src/routes/time-entries.ts`, `apps/api/src/routes/employees.ts`, `apps/api/src/routes/leave.ts`, `apps/api/src/routes/auth.ts`
- Pattern: Each exports an `async function xxxRoutes(app: FastifyInstance)` that registers GET/POST/PUT/DELETE handlers. Registered in `apps/api/src/app.ts` with URL prefix (e.g., `{ prefix: "/api/v1/time-entries" }`).
- Purpose: JWT/API-key authentication and role-based authorization
- Location: `apps/api/src/middleware/auth.ts`
- Pattern: `requireAuth` verifies JWT or API key (`clk_` prefix). `requireRole(...roles)` combines auth + role check. Used as `preHandler` on routes.
- Purpose: Cron-based background tasks running in the API process
- Plugins: `apps/api/src/plugins/attendance-checker.ts` (6 cron jobs), `apps/api/src/plugins/scheduler.ts` (Phorest sync), `apps/api/src/plugins/auto-close-month.ts` (monthly close), `apps/api/src/plugins/data-retention.ts` (annual archival)
- Pattern: Each plugin registers cron tasks via `node-cron`, starts in `onReady` hook, stops in `onClose` hook. Tasks are tenant-aware (loop over all tenants).
- Purpose: Typed HTTP client wrapping fetch with auth token injection and auto-refresh
- Location: `apps/web/src/lib/api/client.ts`
- Pattern: `api.get<T>()`, `api.post<T>()`, `api.put<T>()`, `api.patch<T>()`, `api.delete<T>()`. Auto-retries on 401 after token refresh. Throws `ApiError` with status code.
- Purpose: Separate authenticated app pages from public auth pages via layout groups
- `(app)` group: `apps/web/src/routes/(app)/` -- requires auth, has sidebar/nav layout
- `(auth)` group: `apps/web/src/routes/(auth)/` -- public pages (login, registration, password reset)

## Entry Points

- Location: `apps/api/src/index.ts`
- Triggers: `tsx watch src/index.ts` (dev) or `node dist/index.js` (prod)
- Responsibilities: Calls `buildApp()` from `apps/api/src/app.ts`, starts Fastify on configured port
- Location: `apps/api/src/app.ts`
- Triggers: Called by `index.ts` and by test setup
- Responsibilities: Creates Fastify instance, registers all plugins, middleware, and routes. Exports `buildApp()` for both production and test usage.
- Location: `apps/web/src/hooks.server.ts`
- Triggers: SvelteKit server startup
- Responsibilities: API proxy (forwards `/api/*` to Fastify backend), CSP headers, structured logging
- Location: `apps/web/src/routes/+page.svelte`
- Triggers: Navigation to `/`
- Responsibilities: Redirects to `/dashboard` (if authenticated) or `/login` (if not)
- Location: `apps/api/src/config.ts`
- Triggers: API startup
- Responsibilities: Validates all environment variables via Zod schema, exits with error if invalid

## Error Handling

- **Zod validation errors**: Global Fastify error handler in `apps/api/src/app.ts` catches `ZodError`, returns 400 with German field-level messages (`"Validierungsfehler"`)
- **Auth errors**: Middleware returns 401/403 directly via `reply.code()`
- **Business logic errors**: Route handlers return specific HTTP codes (404, 409, 422) with German error messages
- **Client errors**: `apps/web/src/lib/api/client.ts` throws `ApiError` with status and message, consumed by page-level `try/catch`
- **Client-side logging**: `apps/web/src/lib/utils/logger.ts` captures `window.onerror` and `unhandledrejection`, sends to `POST /api/v1/logs/client`
- **Server errors**: Fastify logger (Pino) with structured JSON output; supports pretty (dev), JSON, and ECS (Elastic) formats

## Cross-Cutting Concerns

- API: Pino via Fastify, configurable format (pretty/json/ecs), optional file output via `pino-roll`
- Web server: Structured JSON logging in `hooks.server.ts`
- Client: `clientLogger` in `apps/web/src/lib/utils/logger.ts` sends errors to API endpoint
- Request logging: `onResponse` hook logs method, URL, status, response time
- All API input validated via Zod schemas defined at the top of each route file
- Environment variables validated via Zod in `apps/api/src/config.ts`
- Frontend relies on API-side validation; forms submit and display API error messages
- JWT-based with access/refresh token pair
- API key support (`clk_` prefix) for programmatic access
- Terminal API keys for NFC devices (separate model)
- Session timeout with client-side inactivity detection
- Account lockout after configurable failed attempts
- Every employee belongs to a `Tenant` via `tenantId`
- JWT payload includes `tenantId`; all queries filter by it
- `TenantConfig` holds per-tenant settings (work hours, SMTP, compliance rules, etc.)
- Background jobs iterate over all tenants
- `app.audit()` plugin creates `AuditLog` entries with userId, action, entity, entityId, old/new values, IP, user agent
- Required for all create/update/delete operations on core models
- SYSTEM user ID used for automated actions (cron jobs)
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.

<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.

<!-- GSD:profile-end -->
