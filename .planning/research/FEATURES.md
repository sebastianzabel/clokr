# Feature Landscape: Production Readiness

**Domain:** German B2B SaaS — Audit-proof time tracking and leave management
**Researched:** 2026-03-30
**Milestone focus:** Quality, hardening, and compliance — not new features

---

## Context

Clokr is feature-complete for v1. This milestone is about making those features trustworthy
enough to put live with real customers. "Features" here means qualities and capabilities that
must be present before the product can be considered production-ready.

The test for each item: "If this is absent, would a paying German SME customer notice, reject
the product, or face legal exposure?" If yes, it's table stakes.

---

## Table Stakes

Features/qualities that must be present. Their absence makes customers leave, creates legal
exposure, or means the product cannot be trusted.

### 1. Isolated Test Database

**Why expected:** Tests currently share the development database. This is a known blocker
(`CONCERNS.md` line 34). Shared test DB causes non-deterministic test failures, prevents
parallel test execution, and means CI/CD cannot be trusted.

**Complexity:** Low-Medium — Docker Compose update, `PG_TEST_URL` env var, per-test cleanup
enforcement.

**Dependency:** All other test-quality work depends on this being solved first. Unreliable
tests invalidate all downstream coverage metrics.

**Confidence:** HIGH — this is not debatable; it is a pre-condition for reliable CI.

---

### 2. API Route Coverage for All Critical Paths

**Why expected:** Time tracking, leave approval, Monatsabschluss, and DSGVO anonymization
are the commercial heart of the product. Bugs in these routes cost customers real money and
create audit failures. The existing test files cover happy paths but coverage of permission
checks, validation errors, and edge cases is thin (`PROJECT.md` line 33).

**What "critical paths" means here:**

- Time entries: create, edit, delete (soft), ArbZG rejection, locked-month rejection, NFC
  punch, duplicate-day 409
- Leave: request, approve, reject, cancel, cancellation-approve, cross-year booking,
  carry-over calculation
- Overtime: saldo read, Monatsabschluss trigger, locked-month immutability
- Auth: login, refresh, JWT expiry, role gates (ADMIN/MANAGER/EMPLOYEE), tenant isolation
- DSGVO: employee anonymization — verify no hard delete, all fields anonymized correctly
- ArbZG: all six rule violations produce correct HTTP 4xx or warnings

**Complexity:** High — requires seeding realistic scenarios (locked months, hired mid-month,
cross-year leave, DST boundaries).

**Dependencies:** Requires isolated test DB (#1). ArbZG tests require no existing utils test
file (`CONCERNS.md` line 359 — `arbzg.test.ts` does not exist).

**Confidence:** HIGH.

---

### 3. Timezone and Date Boundary Tests

**Why expected:** Germany runs CET/CEST. The codebase has known bugs at timezone boundaries
(`CONCERNS.md` lines 83-104). Month-close errors at these boundaries produce incorrect saldo
data — which is an audit failure in a revisionssicher system. The BAG/ECJ time-recording
rules require that start and end times be accurate to the day.

**What must be tested:**

- DST spring-forward (last Sunday of March) and fall-back (last Sunday of October)
- December 31 → January 1 transitions in Europe/Berlin
- Leap year February 28/29 boundaries
- Month-close at 00:00 UTC vs. 00:00 Europe/Berlin (potentially 23:00 UTC previous day)
- Hire/termination on month boundaries (partial-month expected hours)

**Complexity:** Medium — property-based or parameterized test helpers; no new code, only
new test cases.

**Dependencies:** Requires isolated test DB (#1). Tests the existing `timezone.ts` and
`arbzg.ts` utilities.

**Confidence:** HIGH — confirmed as high-risk gap in `CONCERNS.md` lines 333-352.

---

### 4. Silent Failure Elimination

**Why expected:** The existing codebase has multiple `.catch(() => {})` patterns that swallow
errors without logging (`CONCERNS.md` lines 54-77). In a German HR system, a silent failure
on an audit log write is a DSGVO and Revisionssicherheit violation. Silent NFC card updates
that fail are invisible to operations. Node.js v15+ will crash on unhandled promise
rejections — these patterns are a latent crash risk.

**Specifically:**

- `apps/api/src/middleware/auth.ts` line 42 — `lastUsedAt` update
- `apps/api/src/routes/time-entries.ts` line 200 — NFC `lastUsedAt`
- `apps/api/src/routes/overtime.ts` line 36 — overtime account recalculation
- `apps/api/src/routes/terminals.ts` line 110 — terminal `lastUsedAt`
- `apps/api/src/plugins/mailer.ts` — SMTP decryption failures are silently null

**Replacement pattern:** `app.log.error({ err }, "context message")` — never suppress.

**Complexity:** Low — mechanical replacement, one line per instance, no new logic.

**Dependencies:** None. Can be done independently.

**Confidence:** HIGH.

---

### 5. ArbZG Compliance Test Coverage

**Why expected:** German law (Arbeitszeitgesetz) creates legal exposure if violations slip
through undetected. The BAG ruling and the 2025 coalition agreement both tighten requirements
for electronic time recording. A time tracking product that does not correctly enforce its own
compliance rules is not fit for sale. `arbzg.test.ts` does not exist at all (`CONCERNS.md`
line 359).

**What must be covered:**

- § 3 daily max: 10h hard limit — entry at 10h01 must be rejected
- § 3 average rule: 9.75h/day over 4 days is legal (do NOT flag individual days 8-10h)
- § 3 weekly max: 48h (Mo-Sa, 6 Werktage)
- § 4 break rules: work > 6h needs 30min; work > 9h needs 45min
- § 5 rest period: < 11h between end and next-day start
- Cross-midnight shifts (start 22:00, end 06:00): correct rest-period calculation
- Timezone midnight boundary: rest period across DST transition

**Complexity:** Medium — all logic exists in `arbzg.ts`; tests are pure unit tests with no DB
dependency.

**Dependencies:** None (pure utility tests).

**Confidence:** HIGH.

---

### 6. Tenant Isolation Tests

**Why expected:** A multi-tenant HR system that leaks one company's employee data to another
is an instant DSGVO Article 83 violation (fines up to €20M or 4% of global turnover).
Cross-tenant authorization bypass is the highest-impact class of SaaS vulnerability in 2025
(API attacks up 104% YoY, per Indusface H1 2025 report).

**What must be verified:**

- Employee A from Tenant 1 cannot read/write Employee B from Tenant 2
- Admin from Tenant 1 cannot access admin endpoints for Tenant 2
- NFC terminal API keys are scoped to one tenant
- JWT token from Tenant 1 cannot be used against Tenant 2's resources
- Cross-tenant leave, time-entry, and overtime reads all return 403/404

**Complexity:** Medium — requires two-tenant seed data setup. Pattern can be a shared test
helper: `assertCrossTenantBlocked(adminToken1, resourceUrl2)`.

**Dependencies:** Requires isolated test DB (#1).

**Confidence:** HIGH.

---

### 7. Mobile-Responsive UI Across All Views

**Why expected:** Factorial, the leading German SME HR tool, explicitly calls out one-touch
mobile time recording as a key differentiator. Employees recording time on-site or from NFC
terminals will also use mobile browsers. The project notes mobile needs work after the
recent redesign (`PROJECT.md` line 40).

**Views requiring mobile audit:**

- Dashboard (clock widget, weekly overview, open items)
- Time entry create/edit form
- Leave request form and list
- Employee admin table (at minimum: readable on 375px width)
- Monatsabschluss (manager-only, tablet is acceptable minimum)
- Login/auth screens

**Quality bar:** No horizontal scroll on iPhone 14 (390px). Forms are usable without pinching.
Touch targets 44px minimum. Navigation accessible without mouse.

**Complexity:** Medium — CSS work, no logic changes.

**Dependencies:** None. Independent track.

**Confidence:** HIGH — standard expectation for any modern web app.

---

### 8. Consistent Error Feedback to Users

**Why expected:** German B2B users expect predictable, legible error states. The current
Playwright E2E scaffolding tests for no 500 errors but does not validate that user-facing
errors are helpful. Silent failures (#4) manifest as blank states or spinners that never
resolve — both are unacceptable in an enterprise product.

**Required:**

- API validation errors (400/422) must surface German-language messages in the UI
- Network errors during form submission must show retry prompts, not blank pages
- Locked-month edits must show clear "Monat ist gesperrt" messages
- ArbZG violation rejections must explain the specific rule broken
- Leave overlap rejections must name the conflicting request

**Complexity:** Low-Medium — mostly UI text and existing error-handling components.

**Dependencies:** Silent failure fix (#4) must precede this so errors actually reach the UI.

**Confidence:** HIGH.

---

### 9. Audit Trail Completeness Verification

**Why expected:** Revisionssicherheit is a stated core requirement. The system logs mutations
via `app.audit()` but there is no test verifying that every mutating endpoint actually calls
it. An untested audit trail is not an audit trail — it is aspirational.

**What must be verified:**

- Every POST/PUT/DELETE on TimeEntry, LeaveRequest, Absence, Employee writes an AuditLog row
- AuditLog row contains: `userId`, `tenantId`, `action`, `entityId`, `before`, `after`,
  `ipAddress`, `timestamp`
- Anonymization audit event is written before any data is overwritten
- Lock/unlock Monatsabschluss events are logged
- Failed auth attempts are logged (for DSGVO breach response)

**Complexity:** Medium — can be asserted at the route-test level: after each mutating
operation, query `auditLog.findFirst({ orderBy: { createdAt: 'desc' } })` and assert fields.

**Dependencies:** Requires isolated test DB (#1).

**Confidence:** HIGH.

---

### 10. Soft Delete Enforcement Tests

**Why expected:** CLAUDE.md mandates no hard deletes on TimeEntry, LeaveRequest, Absence.
DSGVO anonymization must preserve these records. If any path exists that hard-deletes
retention-relevant records, the product is not audit-proof. This is a legal requirement,
not a preference.

**What must be tested:**

- DELETE /time-entries/:id sets `deletedAt`, does not remove the row
- Queries for time entries include `deletedAt: null` filter — soft-deleted entries do not
  appear in saldo calculations
- DSGVO anonymization preserves all TimeEntry/LeaveRequest/Absence rows
- Locked-month entries cannot be deleted even by ADMIN

**Complexity:** Low — targeted assertions in existing test files.

**Dependencies:** None independent; can layer on top of time-entry tests (#2).

**Confidence:** HIGH.

---

### 11. UI Design Consistency

**Why expected:** German B2B buyers evaluate software in demos. Inconsistent spacing,
mismatched component styles, and mixed font weights are instant credibility signals. The
recent dashboard redesign (`PROJECT.md` context) created drift between redesigned and
non-redesigned views.

**Required:**

- Consistent use of spacing scale (no ad-hoc pixel values)
- Color tokens used consistently (brand borders, backgrounds)
- Loading skeletons on all async views (not a mix of spinners and skeletons)
- Form component consistency (inputs, selects, date pickers same across all forms)
- Consistent German labels and terminology (no Anglicisms where German terms exist)

**Complexity:** Medium — systematic audit then targeted fixes, no architecture changes.

**Dependencies:** None.

**Confidence:** MEDIUM — standard quality bar for B2B SaaS; German market is conservative.

---

### 12. Password Policy UI

**Why expected:** TenantConfig already has password policy fields in the schema
(`CONCERNS.md` lines 147-159). The DB config exists, the enforcement logic exists, but no
UI lets admins configure it. An admin who cannot set password complexity requirements cannot
meet their own corporate IT security policy.

**Complexity:** Low — single form component in the settings page. The backend already works.

**Dependencies:** None.

**Confidence:** HIGH — confirmed as missing in CONCERNS.md.

---

## Differentiators

Capabilities that distinguish Clokr in the German SME market. These are above the baseline
but should be preserved or made more visible.

### NFC Terminal Integration

Clokr already has NFC punch integration. This is a genuine differentiator vs. browser-only
tools like Clockify. The terminal → time-entry path must be tested as part of the API test
suite (#2) to ensure it stays reliable. The `lastUsedAt` silent failure (#4) specifically
affects this path.

**Competitive note:** Personio and Factorial do not offer NFC terminals as standard —
they rely on app-based check-ins.

**Complexity:** No new work needed; just tested reliably.

---

### Audit-Proof by Design (Revisionssicherheit)

The soft-delete model, locked months, and full audit trail are architecturally baked in.
This is rare for SME tools. Personio's audit log is optional and shallow. Making this
verifiable via tests (#9, #10) allows sales to claim it truthfully.

**Complexity:** No new architecture needed; tests make the claim verifiable.

---

### German Legal Compliance Out of the Box

ArbZG §3/§4/§5, BUrlG §7 carry-over, DSGVO anonymization, and § 147 AO retention are
already implemented. Competitors like Clockify require manual configuration. Making these
verifiable via tests (#5) turns an assumption into a guarantee.

**Complexity:** Tests only.

---

### Monatsabschluss with Saldo Snapshot

Monthly close with immutable saldo snapshot is a genuine enterprise feature missing from
budget tools. It must remain reliable through all the hardening work.

**Complexity:** Preservation, not new work.

---

## Anti-Features

Things to deliberately NOT build in this milestone.

### New Features

The milestone scope is hardening. Adding features during a quality milestone dilutes focus,
introduces new bugs, and shifts the definition of done. Any scope creep from "while we're
here..." should be logged as a future issue.

**What to do instead:** Log in GitHub issues with label "post-v1".

---

### Saldo Snapshot Architecture Migration

Issue #6 (snapshot-based saldo calculation) is explicitly out of scope per `PROJECT.md`.
The performance concern is real but not a production blocker for early customer counts.
Attempting this migration in parallel with hardening work risks introducing correctness
regressions in the most critical calculation in the system.

**What to do instead:** Complete this as a standalone milestone after launch.

---

### i18n / Localization

German-only for v1. Adding i18n scaffolding now is irreversible complexity with no customer
value at launch. The UI is already in German; no action required.

**What to do instead:** Defer until there is a specific customer request for another language.

---

### CI/CD Pipeline

Infrastructure concern explicitly listed as out of scope (`PROJECT.md` line 45). A working
pipeline is valuable but is not app quality. The tests must be reliable first; then CI/CD
is a thin wrapper.

**What to do instead:** Address in a dedicated infrastructure milestone after test suite is
solid.

---

### DATEV Integration

Personio and Factorial both offer DATEV interfaces. This is a genuine market expectation for
payroll export but is a distinct integration project requiring DATEV API access, agreements,
and format compliance. Adding it under a "quality" milestone mischaracterizes its scope.

**What to do instead:** Separate milestone; requires customer demand signal first.

---

### GPS / Location Tracking

Mobile time tracking competitors (Timeero, TrakGo) offer GPS pinning for field workers.
Clokr targets office and mixed-environment SMEs. Adding GPS to a hardening milestone is
scope creep with DSGVO complications (location data = sensitive personal data requiring
explicit consent and purpose limitation).

**What to do instead:** Evaluate only if specific customer segment requests it, with DSGVO
impact assessment first.

---

## Feature Dependencies

```
Isolated Test DB (#1)
    → API Route Coverage (#2)
    → Timezone/Date Boundary Tests (#3)
    → Tenant Isolation Tests (#6)
    → Audit Trail Completeness (#9)
    → Soft Delete Enforcement (#10)

Silent Failure Elimination (#4)
    → Consistent Error Feedback (#8)

ArbZG Tests (#5) — independent (pure unit tests, no DB)
Mobile UI (#7) — independent
UI Design Consistency (#11) — independent
Password Policy UI (#12) — independent
```

---

## MVP Launch Prioritization

**Ship before any customer sees the product:**

1. Isolated Test DB (#1) — prerequisite for trusting anything else
2. Silent Failure Elimination (#4) — one-line fixes, high-leverage
3. ArbZG Test Coverage (#5) — no DB needed, pure legal compliance
4. Soft Delete Enforcement (#10) — legal requirement, fast to add
5. Tenant Isolation Tests (#6) — highest-impact security risk

**Ship before charging customers:**

6. API Route Coverage — all critical paths (#2)
7. Timezone Boundary Tests (#3)
8. Audit Trail Completeness (#9)
9. Mobile-Responsive UI (#7)
10. Consistent Error Feedback (#8)

**Ship before meaningful scale:**

11. UI Design Consistency (#11) — affects conversion, not correctness
12. Password Policy UI (#12) — affects enterprise security posture

**Defer entirely:**

- All anti-features listed above

---

## Sources

- [Germany Mandatory Time Tracking - Deel](https://www.deel.com/blog/germany-mandatory-time-tracking/)
- [Zeiterfassungspflicht 2025 - ZEP](https://www.zep.de/en/blog/pflicht-arbeitszeiterfassung-leitfaden-2025)
- [GDPR Compliance Checklist for B2B SaaS - ComplyDog](https://complydog.com/blog/gdpr-compliance-checklist-complete-guide-b2b-saas-companies)
- [OWASP Top 10:2025 - Indusface](https://www.indusface.com/learning/owasp-top-10-vulnerabilities/)
- [Multi-Tenant Security Cheat Sheet - OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
- [Scaling E2E Tests for Multi-Tenant SaaS - CyberArk/Medium](https://medium.com/cyberark-engineering/scaling-e2e-tests-for-multi-tenant-saas-with-playwright-c85f50e6c2ae)
- [Production Readiness Checklist 2025 - GoReplay](https://goreplay.org/blog/production-readiness-checklist-20250808133113/)
- [Beste Zeiterfassungssoftware Mittelstand 2025 - TimeTrack](https://www.timetrackapp.com/blog/beste-zeiterfassungssoftware-fuer-den-mittelstand-2025/)
- [Stop Building APIs That Fail Silently - DEV.to](https://dev.to/arbythecoder/stop-building-apis-that-fail-silently-a-nodejs-developers-community-challenge-1moo)
- [Fastify Testing Guide](https://fastify.dev/docs/v5.3.x/Guides/Testing/)
- [End-to-End Testing Your SaaS with Playwright - MakerKit](https://makerkit.dev/blog/tutorials/playwright-testing)
- Internal: `.planning/PROJECT.md`, `.planning/codebase/CONCERNS.md`, `CLAUDE.md`
