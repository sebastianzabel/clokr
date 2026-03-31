# Technology Stack: Production-Readiness Layer

**Project:** Clokr — German time tracking SaaS (brownfield hardening milestone)
**Researched:** 2026-03-30
**Scope:** What to ADD or ENFORCE on top of the existing Fastify + SvelteKit + Prisma stack

---

## Context: What Already Exists

The base stack is fixed and healthy (no migrations):

| Layer                        | Existing                   | Version         |
| ---------------------------- | -------------------------- | --------------- |
| API framework                | Fastify                    | 5.8.4           |
| Web framework                | SvelteKit + Svelte 5       | 2.55.0 / 5.55.0 |
| ORM                          | Prisma                     | 7.6.0           |
| Database                     | PostgreSQL                 | 18-alpine       |
| Unit/integration test runner | Vitest                     | 4.1.2           |
| E2E test runner              | Playwright                 | 1.58.2          |
| Coverage provider            | @vitest/coverage-v8        | 4.1.1           |
| Linter                       | ESLint + typescript-eslint | 10.1.0 / 8.57.2 |
| Formatter                    | Prettier                   | 3.8.1           |
| Pre-commit hooks             | husky + lint-staged        | 9.1.7 / 16.4.0  |

This document covers the **production-readiness gap**: what is missing, what needs configuration change, and what needs to be added.

---

## Recommended Additions

### 1. Error Tracking

**Add: `@sentry/node` + `@sentry/sveltekit`**

| Package             | Version    | Purpose                                                        |
| ------------------- | ---------- | -------------------------------------------------------------- |
| `@sentry/node`      | `^10.46.0` | API error capture, performance tracing, Fastify v5 integration |
| `@sentry/sveltekit` | `^10.46.0` | Web error capture, web vitals, SSR error boundaries            |

**Why Sentry over alternatives:**

- Sentry has first-party guides for both Fastify 5 and SvelteKit 2. No adapter shim required.
- `Sentry.fastifyIntegration()` + `setupFastifyErrorHandler(app)` is the documented two-call setup for Fastify 5. It captures all 5xx errors automatically.
- SvelteKit 2.31+ added official observability hooks, enabling Sentry to initialize at the correct server startup point in `hooks.server.ts`.
- Self-hosted Sentry (via Docker) is viable for DSGVO compliance — no data leaves the tenant's infrastructure if needed.
- Alternatives (Datadog, New Relic) have no Fastify 5 first-party integration and add cost with no benefit for this scale.

**Confidence:** HIGH — verified against Sentry official docs (sentry.io/platforms/javascript/guides/fastify, /sveltekit).

**Install:**

```bash
pnpm --filter @clokr/api add @sentry/node
pnpm --filter @clokr/web add @sentry/sveltekit
```

**Fastify 5 integration pattern (must import before fastify):**

```typescript
// apps/api/src/instrument.ts — must be imported FIRST in index.ts
import * as Sentry from "@sentry/node";
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  integrations: [
    Sentry.fastifyIntegration(),
    Sentry.prismaIntegration(), // traces slow queries
  ],
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
});
```

---

### 2. Coverage Enforcement

**Change: Add thresholds to `apps/api/vitest.config.ts`**

Currently: no minimum thresholds — coverage runs but never fails CI.
Required: CI must fail below threshold to prevent coverage regression.

**Why V8 over Istanbul:** V8 is already configured and produces accurate source-map-based coverage. Switching to Istanbul has no benefit for this codebase and would require additional configuration. V8 is the correct choice for server-side TypeScript.

**Recommended thresholds for production milestone (pragmatic, not aspirational):**

- `lines: 70` — achievable with existing test suite + new tests this milestone
- `functions: 75` — utility functions are well-covered; routes are the gap
- `branches: 65` — conditional logic in compliance checks needs coverage
- `statements: 70` — aligns with lines threshold

Rationale for 70% not 80%: the existing test suite covers integration paths well but `branches` coverage is lower because Prisma query branches are hard to instrument from HTTP injection tests. Setting unreachable thresholds defeats the purpose.

```typescript
// apps/api/vitest.config.ts — add thresholds
coverage: {
  provider: "v8",
  include: ["**/*.ts"],
  exclude: ["**/*.test.ts", "**/index.ts"],
  thresholds: {
    lines: 70,
    functions: 75,
    branches: 65,
    statements: 70,
  },
},
```

**Confidence:** HIGH — Vitest coverage threshold docs verified.

---

### 3. Vulnerability Scanning

**Add: `pnpm audit` enforcement in CI**

| Tool                            | Use                                       |
| ------------------------------- | ----------------------------------------- |
| `pnpm audit --audit-level=high` | Gate CI on high/critical CVEs             |
| `.trivyignore` (existing)       | Document accepted low/moderate exceptions |

**Why pnpm audit over Snyk/Trivy:**

- `pnpm audit` is built-in, zero additional setup, uses the npm advisory database (superset of npm, includes GitHub Security Advisories).
- Trivy has documented issues scanning `pnpm-lock.yaml` in monorepos (GitHub issue #3793) — it often finds zero vulnerabilities in pnpm workspaces, giving false confidence.
- Snyk provides better scanning but requires a paid plan for CI enforcement and introduces external service dependency.
- `pnpm audit --audit-level=high` blocks only High and Critical — low/moderate noise is real and causes alert fatigue.

**CI addition (append to `.github/workflows/ci.yml` test job):**

```yaml
- name: Security audit
  run: pnpm audit --audit-level=high
```

**Confidence:** MEDIUM — pnpm audit reliability verified via pnpm.io/cli/audit; Trivy pnpm limitation verified via GitHub issue discussion.

---

### 4. Static Analysis Tightening

**Change: Promote ESLint from non-blocking to blocking in CI**

Currently: `eslint src/ ... || true` — errors are reported but do not fail the build.
Required: ESLint errors must block merge.

**No new ESLint plugins needed.** The existing stack (`@typescript-eslint/eslint-plugin` 8.57.2, `eslint-plugin-svelte`, flat config) is correct. What is missing is enforcement.

**Specific rules to enable** (add to existing `eslint.config.js`):

```javascript
// Add to API TypeScript rules — these catch real bugs:
"@typescript-eslint/no-floating-promises": "error",         // fire-and-forget .catch(()=>{}) patterns
"@typescript-eslint/switch-exhaustiveness-check": "error",  // exhaustive union handling
"@typescript-eslint/no-explicit-any": "warn",               // warn, not error — Prisma uses any internally
"@typescript-eslint/no-unnecessary-condition": "warn",      // dead code from null checks
```

**Why these four specifically:**

- `no-floating-promises` directly addresses the known tech debt of `fire-and-forget .catch(() => {})` patterns documented in PROJECT.md. This is the single highest-value rule for this codebase.
- `switch-exhaustiveness-check` prevents silent failures when new status enums are added (leave statuses, time entry types) — critical for audit-proof correctness.
- `no-explicit-any` as warn (not error) because Prisma 7 internals and some FastifyInstance extensions legitimately use `any`.
- `no-unnecessary-condition` surfaces dead code branches in compliance checks.

**Do NOT enable `strictTypeChecked` preset.** It requires type-information linting, which increases ESLint execution time 30x on large codebases. The four targeted rules above deliver the 80% value at negligible cost.

**CI change:**

```yaml
# Remove the `|| true` from lint step:
- name: Lint (blocking)
  run: pnpm --filter @clokr/api exec eslint src/ --no-warn-ignored
```

**Confidence:** HIGH — typescript-eslint docs verified for all four rules.

---

### 5. Frontend Component Testing

**Add: `vitest-browser-svelte` + `@vitest/browser`**

| Package                 | Version  | Purpose                                             |
| ----------------------- | -------- | --------------------------------------------------- |
| `@vitest/browser`       | `^4.1.2` | Browser-mode test runner (Playwright provider)      |
| `vitest-browser-svelte` | `^2.1.0` | Renders Svelte 5 components in real browser context |

**Why this over alternatives:**

- `@testing-library/svelte` v5 has experimental Svelte 5 runes support but runs in jsdom — simulated DOM cannot test reactive state updates reliably with `$state`/`$derived`.
- `vitest-browser-svelte` runs tests in a real browser via Playwright, which is already installed. Reactive state (`$state`, `$derived`) updates are waited on correctly by locators.
- No JSDOM quirks for forms, focus, CSS-driven interactions relevant to the mobile-responsive audit.
- `vitest-browser-svelte` v2.1.0 (latest, August 2025 release) supports Vitest 4 syntax and Svelte 5 runes natively.

**Scope for this milestone:** Only add component tests for the most critical, interaction-heavy components (time entry form, leave request flow). Do not attempt full component coverage — the ROI is in E2E tests for this brownfield codebase.

**Install:**

```bash
pnpm --filter @clokr/web add -D @vitest/browser vitest-browser-svelte vitest
```

**Config (add `apps/web/vitest.config.ts`):**

```typescript
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      name: "chromium",
    },
  },
});
```

**Confidence:** MEDIUM — vitest-browser-svelte 2.1.0 existence verified via npm. Svelte 5 runes support confirmed via GitHub readme and community blog posts. jsdom vs browser mode tradeoff is well-documented.

---

### 6. Performance Monitoring for Slow Queries

**Use existing: Prisma query events + pino logging**

No new package needed. Prisma 7 with `@prisma/adapter-pg` already supports query event instrumentation.

**Why not Sentry prismaIntegration alone:** The `Sentry.prismaIntegration()` traces all queries to Sentry but does not log locally. For an audit-proof system, slow queries should also appear in the application's pino log stream (already configured with log rotation and ECS format).

**Pattern to add in `packages/db/src/client.ts`:**

```typescript
// Add slow query warning — log queries over 2s
const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "query" },
    { emit: "stdout", level: "warn" },
    { emit: "stdout", level: "error" },
  ],
});

if (process.env.NODE_ENV !== "test") {
  prisma.$on("query", (e) => {
    if (e.duration > 2000) {
      app.log.warn({ query: e.query, duration: e.duration }, "slow_query");
    }
  });
}
```

**Confidence:** HIGH — Prisma query event API is documented and stable.

---

## What NOT to Add

| Tool                                   | Reason to Skip                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Testcontainers**                     | Spins up Docker per test suite — massive CI overhead. The existing shared-DB approach with per-tenant seeding/cleanup already isolates adequately.                                                                                                                          |
| **PGLite (in-memory Postgres)**        | No official Prisma 7 driver adapter. Community adapters (`pglite-prisma-adapter` 0.2.0) do not support Prisma migrations, only client queries. Risk of test/production schema divergence is unacceptable for an audit-proof system.                                         |
| **vitest-environment-prisma-postgres** | Transaction-rollback environment wraps tests in rolled-back transactions — incompatible with tests that verify audit log creates (audit logs must survive the transaction boundary to test correctly). Clokr's audit trail tests are the most important tests to get right. |
| **Sonar / Checkmarx / Fortify**        | Enterprise tools requiring paid licences. The combination of typescript-eslint strict rules + pnpm audit covers the same attack surface for this scale.                                                                                                                     |
| **Istanbul coverage provider**         | V8 is already configured, produces correct results, no migration needed. Istanbul is heavier and the benefit (branch annotation quality) does not justify migration for a Node.js API.                                                                                      |
| **Snyk CLI**                           | Snyk is excellent for monorepos but requires a paid plan for CI enforcement and introduces an external SaaS dependency. pnpm audit covers the use case adequately.                                                                                                          |
| **New Relic / Datadog**                | Cost-prohibitive for a bootstrapped SaaS. Sentry (10.x) covers error tracking + performance tracing. Structured pino logging in ECS format is already set up for ingestion if needed later.                                                                                 |
| **@testing-library/svelte**            | jsdom-based. Does not reliably test Svelte 5 runes reactivity. Use `vitest-browser-svelte` instead.                                                                                                                                                                         |
| **Jest**                               | No reason to migrate. Vitest 4 is faster, TypeScript-native, and identical API for this codebase.                                                                                                                                                                           |

---

## Summary: Changes Required vs Additions

| Category             | Change Type        | Package/Config                              | Priority |
| -------------------- | ------------------ | ------------------------------------------- | -------- | ------------------ | ---- |
| Error tracking       | Add                | `@sentry/node` + `@sentry/sveltekit`        | High     |
| Coverage enforcement | Config change      | `vitest.config.ts` thresholds               | High     |
| Vulnerability scan   | CI change          | `pnpm audit` in CI workflow                 | High     |
| ESLint blocking      | CI + config change | Remove `                                    |          | true`, add 4 rules | High |
| Component testing    | Add                | `vitest-browser-svelte` + `@vitest/browser` | Medium   |
| Slow query logging   | Code change        | Prisma `$on("query")` pattern               | Medium   |

---

## Installation Reference

```bash
# Error tracking
pnpm --filter @clokr/api add @sentry/node
pnpm --filter @clokr/web add @sentry/sveltekit

# Frontend component testing (dev only)
pnpm --filter @clokr/web add -D @vitest/browser vitest-browser-svelte vitest
```

No other net-new runtime dependencies are required.

---

## Sources

- Sentry Fastify integration: https://docs.sentry.io/platforms/javascript/guides/fastify/
- Sentry SvelteKit integration: https://docs.sentry.io/platforms/javascript/guides/sveltekit/
- vitest-browser-svelte GitHub: https://github.com/vitest-dev/vitest-browser-svelte
- Vitest coverage thresholds: https://vitest.dev/config/coverage
- Vitest browser mode: https://vitest.dev/guide/browser/
- typescript-eslint no-floating-promises: https://typescript-eslint.io/rules/no-floating-promises/
- typescript-eslint switch-exhaustiveness-check: https://typescript-eslint.io/rules/switch-exhaustiveness-check/
- pnpm audit: https://pnpm.io/cli/audit
- Trivy pnpm issue: https://github.com/aquasecurity/trivy/issues/3793
- PGLite Prisma issue: https://github.com/prisma/prisma/issues/23752
- vitest-environment-prisma-postgres: https://github.com/codepunkt/vitest-environment-prisma-postgres
- Svelte testing docs: https://svelte.dev/docs/svelte/testing

---

_Research date: 2026-03-30 | Confidence: MEDIUM-HIGH overall_
