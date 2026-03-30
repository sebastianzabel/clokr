# Coding Conventions

**Analysis Date:** 2026-03-30

## Naming Patterns

**Files:**

- API route files: kebab-case, singular noun — `time-entries.ts`, `company-shutdowns.ts`, `audit-logs.ts`
- API utility files: kebab-case — `vacation-calc.ts`, `password-policy.ts`, `timezone.ts`
- API plugin files: kebab-case — `prisma.ts`, `audit.ts`, `auto-close-month.ts`
- Svelte pages: SvelteKit convention — `+page.svelte`, `+layout.svelte`
- Svelte components: PascalCase — `Toast.svelte`, `EmptyState.svelte`, `CommandPalette.svelte`, `Breadcrumb.svelte`
- Svelte stores: camelCase — `auth.ts`, `toast.ts`, `theme.ts`
- Test files: `{name}.test.ts` in `__tests__/` directories

**Functions:**

- camelCase for all functions — `requireAuth`, `seedTestData`, `checkArbZG`, `calcBreakMinutes`
- Route registrations: `async function {domain}Routes(app: FastifyInstance)` — e.g., `employeeRoutes`, `timeEntryRoutes`, `leaveRoutes`
- Utility exports: named exports of pure functions — `getHolidays()`, `todayInTz()`, `validatePassword()`
- Helper functions in route files: module-scoped, private (not exported) — `calcBreakMinutes()`, `validateBreakSlots()`, `checkOverlap()`

**Variables:**

- camelCase for all variables — `adminToken`, `empUser`, `vacationType`
- Constants: UPPER_SNAKE_CASE for domain constants — `TYPE_CODES`, `LEAVE_TYPE_DEFS`, `LEGACY_ALIASES`, `CACHE_TTL_MS`
- State variables in Svelte: `let varName = $state(initialValue)` — `let loading = $state(false)`, `let entries: TimeEntry[] = $state([])`

**Types/Interfaces:**

- PascalCase for all types and interfaces — `JwtPayload`, `ArbZGWarning`, `CalDay`, `AuthState`
- Prefix `Props` for Svelte component props interfaces
- Zod schemas: camelCase with `Schema` suffix — `createEmployeeSchema`, `idParamSchema`, `loginSchema`, `manualEntrySchema`

## Code Style

**Formatting:**

- Prettier (v3.8+) with `prettier-plugin-svelte`
- No explicit Prettier config file found (uses defaults: double quotes, trailing commas, semicolons)
- Pre-commit hook via Husky runs `lint-staged` which applies `eslint --fix` and `prettier --write`

**Linting:**

- ESLint v10 with flat config at `/eslint.config.js`
- TypeScript ESLint recommended rules
- Svelte ESLint plugin (flat/recommended)
- Key rules:
  - `@typescript-eslint/no-explicit-any`: warn (not error)
  - `@typescript-eslint/no-unused-vars`: warn with `^_` pattern for intentionally unused args
  - `no-console`: warn (allows `console.warn` and `console.error`)
  - `no-empty`: warn

**TypeScript:**

- Strict mode enabled in both `apps/api/tsconfig.json` and `apps/web/tsconfig.json`
- Target: ES2022 (API), extended from SvelteKit (Web)
- `esModuleInterop: true`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`

## Language Conventions

**UI text: German (Deutsch)**

- All user-facing strings, error messages, and labels are in German
- Examples: `"Mitarbeiter nicht gefunden"`, `"Ungültige Anmeldedaten"`, `"Konto temporär gesperrt"`
- Comments in route files mix German and English (German for domain terms, English for technical comments)

**Code/docs/commits: English**

- All variable names, function names, type names in English
- Domain-specific German terms kept where they are proper nouns: `Monatsabschluss`, `Sonderurlaub`, `Betriebsurlaub`, `ArbZG`

## Import Organization

**Order:**

1. Node.js built-ins — `import crypto from "crypto"`, `import { resolve } from "path"`
2. External packages — `import Fastify from "fastify"`, `import { z } from "zod"`
3. Internal workspace packages — `import { PrismaClient } from "@clokr/db"`, `import { Role } from "@clokr/db"`
4. Local absolute/alias imports — `import { authStore } from "$stores/auth"`, `import { api } from "$api/client"`
5. Relative imports — `import { requireAuth } from "../middleware/auth"`, `import { config } from "./config"`

**Path Aliases (SvelteKit `apps/web`):**

- `$lib` -> `src/lib`
- `$components` -> `src/lib/components`
- `$stores` -> `src/lib/stores`
- `$api` -> `src/lib/api`

**No barrel files:** Direct imports to specific files throughout. No `index.ts` re-exports (except `packages/types/src/index.ts` and `apps/api/src/index.ts` which is an entry point).

## Error Handling

**API Error Pattern:**

- Global error handler in `apps/api/src/app.ts` catches ZodErrors and converts them to `{ error: string, message: string, details: [] }` with HTTP 400
- All other errors return `{ error: string }` with appropriate status code
- German error messages for user-facing responses: `"Validierungsfehler"`, `"Interner Serverfehler"`

**Route-level errors:**

- Return early with `reply.code(XXX).send({ error: "German message" })` — no `throw`
- Common HTTP codes used:
  - `400` — validation errors
  - `401` — unauthorized / invalid credentials
  - `403` — forbidden / insufficient role
  - `404` — resource not found: `"Mitarbeiter nicht gefunden"`
  - `409` — conflict (duplicate entry, already closed, already active)
  - `423` — account locked
  - `502` — upstream error (email sending failed)

**Frontend errors:**

- `ApiError` class in `apps/web/src/lib/api/client.ts` wraps fetch errors with `status`, `message`, `data`
- Automatic 401 handling: tries token refresh, redirects to `/login` on failure
- Toast notifications for user-visible errors via `toasts.error("message")`
- Client-side error logging via `apps/web/src/lib/utils/logger.ts` which sends errors to `/api/v1/logs/client`

## Logging

**API Framework:** Pino (via Fastify's built-in logger)

- Structured JSON logging in production, `pino-pretty` in development
- ECS (Elastic Common Schema) format available via `LOG_FORMAT=ecs`
- Optional file logging via `LOG_FILE` env var with daily rotation (`pino-roll`)
- Request context enrichment: `userId`, `tenantId`, `role` added via `onRequest` hook
- Request completion logged via `onResponse` hook with method, URL, status, response time

**Log levels:** `trace`, `debug`, `info`, `warn`, `error`, `fatal`

**Usage pattern:**

```typescript
app.log.error(error); // Structured error logging
app.log.error({ err }, "Description"); // Error with context
req.log.info({ msg: "...", http: {} }); // Request-scoped logging
```

**Frontend logging:**

- `clientLogger` at `apps/web/src/lib/utils/logger.ts` batches and sends errors to `/api/v1/logs/client`
- `console.error` and `console.warn` allowed by ESLint config
- `console.log` produces lint warnings

## Comments

**When to Comment:**

- Section separators: `// ── Section Name ──────────────────` used throughout route files and app.ts to visually separate logical blocks
- JSDoc-style comments for utility functions that have non-obvious behavior — see `apps/api/src/utils/timezone.ts`
- German domain context comments where business rules apply: `// Einladung nur erstellen wenn kein Passwort gesetzt`
- TODO comments for known future work: `// TODO: separate test DB for CI`

**JSDoc/TSDoc:**

- Used sparingly — mainly on exported utility functions and plugin interfaces
- Declare module augmentation blocks use JSDoc for plugin-decorated properties:
  ```typescript
  declare module "fastify" {
    interface FastifyInstance {
      audit: (params: { ... }) => Promise<void>;
    }
  }
  ```

## Function/Route Design

**Route Handler Pattern:**

- Each route file exports a single async function: `export async function fooRoutes(app: FastifyInstance)`
- Zod schemas defined at module top as `const` — `createSchema`, `updateSchema`, `idParamSchema`
- Route definition uses `app.method(path, { schema, preHandler, handler })` inline object syntax
- Validation: `schema.parse(req.body)` or `schema.parse(req.params)` inside handler (throws ZodError caught by global handler)
- Swagger tags use German domain names: `tags: ["Mitarbeiter"]`, `tags: ["Auth"]`

**Audit Trail Pattern (mandatory for data mutations):**

```typescript
await app.audit({
  userId: req.user.sub,
  action: "CREATE" | "UPDATE" | "DELETE" | "ANONYMIZE",
  entity: "Employee" | "TimeEntry" | "LeaveRequest",
  entityId: id,
  oldValue: previousData,
  newValue: updatedData,
  request: { ip: req.ip, headers: req.headers as Record<string, string> },
});
```

**Fastify Plugin Pattern:**

- Use `fastify-plugin` (`fp`) wrapper for plugins that decorate the app instance
- Declare module augmentation for type safety
- Example at `apps/api/src/plugins/audit.ts`, `apps/api/src/plugins/prisma.ts`

## Svelte 5 Patterns

**State Management:**

- Use `$state()` for component-local reactive state: `let loading = $state(false)`
- Use `$derived()` for computed values: `let visible = $derived(items.slice(-5))`
- Use `$effect()` sparingly — prefer `onMount` for initialization
- Stores use `svelte/store` writable pattern (not Svelte 5 runes) for cross-component state: `apps/web/src/lib/stores/auth.ts`

**Component Props:**

- Define `interface Props` then destructure: `let { children }: Props = $props()`
- Use default values in destructuring: `let { icon = "inbox", title, description }: Props = $props()`
- Snippet-based children: `children?: import("svelte").Snippet`

**Data Fetching:**

- Direct `api.get()` / `api.post()` calls inside `onMount` or event handlers
- `@tanstack/svelte-query` is listed as a dependency but not currently used in routes (direct fetch pattern prevalent)
- Loading/error state managed locally per page

**CSS:**

- Scoped `<style>` blocks in each component — no Tailwind utility classes in markup (Tailwind v4 installed but CSS is primarily custom)
- CSS custom properties for theming: `var(--color-brand)`, `var(--color-text)`, `var(--color-surface)`
- Global styles in `apps/web/src/app.css` (~1476 lines) with theme system (`data-theme` attribute)
- Four themes: `pflaume` (default), `nacht`, `wald`, `schiefer`
- BEM-like class naming: `.admin-tab`, `.admin-tab--active`, `.toast-container`, `.empty-state-title`
- Responsive via `@media` queries in component styles

## Module Design

**Exports:**

- Route files: single named export — `export async function fooRoutes(app: FastifyInstance)`
- Utility files: multiple named exports of pure functions
- Plugin files: single named export — `export const fooPlugin = fp(async (app) => { ... })`
- Store files: single named export — `export const authStore = createAuthStore()`

**Workspace packages:**

- `@clokr/db`: Prisma client + generated types — imported as `import { PrismaClient } from "@clokr/db"`
- `@clokr/types`: Shared TypeScript interfaces — imported as `import { Role } from "@clokr/types"`

## Configuration Pattern

**Environment variables:**

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

---

_Convention analysis: 2026-03-30_
