---
phase: 2
slug: compliance-and-api-coverage
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-30
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.2 |
| **Config file** | `apps/api/vitest.config.ts` |
| **Quick run command** | `docker compose exec api pnpm vitest run --reporter=verbose` |
| **Full suite command** | `docker compose exec api pnpm vitest run --coverage` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `docker compose exec api pnpm vitest run --reporter=verbose`
- **After every plan wave:** Run `docker compose exec api pnpm vitest run --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | SEC-01 | unit | `docker compose exec api pnpm vitest run src/routes/__tests__/arbzg.test.ts --reporter=verbose` | Yes | pending |
| 02-01-02 | 01 | 1 | SEC-05 | unit | `docker compose exec api pnpm vitest run src/routes/__tests__/arbzg.test.ts --reporter=verbose` | Yes | pending |
| 02-02-01 | 02 | 1 | SEC-02 | integration | `docker compose exec api pnpm vitest run src/__tests__/tenant-isolation.test.ts --reporter=verbose` | No (W0) | pending |
| 02-02-02 | 02 | 1 | SEC-03 | integration | `docker compose exec api pnpm vitest run src/__tests__/audit-trail.test.ts --reporter=verbose` | No (W0) | pending |
| 02-03-01 | 03 | 1 | API-01 | integration | `docker compose exec api pnpm vitest run src/__tests__/time-entries.test.ts --reporter=verbose` | Yes | pending |
| 02-03-02 | 03 | 1 | SEC-04 | integration | `docker compose exec api pnpm vitest run src/__tests__/time-entries.test.ts --reporter=verbose` | Yes | pending |
| 02-04-01 | 04 | 1 | API-02 | integration | `docker compose exec api pnpm vitest run src/__tests__/leave.test.ts --reporter=verbose` | Yes | pending |
| 02-04-02 | 04 | 1 | API-03 | integration | `docker compose exec api pnpm vitest run src/__tests__/overtime-calc.test.ts --reporter=verbose` | Yes | pending |
| 02-05-01 | 05 | 1 | API-04 | integration | `docker compose exec api pnpm vitest run src/__tests__/auth.test.ts --reporter=verbose` | Yes | pending |
| 02-05-02 | 05 | 1 | API-05, API-06, SEC-04 | integration | `docker compose exec api pnpm vitest run src/__tests__/employees.test.ts src/routes/__tests__/nfc-punch.test.ts --reporter=verbose` | Yes | pending |
| 02-06-01 | 06 | 1 | AUDIT-02 | manual+unit | `docker compose exec web pnpm build 2>&1 \| tail -5` | Yes | pending |
| 02-06-02 | 06 | 1 | AUDIT-02 | manual | Visual: browser DevTools network tab — zero Google Fonts requests | N/A | pending |

*Status: pending -- green -- red -- flaky*

---

## Wave 0 Requirements

- [ ] `apps/api/src/__tests__/tenant-isolation.test.ts` — stubs for SEC-02
- [ ] `apps/api/src/__tests__/audit-trail.test.ts` — stubs for SEC-03

*Existing infrastructure covers all other phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google Fonts eliminated | AUDIT-02 | Visual + CSP check | Build web app, inspect network tab — no requests to fonts.googleapis.com or fonts.gstatic.com |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** signed off
