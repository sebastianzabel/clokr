# Phase 3: E2E and UI Quality - Discussion Log (Assumptions Mode)

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-03-31T00:00:00Z
**Phase:** 03-e2e-and-ui-quality
**Mode:** assumptions (--auto)
**Areas analyzed:** E2E Test Coverage, Mobile Responsiveness, German Error Messages, Password Policy UI, Design Consistency

## Assumptions Presented

### E2E Test Coverage
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| 5 required flows have partial scaffolding but none asserts action completion | Confident | core-flows.spec.ts (page-load only), time-entries-flow.spec.ts (conditional create with no persistence assert), leave-flow.spec.ts (navigation only), admin-settings-flow.spec.ts (tab nav), mobile-flow.spec.ts (bounding box but no click+assert) |

### Mobile Responsiveness
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| Tests use 375px not required 390px; touch target threshold is 32px not 44px; no global CSS breakpoints | Confident | mobile-flow.spec.ts line 6 sets 375px; ux-design-audit.spec.ts uses 32px threshold; app.css has no @media queries |

### German Error Messages
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| Auth/validation messages are German (confirmed); "Monat ist gesperrt" does NOT exist in apps/web/src | Likely | auth.spec.ts asserts German auth errors; grep for "gesperrt" in time-entry components returned 0 hits |

### Password Policy UI
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| UI fully built in admin/system/+page.svelte; only E2E test missing | Likely | admin/system/+page.svelte has savePasswordPolicy(), min-length input, toggles at ~lines 283-291; PasswordStrength.svelte reads policy object |

### Design Consistency
| Assumption | Confidence | Evidence |
|------------|-----------|----------|
| Existing audit tests comprehensive but use collector/log not hard assertions | Likely | ui-quality.spec.ts uses UIFinding collector + afterAll log; ux-design-audit.spec.ts uses findings.push() — no expect() calls in audit loop |

## Corrections Made

No corrections — --auto mode, all assumptions Confident/Likely, proceeded to context capture.

## Auto-Resolved

No Unclear assumptions — all were Confident or Likely. Proceeded directly to write_context.
