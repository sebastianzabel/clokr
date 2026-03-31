# Phase 2: Compliance and API Coverage - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-30
**Phase:** 02-compliance-and-api-coverage
**Areas discussed:** Bug handling scope, Test organization, Font self-hosting, ArbZG edge cases

---

## Bug Handling Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Fix bugs inline | Write the test, fix the bug in the same plan. Tests verify the fix. | ✓ |
| Document only | Write failing tests, skip them with a TODO, file GitHub issues. | |
| Fix critical, document minor | Fix ArbZG/legal bugs immediately. Document non-legal bugs for later. | |

**User's choice:** Fix bugs inline
**Notes:** Legal compliance bugs (e.g., ArbZG rolling average) cannot be deferred.

### ArbZG Fix Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Fix it in this phase | If rolling average is wrong, fix it alongside the test. | ✓ |
| Flag and defer | Document the issue, write the correct test as skipped. | |

**User's choice:** Fix it in this phase

### Commit Style

| Option | Description | Selected |
|--------|-------------|----------|
| Together | Test + fix in one commit. Keeps the fix traceable. | ✓ |
| Separate commits | First commit: failing test. Second commit: fix + unskip. | |
| You decide | Claude picks per situation. | |

**User's choice:** Together

### Bug Tracking

| Option | Description | Selected |
|--------|-------------|----------|
| Commit message is enough | The test proves the fix, commit message references requirement ID. | |
| Open GitHub issue | Create an issue for each production bug found, reference in commit. | ✓ |
| You decide | Claude judges based on severity. | |

**User's choice:** Open GitHub issue

### decryptSafe Migration

| Option | Description | Selected |
|--------|-------------|----------|
| Address in Phase 2 | Query DB, write test, migrate plaintext if found. | ✓ |
| Defer | Out of scope for compliance tests. | |
| You decide | Claude evaluates scope fit. | |

**User's choice:** Address in Phase 2

---

## Test Organization

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing files | Add compliance describe blocks to existing test files. | ✓ |
| Separate compliance files | Create new auth-compliance.test.ts, etc. | |
| You decide | Claude picks per domain. | |

**User's choice:** Extend existing files

### Test Grouping

| Option | Description | Selected |
|--------|-------------|----------|
| No special grouping | Tests live in describe blocks, run all together. | |
| Use tags/naming convention | Mark with naming convention for --grep filtering. | |
| You decide | Claude determines if grouping adds value. | ✓ |

**User's choice:** You decide

### Tenant Isolation Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Every resource type | Test cross-tenant for each model. Comprehensive. | ✓ |
| Representative sample | Test 2-3 representative resources. | |
| You decide | Claude evaluates distinct access patterns. | |

**User's choice:** Every resource type

---

## Font Self-Hosting

| Option | Description | Selected |
|--------|-------------|----------|
| Download WOFF2 to static/ | Place in apps/web/static/fonts/, write local @font-face. | ✓ |
| Use fontsource npm packages | Install @fontsource packages, import in app.css. | |
| You decide | Claude picks simplest approach. | |

**User's choice:** Download WOFF2 to static/

### Font Weight Variants

| Option | Description | Selected |
|--------|-------------|----------|
| Keep all weights | Download all declared weights (300-700). Safe. ~200KB total. | ✓ |
| Trim to used weights | Audit CSS, only download referenced weights. | |
| You decide | Claude audits and decides. | |

**User's choice:** Keep all weights

---

## ArbZG Edge Cases

| Option | Description | Selected |
|--------|-------------|----------|
| Comprehensive | Test all rules at exact boundaries. Plus cross-midnight and DST. | ✓ |
| Core rules only | Test 5 main rules with clear pass/fail. Skip boundary precision. | |
| You decide | Claude determines based on arbzg.ts implementation. | |

**User's choice:** Comprehensive

### 24-Week Average Test

| Option | Description | Selected |
|--------|-------------|----------|
| Realistic synthetic data | Generate 24+ weeks of entries. Most representative. | ✓ |
| Simplified scenarios | Test calculation function directly with mock arrays. | |
| Both approaches | Unit test + integration test. | |

**User's choice:** Realistic synthetic data

### DST/Timezone Scenarios (multiSelect)

| Option | Description | Selected |
|--------|-------------|----------|
| DST spring forward (March) | CET→CEST, 1 hour disappears. | ✓ |
| DST fall back (October) | CEST→CET, 1 hour repeats. | ✓ |
| Cross-midnight shifts | 22:00–06:00, spans two calendar days. | ✓ |
| Year boundary (Dec 31→Jan 1) | Monatsabschluss, carry-over, saldo. | ✓ |

**User's choice:** All 4 scenarios

---

## Claude's Discretion

- Test grouping/tagging strategy
- Exact test data seeding approach for multi-week scenarios
- decryptSafe migration implementation details
- Additional edge cases beyond specified boundaries

## Deferred Ideas

None — discussion stayed within phase scope
