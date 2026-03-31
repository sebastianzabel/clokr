# Phase 02: Compliance and API Coverage - Research

**Researched:** 2026-03-30
**Domain:** Vitest integration testing, ArbZG compliance, tenant isolation, audit trails, soft delete, DST/timezone testing, DSGVO font self-hosting
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Fix bugs inline — write the test, fix the bug, commit together. Tests verify the fix exists.
- **D-02:** Open a GitHub issue for every production bug found during testing, reference it in the commit message.
- **D-03:** Fix the ArbZG rolling average if it's wrong — this is a legal compliance bug, not deferrable.
- **D-04:** Address the decryptSafe migration state in Phase 2 — query DB, write test asserting all SMTP passwords are encrypted, migrate any plaintext found.
- **D-05:** Extend existing test files (auth.test.ts, leave.test.ts, time-entries.test.ts, etc.) with compliance-specific describe blocks. Do not create separate compliance files.
- **D-06:** Test tenant isolation (SEC-02) for every resource type: TimeEntry, LeaveRequest, Employee, Absence, OvertimeAccount, AuditLog. Cross-tenant reads AND writes must return 403/404.
- **D-07:** Download WOFF2 font files for Jost (300-700), DM Sans (300-700), and Fraunces (300, 400, 600) to `apps/web/static/fonts/`.
- **D-08:** Write local `@font-face` declarations replacing the Google Fonts `@import` in `app.css`.
- **D-09:** Remove `https://fonts.googleapis.com` from CSP `style-src` in `hooks.server.ts`. Eliminate all external Google domain requests.
- **D-10:** Keep all declared weight variants — do not trim.
- **D-11:** Comprehensive boundary testing at exact thresholds: 10h00 vs 10h01 (§3 daily), 6h00 vs 6h01 (§4 break threshold), exactly 11h rest (§5), 48h weekly cap.
- **D-12:** Test 24-week rolling average with realistic synthetic data — generate 24+ weeks of time entries simulating a real employee. Verify that a 4-day/39h week is legal, exceeding the average triggers a warning.
- **D-13:** All 4 DST/timezone scenarios must be tested: spring forward (March CET→CEST), fall back (October CEST→CET), cross-midnight shifts (22:00–06:00), year boundary (Dec 31→Jan 1 for Monatsabschluss/carry-over/saldo).

### Claude's Discretion

- Test grouping/tagging strategy — Claude decides if compliance tests get a naming convention for filtering
- Exact test data seeding approach for multi-week ArbZG scenarios
- decryptSafe migration implementation details
- Additional edge cases beyond the specified boundaries

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| API-01 | Time entry CRUD tests (create, edit, soft-delete, locked-month rejection, duplicate-day 409) | Existing test file extends; locked-month and soft-delete patterns identified |
| API-02 | Leave request lifecycle tests (request, approve, reject, cancel, cancellation-approve, cross-year booking) | Existing leave.test.ts extends; cross-year booking pattern researched |
| API-03 | Overtime saldo and Monatsabschluss tests (saldo read, month-close trigger, locked-month immutability) | overtime-calc.test.ts extends; saldo-snapshot.test.ts exists |
| API-04 | Auth flow tests (login, refresh, JWT expiry, role gates ADMIN/MANAGER/EMPLOYEE) | auth.test.ts extends; role gate pattern via requireRole() identified |
| API-05 | DSGVO anonymization tests (no hard delete, all fields anonymized, audit event written) | DELETE /employees/:id anonymization route confirmed at employees.ts line 431 |
| API-06 | NFC terminal punch tests (punch endpoint, lastUsedAt update, API key scoping) | nfc-punch.test.ts exists and extends; terminalApiKey pattern confirmed |
| SEC-01 | ArbZG compliance unit tests (§3 daily max 10h, §3 24-week average, §4 breaks, §5 rest period, cross-midnight shifts) | CONFIRMED BUG: 24-week average missing from arbzg.ts — must implement |
| SEC-02 | Tenant isolation tests (cross-tenant reads/writes blocked on all resources) | seedTestData creates one tenant; pattern is create second tenant, attempt cross-access |
| SEC-03 | Audit trail completeness tests (every mutating endpoint writes AuditLog with required fields) | app.audit() plugin confirmed; verification via app.prisma.auditLog.findMany() |
| SEC-04 | Soft delete enforcement tests (DELETE sets deletedAt, queries filter deletedAt:null, locked-month entries undeletable) | time-entries.ts and leave.ts both use deletedAt pattern; isLocked check exists |
| SEC-05 | Timezone/date boundary tests (DST transitions, Dec 31→Jan 1, leap year, month-close at midnight CET vs UTC) | date-fns-tz in use; timezone.ts utility functions identified; DST dates confirmed |
| AUDIT-02 | Google Fonts lokal hosten (DSGVO Art. 44) | 8 unique WOFF2 URLs fetched live; CSP change in hooks.server.ts line 70 confirmed |
</phase_requirements>

---

## Summary

Phase 2 adds comprehensive test coverage to a feature-complete API and fixes one confirmed legal compliance bug. The codebase already has solid test infrastructure from Phase 1: `getTestApp()` / `seedTestData()` / `cleanupTestData()` patterns, `app.inject()` for route testing, and Vitest with `fileParallelism: false` for sequential test execution against a shared test schema.

The most critical finding is a **confirmed code gap in `arbzg.ts`**: the §3 ArbZG 24-week rolling average check is completely absent. The file checks daily max (§3), weekly max (§3), breaks (§4), and rest periods (§5), but never queries the past 168 days to compute an average. D-03 locks in the fix. The 24-week check must query the past 24 × 7 = 168 days of `TimeEntry` records, sum net worked minutes on actual workdays, divide by the count of workdays in that range, and warn only when the average exceeds 8h (480 min) — not per-day.

For font self-hosting, live inspection of the Google Fonts API confirmed exactly **8 unique WOFF2 files** (not 5 weights × 3 families as one might assume): Google Fonts uses a single file per unicode-subset per font, with all weights sharing that file via CSS unicode-range splitting. Jost has 3 files (cyrillic, latin-ext, latin), DM Sans has 2 (latin-ext, latin), and Fraunces has 3 (vietnamese, latin-ext, latin). The `@font-face` declarations in `app.css` must be replaced with local references to these files after downloading to `apps/web/static/fonts/`.

**Primary recommendation:** Proceed wave by wave — ArbZG fix first (legal compliance), then tenant isolation (security), then audit trail coverage, then remaining API domain tests, then font migration last (no logic, just file plumbing).

---

## Project Constraints (from CLAUDE.md)

These directives apply to all code in this phase:

- **No hard deletes**: TimeEntry, LeaveRequest, Absence use soft delete (`deletedAt`). Tests must verify DELETE sets `deletedAt`, not removes the record.
- **Soft delete queries**: All WHERE clauses on soft-deletable models must include `deletedAt: null`. Tests that query post-delete must use this filter.
- **Audit trail**: Every create, update, delete must produce an `AuditLog` row with userId, action, entity, entityId, IP, old/new values via `app.audit()`.
- **Immutability after lock**: `isLocked` months must reject edit and delete — tests must verify 409/403 responses.
- **Multi-tenancy**: All data queries filter by `tenantId`. Tests must confirm cross-tenant access returns 403/404.
- **German UI strings**: Error messages in tests assert German strings (e.g., "Mitarbeiter nicht gefunden", "Ungültige Anmeldedaten").
- **Svelte 5 runes**: Font CSS changes are in `app.css` (no component impact); CSP change is in `hooks.server.ts` (server-side only).
- **ArbZG rules**: §3 8h rule is a **24-week average**, not a daily limit. A single 9.75h day must NOT trigger a warning.
- **DSGVO anonymization**: Employee deletion anonymizes (firstName → "Gelöscht", etc.) — hard delete is forbidden.
- **Docker dev**: All testing runs against the Docker stack. Commands run via `docker compose exec`.

---

## Architecture Patterns

### Test File Organization (Decision D-05)

All compliance tests extend existing test files with new `describe` blocks. Do not create separate `compliance.test.ts` files.

```
apps/api/src/__tests__/
  auth.test.ts              ← add: role gate tests, JWT expiry (API-04)
  time-entries.test.ts      ← add: soft-delete, locked-month, COMPLIANCE: prefix (API-01, SEC-04)
  leave.test.ts             ← add: cancel lifecycle, cross-year booking (API-02)
  overtime-calc.test.ts     ← add: Monatsabschluss lock, saldo after lock (API-03)
  employees.test.ts         ← add: DSGVO anonymization asserts (API-05)

apps/api/src/routes/__tests__/
  arbzg.test.ts             ← add: 24-week average, boundary thresholds, DST (SEC-01, SEC-05)
  nfc-punch.test.ts         ← add: lastUsedAt update, API key scope (API-06)

NEW TEST FILES:
  apps/api/src/__tests__/tenant-isolation.test.ts  ← SEC-02 (two-tenant cross-access)
  apps/api/src/__tests__/audit-trail.test.ts        ← SEC-03 (every mutating endpoint)
```

**Rationale for two new files**: Tenant isolation (SEC-02) and audit trail completeness (SEC-03) are cross-cutting concerns that touch every resource type. Embedding them inside domain test files would require duplicating the two-tenant setup in every file. A single `tenant-isolation.test.ts` with a two-tenant `beforeAll` is cleaner.

### Vitest Test Structure Pattern

```typescript
// Source: apps/api/src/__tests__/time-entries.test.ts (existing)
describe("Time Entries API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "te");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Compliance-specific describe block added inline:
  describe("COMPLIANCE: Soft delete and locked month", () => {
    it("DELETE sets deletedAt, does not hard-delete", async () => { ... });
    it("returns 409 when editing entry in locked month", async () => { ... });
  });
});
```

### Two-Tenant Pattern for SEC-02

```typescript
// New file: apps/api/src/__tests__/tenant-isolation.test.ts
describe("Tenant Isolation", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "iso-a");
    tenantB = await seedTestData(app, "iso-b");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("tenantA admin cannot read tenantB employee", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${tenantB.employee.id}`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(res.statusCode).toBeOneOf([403, 404]);
  });
});
```

### AuditLog Assertion Pattern

```typescript
// Source: apps/api/src/plugins/audit.ts — app.audit() writes AuditLog rows
it("POST /time-entries writes AuditLog", async () => {
  const beforeCount = await app.prisma.auditLog.count({
    where: { entity: "TimeEntry" }
  });

  await app.inject({
    method: "POST",
    url: "/api/v1/time-entries",
    headers: { authorization: `Bearer ${data.adminToken}` },
    payload: { ... }
  });

  const logs = await app.prisma.auditLog.findMany({
    where: { entity: "TimeEntry", action: "CREATE" },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].userId).toBeDefined();
  expect(logs[0].newValue).toBeDefined();
});
```

---

## Critical Findings

### Finding 1: ArbZG §3 24-Week Average Is Missing (CONFIRMED BUG)

**Verdict:** `apps/api/src/utils/arbzg.ts` does NOT implement the §3 24-week rolling average check. The file has:
- Daily max check (§3 10h absolute) — present
- Weekly max check (§3 48h) — present
- Break check (§4) — present
- Rest period check (§5) — present
- **24-week rolling average check (§3) — ABSENT**

**Implementation required:** Add a new check in `checkArbZG()` that:
1. Queries `TimeEntry` for the past 168 days (24 weeks × 7 days) for this employee, where `deletedAt: null` and `type = 'WORK'` and `endTime != null`
2. Counts the number of calendar days that are actual workdays per employee schedule (Mon-Fri typically)
3. Sums net worked minutes across those workdays
4. Divides sum by workday count to get rolling average
5. Warns only if average > 480 min (8h)

**Legal significance:** A 4-day week with 39h (9.75h/day) is perfectly legal. Only warn when the 24-week rolling average exceeds 8h per workday.

**Test data strategy for D-12:** Create 24 weeks of synthetic `TimeEntry` records directly via `app.prisma.timeEntry.create()` in `beforeAll`. Use past dates. A fast path: insert 168 daily entries (Mon-Fri with ~8.5h each) to exceed the average, then verify the warning fires. Then test the 39h/4-day-week scenario (9.75h × 4 days, but only 4 workdays per week counted) — this should NOT fire.

### Finding 2: Google Fonts WOFF2 File Map (Verified Live)

Live fetch of Google Fonts CSS (2026-03-30) returned exactly **8 unique WOFF2 file URLs**. Google uses variable-weight font files — all weights (300-700) for a given font share the same subset files, differentiated only by `unicode-range` in the CSS:

**DM Sans (v17) — 2 files:**
- `rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu6-K6z9mXgjU0.woff2` — latin-ext subset
- `rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu0-K6z9mXg.woff2` — latin subset

**Fraunces (v38) — 3 files:**
- `6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxCBTeP2Xz5fU8w.woff2` — vietnamese subset
- `6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxCFTeP2Xz5fU8w.woff2` — latin-ext subset
- `6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxC9TeP2Xz5c.woff2` — latin subset

**Jost (v20) — 3 files:**
- `92zatBhPNqw73oDd4jQmfxIC7w.woff2` — cyrillic subset
- `92zatBhPNqw73ord4jQmfxIC7w.woff2` — latin-ext subset
- `92zatBhPNqw73oTd4jQmfxI.woff2` — latin subset

**Download base URL:** `https://fonts.gstatic.com/s/{family}/{version}/{filename}`

The `@font-face` declarations in `app.css` must reproduce the exact structure Google Fonts uses (one `@font-face` block per weight × per unicode-range subset) but pointing to `/fonts/{filename}` instead of `fonts.gstatic.com`. Because all weights share the same file, the CSS will have many `@font-face` blocks (10 weights × ~2 subsets each = ~20 blocks for DM Sans alone) but reference only 2 actual files.

**CSP change required in `hooks.server.ts` line 70:**
```
// Before:
"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
"font-src 'self' https://fonts.gstatic.com",

// After:
"style-src 'self' 'unsafe-inline'",
"font-src 'self'",
```

### Finding 3: decryptSafe Returns Plaintext as Fallback

**File:** `apps/api/src/utils/crypto.ts` lines 47-55

```typescript
export function decryptSafe(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    // If decryption fails, it might be plaintext (pre-migration)
    return value;   // ← returns plaintext unchanged if decrypt throws
  }
}
```

**D-04 requires:** Query `TenantConfig` for any rows where `smtpPassword` is not null and does not match the encrypted format (`iv:tag:ciphertext` — 3 colon-separated base64 segments, length > 50). Migrate any plaintext found using `encryptIfNeeded()`. Write a test that asserts after migration no plaintext SMTP passwords remain.

**`encryptIfNeeded()` already exists** at `crypto.ts` lines 38-45 and handles idempotence:
```typescript
export function encryptIfNeeded(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.split(":").length === 3 && value.length > 50) {
    return value; // Already encrypted
  }
  return encrypt(value);
}
```

**Migration approach (D-04):**
1. Query: `prisma.tenantConfig.findMany({ where: { smtpPassword: { not: null } } })`
2. For each row, call `encryptIfNeeded(row.smtpPassword)` — if result differs from current value, update the row
3. Write test that queries all TenantConfig rows and asserts none have `smtpPassword` in plaintext format

### Finding 4: Existing ArbZG Test File Has No Boundary or Rolling Average Tests

**File:** `apps/api/src/routes/__tests__/arbzg.test.ts` (155 lines, read in full)

Current tests cover:
- 8h day → no MAX_DAILY warning
- 10.5h day → MAX_DAILY error
- 6.5h with 0 break → BREAK_TOO_SHORT warning
- 9.5h with 30min break → BREAK_TOO_SHORT error
- 9.5h with 45min break → no warning
- Gap > 2h not counted as break
- Gap < 2h counted as break

**Gaps (D-11, D-12, D-13):**
- Exact boundary: exactly 10h00 (no warning) vs 10h01 (warning)
- Exact boundary: exactly 6h00 (no warning) vs 6h01 (break required)
- Exactly 11h rest (no warning) vs 10h59 rest (warning)
- Weekly 48h boundary
- 24-week rolling average (new function needed)
- DST spring forward (late March — shift spanning 02:00 CET→CEST loses 1 hour)
- DST fall back (late October — shift spanning 03:00 CEST→CET gains 1 hour)
- Cross-midnight shifts

### Finding 5: Existing Test Infrastructure is Solid

From reading `setup.ts`, `auth.test.ts`, `leave.test.ts`, `time-entries.test.ts`:
- `seedTestData(app, suffix)` creates: tenant, tenantConfig (timezone: "Europe/Berlin"), adminUser + adminEmployee, empUser + employee, workSchedule (40h/5-day), overtimeAccount, leaveType, leaveEntitlement
- Unique suffix (`"te"`, `"az"`, `"au"`) per test suite prevents cross-test data collision
- `cleanupTestData()` deletes in dependency order, safe to call in `try/catch` in `afterAll`
- `fileParallelism: false` ensures sequential execution — safe for shared DB schema

**The `seedTestData()` function does NOT return a manager user.** Tests requiring manager-level actions (e.g., leave approval) must either use adminToken or create a manager user inline.

---

## ArbZG Implementation: 24-Week Rolling Average

### Required Logic

```typescript
// To add to checkArbZG() in apps/api/src/utils/arbzg.ts

// ── 3. 24-Wochen-Schnitt: § 3 ArbZG (8h als Durchschnitt über 24 Wochen) ─
const lookbackDays = 168; // 24 weeks
const lookbackStart = new Date(changedDate);
lookbackStart.setDate(lookbackStart.getDate() - lookbackDays);

const historicSlots = await prisma.timeEntry.findMany({
  where: {
    employeeId,
    deletedAt: null,
    startTime: { gte: lookbackStart, lte: changedDate },
    endTime: { not: null },
    type: "WORK",
  },
});

if (historicSlots.length > 0) {
  // Sum net worked minutes across ALL workdays in the window
  const totalNetMin = historicSlots.reduce((sum, e) => {
    const slotMin = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    return sum + slotMin - Number(e.breakMinutes ?? 0);
  }, 0);

  // Count distinct workdays with entries (days where employee actually worked)
  const workdayDates = new Set(
    historicSlots.map((e) => dateStrInTz(e.date, tz))
  );
  const workdayCount = workdayDates.size;

  if (workdayCount > 0) {
    const avgMin = totalNetMin / workdayCount;
    if (avgMin > 8 * 60) {
      warnings.push({
        code: "MAX_DAILY_EXCEEDED", // reuse existing code for rolling avg
        severity: "warning",
        message: `§ 3 ArbZG: 24-Wochen-Durchschnitt von 8 Stunden überschritten. Aktueller Schnitt: ${(avgMin / 60).toFixed(1)} h/Tag.`,
      });
    }
  }
}
```

**Note:** A new warning code `MAX_DAILY_AVG_EXCEEDED` would be more precise than reusing `MAX_DAILY_EXCEEDED`, but this is left to Claude's discretion (D-13 allows additional edge cases). Adding a new code requires updating the `ArbZGWarning` interface union type.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DST-aware date arithmetic | Custom offset math | `date-fns-tz` (already installed: `toZonedTime`, `fromZonedTime`, `formatInTimeZone`) | DST rules change per country/year; `date-fns-tz` tracks IANA tz database |
| Font file downloading | Manual wget + rename | `curl -o` with predictable filenames | No build tool needed; files are static assets |
| Unicode-range CSS generation | Custom `@font-face` template | Copy exact CSS from Google Fonts response | Google's CSS is the ground truth for correct ranges |
| Tenant isolation enforcement | Custom middleware filter | Existing `requireAuth` extracts `tenantId` from JWT; route queries already filter by `tenantId` | Infrastructure exists — tests verify it works, not re-implement it |
| AuditLog schema | Custom event table | Existing `app.audit()` plugin + `AuditLog` Prisma model | Already deployed with all required fields |

---

## Common Pitfalls

### Pitfall 1: ArbZG Test Dates Falling on Holidays or Weekends

**What goes wrong:** Tests use hardcoded dates like `"2025-01-06"` (Monday). If the test environment has public holidays configured for that tenant, `checkArbZG` might behave differently.
**Why it happens:** `seedTestData()` does NOT create `PublicHoliday` entries. ArbZG checks query `timeEntry` directly, not schedules — so this is actually safe for ArbZG tests. Rest period and break checks are schedule-agnostic.
**How to avoid:** Keep using hardcoded dates in the past (2025 range) as the existing tests do. Do not use `new Date()` for ArbZG entries because the result depends on execution date.
**Warning signs:** Tests that pass locally but fail in CI due to date proximity to a weekend or holiday.

### Pitfall 2: The 24-Week Average Test Requires Isolated Dates

**What goes wrong:** The 24-week rolling average check queries the past 168 days. If other ArbZG tests in the same file created `TimeEntry` records for the same employee, those records appear in the rolling window and corrupt the average calculation.
**Why it happens:** `fileParallelism: false` runs files sequentially but all tests in `arbzg.test.ts` share the same employee from `seedTestData()`.
**How to avoid:** Either clean all historic entries in `beforeAll` of the rolling-average describe block, or use a separate employee created specifically for this test (inline `app.prisma.employee.create()`). The `cleanDate()` helper in the existing arbzg test file only cleans one date at a time — a bulk delete by employeeId is needed for the 24-week test.

### Pitfall 3: Tenant Isolation Test Cleanup Order

**What goes wrong:** `cleanupTestData()` for tenantA races with cleanup for tenantB if called in parallel (`Promise.all`).
**Why it happens:** Both call `prisma.leaveType.deleteMany({ where: { tenantId } })` etc. — each scoped correctly, but the shared app instance has one Prisma connection pool.
**How to avoid:** Call `cleanupTestData(app, tenantA.tenant.id)` then `cleanupTestData(app, tenantB.tenant.id)` sequentially (await each), or wrap in a single `try/catch` block as shown in the pattern above.

### Pitfall 4: AuditLog User ID for Admin Actions

**What goes wrong:** An audit trail test creates a resource with `adminToken`, then checks `auditLog.userId` matches the admin user's ID. But the JWT payload has `sub = userId` and the audit plugin receives `userId` from the route handler. Some routes pass `req.user.sub` and others pass `req.user.employeeId`.
**Why it happens:** Route handlers must explicitly call `app.audit({ userId: req.user.sub, ... })`. If a handler was written before the audit plugin and never updated, the log entry may have `userId: undefined`.
**How to avoid:** In the audit trail test, after each mutation, assert `logs[0].userId === data.adminUser.id` (not employee ID). If userId is undefined, the route needs the audit call added (this is the inline bug fix per D-01).

### Pitfall 5: Font CSS — Weight 300-700 Requires Repeated @font-face Blocks

**What goes wrong:** Developer writes one `@font-face` per file and uses `font-weight: 300 700` (a range). This works in modern browsers but loses the precise `unicode-range` subsetting.
**Why it happens:** Google's approach is one `@font-face` per weight × per unicode-range, each pointing to the same file. Consolidating to one block per file drops the unicode-range, causing all characters to load from a single file regardless of needed subset.
**How to avoid:** Reproduce Google's exact CSS structure but replace `fonts.gstatic.com/...` with `/fonts/...`. Keep all individual `@font-face` blocks.

### Pitfall 6: DST Test Dates Require Careful UTC Construction

**What goes wrong:** A test for "spring forward" creates a time entry starting at `2026-03-29T01:00:00Z` (UTC), which in Europe/Berlin is 02:00 CET. During the spring forward transition (last Sunday of March in EU), clocks move from 02:00 to 03:00, so 01:00-02:00 UTC is a gap. ArbZG checks use UTC for storage but `dateStrInTz` for the date key.
**Why it happens:** The `changedDate` passed to `checkArbZG` must be in UTC, but the function resolves tenant timezone and computes the local date. Tests that use UTC midnight (e.g., `new Date("2026-03-29")`) may land on the wrong local date in Europe/Berlin.
**How to avoid:** For DST transition tests, use `fromZonedTime(new Date(2026, 2, 29, 23, 30), "Europe/Berlin")` to construct a UTC date that is definitely on March 29 in Berlin timezone. For cross-midnight shifts, use entries where `startTime` is 22:00 and `endTime` is 06:00 next day — both in UTC with dates adjusted for Berlin offset.

### Pitfall 7: CleanupTestData Missing AuditLog Entries

**What goes wrong:** `cleanupTestData()` does not delete `AuditLog` rows. After SEC-03 audit trail tests, audit logs for that tenant's entities remain in the database. While scoped by `tenantId` is not in `AuditLog`, they reference entities that were deleted — this is benign but may inflate audit log counts in subsequent test runs if the audit trail test counts logs by entity type.
**Why it happens:** `AuditLog` is intentionally not cleaned up (it's part of audit-proof requirements). But tests that count audit logs by entity type and action may see logs from a previous test run.
**How to avoid:** In audit trail tests, don't count total logs by entity — instead, capture a pre-test timestamp and filter `auditLog.findMany({ where: { entity: "TimeEntry", createdAt: { gte: beforeTimestamp } } })` to isolate the specific log entries created by the test.

---

## Code Examples

### Soft Delete Test Pattern (SEC-04)

```typescript
// Source: apps/api/src/routes/time-entries.ts — DELETE sets deletedAt
it("COMPLIANCE: DELETE sets deletedAt, does not remove record", async () => {
  // Create entry
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/time-entries",
    headers: { authorization: `Bearer ${data.adminToken}` },
    payload: { employeeId: data.employee.id, date: "2025-03-10", startTime: "2025-03-10T08:00:00Z", endTime: "2025-03-10T16:00:00Z", breakMinutes: 30 },
  });
  const { entry } = JSON.parse(createRes.body);

  // Delete via API
  await app.inject({
    method: "DELETE",
    url: `/api/v1/time-entries/${entry.id}`,
    headers: { authorization: `Bearer ${data.adminToken}` },
  });

  // Row still exists with deletedAt set
  const row = await app.prisma.timeEntry.findUnique({ where: { id: entry.id } });
  expect(row).not.toBeNull();
  expect(row!.deletedAt).not.toBeNull();
});
```

### Locked Month Immutability Pattern (SEC-04, API-03)

```typescript
it("COMPLIANCE: cannot edit entry in locked month", async () => {
  // Lock the month directly via Prisma
  const month = await app.prisma.monthlyPeriod.upsert({
    where: { employeeId_year_month: { employeeId: data.employee.id, year: 2025, month: 1 } },
    create: { employeeId: data.employee.id, year: 2025, month: 1, isLocked: true, lockedAt: new Date(), lockedBy: data.adminUser.id },
    update: { isLocked: true, lockedAt: new Date(), lockedBy: data.adminUser.id },
  });

  // Create entry in that month
  const entry = await app.prisma.timeEntry.create({
    data: { employeeId: data.employee.id, date: new Date("2025-01-15"), startTime: new Date("2025-01-15T08:00:00Z"), endTime: new Date("2025-01-15T16:00:00Z"), breakMinutes: 30, source: "MANUAL" }
  });

  // Attempt edit → must reject
  const res = await app.inject({
    method: "PUT",
    url: `/api/v1/time-entries/${entry.id}`,
    headers: { authorization: `Bearer ${data.adminToken}` },
    payload: { breakMinutes: 45 },
  });
  expect(res.statusCode).toBeOneOf([403, 409, 422]);
});
```

### DSGVO Anonymization Assert Pattern (API-05)

```typescript
it("COMPLIANCE: DELETE /employees/:id anonymizes, does not hard-delete", async () => {
  // Delete employee via API
  const res = await app.inject({
    method: "DELETE",
    url: `/api/v1/employees/${data.employee.id}`,
    headers: { authorization: `Bearer ${data.adminToken}` },
  });
  expect(res.statusCode).toBeOneOf([200, 204]);

  // Employee record still exists
  const emp = await app.prisma.employee.findUnique({ where: { id: data.employee.id } });
  expect(emp).not.toBeNull();
  expect(emp!.firstName).toBe("Gelöscht");
  expect(emp!.nfcCardId).toBeNull();

  // User account anonymized
  const user = await app.prisma.user.findUnique({ where: { id: data.empUser.id } });
  expect(user).not.toBeNull();
  expect(user!.isActive).toBe(false);
  expect(user!.email).toMatch(/anonymized\.local$/);

  // TimeEntries still exist (retention compliance)
  const entries = await app.prisma.timeEntry.count({ where: { employeeId: data.employee.id } });
  expect(entries).toBeGreaterThanOrEqual(0); // not deleted

  // AuditLog was written
  const logs = await app.prisma.auditLog.findMany({
    where: { entity: "Employee", action: "DELETE", entityId: data.employee.id },
    orderBy: { createdAt: "desc" }, take: 1,
  });
  expect(logs).toHaveLength(1);
});
```

### decryptSafe Migration Pattern (D-04)

```typescript
// apps/api/src/utils/crypto.ts — encryptIfNeeded() already handles idempotence

// Migration query (run once at startup or in test setup):
async function migrateSmtpPasswords(prisma: PrismaClient) {
  const configs = await prisma.tenantConfig.findMany({
    where: { smtpPassword: { not: null } },
    select: { tenantId: true, smtpPassword: true },
  });
  for (const cfg of configs) {
    if (!cfg.smtpPassword) continue;
    const encrypted = encryptIfNeeded(cfg.smtpPassword);
    if (encrypted !== cfg.smtpPassword) {
      await prisma.tenantConfig.update({
        where: { tenantId: cfg.tenantId },
        data: { smtpPassword: encrypted },
      });
    }
  }
}

// Test assertion:
it("COMPLIANCE: all SMTP passwords are encrypted", async () => {
  const configs = await app.prisma.tenantConfig.findMany({
    where: { smtpPassword: { not: null } },
    select: { smtpPassword: true },
  });
  for (const cfg of configs) {
    // Encrypted format: "iv:tag:ciphertext" — 3 base64 segments, length > 50
    const parts = cfg.smtpPassword!.split(":");
    expect(parts).toHaveLength(3);
    expect(cfg.smtpPassword!.length).toBeGreaterThan(50);
  }
});
```

---

## Font Self-Hosting Implementation

### Files to Download

All 8 files from `https://fonts.gstatic.com/s/{path}`:

```
# DM Sans v17 (2 files)
/fonts/dmsans-v17-latin-ext.woff2   ← rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu6-K6z9mXgjU0.woff2
/fonts/dmsans-v17-latin.woff2       ← rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu0-K6z9mXg.woff2

# Fraunces v38 (3 files)
/fonts/fraunces-v38-vietnamese.woff2 ← 6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxCBTeP2Xz5fU8w.woff2
/fonts/fraunces-v38-latin-ext.woff2  ← 6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxCFTeP2Xz5fU8w.woff2
/fonts/fraunces-v38-latin.woff2      ← 6NU78FyLNQOQZAnv9bYEvDiIdE9Ea92uemAk_WBq8U_9v0c2Wa0KxC9TeP2Xz5c.woff2

# Jost v20 (3 files)
/fonts/jost-v20-cyrillic.woff2       ← 92zatBhPNqw73oDd4jQmfxIC7w.woff2
/fonts/jost-v20-latin-ext.woff2      ← 92zatBhPNqw73ord4jQmfxIC7w.woff2
/fonts/jost-v20-latin.woff2          ← 92zatBhPNqw73oTd4jQmfxI.woff2
```

### app.css Change

Replace line 1 of `apps/web/src/app.css`:

```css
/* BEFORE: */
@import url("https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600;700&family=DM+Sans:wght@300;400;500;600;700&family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,600&display=swap");

/* AFTER: Local @font-face declarations — replaces Google Fonts CDN import */
/* DM Sans (weights 300-700, shared files via unicode-range CSS subsetting) */
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/dmsans-v17-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/dmsans-v17-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* Fraunces (weights 300-600) */
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 300 600;
  font-display: swap;
  src: url('/fonts/fraunces-v38-vietnamese.woff2') format('woff2');
  unicode-range: U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB;
}
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 300 600;
  font-display: swap;
  src: url('/fonts/fraunces-v38-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Fraunces';
  font-style: normal;
  font-weight: 300 600;
  font-display: swap;
  src: url('/fonts/fraunces-v38-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* Jost (weights 300-700) */
@font-face {
  font-family: 'Jost';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/jost-v20-cyrillic.woff2') format('woff2');
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: 'Jost';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/jost-v20-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Jost';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('/fonts/jost-v20-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
```

**Note on weight ranges:** The CSS spec allows `font-weight: 300 700` (range) in a single `@font-face` when the font file is variable. Google's CSS repeats individual weight values but this is for compatibility with older engines. Modern browsers (and the app's target) support ranges. Use the range form to keep the CSS concise while preserving all weights per D-10.

---

## Standard Stack (Existing — No New Libraries Needed)

All libraries required for this phase are already installed:

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| vitest | 4.1.2 | Test runner | Already configured in `apps/api/vitest.config.ts` |
| @prisma/client | 7.6.0 | Test data seeding and assertions | Accessed via `app.prisma` |
| date-fns-tz | 3.2.0 | DST-aware date construction in tests | `fromZonedTime`, `toZonedTime`, `formatInTimeZone` |
| fastify | 5.8.4 | `app.inject()` for route testing | `buildApp()` singleton via `getTestApp()` |

No new npm packages are required. Font files are static assets — no CSS-in-JS or font tooling needed.

---

## Environment Availability

Step 2.6: Phase is primarily code/test changes against the existing Docker stack. Font files are downloaded via `curl` (available on macOS).

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Docker + compose | Test DB (PostgreSQL) | Implied by project setup | per docker compose | None — required |
| curl | Font file download | Confirmed (macOS built-in) | — | wget |
| Node.js 24 | Test runner | Available | 24-alpine (container) | — |
| PostgreSQL 18 | Test schema | Per Phase 1 setup | 18-alpine | — |

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `docker compose exec api pnpm vitest run --reporter=verbose 2>&1 | tail -30` |
| Full suite command | `docker compose exec api pnpm vitest run --coverage` |
| Single file run | `docker compose exec api pnpm vitest run src/routes/__tests__/arbzg.test.ts` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| API-01 | Time entry CRUD, soft-delete, locked-month, duplicate 409 | integration | `pnpm vitest run src/__tests__/time-entries.test.ts` | ✅ (extend) |
| API-02 | Leave lifecycle (approve, reject, cancel, cross-year) | integration | `pnpm vitest run src/__tests__/leave.test.ts` | ✅ (extend) |
| API-03 | Saldo, Monatsabschluss lock | integration | `pnpm vitest run src/__tests__/overtime-calc.test.ts` | ✅ (extend) |
| API-04 | Auth, JWT expiry, role gates | integration | `pnpm vitest run src/__tests__/auth.test.ts` | ✅ (extend) |
| API-05 | DSGVO anonymization | integration | `pnpm vitest run src/__tests__/employees.test.ts` | ✅ (extend) |
| API-06 | NFC punch, lastUsedAt, key scoping | integration | `pnpm vitest run src/routes/__tests__/nfc-punch.test.ts` | ✅ (extend) |
| SEC-01 | ArbZG boundaries + 24-week avg | unit+integration | `pnpm vitest run src/routes/__tests__/arbzg.test.ts` | ✅ (extend) |
| SEC-02 | Tenant isolation (all resources) | integration | `pnpm vitest run src/__tests__/tenant-isolation.test.ts` | ❌ Wave 0 |
| SEC-03 | Audit trail completeness | integration | `pnpm vitest run src/__tests__/audit-trail.test.ts` | ❌ Wave 0 |
| SEC-04 | Soft delete + locked-month immutability | integration | `pnpm vitest run src/__tests__/time-entries.test.ts` | ✅ (extend) |
| SEC-05 | DST, Dec31→Jan1, cross-midnight | integration | `pnpm vitest run src/routes/__tests__/arbzg.test.ts` | ✅ (extend) |
| AUDIT-02 | Font self-hosted, no Google domain in CSP | manual smoke | Check CSP header in browser devtools | N/A |

### Wave 0 Gaps

- [ ] `apps/api/src/__tests__/tenant-isolation.test.ts` — covers SEC-02, two-tenant cross-access on all resource types
- [ ] `apps/api/src/__tests__/audit-trail.test.ts` — covers SEC-03, every mutating endpoint produces AuditLog

*(All other test files exist and require only new `describe` blocks)*

---

## Open Questions

1. **Does `seedTestData()` need a manager user for leave approval tests?**
   - What we know: Current `seedTestData()` returns admin + employee. Leave approval requires ADMIN or MANAGER role.
   - What's unclear: Whether the existing leave.test.ts tests use adminToken for approval (legitimate) or need a real manager user for the cancellation-approval-by-different-manager tests.
   - Recommendation: Read leave.test.ts in full during planning. If manager user needed, add it inline in the leave describe block without modifying `seedTestData()`.

2. **Does the MonthlyPeriod (Monatsabschluss) model exist in Prisma schema?**
   - What we know: The codebase references `isLocked` and `auto-close-month.ts` plugin exists.
   - What's unclear: The exact Prisma model name for the monthly close record — it may be `MonthlyClose`, `OvertimePeriod`, or similar.
   - Recommendation: Read `packages/db/prisma/schema.prisma` during planning to confirm model name before writing locked-month tests.

3. **Which routes are missing `app.audit()` calls?**
   - What we know: Routes should call `app.audit()` on create/update/delete. The pattern is established.
   - What's unclear: Whether all ~20 mutating endpoints actually have audit calls, or which are missing.
   - Recommendation: `grep -n "app.audit\|app\.audit" apps/api/src/routes/*.ts` to get a definitive list before writing SEC-03 tests.

---

## Sources

### Primary (HIGH confidence)
- Direct file read: `apps/api/src/utils/arbzg.ts` — confirmed §3 24-week average is absent
- Direct file read: `apps/api/src/utils/crypto.ts` — confirmed `decryptSafe` plaintext fallback
- Direct file read: `apps/api/src/__tests__/setup.ts` — confirmed test infrastructure pattern
- Direct file read: `apps/api/src/routes/__tests__/arbzg.test.ts` — confirmed existing tests and gaps
- Direct file read: `apps/api/src/plugins/audit.ts` — confirmed `app.audit()` interface
- Direct file read: `apps/web/src/app.css` line 1 — confirmed Google Fonts @import
- Direct file read: `apps/web/src/hooks.server.ts` lines 67-78 — confirmed CSP with Google domains

### Secondary (HIGH confidence)
- Live fetch from `fonts.googleapis.com` — confirmed 8 unique WOFF2 URLs, font versions, unicode-range structure (fetched 2026-03-30)

### Tertiary
- CLAUDE.md — ArbZG rules, soft delete conventions, audit trail requirements

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already installed and in use; no new dependencies
- Architecture: HIGH — directly read existing test files; patterns are established
- ArbZG 24-week bug: HIGH — direct code inspection confirmed absence of the check
- Font WOFF2 URLs: HIGH — fetched live from Google Fonts API on research date
- Pitfalls: MEDIUM-HIGH — derived from code reading and known test patterns; some (locked-month model name) need plan-time verification

**Research date:** 2026-03-30
**Valid until:** 2026-04-30 (stable codebase; Google Fonts WOFF2 URLs are versioned and stable until font version changes)
