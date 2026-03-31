# Domain Pitfalls

**Domain:** German B2B time tracking SaaS (Clokr — production hardening)
**Researched:** 2026-03-30
**Sources:** Codebase audit (CONCERNS.md, schema.prisma, route files, test setup), CLAUDE.md, PROJECT.md

---

## Critical Pitfalls

These mistakes cause rewrites, audit failures, or legal exposure.

---

### Pitfall 1: Shared Test Database Contaminates Production Queries

**What goes wrong:** `apps/api/src/__tests__/setup.ts` line 4 documents the TODO: tests run against the development database. If cleanup fails mid-test (exception before `afterAll`), orphaned tenant data remains and can corrupt subsequent test runs or, in the worst case, appear in development queries that accidentally omit tenantId filters.

**Why it happens:** The `getTestApp()` singleton shares the Fastify instance (and its Prisma client) across all test suites. Cleanup is only attempted in `afterAll`. If a test throws before `afterAll` runs, the tenant and its data survive in the DB.

**Consequences:**

- Non-deterministic test failures that are hard to reproduce
- False confidence from green tests that happened to run on clean state
- Parallel test execution is impossible (vitest workers would race on the same DB)
- In CI, a flaky test run leaves the DB in a state that causes the next run to fail immediately

**Warning signs:**

- Tests pass locally but fail in CI on the second run
- `cleanupTestData` calls appear in `afterAll` but not in a `finally` block
- `setup.ts` says `TODO: separate test DB for CI`

**Prevention:**

1. Add a `PG_TEST_URL` env var pointing to a separate PostgreSQL database (`clokr_test`)
2. Wrap all cleanup in `try/finally` — never rely on `afterAll` alone
3. Each test suite seeds its own unique tenant (already done via `suffix`), so isolation is achievable without full DB wipe
4. Use `vitest --pool=forks` with per-worker DB schemas for full parallelism once test DB is isolated

**Phase:** Testing phase — resolve before any test coverage work begins. Fixing this first makes all subsequent test writing reliable.

---

### Pitfall 2: Google Fonts CDN Violates DSGVO (Art. 44 DSGVO / Schrems II)

**What goes wrong:** `apps/web/src/app.css` imports fonts directly from `fonts.googleapis.com`. The browser sends the user's IP address to Google servers in the US on every page load. The DSGVO prohibits transferring personal data (IP addresses are personal data under Art. 4 No. 1) to third countries without adequate safeguards.

**Why it happens:** Google Fonts CDN is the default convenience approach and is easy to overlook during development.

**Consequences:**

- Violates DSGVO Art. 44 (transfer to third countries without adequacy decision)
- German courts have issued injunctions and fines for exactly this pattern (LG München I, Az. 3 O 17493/20)
- Invalidates any "we are DSGVO-compliant" claim to B2B customers
- The CSP in `hooks.server.ts` explicitly whitelists `fonts.googleapis.com` and `fonts.gstatic.com`, meaning the breach is structural, not accidental

**Warning signs:**

- `@import url("https://fonts.googleapis.com/...")` in any CSS file
- `style-src ... https://fonts.googleapis.com` in Content-Security-Policy header
- No `<link rel="preload">` pointing to `/fonts/` (self-hosted path)

**Prevention:**

1. Download the three font families (Jost, DM Sans, Fraunces) using `google-webfonts-helper` or `fontsource`
2. Place font files under `apps/web/static/fonts/`
3. Replace the `@import` with `@font-face` declarations pointing to `/fonts/`
4. Remove `fonts.googleapis.com` and `fonts.gstatic.com` from the CSP — this tightens security as a bonus
5. Use `fontsource` npm packages as the lowest-friction alternative: `npm install @fontsource/jost @fontsource/dm-sans @fontsource/fraunces`

**Phase:** Security/compliance audit phase — this is a one-hour fix with significant legal exposure if skipped.

---

### Pitfall 3: Fire-and-Forget `.catch(() => {})` Hides Compliance-Critical Failures

**What goes wrong:** Four confirmed locations suppress errors silently:

- `apps/api/src/middleware/auth.ts` line 42 — API key `lastUsedAt` update
- `apps/api/src/routes/time-entries.ts` line 200 — NFC terminal `lastUsedAt` update
- `apps/api/src/routes/overtime.ts` line 36 — overtime account recalculation
- `apps/api/src/routes/terminals.ts` line 110 — terminal API key `lastUsedAt` update

The overtime recalculation failure is the most dangerous: if `updateOvertimeAccount` fails silently, the balance displayed to the user is stale. The employee may receive incorrect payroll data without any alarm.

**Why it happens:** Fire-and-forget is used to avoid blocking HTTP responses for non-critical updates. The `.catch(() => {})` suppresses the promise rejection to prevent Fastify from treating it as an unhandled rejection.

**Consequences:**

- Database connection failures go undetected until a user reports a data discrepancy
- Audit trail gaps: if the DB write that records `lastUsedAt` fails, there is no log of the access attempt
- Overtime saldo shown in the UI can be wrong without any visible error
- In an audit, "the system had silent failures" is a significant finding against revisionssicherheit

**Warning signs:**

- `.catch(() => {})` with empty body anywhere in the codebase
- Operations that update audit/tracking fields without logging on failure

**Prevention:**
Replace every silent catch with a logged catch:

```typescript
// Instead of:
someOperation().catch(() => {});

// Use:
someOperation().catch((err) =>
  app.log.error({ err, context: "lastUsedAt update" }, "Non-critical DB write failed"),
);
```

For the overtime recalculation specifically, consider returning a warning in the API response if the recalculation fails, so the frontend can show a stale-data indicator.

**Phase:** Code audit phase — mechanical fix with outsized compliance and observability benefit.

---

### Pitfall 4: `decryptSafe` Falls Back to Plaintext on Decryption Failure

**What goes wrong:** `apps/api/src/utils/crypto.ts` line 47-55: `decryptSafe` catches all decryption errors and returns the raw value, treating it as plaintext. This means a rotated or corrupted `ENCRYPTION_KEY` causes SMTP passwords to be used as-is (likely garbled ciphertext), and the failure is invisible.

**Why it happens:** The function was designed to handle a migration from plaintext to encrypted storage. The fallback was intentional during the migration window.

**Consequences:**

- Key rotation silently breaks all tenant SMTP configurations
- Email delivery fails (invitations, OTP, password reset) without alerting admins
- The fallback to plaintext means previously-encrypted values are sent to the SMTP server as garbage, causing authentication failures that look like SMTP server errors
- No audit trail of why decryption failed

**Warning signs:**

- `decryptSafe` returning a value that contains colons and looks base64-encoded (the iv:tag:ciphertext format)
- Emails failing with "authentication failed" after an infrastructure change

**Prevention:**

1. Log decryption failures with tenantId and timestamp (never log the value itself)
2. Add a startup health check that verifies the encryption key can round-trip a test string
3. Remove the plaintext fallback once migration is confirmed complete — the comment "might be plaintext (pre-migration)" is the signal
4. Add a `/health/smtp` endpoint that validates SMTP config is decryptable (without actually connecting)

**Phase:** Security audit phase.

---

### Pitfall 5: ArbZG § 3 Weekly Maximum Not Tested

**What goes wrong:** `apps/api/src/utils/__tests__/arbzg.test.ts` does not exist. The ArbZG check function in `apps/api/src/utils/arbzg.ts` implements § 3 daily max (10h), § 4 breaks, § 5 rest period, and § 3 weekly max (48h). None of these are covered by automated tests.

**Why it happens:** The utility was written but tests were deferred.

**Consequences:**

- A bug in the weekly maximum calculation (48h across Mo-Sa = 6 Werktage) would go undetected
- The 24-week rolling average rule (8h/day average, NOT a daily limit per CLAUDE.md) is the most legally nuanced and most likely to be implemented incorrectly — it cannot be validated by code review alone
- Cross-day shift edge cases (entry starts 23:50, ends 01:30 next day) are untested — the rest period check is especially vulnerable here
- Regulatory audits of time tracking software specifically look for edge case handling

**Warning signs:**

- `arbzg.test.ts` file does not exist
- Weekly maximum check only exercises the "happy path" in integration tests (if at all)

**Prevention:**

1. Create `apps/api/src/utils/__tests__/arbzg.test.ts` with unit tests for each § separately
2. Test the 24-week rolling average: confirm no warning for a single day of 9.5h, confirm warning only when the average exceeds 8h over 24 weeks
3. Test cross-midnight entries for § 5 rest period: entry ends at 23:00, next entry starts at 07:00 = 8h gap = violation
4. Test § 4 breaks: exactly 6h00m (no break required), 6h01m (break required), 9h01m (45min required)
5. Test the Mo-Sa = 6 Werktage interpretation for weekly max (Sonntag is excluded)

**Phase:** Testing phase — legally required, not optional.

---

### Pitfall 6: Leave Carry-Over Cross-Year Booking Untested

**What goes wrong:** `apps/api/src/__tests__/leave.test.ts` covers basic flow but CLAUDE.md documents multiple untested scenarios: advance booking into next year with projected carry-over, partial-year pro-rata, carry-over expiry deadline enforcement (March 31 per BUrlG § 7 Abs. 3), and multiple leave type cross-year scenarios.

**Why it happens:** Cross-year booking is complex and the test file already exists (425 lines), creating false confidence that coverage is adequate.

**Consequences:**

- An employee booking Dec 27 - Jan 3 may have days charged to the wrong year's entitlement
- If carry-over is calculated incorrectly, employees may lose legally-entitled vacation days without recourse
- BUrlG § 7 Abs. 3 violations (carry-over past March 31 without documented reason) expose the employer to claims
- The "Hinweispflicht" (CLAUDE.md) — employer must warn before expiry — is untestable without test coverage for the expiry logic itself

**Warning signs:**

- No test with `startDate` in December and `endDate` in January
- No test asserting that year N+1 entitlement is debited separately from year N
- No test asserting March 31 deadline rejection

**Prevention:**
Add these specific test cases to the leave test suite:

1. `startDate: "2026-12-29"`, `endDate: "2027-01-02"` — assert 2 days from 2026 entitlement, 2 days from 2027 entitlement (accounting for the Dec 31 holiday)
2. `endDate: "2027-04-01"` for carried-over days — assert rejection with "Resturlaub verfallen" reason
3. Employee hired September 1: assert pro-rata entitlement = (4 months / 12) × annual days, rounded up

**Phase:** Testing phase — required before leave/calendar features are signed off as production-ready.

---

## Moderate Pitfalls

---

### Pitfall 7: Timezone Midnight Boundary in ArbZG Queries

**What goes wrong:** `apps/api/src/utils/arbzg.ts` line 35 queries time entries using a date range constructed from the date string in the tenant timezone. However, the query uses `new Date(dateStr)` and `new Date(dateStr + "T23:59:59.999Z")` — both anchored to UTC midnight, not tenant midnight. For Berlin (UTC+1 in winter), an entry at 23:30 Berlin time is stored as 22:30 UTC — it would be included. But an entry at 00:15 Berlin time is stored as 23:15 UTC the _previous_ day — it might be missed.

**Warning signs:**

- CONCERNS.md explicitly flags this as a known bug with "off-by-one errors at midnight boundaries"
- `monthRangeUtc` tests in `timezone.test.ts` show the correct UTC-aware approach, but `arbzg.ts` does not use `monthRangeUtc`

**Prevention:**

1. Replace direct `new Date(dateStr)` date range construction in `arbzg.ts` with the `monthRangeUtc` / day-range equivalent from `timezone.ts`
2. Add a specific test: entry at 23:45 Berlin time (= 22:45 UTC) should be included in that day's ArbZG check; entry at 00:10 Berlin time (= 23:10 UTC previous day) should be included in the _next_ day's check
3. Run ArbZG checks during DST transitions (last Sunday of March and October) explicitly

**Phase:** Testing phase (test first to expose the bug), then code audit phase (fix).

---

### Pitfall 8: Concurrent Time Entry Writes Without Optimistic Locking

**What goes wrong:** A manager and an employee editing the same time entry simultaneously (e.g., manager approving a correction while the employee saves an edit) will result in a last-write-wins overwrite. The earlier save is silently discarded.

**Why it happens:** No `version` field exists on `TimeEntry`. The UPDATE handler does not check whether the record has changed since the client loaded it.

**Consequences:**

- Audit trail shows both writes, but the intermediate state is lost
- The employee's legitimate working time can be silently overwritten
- In a locked month, `isLocked` prevents this — but the window before locking is unprotected

**Warning signs:**

- No `version` or `updatedAt`-based conflict detection in `PUT /time-entries/:id`
- No 409 Conflict response documented in the API schema

**Prevention:**

1. Add a `version Int @default(1)` field to the `TimeEntry` model
2. Require the client to send `version` in update requests
3. Return 409 if `version` in request does not match current DB value
4. Increment `version` on each successful update

**Phase:** Code audit phase — implement alongside the locking audit.

---

### Pitfall 9: Seed Script Compiled with `|| true` — Silent Compilation Failures

**What goes wrong:** `apps/api/Dockerfile` line 33 compiles the seed script with `2>/dev/null || true`. If the TypeScript compilation fails (e.g., after a schema change that breaks imports), no error is raised, no `dist/seed.js` is produced, and the `docker-entrypoint.sh` falls back to `npx tsx src/seed.ts` — which also fails in the production image because `tsx` is not installed in the runtime stage.

**Why it happens:** The `|| true` was added to prevent build failures when the seed script has minor type issues. The intent was "seed is optional, don't fail the build." But it creates a failure mode that is invisible at build time.

**Consequences:**

- A fresh deployment with `SEED_DEMO_DATA=true` silently skips seeding, leaving no demo tenant
- The entrypoint prints "Seed skipped (tsx not available or already seeded)" — which looks like a normal skip, not a failure
- Debugging this requires inspecting the Docker build logs, not the runtime logs

**Warning signs:**

- `npx tsc ... 2>/dev/null || true` in the Dockerfile
- `apps/api/docker-entrypoint.sh` line 51: the fallback to `tsx` in a production image

**Prevention:**

1. Remove `2>/dev/null || true` — let the build fail loudly if seed compilation fails
2. Alternatively: move seed to a separate `seeder` Docker target that runs as an init container or a one-off job, not inside the API container's startup
3. Test the Docker build on schema changes with `SEED_DEMO_DATA=true` as part of local verification

**Phase:** Code audit phase (infrastructure hardening).

---

### Pitfall 10: Monolithic Route Files Prevent Meaningful Unit Testing

**What goes wrong:** `leave.ts` (1516 lines), `time-entries.ts` (1369 lines), and `overtime.ts` (988 lines) mix business logic directly inside Fastify route handlers. There is no `services/` layer. Testing business logic requires spinning up a full Fastify instance with a live database connection.

**Why it happens:** Incremental feature development in a single file is faster in the short term.

**Consequences:**

- The leave carry-over calculation cannot be unit-tested with a fake/mock Prisma client — every test requires the full DB stack
- Test runs are inherently slow (integration tests against a live DB vs. sub-millisecond unit tests)
- Adding a bug in one function in `leave.ts` requires running all 425+ lines of leave tests to find it
- The ArbZG check _is_ extracted to a utility (`utils/arbzg.ts`) and _can_ be unit-tested — this is the right pattern

**Warning signs:**

- Business logic implemented inside `async handler()` functions rather than imported services
- No `apps/api/src/services/` directory
- Test files use `app.inject()` for every assertion (HTTP roundtrip required even for pure math)

**Prevention:**

1. Extract leave calculation logic to `services/leave-calc.ts` (pure functions, no Fastify dependency)
2. Extract time entry validation to `services/time-entry-validation.ts`
3. The ArbZG utility is the template: pure function, takes Prisma + args, returns result — can be tested with a mock Prisma client
4. Do NOT refactor everything at once — extract only the functions that need tests in the current milestone

**Phase:** Testing phase — extract as needed for test coverage, not as a blanket refactor.

---

### Pitfall 11: Password Policy Configuration Exists in DB but Has No UI

**What goes wrong:** `TenantConfig` has `passwordMinLength`, `passwordRequireUpper/Lower/Digit/Special` fields (schema lines 67-72). CONCERNS.md confirms there is no UI to edit these. The default 12-char policy applies to all tenants regardless of their security requirements.

**Consequences:**

- B2B customers with ISO 27001 or BSI requirements cannot configure password policies
- Admins do not know a policy configuration exists — they may assume the system has no password policy
- The default policy is applied silently, which is fine until a customer asks "can you lower the minimum length for our short-lived terminal accounts?" — the answer is technically yes but operationally impossible

**Warning signs:**

- `apps/web/src/routes/(app)/settings/+page.svelte` has no password policy form
- `apps/web/src/routes/(app)/admin/system/+page.svelte` is the likely correct location but this form is absent

**Prevention:**
Add a password policy form to the admin settings page. Low complexity: one form section with 5 fields and a save button. The API endpoint already handles password validation against these fields.

**Phase:** UI consistency phase.

---

## Minor Pitfalls

---

### Pitfall 12: Notification Polling at 60-Second Interval Without Backoff

**What goes wrong:** `apps/web/src/routes/(app)/+layout.svelte` line 108 polls `/api/v1/notifications` every 60 seconds for every logged-in user. There is no backoff on errors.

**Consequences:**

- If the API is slow or returns errors, the frontend floods it with a request every 60 seconds per user
- 100 concurrent users = 100 requests per minute to the notifications endpoint at steady state
- On mobile with a flaky connection, the polling may cause visible battery/data consumption

**Prevention:**

1. Add exponential backoff: on error, double the interval up to a maximum of 5 minutes
2. Clear the interval when the browser tab is hidden (`document.visibilityState === 'hidden'`)
3. Long-term: replace polling with Server-Sent Events (SSE) — Fastify supports this natively

**Phase:** UI/performance phase.

---

### Pitfall 13: `decryptSafe` Falls Back Silently for Pre-Migration Plaintext Passwords

**What goes wrong:** `decryptSafe` (crypto.ts line 47-55) returns the raw value if decryption throws. The comment says "might be plaintext (pre-migration)." If an admin stores a new SMTP password via the UI and it gets encrypted correctly, but a future `ENCRYPTION_KEY` change causes decryption to fail, the raw ciphertext is returned as the SMTP password. The SMTP connection attempt fails with an unhelpful auth error, not a decryption error.

**Note:** This is a specific symptom of Pitfall 4 above, treated separately because the fix is different: the plaintext fallback itself should be removed once migration is confirmed.

**Prevention:**
After confirming all tenants have migrated to encrypted storage (no plaintext passwords in the column), replace `decryptSafe` with `decrypt` (which throws) and handle the error explicitly at the call site.

**Phase:** Code audit phase — once the migration period is over.

---

### Pitfall 14: `app-main` Has No `overflow-x: hidden` on Mobile

**What goes wrong:** The layout CSS sets `margin-left: 0` and `padding: 4.5rem 1rem 5rem` on mobile, but individual page components that render wide tables (e.g., `admin/employees`, `reports`) may overflow horizontally on narrow viewports without being constrained.

**Warning signs:**

- Horizontal scroll appears on iPhone SE (375px viewport) on table-heavy pages
- Content is clipped or causes `overflow-x: scroll` on the `<body>`

**Prevention:**
Add `overflow-x: hidden` to `.app-main` in the layout CSS, and audit all table components for responsive handling (either horizontal scroll within the table container, or column hiding at small breakpoints).

**Phase:** UI/mobile responsiveness phase.

---

## Phase-Specific Warnings

| Phase Topic                  | Likely Pitfall                                  | Mitigation                                                                          |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| Test setup                   | Shared test DB contaminates runs (Pitfall 1)    | Add `PG_TEST_URL`, fix cleanup to use `try/finally` before writing any new tests    |
| ArbZG compliance tests       | No test file exists (Pitfall 5)                 | Create `arbzg.test.ts` from scratch; test each § independently with boundary values |
| Leave edge case tests        | Cross-year booking untested (Pitfall 6)         | Add Dec→Jan test cases; assert per-year entitlement deduction                       |
| Code audit — error handling  | Silent `.catch(() => {})` (Pitfall 3)           | Grep for the pattern, replace all 4 instances with logged errors                    |
| Code audit — security        | Google Fonts CDN (Pitfall 2)                    | Self-host fonts before any DSGVO claim is made to customers                         |
| Code audit — crypto          | `decryptSafe` plaintext fallback (Pitfall 4)    | Add startup health check; log decryption failures                                   |
| Code audit — concurrency     | No optimistic locking on TimeEntry (Pitfall 8)  | Add `version` field to schema; enforce in PUT handler                               |
| Infrastructure hardening     | Seed script compiled with `                     |                                                                                     | true` (Pitfall 9) | Remove suppression; fail loudly on seed compile error |
| UI consistency               | Password policy UI missing (Pitfall 11)         | Add one form section to admin settings                                              |
| Mobile responsiveness        | Table overflow on narrow viewports (Pitfall 14) | Audit all table pages at 375px; add `overflow-x: auto` to table wrappers            |
| Monatsabschluss / auto-close | Per-snapshot query N+1 (CONCERNS.md)            | Batch-load holidays and leave for affected date range before the snapshot loop      |

---

## Sources

- `/Users/sebastianzabel/git/clokr/.planning/codebase/CONCERNS.md` — codebase audit (2026-03-30)
- `/Users/sebastianzabel/git/clokr/CLAUDE.md` — project rules, ArbZG rules, DSGVO rules
- `/Users/sebastianzabel/git/clokr/apps/api/src/__tests__/setup.ts` — shared test DB pattern confirmed
- `/Users/sebastianzabel/git/clokr/apps/web/src/app.css` — Google Fonts import confirmed
- `/Users/sebastianzabel/git/clokr/apps/web/src/hooks.server.ts` — CSP whitelisting Google domains confirmed
- `/Users/sebastianzabel/git/clokr/apps/api/src/middleware/auth.ts` — fire-and-forget pattern confirmed
- `/Users/sebastianzabel/git/clokr/apps/api/src/routes/overtime.ts` — fire-and-forget overtime recalculation confirmed
- `/Users/sebastianzabel/git/clokr/apps/api/src/utils/crypto.ts` — `decryptSafe` plaintext fallback confirmed
- `/Users/sebastianzabel/git/clokr/apps/api/Dockerfile` — seed compilation with `|| true` confirmed
- `/Users/sebastianzabel/git/clokr/apps/api/src/utils/arbzg.ts` — ArbZG implementation reviewed; no test file exists
- LG München I, Az. 3 O 17493/20 (2022) — Google Fonts DSGVO ruling (MEDIUM confidence, widely reported)
- BUrlG § 7 Abs. 3 — carry-over deadline rule (HIGH confidence, statutory text)
- ArbZG §§ 3, 4, 5 — daily/weekly max and break/rest rules (HIGH confidence, statutory text)
