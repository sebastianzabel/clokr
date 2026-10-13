/**
 * Phase 76.24-01 — Same-month AZ-model-switch guard regression tests.
 *
 * Verifies that PUT /settings/work/:employeeId and the bulk-apply path enforce:
 *  D-01  — type change colliding with existing same-month-1st row → HTTP 400
 *  D-01a — hours-only edit within the SAME type → update-in-place (200, no new row)
 *  D-01b — MODEL_SWITCH_SAME_MONTH_ERROR is the canonical message asserted
 *
 * Also verifies the bulk-apply path (Issue #568: preview, then PUT /settings/work with the
 * preview's fingerprint and selection):
 *  - A differing-type row at the chosen effective date is a non-candidate (SAME_MONTH_MODEL_SWITCH):
 *    it is never overwritten or duplicated, and sending its id is refused with 409
 *  - A contract that already starts after the effective date is a non-candidate (FUTURE_CONTRACT)
 *  - Exposes `skippedModelSwitch` in the response
 *  - Same-type FIXED_SCHEDULE bulk apply still writes a versioned row, now at the effective date
 *
 * Test run: pnpm --filter @clokr/api test -- schedule-type-switch-guard
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../../../__tests__/setup";
import { dbDateStr, monthStartUtc } from "../../../../__tests__/test-dates";
import {
  applyBulkDefaults,
  previewBulkApply,
  type BulkPreviewBody,
} from "../../../../__tests__/bulk-apply-helpers";
import { MODEL_SWITCH_SAME_MONTH_ERROR } from "../../month-first-date";
import type { FastifyInstance } from "fastify";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Canonical FIXED_SCHEDULE payload for a month-1st target. */
function fixedPayload(validFrom: string, weeklyHours = 40) {
  return {
    type: "FIXED_SCHEDULE",
    weeklyHours,
    mondayHours: weeklyHours / 5,
    tuesdayHours: weeklyHours / 5,
    wednesdayHours: weeklyHours / 5,
    thursdayHours: weeklyHours / 5,
    fridayHours: weeklyHours / 5,
    saturdayHours: 0,
    sundayHours: 0,
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    validFrom,
  };
}

/** Canonical SHIFT_BASED payload for a month-1st target. */
function shiftPayload(validFrom: string) {
  return {
    type: "SHIFT_BASED",
    weeklyHours: 40,
    usualWorkDays: [1, 2, 3, 4, 5], // Issue #481 R5: SHIFT_BASED requires übliche Arbeitstage
    monthlyHours: null,
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    overtimeMode: "CARRY_FORWARD",
    validFrom,
  };
}

/** Canonical MONTHLY_HOURS payload for a month-1st target. */
function monthlyPayload(validFrom: string, monthlyHours = 80) {
  return {
    type: "MONTHLY_HOURS",
    weeklyHours: null,
    monthlyHours,
    mondayHours: 0,
    tuesdayHours: 0,
    wednesdayHours: 0,
    thursdayHours: 0,
    fridayHours: 0,
    saturdayHours: 0,
    sundayHours: 0,
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    overtimeMode: "CARRY_FORWARD",
    validFrom,
  };
}

const DEFAULTS_40 = {
  defaultWeeklyHours: 40,
  defaultMondayHours: 8,
  defaultTuesdayHours: 8,
  defaultWednesdayHours: 8,
  defaultThursdayHours: 8,
  defaultFridayHours: 8,
  defaultSaturdayHours: 0,
  defaultSundayHours: 0,
};

/** The ids a preview lists under one non-candidate reason (empty when the group is absent). */
function nonCandidateIds(preview: BulkPreviewBody, reason: string): string[] {
  const group = preview.nonCandidates.find((g) => g.reason === reason);
  return group ? group.employees.map((e) => e.employeeId) : [];
}

// ── suite ────────────────────────────────────────────────────────────────────

describe("Schedule type-switch guard (Phase 76.24-01)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "stsg");
  });

  /** A fresh employee of the tenant with no contract row: always a default-selected candidate. */
  async function mkNoContractEmployee(label: string): Promise<string> {
    const uid = `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: { email: `stsg-${uid}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `STSG-${uid}`,
        firstName: "Bulk",
        lastName: label,
        hireDate: new Date("2024-01-01"),
      },
    });
    return employee.id;
  }

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── PUT /settings/work/:employeeId — single-employee path ──────────────────

  describe("Single-employee PUT — type change with NO existing row at target validFrom", () => {
    it("creates a distinct new row when switching type to a validFrom that has no existing row", async () => {
      const empId = data.employee.id;
      const targetFrom = "2027-01-01"; // far future — no existing row

      // Count before
      const before = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

      // Switch FIXED → SHIFT_BASED at a clean month boundary
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: shiftPayload(targetFrom),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.type).toBe("SHIFT_BASED");
      expect(body.validFrom.startsWith(targetFrom)).toBe(true);

      // Exactly one new row was added
      const after = await app.prisma.workSchedule.count({ where: { employeeId: empId } });
      expect(after).toBe(before + 1);

      // The prior row (initial FIXED_SCHEDULE) remains queryable
      const prior = await app.prisma.workSchedule.findFirst({
        where: { employeeId: empId, validFrom: new Date("2024-01-01") },
      });
      expect(prior).not.toBeNull();
      expect(prior!.type).toBe("FIXED_SCHEDULE");
    });
  });

  describe("Single-employee PUT — same-month type collision → HTTP 400", () => {
    it("rejects a type change when a differing-type row already exists at the target month-1st", async () => {
      const empId = data.employee.id;
      const targetFrom = "2027-02-01";

      // First: write FIXED_SCHEDULE row at that validFrom (succeeds — no collision)
      const setup = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: fixedPayload(targetFrom, 35),
      });
      expect(setup.statusCode).toBe(200);

      // Verify that row now exists with type FIXED_SCHEDULE
      const existingRow = await app.prisma.workSchedule.findFirst({
        where: { employeeId: empId, validFrom: new Date(targetFrom) },
      });
      expect(existingRow).not.toBeNull();
      expect(existingRow!.type).toBe("FIXED_SCHEDULE");
      const existingRowId = existingRow!.id;
      const countBefore = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

      // Now try to switch to SHIFT_BASED at the SAME validFrom → must 400
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: shiftPayload(targetFrom),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe(MODEL_SWITCH_SAME_MONTH_ERROR);

      // Row count unchanged — no mutation
      const countAfter = await app.prisma.workSchedule.count({ where: { employeeId: empId } });
      expect(countAfter).toBe(countBefore);

      // The existing row is untouched — still FIXED_SCHEDULE
      const rowAfter = await app.prisma.workSchedule.findUnique({ where: { id: existingRowId } });
      expect(rowAfter).not.toBeNull();
      expect(rowAfter!.type).toBe("FIXED_SCHEDULE");
    });

    it("rejects MONTHLY_HOURS→FIXED collision at the same month-1st", async () => {
      const empId = data.employee.id;
      const targetFrom = "2027-03-01";

      // Write MONTHLY_HOURS first
      const setup = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: monthlyPayload(targetFrom),
      });
      expect(setup.statusCode).toBe(200);

      // Try FIXED_SCHEDULE at same validFrom → must 400
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: fixedPayload(targetFrom),
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe(MODEL_SWITCH_SAME_MONTH_ERROR);
    });
  });

  describe("Single-employee PUT — hours-only edit within SAME type (D-01a) → update-in-place", () => {
    it("updates existing row in-place when type matches — no new row created", async () => {
      const empId = data.employee.id;
      const targetFrom = "2027-04-01";

      // Write FIXED_SCHEDULE 40h
      const first = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: fixedPayload(targetFrom, 40),
      });
      expect(first.statusCode).toBe(200);

      const countAfterFirst = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

      // Update hours only — same type FIXED_SCHEDULE at same validFrom
      const second = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: fixedPayload(targetFrom, 32), // hours changed, type same
      });

      expect(second.statusCode).toBe(200);
      const body = JSON.parse(second.body);
      expect(Number(body.weeklyHours)).toBe(32);
      expect(body.type).toBe("FIXED_SCHEDULE");
      expect(body.validFrom.startsWith(targetFrom)).toBe(true);

      // No new row — count unchanged
      const countAfterSecond = await app.prisma.workSchedule.count({
        where: { employeeId: empId },
      });
      expect(countAfterSecond).toBe(countAfterFirst);
    });
  });

  describe("Single-employee PUT — non-month-1st validFrom still rejected (#220 unchanged)", () => {
    it("rejects a non-month-1st validFrom with MONTH_FIRST_ERROR (Zod-level, unchanged)", async () => {
      const empId = data.employee.id;

      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: shiftPayload("2027-06-15"), // mid-month → Zod refinement rejects
      });

      expect(res.statusCode).toBe(400);
      // MONTH_FIRST_ERROR is the Zod message; MODEL_SWITCH_SAME_MONTH_ERROR must NOT appear
      expect(res.body).toContain("Vertragswechsel sind nur zum Monats-1. erlaubt");
      expect(res.body).not.toContain("Modellwechsel");
    });
  });

  describe("Single-employee PUT — SHIFT_BASED→other collision also guarded (orphan branch)", () => {
    it("rejects SHIFT_BASED→FIXED collision at same month-1st even via the orphan-shift branch", async () => {
      const empId = data.employee.id;
      const targetFrom = "2027-05-01";

      // Write SHIFT_BASED row at that validFrom so a row exists
      const setup = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: shiftPayload(targetFrom),
      });
      expect(setup.statusCode).toBe(200);

      // Prior effective schedule (before targetFrom) must be SHIFT_BASED for the
      // orphan-shift detection branch to trigger. Let's set that up by ensuring
      // the prior effective schedule is SHIFT_BASED.
      // The employee currently has SHIFT_BASED at targetFrom. Now try to switch
      // back to FIXED_SCHEDULE at the same validFrom — must 400.
      // (cancelOrphanShifts=true so we enter the orphan branch explicitly)
      const res = await app.inject({
        method: "PUT",
        url: `/api/v1/settings/work/${empId}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          ...fixedPayload(targetFrom),
          cancelOrphanShifts: true,
        },
      });

      // Must be rejected because existing row at targetFrom is SHIFT_BASED,
      // and the submitted type (FIXED_SCHEDULE) differs → collision
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe(MODEL_SWITCH_SAME_MONTH_ERROR);
    });
  });

  // ── Bulk apply (PUT /settings/work) — applyToExisting path ────────────────

  describe("Bulk apply — differing-type same-month row is skipped, not overwritten", () => {
    it("skips employees with a non-FIXED differing-type row at the effective date", async () => {
      // Use adminEmployee — its schedule is seeded as FIXED_SCHEDULE with validFrom=2024-01-01
      // and is only modified by other bulk-apply tests (not the single-employee tests above).
      // The engineered state, relative to the bulk apply's effective date E (the 1st of NEXT
      // month under the mid-month clock below — a bulk apply is never retroactive, Issue #568):
      //   1) the contract valid at E is the seeded FIXED_SCHEDULE row (valid-before row)
      //   2) a MONTHLY_HOURS row exists exactly at E — the collision the guard must block
      const empId = data.adminEmployee.id;
      // Issue #136 (batch D): E is derived from "now" and compared/seeded against, while the
      // server ALSO resolves its own "now" at request time — a month-end crossing between the
      // seed and the request makes the engineered collision land in the wrong month and the
      // guard silently stops firing. Pin the clock across seed + request + assertion to a
      // derived, safely-mid-month instant so the test's and the server's "now" are the same
      // instant by construction.
      vi.useFakeTimers({
        now: new Date(monthStartUtc(0).getTime() + 10 * 24 * 60 * 60 * 1000),
        toFake: ["Date"],
      });
      try {
        // Issue #434: `data.adminToken` was minted under the REAL clock in `beforeAll`, with a
        // 15-minute `JWT_EXPIRES_IN`. The fake "now" above can land 10+ days ahead of that real
        // issuance (early in a calendar month), which reads as an already-expired token and 401s.
        // Re-issue it at the now-active faked "now" so its `iat`/`exp` are anchored correctly.
        const adminTokenNow = reissueTokenNow(app, data.adminToken);

        const thisMonthFirst = monthStartUtc(0);
        // E: the first allowed effective date under the mid-month clock.
        const effectiveFrom = monthStartUtc(-1);

        // Clean slate from this month on for this employee
        await app.prisma.workSchedule.deleteMany({
          where: { employeeId: empId, validFrom: { gte: thisMonthFirst } },
        });

        // Write MONTHLY_HOURS at E (the collision row the guard must block)
        await app.prisma.workSchedule.create({
          data: {
            employeeId: empId,
            type: "MONTHLY_HOURS",
            weeklyHours: null,
            monthlyHours: 80,
            mondayHours: 0,
            tuesdayHours: 0,
            wednesdayHours: 0,
            thursdayHours: 0,
            fridayHours: 0,
            saturdayHours: 0,
            sundayHours: 0,
            overtimeThreshold: 60,
            allowOvertimePayout: false,
            validFrom: effectiveFrom,
          },
        });

        // Confirm collision row is MONTHLY_HOURS
        const preRow = await app.prisma.workSchedule.findFirst({
          where: { employeeId: empId, validFrom: effectiveFrom },
        });
        expect(preRow).not.toBeNull();
        expect(preRow!.type).toBe("MONTHLY_HOURS");

        // A fresh no-contract employee so the preview has a default-selected candidate and the
        // apply actually runs (the guarded employee must be skipped, not the whole apply).
        const freshId = await mkNoContractEmployee("collision");

        const preCount = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

        // The preview lists the admin employee as a same-month model switch, not as a candidate
        const preview = await previewBulkApply(app, adminTokenNow, { defaults: DEFAULTS_40 });
        expect(preview.effectiveFrom).toBe(dbDateStr(effectiveFrom));
        expect(nonCandidateIds(preview, "SAME_MONTH_MODEL_SWITCH")).toContain(empId);
        expect(preview.candidates.map((c) => c.employeeId)).not.toContain(empId);

        // Act: bulk apply of the default-selected candidates.
        // The guarded employee must be skipped and counted in skippedModelSwitch.
        const { res } = await applyBulkDefaults(app, adminTokenNow, {
          defaults: DEFAULTS_40,
          employeeIds: "defaultSelected",
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);

        // The admin employee was skipped because of model-switch collision
        expect(typeof body.skippedModelSwitch).toBe("number");
        expect(body.skippedModelSwitch).toBeGreaterThanOrEqual(1);

        // The fresh employee did get its row, at E
        const freshRows = await app.prisma.workSchedule.findMany({
          where: { employeeId: freshId },
        });
        expect(freshRows).toHaveLength(1);
        expect(freshRows[0].validFrom.toISOString()).toBe(effectiveFrom.toISOString());

        // Row count unchanged — no new row created at E for the admin employee
        const postCount = await app.prisma.workSchedule.count({ where: { employeeId: empId } });
        expect(postCount).toBe(preCount);

        // The MONTHLY_HOURS collision row is still intact
        const postRow = await app.prisma.workSchedule.findFirst({
          where: { employeeId: empId, validFrom: effectiveFrom },
        });
        expect(postRow).not.toBeNull();
        expect(postRow!.type).toBe("MONTHLY_HOURS");

        // Sending the guarded id explicitly is refused (it is no candidate), nothing changes
        const forced = await applyBulkDefaults(app, adminTokenNow, {
          defaults: DEFAULTS_40,
          employeeIds: [empId],
        });
        expect(forced.res.statusCode).toBe(409);
        expect(JSON.parse(forced.res.body).code).toBe("BULK_APPLY_PREVIEW_STALE");
        expect(await app.prisma.workSchedule.count({ where: { employeeId: empId } })).toBe(
          preCount,
        );
        const stillRow = await app.prisma.workSchedule.findFirst({
          where: { employeeId: empId, validFrom: effectiveFrom },
        });
        expect(stillRow!.type).toBe("MONTHLY_HOURS");
      } finally {
        vi.useRealTimers();
      }
    });

    it("lists a contract that starts after the effective date as FUTURE_CONTRACT and refuses its id", async () => {
      // The pre-#568 shape of this scenario was a FIXED row two months ahead that made the
      // employee the "most recent contract" holder. A row after E cannot be superseded by a row
      // inserted at E, so the employee is a non-candidate with its own reason.
      const empId = data.adminEmployee.id;
      vi.useFakeTimers({
        now: new Date(monthStartUtc(0).getTime() + 10 * 24 * 60 * 60 * 1000),
        toFake: ["Date"],
      });
      try {
        const adminTokenNow = reissueTokenNow(app, data.adminToken);
        const thisMonthFirst = monthStartUtc(0);
        const effectiveFrom = monthStartUtc(-1);
        // One month after E
        const laterMonthFirst = new Date(
          Date.UTC(effectiveFrom.getUTCFullYear(), effectiveFrom.getUTCMonth() + 1, 1),
        );

        await app.prisma.workSchedule.deleteMany({
          where: { employeeId: empId, validFrom: { gte: thisMonthFirst } },
        });
        await app.prisma.workSchedule.create({
          data: {
            employeeId: empId,
            type: "FIXED_SCHEDULE",
            weeklyHours: 40,
            mondayHours: 8,
            tuesdayHours: 8,
            wednesdayHours: 8,
            thursdayHours: 8,
            fridayHours: 8,
            saturdayHours: 0,
            sundayHours: 0,
            overtimeThreshold: 60,
            allowOvertimePayout: false,
            validFrom: laterMonthFirst,
          },
        });
        const preCount = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

        const preview = await previewBulkApply(app, adminTokenNow, { defaults: DEFAULTS_40 });
        expect(preview.effectiveFrom).toBe(dbDateStr(effectiveFrom));
        expect(nonCandidateIds(preview, "FUTURE_CONTRACT")).toContain(empId);
        expect(preview.candidates.map((c) => c.employeeId)).not.toContain(empId);

        const forced = await applyBulkDefaults(app, adminTokenNow, {
          defaults: DEFAULTS_40,
          employeeIds: [empId],
        });
        expect(forced.res.statusCode).toBe(409);
        expect(JSON.parse(forced.res.body).code).toBe("BULK_APPLY_PREVIEW_STALE");
        expect(await app.prisma.workSchedule.count({ where: { employeeId: empId } })).toBe(
          preCount,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Bulk apply — same-type FIXED_SCHEDULE employee still gets versioned row", () => {
    it("creates a versioned month-1st row for a FIXED_SCHEDULE employee (no regression)", async () => {
      // Use the regular employee (data.employee) for the same-type no-collision test.
      // By this point its most-recent schedule is a SHIFT_BASED row (from single-employee
      // tests), so it won't be a candidate. Use the adminEmployee instead but after ensuring a
      // clean known state: remove all rows from this month on so the seeded FIXED row is the
      // contract valid at the effective date, then let the bulk apply create a versioned row
      // at that date (the 1st of NEXT month — never retroactive, Issue #568).
      const empId = data.adminEmployee.id;

      // Issue #136 (batch D): same remedy as the collision test above — pin the clock
      // across the derivation, the request and the assertion.
      vi.useFakeTimers({
        now: new Date(monthStartUtc(0).getTime() + 10 * 24 * 60 * 60 * 1000),
        toFake: ["Date"],
      });
      try {
        // Issue #434: `data.adminToken` was minted under the REAL clock in `beforeAll`, with a
        // 15-minute `JWT_EXPIRES_IN`. The fake "now" above can land 10+ days ahead of that real
        // issuance (early in a calendar month), which reads as an already-expired token and 401s.
        // Re-issue it at the now-active faked "now" so its `iat`/`exp` are anchored correctly.
        const adminTokenNow = reissueTokenNow(app, data.adminToken);

        const thisMonthFirst = monthStartUtc(0);
        const effectiveFrom = monthStartUtc(-1);

        // Clean up any rows from this month on (left from the collision tests above)
        await app.prisma.workSchedule.deleteMany({
          where: { employeeId: empId, validFrom: { gte: thisMonthFirst } },
        });

        // The most-recent schedule is now the seeded 2024-01-01 FIXED_SCHEDULE row
        const current = await app.prisma.workSchedule.findFirst({
          where: { employeeId: empId },
          orderBy: { validFrom: "desc" },
        });
        expect(current?.type).toBe("FIXED_SCHEDULE");

        const beforeCount = await app.prisma.workSchedule.count({ where: { employeeId: empId } });

        // Act: bulk apply — no collision at E; the employee is selected explicitly (its stored
        // contract differs from the stored defaults, so it is not pre-ticked by default)
        const { res, preview } = await applyBulkDefaults(app, adminTokenNow, {
          defaults: {
            defaultWeeklyHours: 38,
            defaultMondayHours: 7.6,
            defaultTuesdayHours: 7.6,
            defaultWednesdayHours: 7.6,
            defaultThursdayHours: 7.6,
            defaultFridayHours: 7.6,
            defaultSaturdayHours: 0,
            defaultSundayHours: 0,
          },
          employeeIds: [empId],
        });
        expect(preview.effectiveFrom).toBe(dbDateStr(effectiveFrom));

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.appliedCount).toBeGreaterThanOrEqual(1);

        // Admin employee got a new versioned row
        const afterCount = await app.prisma.workSchedule.count({ where: { employeeId: empId } });
        expect(afterCount).toBe(beforeCount + 1);

        // The new row is at the effective date with 38h
        const newRow = await app.prisma.workSchedule.findFirst({
          where: { employeeId: empId, validFrom: effectiveFrom },
        });
        expect(newRow).not.toBeNull();
        expect(Number(newRow!.weeklyHours)).toBe(38);
        expect(newRow!.type).toBe("FIXED_SCHEDULE");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
