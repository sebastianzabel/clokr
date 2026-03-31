---
phase: 3
slug: e2e-and-ui-quality
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-31
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | @playwright/test 1.58.2 |
| **Config file** | `apps/e2e/playwright.config.ts` |
| **Quick run command** | `cd apps/e2e && npx playwright test --project=chromium` |
| **Full suite command** | `cd apps/e2e && npx playwright test` |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd apps/e2e && npx playwright test --project=chromium`
- **After every plan wave:** Run `cd apps/e2e && npx playwright test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 1 | E2E-01 | e2e | `npx playwright test core-flows` | ✅ | ⬜ pending |
| 3-01-02 | 01 | 1 | E2E-02 | e2e | `npx playwright test time-entries-flow` | ✅ | ⬜ pending |
| 3-01-03 | 01 | 1 | E2E-03 | e2e | `npx playwright test leave-flow` | ✅ | ⬜ pending |
| 3-01-04 | 01 | 1 | E2E-04 | e2e | `npx playwright test admin-settings-flow` | ✅ | ⬜ pending |
| 3-01-05 | 01 | 1 | E2E-05 | e2e | `npx playwright test admin-settings-flow` | ✅ | ⬜ pending |
| 3-02-01 | 02 | 1 | UI-01 | e2e | `npx playwright test mobile-flow` | ✅ | ⬜ pending |
| 3-02-02 | 02 | 1 | UI-02 | e2e | `npx playwright test time-entries-flow` | ✅ | ⬜ pending |
| 3-02-03 | 02 | 1 | UI-03 | e2e | `npx playwright test ui-quality ux-design-audit` | ✅ | ⬜ pending |
| 3-02-04 | 02 | 1 | UI-04 | e2e | `npx playwright test ux-design-audit` | ✅ | ⬜ pending |
| 3-02-05 | 02 | 1 | UI-05 | e2e | `npx playwright test admin-settings-flow` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements. All test files already exist — Wave 1 updates them in place.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Monatsabschluss month close visible + isLocked UI state | E2E-05 | Requires seeded data in closed state | Navigate to admin Monatsabschluss page, close a month, verify isLocked indicator |
| Mobile horizontal scroll absence | UI-01 | Requires visual inspection at 390px | Open app in browser at 390px width, scroll each main view |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
