# Codebase Structure

**Analysis Date:** 2026-03-30

## Directory Layout

```
clokr/
├── apps/
│   ├── api/                    # Fastify REST API server
│   │   ├── src/
│   │   │   ├── __tests__/      # Top-level integration tests
│   │   │   ├── middleware/      # Auth middleware (JWT + API keys)
│   │   │   ├── plugins/        # Fastify plugins (prisma, audit, mailer, etc.)
│   │   │   ├── routes/         # Route handlers by domain
│   │   │   │   └── __tests__/  # Route-specific tests
│   │   │   ├── services/       # Service layer (currently empty)
│   │   │   ├── utils/          # Utility functions (ArbZG, holidays, timezone, etc.)
│   │   │   │   └── __tests__/  # Utility tests
│   │   │   ├── app.ts          # Fastify app builder (plugins + routes)
│   │   │   ├── config.ts       # Env var validation via Zod
│   │   │   └── index.ts        # Server entry point
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── web/                    # SvelteKit frontend (SPA)
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── api/        # API client (fetch wrapper with auth)
│   │   │   │   ├── components/
│   │   │   │   │   ├── layout/ # Layout components (currently empty)
│   │   │   │   │   └── ui/     # Shared UI components (Toast, CommandPalette, etc.)
│   │   │   │   ├── stores/     # Svelte stores (auth, toast, theme)
│   │   │   │   └── utils/      # Frontend utilities (logger, focus-trap, chart-theme)
│   │   │   ├── routes/
│   │   │   │   ├── (app)/      # Authenticated app pages (sidebar layout)
│   │   │   │   │   ├── admin/  # Admin section with sub-tabs
│   │   │   │   │   │   ├── audit/
│   │   │   │   │   │   ├── employees/
│   │   │   │   │   │   ├── import/
│   │   │   │   │   │   ├── monatsabschluss/
│   │   │   │   │   │   ├── shifts/
│   │   │   │   │   │   ├── shutdowns/
│   │   │   │   │   │   ├── special-leave/
│   │   │   │   │   │   ├── system/
│   │   │   │   │   │   └── vacation/
│   │   │   │   │   ├── dashboard/
│   │   │   │   │   ├── employees/
│   │   │   │   │   ├── leave/
│   │   │   │   │   ├── overtime/
│   │   │   │   │   ├── reports/
│   │   │   │   │   ├── settings/
│   │   │   │   │   └── time-entries/
│   │   │   │   ├── (auth)/     # Public auth pages (no sidebar)
│   │   │   │   │   ├── einladung/
│   │   │   │   │   ├── forgot-password/
│   │   │   │   │   ├── login/
│   │   │   │   │   ├── otp/
│   │   │   │   │   └── reset-password/
│   │   │   │   ├── +layout.svelte   # Root layout (theme, Toast)
│   │   │   │   └── +page.svelte     # Root redirect (→ dashboard or login)
│   │   │   ├── app.css         # Global CSS / design tokens
│   │   │   ├── app.d.ts        # Global type declarations
│   │   │   └── hooks.server.ts # API proxy + CSP headers
│   │   ├── static/             # Static assets (icons, fonts)
│   │   ├── svelte.config.js    # SvelteKit config (adapter-node, aliases)
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── e2e/                    # Playwright E2E tests
│   │   ├── tests/              # Test spec files
│   │   └── playwright.config.ts
│   └── nfc-client/             # Tauri NFC terminal app
│       ├── dist/               # Built web assets
│       └── src-tauri/          # Rust Tauri shell
├── packages/
│   ├── db/                     # Prisma database package
│   │   ├── prisma/
│   │   │   └── schema.prisma   # Database schema (all models, enums, relations)
│   │   ├── generated/
│   │   │   └── client/         # Generated Prisma client (DO NOT EDIT)
│   │   ├── src/
│   │   │   └── seed.ts         # Demo data seeder
│   │   ├── prisma.config.ts    # Prisma config (adapter-pg)
│   │   └── package.json
│   ├── types/                  # Shared TypeScript types
│   │   └── src/
│   │       └── index.ts        # Role, Employee, TimeEntry, etc.
│   ├── mcp/                    # MCP server for Claude Code dev tools
│   │   └── src/
│   │       └── index.ts
│   └── openapi/                # OpenAPI spec package (exists but minimal)
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI pipeline (lint, typecheck, test, build)
│       ├── build-push.yml      # Docker build + push + Trivy scan
│       ├── release.yml         # Release workflow
│       ├── cleanup-images.yml  # Docker image cleanup
│       └── dependabot-auto-approve.yml
├── docker-compose.yml          # Dev stack (postgres, redis, minio, api, web)
├── docker-compose.prod.yml     # Production compose
├── turbo.json                  # Turborepo task config
├── pnpm-workspace.yaml         # Workspace definition
├── package.json                # Root package (scripts, devDependencies)
├── eslint.config.js            # Shared ESLint config
├── .prettierrc                 # Prettier config
├── .trivyignore                # Trivy CVE exceptions
├── CLAUDE.md                   # Project rules for AI assistants
└── FEATURES.md                 # Feature documentation
```

## Directory Purposes

**`apps/api/src/routes/`:**

- Purpose: REST API endpoint handlers grouped by domain
- Contains: One file per domain (e.g., `time-entries.ts`, `employees.ts`, `leave.ts`)
- Key files: `apps/api/src/routes/time-entries.ts` (core time tracking), `apps/api/src/routes/employees.ts` (employee CRUD + DSGVO anonymization), `apps/api/src/routes/auth.ts` (login, OTP, refresh), `apps/api/src/routes/leave.ts` (vacation/leave management)
- Pattern: Each file exports `async function xxxRoutes(app: FastifyInstance)` registered with a URL prefix

**`apps/api/src/plugins/`:**

- Purpose: Fastify plugins that add services to the app instance
- Contains: Database (prisma), audit logging, email (mailer), notifications (notify), file storage (MinIO), background schedulers
- Key files: `apps/api/src/plugins/prisma.ts` (DB connection pool), `apps/api/src/plugins/audit.ts` (audit trail), `apps/api/src/plugins/attendance-checker.ts` (6 cron jobs for reminders/invalidation), `apps/api/src/plugins/auto-close-month.ts` (monthly saldo snapshot + lock)

**`apps/api/src/middleware/`:**

- Purpose: Request-level middleware (authentication, authorization)
- Contains: `auth.ts` -- JWT verification, API key auth, role-based access control
- Key file: `apps/api/src/middleware/auth.ts`

**`apps/api/src/utils/`:**

- Purpose: Pure utility functions for business logic calculations
- Contains: ArbZG compliance checks, holiday calculations, timezone handling, vacation calculations, PDF generation, password policy
- Key files: `apps/api/src/utils/arbzg.ts` (working time law checks), `apps/api/src/utils/timezone.ts` (tenant-aware TZ handling), `apps/api/src/utils/vacation-calc.ts` (leave entitlement calculation), `apps/api/src/utils/holidays.ts` (German public holiday generation)

**`apps/web/src/lib/`:**

- Purpose: Shared frontend code (stores, API client, components, utilities)
- Contains: Svelte stores, API client wrapper, reusable UI components, utility functions

**`apps/web/src/routes/(app)/`:**

- Purpose: Authenticated application pages with sidebar navigation
- Contains: Dashboard, time entries, leave, reports, overtime, admin section, settings, employees
- Layout: `+layout.svelte` provides sidebar nav, notification bell, user menu, auth guard, inactivity timeout

**`apps/web/src/routes/(auth)/`:**

- Purpose: Public authentication pages (no sidebar)
- Contains: Login, OTP verification, invitation acceptance, password reset, forgot password

**`apps/web/src/routes/(app)/admin/`:**

- Purpose: Admin-only section with tabbed sub-navigation
- Contains: Employee management, vacation/time overview, shift planning, monthly close, system settings, audit log, data import
- Layout: `+layout.svelte` adds tab navigation and ADMIN/MANAGER role guard

**`packages/db/prisma/`:**

- Purpose: Database schema definition
- Key file: `packages/db/prisma/schema.prisma` -- all models, enums, relations, indexes
- Generated: `packages/db/generated/client/` (auto-generated, committed)

## Key File Locations

**Entry Points:**

- `apps/api/src/index.ts`: API server startup
- `apps/api/src/app.ts`: Fastify app builder (all plugins + routes registered here)
- `apps/web/src/hooks.server.ts`: SvelteKit server hook (API proxy + CSP)
- `apps/web/src/routes/+page.svelte`: Root page (redirect logic)

**Configuration:**

- `apps/api/src/config.ts`: Environment variable validation (Zod schema)
- `packages/db/prisma/schema.prisma`: Database schema
- `apps/web/svelte.config.js`: SvelteKit config (adapter, aliases)
- `docker-compose.yml`: Development Docker stack
- `turbo.json`: Monorepo task orchestration
- `.prettierrc`: Code formatting rules
- `eslint.config.js`: Linting rules

**Core Business Logic:**

- `apps/api/src/routes/time-entries.ts`: Time entry CRUD, clock-in/out, NFC punch, overlap/conflict validation
- `apps/api/src/routes/employees.ts`: Employee CRUD, DSGVO anonymization, schedule management
- `apps/api/src/routes/leave.ts`: Leave requests, approval workflow, cancellation flow
- `apps/api/src/routes/overtime.ts`: Overtime saldo calculation, transactions, plans
- `apps/api/src/plugins/auto-close-month.ts`: Monthly/yearly saldo snapshot creation + entry locking
- `apps/api/src/utils/arbzg.ts`: German working time law compliance checks
- `apps/api/src/utils/vacation-calc.ts`: Vacation entitlement and carry-over calculations
- `apps/api/src/utils/timezone.ts`: Tenant-aware timezone operations (critical for date handling)

**Authentication:**

- `apps/api/src/middleware/auth.ts`: JWT + API key auth
- `apps/api/src/routes/auth.ts`: Login, OTP, refresh, password reset endpoints
- `apps/web/src/lib/stores/auth.ts`: Client-side auth state (tokens in localStorage)
- `apps/web/src/lib/api/client.ts`: Auto-refresh HTTP client

**Testing:**

- `apps/api/src/__tests__/`: Integration tests (auth, employees, leave, time-entries, overtime, saldo-snapshot, etc.)
- `apps/api/src/routes/__tests__/`: Route-specific tests (ArbZG, breaks, minijob, NFC punch, reports, etc.)
- `apps/api/src/utils/__tests__/`: Utility tests (holidays, timezone, vacation-calc)
- `apps/e2e/tests/`: Playwright E2E tests

## Naming Conventions

**Files:**

- Route files: `kebab-case.ts` (e.g., `time-entries.ts`, `company-shutdowns.ts`, `special-leave.ts`)
- Plugin files: `kebab-case.ts` (e.g., `attendance-checker.ts`, `auto-close-month.ts`)
- Utility files: `kebab-case.ts` (e.g., `vacation-calc.ts`, `password-policy.ts`)
- Test files: `kebab-case.test.ts` (e.g., `auth.test.ts`, `arbzg.test.ts`)
- Svelte components: `PascalCase.svelte` (e.g., `CommandPalette.svelte`, `Toast.svelte`, `EmptyState.svelte`)
- Svelte pages: `+page.svelte` (SvelteKit convention)
- Svelte layouts: `+layout.svelte` (SvelteKit convention)
- Store files: `kebab-case.ts` (e.g., `auth.ts`, `toast.ts`, `theme.ts`)

**Directories:**

- Route groups: `(group-name)/` with parentheses (SvelteKit convention: `(app)`, `(auth)`)
- Feature directories: `kebab-case/` (e.g., `time-entries/`, `special-leave/`, `monatsabschluss/`)
- Test directories: `__tests__/` (double underscore convention)

**Exports:**

- Route modules: `export async function xxxRoutes(app: FastifyInstance)` (named export, camelCase)
- Plugin modules: `export const xxxPlugin = fp(async (app) => { ... })` (named const export)
- Stores: `export const xxxStore = createXxxStore()` (named const)
- Utilities: Named function exports (e.g., `export function checkArbZG(...)`, `export async function requireAuth(...)`)

## Where to Add New Code

**New API Route (e.g., "absences"):**

1. Create route handler: `apps/api/src/routes/absences.ts`
2. Export: `export async function absenceRoutes(app: FastifyInstance) { ... }`
3. Register in `apps/api/src/app.ts`: `await app.register(absenceRoutes, { prefix: "/api/v1/absences" })`
4. Add tests: `apps/api/src/routes/__tests__/absences.test.ts` or `apps/api/src/__tests__/absences.test.ts`

**New Fastify Plugin (e.g., "redis-cache"):**

1. Create plugin: `apps/api/src/plugins/redis-cache.ts`
2. Use `fp()` wrapper, `app.decorate()`, augment `FastifyInstance` type
3. Register in `apps/api/src/app.ts` (before routes that use it)

**New Frontend Page (e.g., "/absences"):**

1. Create page: `apps/web/src/routes/(app)/absences/+page.svelte`
2. Use Svelte 5 runes (`$state`, `$derived`, `$props`)
3. Fetch data via `api.get<T>()` in `onMount`
4. Add nav item in `apps/web/src/routes/(app)/+layout.svelte` `navItems` array

**New Admin Sub-page (e.g., "/admin/terminals"):**

1. Create page: `apps/web/src/routes/(app)/admin/terminals/+page.svelte`
2. Add tab entry in `apps/web/src/routes/(app)/admin/+layout.svelte` `tabs` array

**New Shared UI Component:**

1. Create: `apps/web/src/lib/components/ui/ComponentName.svelte`
2. Import via: `import ComponentName from "$lib/components/ui/ComponentName.svelte"`

**New Svelte Store:**

1. Create: `apps/web/src/lib/stores/store-name.ts`
2. Import via: `import { storeName } from "$stores/store-name"`

**New API Utility Function:**

1. Create: `apps/api/src/utils/utility-name.ts`
2. Add tests: `apps/api/src/utils/__tests__/utility-name.test.ts`

**New Prisma Model:**

1. Add model to `packages/db/prisma/schema.prisma`
2. Run `pnpm --filter @clokr/db exec prisma db push` to sync schema
3. Run `pnpm --filter @clokr/db exec prisma generate` to regenerate client
4. Import types from `@clokr/db` in API code

**New Shared Type:**

1. Add to `packages/types/src/index.ts`
2. Available in both `@clokr/api` and `@clokr/web` via `@clokr/types`

## Special Directories

**`packages/db/generated/client/`:**

- Purpose: Auto-generated Prisma client code
- Generated: Yes (by `prisma generate`)
- Committed: Yes (committed to git for deployment)
- WARNING: Do NOT edit manually

**`.svelte-kit/`:**

- Purpose: SvelteKit build artifacts
- Generated: Yes (by SvelteKit)
- Committed: No (gitignored)

**`apps/api/dist/`:**

- Purpose: Compiled TypeScript output
- Generated: Yes (by `tsc`)
- Committed: No (gitignored)

**`.planning/`:**

- Purpose: Planning and analysis documents for GSD workflow
- Generated: Yes (by Claude Code)
- Committed: Yes

**`node_modules/`:**

- Purpose: Installed dependencies (hoisted by pnpm)
- Generated: Yes
- Committed: No

## Path Aliases (SvelteKit)

Use these aliases when importing in `apps/web/`:

| Alias         | Resolves to          | Example                                           |
| ------------- | -------------------- | ------------------------------------------------- |
| `$lib`        | `src/lib`            | `import Foo from "$lib/components/ui/Foo.svelte"` |
| `$components` | `src/lib/components` | `import Bar from "$components/ui/Bar.svelte"`     |
| `$stores`     | `src/lib/stores`     | `import { authStore } from "$stores/auth"`        |
| `$api`        | `src/lib/api`        | `import { api } from "$api/client"`               |

Defined in `apps/web/svelte.config.js`.

## API Route Prefixes

All API routes are versioned under `/api/v1/`:

| Prefix                      | Route File                    | Domain                |
| --------------------------- | ----------------------------- | --------------------- |
| `/api/v1/auth`              | `routes/auth.ts`              | Authentication        |
| `/api/v1/employees`         | `routes/employees.ts`         | Employee management   |
| `/api/v1/time-entries`      | `routes/time-entries.ts`      | Time tracking         |
| `/api/v1/leave`             | `routes/leave.ts`             | Leave/vacation        |
| `/api/v1/overtime`          | `routes/overtime.ts`          | Overtime saldo        |
| `/api/v1/reports`           | `routes/reports.ts`           | Reports/exports       |
| `/api/v1/settings`          | `routes/settings.ts`          | Tenant settings       |
| `/api/v1/holidays`          | `routes/holidays.ts`          | Public holidays       |
| `/api/v1/invitations`       | `routes/invitations.ts`       | User invitations      |
| `/api/v1/audit-logs`        | `routes/audit-logs.ts`        | Audit trail           |
| `/api/v1/company-shutdowns` | `routes/company-shutdowns.ts` | Company shutdowns     |
| `/api/v1/dashboard`         | `routes/dashboard.ts`         | Dashboard data        |
| `/api/v1/notifications`     | `routes/notifications.ts`     | In-app notifications  |
| `/api/v1/shifts`            | `routes/shifts.ts`            | Shift planning        |
| `/api/v1/integrations`      | `routes/integrations.ts`      | External integrations |
| `/api/v1/imports`           | `routes/imports.ts`           | Data import           |
| `/api/v1/terminals`         | `routes/terminals.ts`         | NFC terminal API      |
| `/api/v1/special-leave`     | `routes/special-leave.ts`     | Special leave rules   |
| `/api/v1/avatars`           | `routes/avatars.ts`           | Employee avatars      |
| `/api/v1/api-keys`          | `routes/api-keys.ts`          | API key management    |

---

_Structure analysis: 2026-03-30_
