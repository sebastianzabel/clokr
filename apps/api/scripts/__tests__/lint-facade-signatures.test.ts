/**
 * Phase 100B Plan 03 (D-07/D-10) — non-vacuity proof for lint-facade-signatures.ts.
 *
 * Driven against FIXTURE TEXT, not the live tree (100B-03-PLAN.md Task 1 <action>): the live tree
 * has only 3 exported facade functions today, all grandfathered — a test asserting "0 findings"
 * over 3 pre-excepted functions would be a test of nothing. The fixtures below cover every F1/F2/F3
 * branch and the exception-file staleness machinery independently of what the live tree happens to
 * contain right now. A separate small "live tree" suite at the bottom pins the real, currently
 * green state (3 checked / 3 excepted / 0 findings) so a future regression there is caught too.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KNOWN_FACADE_FILES,
  MIN_REASON_LENGTH,
  analyzeSource,
  computeFindings,
  discoverFacadeFiles,
  formatSummary,
  validateExceptionsDocument,
  type ExportedFacadeFunction,
} from "../lint-facade-signatures";

const API_ROOT = join(__dirname, "..", "..");
const REPO_ROOT = join(API_ROOT, "..", "..");

// ── analyzeSource — the F1/F2/F3 fixture matrix (100B-03-PLAN.md Task 1 <action>) ───────────────

describe("analyzeSource — F1/F2/F3 fixture matrix", () => {
  it("a compliant signature (db: Prisma.TransactionClient, employeeId, tenantId) has 0 violations", () => {
    const src = `
      export async function getFoo(db: Prisma.TransactionClient, employeeId: string, tenantId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    expect(fn.functionName).toBe("getFoo");
    expect(fn.violations).toEqual([]);
  });

  it("an app: FastifyInstance signature fails F1, F2 AND F3 by name", () => {
    const src = `
      export async function getBar(app: FastifyInstance, employeeId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    const rules = fn.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(["F1", "F2", "F3"]);
    const f2 = fn.violations.find((v) => v.rule === "F2")!;
    expect(f2.message).toContain("FastifyInstance");
    expect(f2.message).toContain("$transaction");
    expect(f2.message).toContain("rollback");
    expect(f2.message).toContain("R1");
  });

  it("a Prisma.TransactionClient first parameter with the WRONG NAME (prisma, not db) fails ONLY F1", () => {
    const src = `
      export async function getBaz(prisma: Prisma.TransactionClient, tenantId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    expect(fn.violations.map((v) => v.rule)).toEqual(["F1"]);
    expect(fn.violations[0].message).toContain("db: Prisma.TransactionClient");
    expect(fn.violations[0].message).toContain("prisma: Prisma.TransactionClient");
  });

  it("an employeeId parameter WITHOUT a tenantId sibling fails ONLY F3", () => {
    const src = `
      export async function getQux(db: Prisma.TransactionClient, employeeId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    expect(fn.violations.map((v) => v.rule)).toEqual(["F3"]);
    expect(fn.violations[0].message).toContain("employeeId");
    expect(fn.violations[0].message).toContain("tenantId");
  });

  it("an employeeId parameter WITH a tenantId sibling has 0 violations", () => {
    const src = `
      export async function getQuux(db: Prisma.TransactionClient, employeeId: string, tenantId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    expect(fn.violations).toEqual([]);
  });

  it("a non-exported function is ignored entirely — not returned, not merely violation-free", () => {
    const src = `
      async function helperOnly(app: FastifyInstance, employeeId: string): Promise<void> {}
    `;
    expect(analyzeSource(src, "fixture.ts")).toEqual([]);
  });

  it("bare tenantId and bare id never trigger F3 on their own", () => {
    const src = `
      export async function getCorge(db: Prisma.TransactionClient, id: string, tenantId: string): Promise<void> {}
    `;
    const [fn] = analyzeSource(src, "fixture.ts");
    expect(fn.violations).toEqual([]);
  });

  it("multiple exported functions in one file are each checked independently", () => {
    const src = `
      export async function ok(db: Prisma.TransactionClient, tenantId: string): Promise<void> {}
      export async function bad(app: FastifyInstance): Promise<void> {}
    `;
    const fns = analyzeSource(src, "fixture.ts");
    expect(fns).toHaveLength(2);
    expect(fns.find((f) => f.functionName === "ok")!.violations).toEqual([]);
    expect(fns.find((f) => f.functionName === "bad")!.violations.map((v) => v.rule)).toEqual(
      expect.arrayContaining(["F1", "F2"]),
    );
  });
});

// ── discoverFacadeFiles — the #229 zero-file guard's precondition ──────────────────────────────

describe("discoverFacadeFiles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "lint-facade-signatures-fixture-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFixture(relPath: string, content: string): void {
    const abs = join(tmpRoot, relPath);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  it("finds every *.ts under contexts/*/facade/, skipping __tests__ and *.test.ts", () => {
    writeFixture("apps/api/src/contexts/scheduling/facade/shifts-facade.ts", "export {}");
    writeFixture(
      "apps/api/src/contexts/scheduling/facade/__tests__/shifts-facade.test.ts",
      "export {}",
    );
    writeFixture("apps/api/src/contexts/scheduling/facade/shifts-facade.test.ts", "export {}");
    const files = discoverFacadeFiles(tmpRoot, []);
    expect(files).toEqual(["apps/api/src/contexts/scheduling/facade/shifts-facade.ts"]);
  });

  it("unions the glob result with knownFiles, deduplicated and sorted", () => {
    writeFixture("apps/api/src/contexts/scheduling/facade/z-facade.ts", "export {}");
    writeFixture("apps/api/src/known.ts", "export {}");
    const files = discoverFacadeFiles(tmpRoot, ["apps/api/src/known.ts"]);
    expect(files).toEqual([
      "apps/api/src/contexts/scheduling/facade/z-facade.ts",
      "apps/api/src/known.ts",
    ]);
  });

  it("throws when a knownFiles entry does not exist on disk", () => {
    expect(() => discoverFacadeFiles(tmpRoot, ["apps/api/src/does-not-exist.ts"])).toThrow(
      /does not exist on disk/,
    );
  });

  it("returns an empty array when contexts/*/facade/ matches nothing and knownFiles is empty (the #229 state KNOWN_FACADE_FILES exists to prevent)", () => {
    expect(discoverFacadeFiles(tmpRoot, [])).toEqual([]);
  });
});

// ── validateExceptionsDocument — staleness and shape (mirrors lint-tenant-scoping-exceptions.ts) ─

describe("validateExceptionsDocument", () => {
  const violatingFn: ExportedFacadeFunction = {
    file: "apps/api/src/contexts/x/facade/y.ts",
    functionName: "getX",
    line: 5,
    violations: [{ rule: "F1", message: "wrong first parameter" }],
  };

  it("accepts a well-formed entry naming a rule the function currently violates", () => {
    const result = validateExceptionsDocument(
      [
        {
          file: violatingFn.file,
          function: violatingFn.functionName,
          rules: ["F1"],
          reason: "x".repeat(MIN_REASON_LENGTH),
        },
      ],
      [violatingFn],
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a stale entry naming a function that no longer exists", () => {
    const result = validateExceptionsDocument(
      [{ file: violatingFn.file, function: "goneNow", rules: ["F1"], reason: "x".repeat(40) }],
      [violatingFn],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("STALE");
  });

  it("rejects a stale entry naming a rule the function no longer violates", () => {
    const result = validateExceptionsDocument(
      [
        {
          file: violatingFn.file,
          function: violatingFn.functionName,
          rules: ["F1", "F2"],
          reason: "x".repeat(40),
        },
      ],
      [violatingFn], // violatingFn only violates F1, not F2
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/STALE.*F2/);
  });

  it("rejects an entry with a reason shorter than MIN_REASON_LENGTH", () => {
    const result = validateExceptionsDocument(
      [
        {
          file: violatingFn.file,
          function: violatingFn.functionName,
          rules: ["F1"],
          reason: "too short",
        },
      ],
      [violatingFn],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an entry naming an unknown rule", () => {
    const result = validateExceptionsDocument(
      [
        {
          file: violatingFn.file,
          function: violatingFn.functionName,
          rules: ["F9"],
          reason: "x".repeat(40),
        },
      ],
      [violatingFn],
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array payload", () => {
    const result = validateExceptionsDocument({ not: "an array" }, [violatingFn]);
    expect(result.ok).toBe(false);
  });
});

// ── computeFindings / formatSummary ─────────────────────────────────────────────────────────────

describe("computeFindings / formatSummary", () => {
  it("an excepted rule is not reported, an unexcepted rule on the SAME function still is", () => {
    const fn: ExportedFacadeFunction = {
      file: "f.ts",
      functionName: "getX",
      line: 1,
      violations: [
        { rule: "F1", message: "m1" },
        { rule: "F3", message: "m3" },
      ],
    };
    const findings = computeFindings(
      [fn],
      [{ file: "f.ts", function: "getX", rules: ["F1"], reason: "x".repeat(40) }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("F3");
  });

  it("formatSummary renders the exact three-count sentence", () => {
    expect(formatSummary(3, 3, 0)).toBe(
      "[lint:facade-signatures] 3 exported facade function(s) checked, 3 exception(s) applied, 0 finding(s).",
    );
  });
});

// ── Live tree — pins the real, currently green state ────────────────────────────────────────────

describe("live tree — KNOWN_FACADE_FILES against the real exceptions file", () => {
  // Phase 100B Plan 04: `contexts/platform/facade/employee-scope.ts` was the first REAL file the
  // glob (`contexts/*/facade/**/*.ts`) discovered on its own, on top of the two KNOWN_FACADE_FILES
  // — measured, not guessed, exactly the "measure fresh, don't copy a stale number" discipline
  // 100B-03-SUMMARY.md already applied to this same file's KNOWN_FACADE_FILES count.
  //
  // Phase 100B Plan 05 (Schichtplanung) added TWO more real facade files:
  // `contexts/scheduling/facade/shifts.ts` (S1/S2/S3 — 3 exported functions) and
  // `contexts/scheduling/facade/availability.ts` (S4 — 1 exported function). 5 files, 8 exported
  // functions total (employee-scope.ts's employeeScopeWhere + leave-check.ts's one +
  // confirmed-saldo.ts's two + shifts.ts's three + availability.ts's one), 4 exception entries
  // (only the pre-existing 4 grandfathered ones — none of plan 05's 4 new functions need one),
  // 0 findings.
  //
  // Phase 100B Plan 06 (Arbeitszeitkonto — OvertimeAccount/OvertimeTransaction) added ONE more
  // real facade file: `contexts/working-time-account/facade/overtime-account.ts` (W8-W15 — 8
  // exported functions: getOvertimeAccount, listOvertimeAccountsForTenant, getBalances,
  // bookOvertimeCompensation, reverseOvertimeCompensation, createOvertimeAccount,
  // setOvertimeAccountBalance, hardDeleteOvertimeDataForEmployee). Plan 07 adds
  // facade/saldo-snapshot.ts (isMonthClosed, getClosedMonthsForDates, getClosedMonthsInRange,
  // getMonthClosingBalance, getMonthlySnapshotsInRange, sumCarryOverByMonth,
  // countSnapshotsBefore — 7 functions, W2 split into two separately-named functions per
  // `lint:saldo-lock-derivation`'s facade-parameter resolver constraint — see
  // facade/saldo-snapshot.ts's own W2a docblock) AND removes confirmed-saldo.ts's two
  // grandfathering exceptions (converted to db: Prisma.TransactionClient, D-07) — the LAST
  // app: FastifyInstance facade in the tree.
  // Phase 100B Plan 08 (Wave 4) added ONE more real facade file:
  // `contexts/time-tracking/facade/time-entries.ts` (T1-T12 plus the T2 regrouping — 14 exported
  // functions: getValidWorkedEntriesInRange, getWorkedEntriesInRange,
  // getRecordedWorkEntriesInRange, getClaimedEntryDatesInRange, countLockedEntries,
  // getInvalidEntries, getEntryActivityFeed, revalidateLeaveCancellationEntries,
  // lockEntriesForMonth, unlockEntriesForMonth, archiveEntriesBefore,
  // clearEntryNotesForEmployee, hardDeleteTimeDataForEmployee, createImportedTimeEntry) and TWO
  // new named F3 exceptions (clearEntryNotesForEmployee, hardDeleteTimeDataForEmployee — same
  // shape as overtime-account.ts's hardDeleteOvertimeDataForEmployee).
  // Phase 100B Plan 09 (Wave 4, closing) added ONE more real facade file:
  // `contexts/time-tracking/facade/presence-devices.ts` (five exported functions:
  // listPresenceDevices, findPresenceDeviceByMac, createPresenceDevice, getPresenceDevice,
  // deletePresenceDevice) and TWO new named F3 exceptions (getPresenceDevice,
  // deletePresenceDevice — 'employeeId' is the caller's own principal identifier, same shape as
  // clearEntryNotesForEmployee/hardDeleteTimeDataForEmployee above).
  // Phase 100B Plan 10 (Wave 5, opening) added TWO more real facade files:
  // `contexts/absence/facade/leave-types.ts` (A17-A19 — originally 4 exported functions; its
  // display-name-based sibling was deleted in Phase 205 Plan 01 (zero remaining callers once the
  // pro-rata-exit site was rerouted to the code-based lookup), leaving getLeaveTypeByCode,
  // listLeaveTypes, updateLeaveType) and
  // `contexts/absence/facade/entitlements.ts` (A11-A16 plus the two originally display-name-based
  // siblings — originally 9 exported functions; the pro-rata-exit sibling was deleted in Phase 205
  // Plan 01 (its sole caller now resolves by code), and the § 7 BUrlG expiry-reminder sibling was
  // renamed in place to getVacationEntitlementsForYearByCode by Phase 205 Plan 02 (its `where` now
  // filters on LeaveType.code, not LeaveType.name — the rename does not change the count), leaving
  // getVacationEntitlement, listEntitlementsForYear, getEntitlementsForEmployee,
  // getEntitlementById, getExpiringCarryOver, upsertVacationEntitlement,
  // getVacationEntitlementsForYearByCode, hardDeleteEntitlementsForEmployee) and ONE new
  // named F3 exception (hardDeleteEntitlementsForEmployee — same shape as
  // hardDeleteOvertimeDataForEmployee/hardDeleteTimeDataForEmployee above).
  // Phase 100B Plan 11 (Wave 5) added TWO new facade files
  // (contexts/absence/facade/vocational-school-patterns.ts — getActiveBsPattern,
  // listActiveBsPatternsForWeek, listActiveBsPatternsWithFederalStateOverride;
  // contexts/absence/facade/section9-credits.ts — getConfirmedSection9Credits,
  // getSection9DocumentPaths, anonymizeSection9CreditsForEmployee) and TWO new named F3
  // exceptions (getSection9DocumentPaths, anonymizeSection9CreditsForEmployee — same shape as
  // clearEntryNotesForEmployee/hardDeleteEntitlementsForEmployee above).
  //
  // Phase 100B Plan 12 (Wave 5, closing model) added ONE new facade file
  // (contexts/absence/facade/absences.ts — getAbsencesOverlapping, getRosterSollAbsencesOverlapping,
  // getVocationalSchoolDays, hasVocationalSchoolDay, getAbsenceDocumentPaths,
  // anonymizeAbsencesForEmployee, hardDeleteAbsencesForEmployee, archiveAbsencesBefore — 8
  // functions) and THREE new named F3 exceptions (getAbsenceDocumentPaths,
  // anonymizeAbsencesForEmployee, hardDeleteAbsencesForEmployee — same shape as
  // getSection9DocumentPaths/anonymizeSection9CreditsForEmployee/hardDeleteEntitlementsForEmployee
  // above; archiveAbsencesBefore needs none, its tenantId parameter satisfies F3 directly).
  //
  // Phase 100B Plan 13 (Wave 5, LAST conversion plan — workload reaches zero) added ONE new facade
  // file (contexts/absence/facade/leave-requests.ts — getApprovedLeaveOverlapping,
  // getActiveLeaveOverlapping, getCalendarLeaveOverlapping, getOwnPendingLeaveRequests,
  // getStalePendingLeaveRequestsForReminder, getPendingLeaveDaysInYear, countPendingApprovals,
  // getLeaveStartingInWindow, getOwnLeaveActivity, getReviewedLeaveActivity,
  // getTeamLeaveSubmissions, getPendingLeaveForShiftProtection, anonymizeLeaveRequestsForEmployee,
  // hardDeleteLeaveRequestsForEmployee, archiveLeaveRequestsBefore — 15 functions) and TWO new
  // named F3 exceptions (anonymizeLeaveRequestsForEmployee, hardDeleteLeaveRequestsForEmployee —
  // same shape as anonymizeAbsencesForEmployee/hardDeleteAbsencesForEmployee above;
  // archiveLeaveRequestsBefore needs none, its tenantId parameter satisfies F3 directly, same as
  // archiveAbsencesBefore).
  // 16 files, 85 exported functions total, 15 exception entries, 0 findings.
  //
  // 84 -> 82 in Phase 205 Plan 01 (Issue #205): the pro-rata-exit and updateLeaveType-adjacent
  // display-name-based siblings in entitlements.ts and leave-types.ts were DELETED, not renamed.
  // Both resolved a LeaveType through its tenant-editable display name; their only callers now go
  // through the code-based getVacationEntitlement / getLeaveTypeByCode, so both were left without
  // a caller and removed. Count unchanged (still 82) after Phase 205 Plan 02's rename of the
  // remaining sibling to getVacationEntitlementsForYearByCode — a rename keeps the count, only a
  // delete or an add changes it.
  //
  // 82 -> 85 in Phase 64b Plan 01 (Issue #64): `contexts/platform/facade/salons.ts` added
  // (matches the `contexts/*/facade/**/*.ts` glob directly, no KNOWN_FACADE_FILES entry needed) —
  // 3 new exported functions (listSalons, countActiveSalons, isMultiSalonTenant), no new
  // exceptions (all 3 pass F1/F2/F3 directly). This golden number is a tripwire, updated only when
  // the tree legitimately changed — here it did.
  //
  // 85 -> 89 in Phase 64b Plan 02 (Issue #64, Task 1): `contexts/platform/facade/salons.ts` (same
  // file, already in the list above) gained 4 more exported functions — findSalon,
  // salonExistsInForeignTenant, createSalon, updateSalon — all four pass F1/F2/F3 directly (each
  // declares `db: Prisma.TransactionClient` first and, where a `*Id` parameter exists, a sibling
  // `tenantId`), so no new exception entry is needed.
  //
  // 89 -> 91 in Phase 64b Plan 02 (Issue #64, Task 2): same file, 2 more exported functions —
  // deactivateSalon, activateSalon — both pass F1/F2/F3 directly, no new exception needed.
  //
  // 91 -> 92 in Phase 64b Plan 04 (Issue #64, Task 1): same file, 1 more exported function —
  // syncSoleActiveSalonOpeningHours (D-16 storeHours<->salon mirror) — passes F1/F2/F3 directly
  // (`db: Prisma.TransactionClient` first, `tenantId` present alongside `openingHours` which does
  // not match the `*Ids?` trigger pattern), no new exception needed. The module-private
  // `normalizeOpeningHoursForCompare` helper is not exported and is not counted here.
  //
  // 92 -> 97 in Phase 67b Plan 01 (Issue #67, Task 1): `contexts/platform/facade/salon-assignments.ts`
  // added (matches the `contexts/*/facade/**/*.ts` glob directly, no KNOWN_FACADE_FILES entry
  // needed) — 5 new exported functions (readTenantTimezone, findEmployeeInTenant,
  // employeeExistsInForeignTenant, listSalonAssignments, salonForDay), all five pass F1/F2/F3
  // directly (each declares `db: Prisma.TransactionClient` first and a required `tenantId`), no new
  // exception needed.
  //
  // 97 -> 98 in Phase 67b Plan 02 (Issue #67, Task 1): `contexts/platform/facade/salon-assignment-
  // changes.ts` added (matches the glob directly) — 1 new exported function
  // (createDeploymentAssignment), passes F1/F2/F3 directly (`db: Prisma.TransactionClient` first,
  // `tenantId` required, `employeeId` paired with `tenantId`), no new exception needed.
  //
  // 98 -> 101 in Phase 67b Plan 02 (Issue #67, Task 2): `contexts/platform/facade/salon-
  // assignments.ts` gained 1 more exported function (salonAssignmentExistsInForeignTenant) and
  // `contexts/platform/facade/salon-assignment-changes.ts` (same two files already in the list
  // above) gained 2 more (changeHomeSalon, endSalonAssignment) — all three pass F1/F2/F3 directly
  // (`db: Prisma.TransactionClient` first, `tenantId` required, every `*Id` parameter paired with
  // `tenantId` or `employeeId`), no new exception needed.
  //
  // 101 -> 104 in Phase 67b Plan 03 (Issue #67, Task 2): `contexts/platform/facade/salon-
  // assignments.ts` (same file already in the list above) gained 3 more exported functions
  // (resolveHomeSalonForNewEmployee, createInitialHomeAssignment, fillHomeGapBeforeHireDate) — all
  // three pass F1/F2/F3 directly (`db: Prisma.TransactionClient` first, `tenantId` required, every
  // `*Id`/`*Ids` parameter — `requestedSalonId`, `employeeId`, `salonId` — paired with `tenantId`),
  // no new exception needed.
  it("the real tree has exactly 104 exported facade functions today, 15 grandfathered/named exceptions, 0 unexcepted findings", () => {
    const files = discoverFacadeFiles(REPO_ROOT);
    expect(files).toEqual(
      [
        ...KNOWN_FACADE_FILES,
        "apps/api/src/contexts/platform/facade/employee-scope.ts",
        "apps/api/src/contexts/platform/facade/salons.ts",
        "apps/api/src/contexts/platform/facade/salon-assignments.ts",
        "apps/api/src/contexts/platform/facade/salon-assignment-changes.ts",
        "apps/api/src/contexts/scheduling/facade/shifts.ts",
        "apps/api/src/contexts/scheduling/facade/availability.ts",
        "apps/api/src/contexts/time-tracking/facade/presence-devices.ts",
        "apps/api/src/contexts/time-tracking/facade/time-entries.ts",
        "apps/api/src/contexts/working-time-account/facade/overtime-account.ts",
        "apps/api/src/contexts/working-time-account/facade/saldo-snapshot.ts",
        "apps/api/src/contexts/absence/facade/leave-types.ts",
        "apps/api/src/contexts/absence/facade/entitlements.ts",
        "apps/api/src/contexts/absence/facade/vocational-school-patterns.ts",
        "apps/api/src/contexts/absence/facade/section9-credits.ts",
        "apps/api/src/contexts/absence/facade/absences.ts",
        "apps/api/src/contexts/absence/facade/leave-requests.ts",
      ].sort((a, b) => a.localeCompare(b)),
    );

    const functions = files.flatMap((relFile) => {
      const abs = join(REPO_ROOT, relFile);
      expect(existsSync(abs)).toBe(true);
      return analyzeSource(readFileSync(abs, "utf8"), relFile);
    });
    expect(functions).toHaveLength(104);

    const rawExceptions = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "apps/api/scripts/lint-facade-signatures-exceptions.json"),
        "utf8",
      ),
    );
    const validated = validateExceptionsDocument(rawExceptions, functions);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.entries).toHaveLength(15);
      const findings = computeFindings(functions, validated.entries);
      expect(findings).toEqual([]);
    }
  });
});
