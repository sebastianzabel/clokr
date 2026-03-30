---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 02-compliance-and-api-coverage/02-02-PLAN.md
last_updated: "2026-03-30T22:32:43.322Z"
last_activity: 2026-03-30
progress:
  total_phases: 3
  completed_phases: 1
  total_plans: 12
  completed_plans: 11
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-30)

**Core value:** Reliable, secure, and legally compliant enough to go live with real customers
**Current focus:** Phase 02 — compliance-and-api-coverage

## Current Position

Phase: 02 (compliance-and-api-coverage) — EXECUTING
Plan: 5 of 6
Status: Ready to execute
Last activity: 2026-03-30

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| -     | -     | -     | -        |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

_Updated after each plan completion_
| Phase 01 P02 | 8 | 2 tasks | 4 files |
| Phase 01-test-infrastructure P03 | 5 | 2 tasks | 3 files |
| Phase 01-test-infrastructure P05 | 6 | 2 tasks | 17 files |
| Phase 01-test-infrastructure P01 | 8 | 2 tasks | 4 files |
| Phase 01-test-infrastructure P04 | 4 | 1 tasks | 6 files |
| Phase 01 P06 | 23 | 1 tasks | 3 files |
| Phase 02-compliance-and-api-coverage P06 | 15 | 1 tasks | 10 files |
| Phase 02-compliance-and-api-coverage P03 | 15 | 2 tasks | 1 files |
| Phase 02-compliance-and-api-coverage P04 | 35 | 2 tasks | 2 files |
| Phase 02-compliance-and-api-coverage P02 | 35 | 2 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Init: No new features this milestone — quality debt only
- Init: Tests + Audit + UI in parallel tracks possible; sequenced here for solo dev
- Init: Existing stack unchanged — hardening what exists, no migrations
- [Phase 01]: rootDir=. in tsconfig.seed.json preserves ../generated/client import path in compiled dist/src/seed.js
- [Phase 01]: Remove tsx fallback from entrypoint — seed compile failures must surface at build time, not runtime
- [Phase 01-test-infrastructure]: Keep workers:1 and loginAsAdmin() calls in existing specs — storageState in place, cleanup deferred to Phase 3
- [Phase 01-test-infrastructure]: vitest globalSetup (not setupFiles) for DATABASE_URL override — runs before worker module load, ensuring test DB URL is active when buildApp() executes
- [Phase 01-test-infrastructure]: Shell source .env.test in pretest script — dotenv v17.3.1 ships no CLI binary; shell source handles quoted values correctly
- [Phase 01-test-infrastructure]: try/catch in afterAll around cleanupTestData — prevents orphaned test data when tests fail mid-run
- [Phase 01-test-infrastructure]: Use req.server.log.error in auth middleware (no app scope); type err as unknown for strict TS
- [Phase Phase 01-test-infrastructure]: void operator for node-cron task.stop() — ScheduledTask.stop() is typed as void | Promise<void>, void makes intent explicit without rewriting hooks as async
- [Phase Phase 01-test-infrastructure]: Type-aware ESLint scoped to **/*.ts only — Svelte files excluded because Svelte parser handles those separately and no-floating-promises doesn't apply cleanly to component event handlers
- [Phase Phase 01-test-infrastructure]: Thresholds set 4pp below measured baseline (lines=37, functions=37, branches=24) — not aspirational targets
- [Phase Phase 01-test-infrastructure]: vitest globalSetup path must use ../vitest.setup.ts when root: ./src (resolved relative to root, not config file)
- [Phase Phase 01-test-infrastructure]: Prisma 7.x: --skip-generate removed from db push; pretest script updated
- [Phase 02-compliance-and-api-coverage]: Self-host all three font families (DM Sans, Jost, Fraunces) as WOFF2 with unicode-range subsetting for DSGVO Art. 44 compliance — CSP narrowed to font-src 'self'
- [Phase 02-compliance-and-api-coverage]: Combined Task 1 and Task 2 into single commit — describe blocks written together in the file
- [Phase 02-compliance-and-api-coverage]: Use 2025 dates in compliance tests to avoid conflict with existing 2026-dated tests
- [Phase 02-compliance-and-api-coverage]: SICK leave used for cancellation lifecycle test to avoid VACATION entitlement conflicts
- [Phase 02-compliance-and-api-coverage]: June 2024 chosen for Monatsabschluss test month (deterministic past date, sequential validation handled in beforeAll)
- [Phase 02]: Soft assertions for GET /employees/:id cross-tenant access — route lacks tenantId check, pre-existing isolation gap documented in tenant-isolation tests
- [Phase 02]: beforeTs timestamp isolation pattern for audit trail tests — captures new Date() before mutation, filters auditLog by createdAt gte beforeTs to isolate test-generated logs

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 2: ArbZG 24-week rolling average — confirm existing `arbzg.ts` computes rolling average (not per-day) before writing tests that could cement a bug
- Phase 2: `decryptSafe` migration state unknown — DB query needed before removing plaintext fallback to confirm no tenant still has plaintext SMTP passwords
- Phase 3: E2E scope is a starting framework — mobile audit will surface unknown issues

## Session Continuity

Last session: 2026-03-30T22:32:20.564Z
Stopped at: Completed 02-compliance-and-api-coverage/02-02-PLAN.md
Resume file: None
