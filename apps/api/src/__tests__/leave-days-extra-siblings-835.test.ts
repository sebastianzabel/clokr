/**
 * Issue #835 (D-835-25) — `extraSiblings` on the request variant of `LeaveDaysPricing`: the leave
 * planner prices its wishes "as if filed one after another" by handing the earlier wishes to
 * `resolveLeaveDays()` as hypothetical siblings. The price with an `extraSiblings` row must equal
 * the price with the same row stored as a PENDING request, a FIXED_SCHEDULE person is unaffected,
 * and a call without the option is unchanged (the 436 suites run unedited next to this file).
 *
 * Fixture: one tenant, a SHIFT_BASED person (contract 4 days per week, no usual-days Angabe) and a
 * FIXED_SCHEDULE person (Mo-Fr). Fixed dates: ISO week of Monday 2027-02-01 (no holiday in any
 * state), an empty holiday set.
 *
 * Mutation proof (Phase 835-06, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 leave-days.ts: the `extraSiblings` spread removed from the `loadSiblingsOnce` branch -> red:
 *    the equality case and the owner example (2 failed | 4 passed).
 * M2 leave-days.ts: the `extraSiblings` spread removed from the half-day branch -> red: the half-day
 *    case (1 failed | 5 passed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { resolveLeaveDays } from "../contexts/absence/leave-days";

const MONDAY = "2027-02-01";
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const NO_HOLIDAYS = new Set<string>();

describe("Issue #835 - resolveLeaveDays extraSiblings (hypothetical earlier siblings)", () => {
  let app: FastifyInstance;
  let fixture: Awaited<ReturnType<typeof seedTestData>>;
  let shiftBased: string;
  let fixed: string;

  async function employee(label: string, schedule: Record<string, unknown>) {
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`,
        passwordHash: "x",
        isActive: true,
      },
    });
    const row = await app.prisma.employee.create({
      data: {
        tenantId: fixture.tenant.id,
        userId: user.id,
        employeeNumber: `S${crypto.randomBytes(4).toString("hex")}`,
        firstName: label,
        lastName: "Sibling835",
        hireDate: new Date("2024-01-01"),
      },
    });
    await app.prisma.workSchedule.create({
      data: { employeeId: row.id, validFrom: new Date("2024-01-01"), ...schedule } as never,
    });
    return row.id;
  }

  function price(
    employeeId: string,
    start: string,
    end: string,
    pricing:
      | { mode: "request"; leaveTypeCode: string; extraSiblings?: never }
      | {
          mode: "request";
          leaveTypeCode: string;
          extraSiblings: ReadonlyArray<{ startDate: Date; endDate: Date; halfDay: boolean }>;
        },
    halfDay = false,
  ) {
    return resolveLeaveDays(
      app.prisma,
      employeeId,
      fixture.tenant.id,
      day(start),
      day(end),
      halfDay,
      NO_HOLIDAYS,
      pricing,
    );
  }

  async function storedSibling(employeeId: string, start: string, end: string, halfDay = false) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: fixture.vacationType.id,
        startDate: day(start),
        endDate: day(end),
        days: 3,
        halfDay,
        status: "PENDING",
      },
    });
  }

  const MO_MI = { startDate: day("2027-02-01"), endDate: day("2027-02-03"), halfDay: false };

  beforeAll(async () => {
    app = await getTestApp();
    fixture = await seedTestData(app, "ex835");
    shiftBased = await employee("shift", {
      type: "SHIFT_BASED",
      weeklyHours: 38,
      contractWorkDaysPerWeek: 4,
      workDays: [2, 3, 4, 5],
    });
    fixed = await employee("fixed", {
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, fixture.tenant.id);
    } catch (err) {
      console.error("leave-days-extra-siblings-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("prices the owner example: Mo-Mi costs 3, Do-Sa in the same week costs 1 with Mo-Mi as an extra sibling", async () => {
    const alone = await price(shiftBased, MONDAY, "2027-02-03", {
      mode: "request",
      leaveTypeCode: "VACATION",
    });
    expect(alone.days).toBe(3);
    const second = await price(shiftBased, "2027-02-04", "2027-02-06", {
      mode: "request",
      leaveTypeCode: "VACATION",
      extraSiblings: [MO_MI],
    });
    expect(second.days).toBe(1);
    // Without the option and without a stored sibling the second range costs its own 3.
    const isolated = await price(shiftBased, "2027-02-04", "2027-02-06", {
      mode: "request",
      leaveTypeCode: "VACATION",
    });
    expect(isolated.days).toBe(3);
  });

  it("gives the same days and provisional flag as the same sibling stored as a PENDING request", async () => {
    const withExtra = await price(shiftBased, "2027-02-04", "2027-02-06", {
      mode: "request",
      leaveTypeCode: "VACATION",
      extraSiblings: [MO_MI],
    });
    const stored = await storedSibling(shiftBased, MONDAY, "2027-02-03");
    try {
      const withStored = await price(shiftBased, "2027-02-04", "2027-02-06", {
        mode: "request",
        leaveTypeCode: "VACATION",
      });
      expect(withStored.days).toBe(withExtra.days);
      expect(withStored.provisional).toBe(withExtra.provisional);
      // Both together do not count the sibling twice.
      const both = await price(shiftBased, "2027-02-04", "2027-02-06", {
        mode: "request",
        leaveTypeCode: "VACATION",
        extraSiblings: [MO_MI],
      });
      expect(both.days).toBe(withExtra.days);
    } finally {
      await app.prisma.leaveRequest.deleteMany({ where: { id: stored.id } });
    }
  });

  it("prices a half day like the stored sibling does", async () => {
    // A half day on Friday after Mo-Do: the week of a 4-day contract is full, so the half day is
    // free - alone it costs 0.5. The same marginal rule as for a range, in the half-day branch.
    const MO_DO = { startDate: day(MONDAY), endDate: day("2027-02-04"), halfDay: false };
    const alone = await price(
      shiftBased,
      "2027-02-05",
      "2027-02-05",
      { mode: "request", leaveTypeCode: "VACATION" },
      true,
    );
    expect(alone.days).toBe(0.5);
    const withExtra = await price(
      shiftBased,
      "2027-02-05",
      "2027-02-05",
      { mode: "request", leaveTypeCode: "VACATION", extraSiblings: [MO_DO] },
      true,
    );
    const stored = await storedSibling(shiftBased, MONDAY, "2027-02-04");
    try {
      const withStored = await price(
        shiftBased,
        "2027-02-05",
        "2027-02-05",
        { mode: "request", leaveTypeCode: "VACATION" },
        true,
      );
      expect(withStored.days).toBe(withExtra.days);
      expect(withExtra.days).toBeLessThan(alone.days);
    } finally {
      await app.prisma.leaveRequest.deleteMany({ where: { id: stored.id } });
    }
  });

  it("leaves a FIXED_SCHEDULE person unaffected", async () => {
    const without = await price(fixed, "2027-02-04", "2027-02-05", {
      mode: "request",
      leaveTypeCode: "VACATION",
    });
    const withExtra = await price(fixed, "2027-02-04", "2027-02-05", {
      mode: "request",
      leaveTypeCode: "VACATION",
      extraSiblings: [MO_MI],
    });
    expect(without.days).toBe(2);
    expect(withExtra.days).toBe(without.days);
  });

  it("ignores extraSiblings for a type other than VACATION", async () => {
    const without = await price(shiftBased, "2027-02-04", "2027-02-06", {
      mode: "request",
      leaveTypeCode: "SPECIAL",
    });
    const withExtra = await price(shiftBased, "2027-02-04", "2027-02-06", {
      mode: "request",
      leaveTypeCode: "SPECIAL",
      extraSiblings: [MO_MI],
    });
    expect(withExtra.days).toBe(without.days);
  });

  it("keeps an unchanged call unchanged: no option, no stored sibling, the plain price", async () => {
    const plain = await price(shiftBased, MONDAY, "2027-02-05", {
      mode: "request",
      leaveTypeCode: "VACATION",
    });
    // A whole week of a 4-day contract costs the 4 contract days.
    expect(plain.days).toBe(4);
    expect(plain.vocationalSchoolOnly).toBe(false);
  });
});
