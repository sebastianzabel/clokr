/**
 * Issue #835 (AC-4, AC-12; D-835-03/05/09/22) — the live read of a leave plan: the population with
 * its home ranges, the gesetzt and beantragt rows, the wishes of this plan and read-only wishes of
 * other open plans, the conflict flag and the type masking, against the real database and routes.
 *
 * Fixture (fake clock 2026-11-03, installed BEFORE the app boots; plan year 2027): tenant one with
 * salons S (the default) and S2, tenant two with its own salon. Open plans: P_S (S) and P_S2 (S2).
 * Callers are built from custom roles, never from what the seeded admin holds: the seeded employee
 * EMP (system role EMPLOYEE, homed in S), a reader RD (leave-request:read), an approver AP (read +
 * approve), a manager MG (manage + read). Persons without a role: B (homed in S, holds every kind
 * of row), X (S until 2027-06-30, S2 from 2027-07-01), D (homed in S2, DEPLOYMENT in S), LEFT
 * (exited before the year), ANON (anonymised) and EXC (an exception of the Betriebsurlaub). No
 * person names.
 *
 * Mutation proof (Phase 835-06, 2026-11-06) — recorded here, not re-run by CI; each change was
 * reverted with cp afterwards (diff against the backup empty):
 * M1 planner-read.ts `maskedTypeCode`: the sick line removed -> red: the rows case and the
 *    masking case (2 failed | 7 passed).
 * M2 planner-read.ts `conflictOf`: the `leaveRequestId !== null` early return removed -> red: the
 *    taken-over wish case (1 failed | 8 passed).
 * M3 planner-read.ts: `state` of a PENDING row forced to GESETZT -> red: the rows case and the
 *    approval case (2 failed | 7 passed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  seedEntitlementYears,
  tokenWithoutSignIn,
} from "./setup";
import { roleNameKey, normalizeRolePermissions } from "../contexts/platform/access-role";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const MANAGE = "leave-plan:manage:ZUGEWIESEN";
const READ = "leave-request:read:ZUGEWIESEN";
const APPROVE = "leave-request:approve:ZUGEWIESEN";
const CREATE_OWN = "leave-request:create:EIGENE";
const YEAR = 2027;

type PlannerRowDto = {
  kind: string;
  state: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  typeCode: string | null;
};
type PlannerWishDto = {
  id: string;
  planId: string;
  foreignPlan: boolean;
  conflict: boolean;
  editable: boolean;
  leaveRequestId: string | null;
  startDate: string;
  endDate: string;
};
type PlannerDto = {
  plan: { partiallyTakenOver: boolean };
  viewer: { canManage: boolean; canWishOwn: boolean; employeeId: string | null };
  persons: Array<{
    employeeId: string;
    homeRanges: Array<{ from: string; to: string }>;
    rows: PlannerRowDto[];
    wishes: PlannerWishDto[];
  }>;
  holidays: Array<{ date: string; name: string }>;
};

describe("Issue #835 - leave plan read (rows, population, conflict, masking)", () => {
  let app: FastifyInstance;
  let one: Awaited<ReturnType<typeof seedTestData>>;
  let two: Awaited<ReturnType<typeof seedTestData>>;
  let salonS2: { id: string };
  let planS: string;
  let planS2: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, { userId: string; employeeId: string }> = {};
  const requestIds: Record<string, string> = {};

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  function day(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
  }

  async function homeIn(
    employeeId: string,
    salonId: string,
    validFrom: string,
    validUntil: string | null = null,
    kind: "HOME" | "DEPLOYMENT" = "HOME",
  ) {
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: one.tenant.id,
        employeeId,
        salonId,
        kind,
        validFrom: day(validFrom),
        validUntil: validUntil ? day(validUntil) : null,
        weekdays: [],
      },
    });
  }

  async function schedule(employeeId: string) {
    await app.prisma.workSchedule.create({
      data: {
        employeeId,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2024-01-01"),
      },
    });
  }

  async function person(
    label: string,
    permissions: string[],
    employee: Partial<{ exitDate: Date | null; firstName: string; lastName: string }> = {},
  ) {
    const email = `${label}-${crypto.randomBytes(3).toString("hex")}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const row = await app.prisma.employee.create({
      data: {
        tenantId: one.tenant.id,
        userId: user.id,
        employeeNumber: `P${crypto.randomBytes(4).toString("hex")}`,
        firstName: employee.firstName ?? label,
        lastName: employee.lastName ?? "Read835",
        hireDate: new Date("2024-01-01"),
        exitDate: employee.exitDate ?? null,
      },
    });
    if (permissions.length > 0) {
      const name = `Read835 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: one.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions(permissions),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: one.tenant.id,
          userId: user.id,
          accessRoleId: role.id,
          scopeType: "TENANT",
          salonIds: [],
          employeeIds: [],
        },
      });
    }
    await schedule(row.id);
    await seedEntitlementYears(app, {
      employeeId: row.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });
    const token = permissions.length > 0 ? await tokenWithoutSignIn(app, email) : "";
    return { userId: user.id, employeeId: row.id, token };
  }

  async function leave(
    employeeId: string,
    leaveTypeId: string,
    status: "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED",
    startDate: string,
    endDate: string,
    halfDay = false,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: day(startDate),
        endDate: day(endDate),
        days: 3,
        status,
        halfDay,
      },
    });
  }

  async function wishRow(
    planId: string,
    employeeId: string,
    startDate: string,
    endDate: string,
    createdByUserId: string,
  ) {
    return app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId,
        employeeId,
        startDate: day(startDate),
        endDate: day(endDate),
        createdByUserId,
      },
    });
  }

  async function read(label: string, planId: string = planS): Promise<PlannerDto> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}`,
      headers: authed(tokens[label]),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as PlannerDto;
  }

  function personOf(dto: PlannerDto, label: string) {
    const found = dto.persons.find((p) => p.employeeId === ids[label].employeeId);
    expect(found, `person ${label} in the planner`).toBeDefined();
    return found!;
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A PAST date on purpose: audit rows written under a fake clock stay in the worker database, and a future stamp is
    // counted by usual-work-days-backfill-route-481 (it counts every leave audit with createdAt >= now).
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    app = await getTestApp();
    one = await seedTestData(app, "lr835a");
    two = await seedTestData(app, "lr835b");
    salonS2 = await createTestSalon(app.prisma, one.tenant.id, { name: "Read835 S2" });
    const S = one.salonId;
    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: one.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });

    // EMP is the seeded employee (system role EMPLOYEE), homed in S.
    await homeIn(one.employee.id, S, "2024-01-01");
    ids.emp = { userId: one.empUser.id, employeeId: one.employee.id };
    tokens.emp = one.empToken;
    await seedEntitlementYears(app, {
      employeeId: one.employee.id,
      leaveTypeId: one.vacationType.id,
      years: [YEAR],
    });

    const roster: Array<[string, string[]]> = [
      ["rd", [READ, CREATE_OWN]],
      ["ap", [READ, APPROVE]],
      ["mg", [MANAGE, READ, CREATE_OWN]],
      ["b", []],
      ["exc", []],
    ];
    for (const [label, permissions] of roster) {
      const p = await person(label, permissions);
      await homeIn(p.employeeId, S, "2024-01-01");
      ids[label] = { userId: p.userId, employeeId: p.employeeId };
      tokens[label] = p.token;
    }

    const x = await person("x", [CREATE_OWN]);
    await homeIn(x.employeeId, S, "2024-01-01", "2027-06-30");
    await homeIn(x.employeeId, salonS2.id, "2027-07-01");
    ids.x = { userId: x.userId, employeeId: x.employeeId };
    tokens.x = x.token;

    const d = await person("d", []);
    await homeIn(d.employeeId, salonS2.id, "2024-01-01");
    await homeIn(d.employeeId, S, "2027-03-01", "2027-03-31", "DEPLOYMENT");
    ids.d = { userId: d.userId, employeeId: d.employeeId };

    const left = await person("left", [], { exitDate: new Date("2026-12-31T22:59:59Z") });
    await homeIn(left.employeeId, S, "2024-01-01");
    ids.left = { userId: left.userId, employeeId: left.employeeId };

    const anon = await person("anon", [], { firstName: "Gelöscht", lastName: "GELÖSCHT-835" });
    await homeIn(anon.employeeId, S, "2024-01-01");
    ids.anon = { userId: anon.userId, employeeId: anon.employeeId };

    planS = (
      await app.prisma.leavePlan.create({
        data: { tenantId: one.tenant.id, salonId: S, year: YEAR, openedByUserId: ids.mg.userId },
      })
    ).id;
    planS2 = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: one.tenant.id,
          salonId: salonS2.id,
          year: YEAR,
          openedByUserId: ids.mg.userId,
        },
      })
    ).id;

    // Rows of B: a PENDING request, a CANCELLATION_REQUESTED one, a SICK one and a Berufsschule day.
    requestIds.pending = (
      await leave(ids.b.employeeId, one.vacationType.id, "PENDING", "2027-05-03", "2027-05-05")
    ).id;
    await leave(
      ids.b.employeeId,
      one.vacationType.id,
      "CANCELLATION_REQUESTED",
      "2027-07-05",
      "2027-07-09",
    );
    await leave(ids.b.employeeId, sickType.id, "APPROVED", "2027-08-02", "2027-08-03");
    await app.prisma.absence.create({
      data: {
        employeeId: ids.b.employeeId,
        type: "VOCATIONAL_SCHOOL",
        startDate: day("2027-09-06"),
        endDate: day("2027-09-06"),
        days: 1,
        createdBy: ids.mg.userId,
      },
    });
    // EMP's own sick row, to prove the own-row rule.
    await leave(ids.emp.employeeId, sickType.id, "APPROVED", "2027-08-09", "2027-08-09");
    // A Betriebsurlaub everybody but EXC takes part in; a manual holiday of S.
    await app.prisma.companyShutdown.create({
      data: {
        tenantId: one.tenant.id,
        name: "Read835 Betriebsurlaub",
        startDate: day("2027-12-27"),
        endDate: day("2027-12-30"),
        exceptions: { create: { employeeId: ids.exc.employeeId } },
      },
    });
    await app.prisma.publicHoliday.create({
      data: {
        tenantId: one.tenant.id,
        salonId: S,
        date: day("2027-03-03"),
        name: "Read835 Stadtfest",
        federalState: "BAYERN",
        year: YEAR,
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: one.tenant.id } });
      await cleanupTestData(app, one.tenant.id);
      await cleanupTestData(app, two.tenant.id);
    } catch (err) {
      console.error("leave-plan-read-835 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("lists the plan population with home ranges and not a deployment, an exit or an anonymised person", async () => {
    const dto = await read("mg");
    const listed = dto.persons.map((p) => p.employeeId);
    for (const label of ["emp", "rd", "ap", "mg", "b", "exc", "x"]) {
      expect(listed, label).toContain(ids[label].employeeId);
    }
    for (const label of ["d", "left", "anon"]) {
      expect(listed, label).not.toContain(ids[label].employeeId);
    }
    expect(personOf(dto, "b").homeRanges).toEqual([{ from: "2027-01-01", to: "2027-12-31" }]);
    expect(personOf(dto, "x").homeRanges).toEqual([{ from: "2027-01-01", to: "2027-06-30" }]);

    const dtoS2 = await read("mg", planS2);
    expect(personOf(dtoS2, "x").homeRanges).toEqual([{ from: "2027-07-01", to: "2027-12-31" }]);
    expect(personOf(dtoS2, "d").homeRanges).toEqual([{ from: "2027-01-01", to: "2027-12-31" }]);
    expect(dtoS2.persons.map((p) => p.employeeId)).not.toContain(ids.b.employeeId);
  });

  it("shows gesetzt, beantragt, Absence and Betriebsurlaub rows and the holidays of the salon", async () => {
    const dto = await read("mg");
    const rows = personOf(dto, "b").rows;
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "LEAVE",
        state: "BEANTRAGT",
        startDate: "2027-05-03",
        endDate: "2027-05-05",
        typeCode: "VACATION",
      }),
      expect.objectContaining({
        kind: "LEAVE",
        state: "GESETZT",
        startDate: "2027-07-05",
        endDate: "2027-07-09",
        typeCode: "VACATION",
      }),
      // A reader with the calendar permission still sees no sick code on a colleague's row.
      expect.objectContaining({
        kind: "LEAVE",
        state: "GESETZT",
        startDate: "2027-08-02",
        typeCode: null,
      }),
      expect.objectContaining({
        kind: "ABSENCE",
        state: "GESETZT",
        startDate: "2027-09-06",
        typeCode: "VOCATIONAL_SCHOOL",
      }),
      expect.objectContaining({
        kind: "COMPANY_SHUTDOWN",
        state: "GESETZT",
        startDate: "2027-12-27",
        endDate: "2027-12-30",
        typeCode: null,
      }),
    ]);
    // The exception of the Betriebsurlaub has no such row.
    expect(personOf(dto, "exc").rows).toEqual([]);

    const holidays = Object.fromEntries(dto.holidays.map((h) => [h.date, h.name]));
    expect(holidays["2027-03-03"]).toBe("Read835 Stadtfest");
    expect(holidays["2027-01-01"]).toBeDefined();
  });

  it("serves no note, attest, document or § 9 field on a row", async () => {
    const dto = await read("mg");
    for (const person of dto.persons) {
      for (const row of person.rows) {
        expect(Object.keys(row).sort()).toEqual(
          ["endDate", "halfDay", "kind", "startDate", "state", "typeCode"].sort(),
        );
      }
    }
    const raw = JSON.stringify(dto);
    expect(raw).not.toMatch(/attest|section9|documentPath|reviewNote|"note"/i);
  });

  it("moves a request from beantragt to gesetzt on approval without any write to the plan", async () => {
    const countsBefore = {
      plans: await app.prisma.leavePlan.findMany({
        where: { tenantId: one.tenant.id },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
      wishes: await app.prisma.leavePlanWish.findMany({
        where: { tenantId: one.tenant.id },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
    };
    expect(
      personOf(await read("mg"), "b").rows.find((r) => r.startDate === "2027-05-03")?.state,
    ).toBe("BEANTRAGT");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${requestIds.pending}/review`,
      headers: authed(tokens.ap),
      payload: { status: "APPROVED" },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(
      personOf(await read("mg"), "b").rows.find((r) => r.startDate === "2027-05-03")?.state,
    ).toBe("GESETZT");
    const countsAfter = {
      plans: await app.prisma.leavePlan.findMany({
        where: { tenantId: one.tenant.id },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
      wishes: await app.prisma.leavePlanWish.findMany({
        where: { tenantId: one.tenant.id },
        select: { id: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
    };
    expect(countsAfter).toEqual(countsBefore);
  });

  it("flags a wish over a leave row of the same person as a conflict, not a Berufsschule, shutdown or holiday overlap", async () => {
    // Over B's CANCELLATION_REQUESTED row (2027-07-05..09): a conflict.
    const over = await wishRow(planS, ids.b.employeeId, "2027-07-07", "2027-07-08", ids.mg.userId);
    // Over the Berufsschule day, the Betriebsurlaub and a holiday: no conflict.
    const bs = await wishRow(planS, ids.b.employeeId, "2027-09-06", "2027-09-07", ids.mg.userId);
    const shutdown = await wishRow(
      planS,
      ids.b.employeeId,
      "2027-12-28",
      "2027-12-29",
      ids.mg.userId,
    );
    const holiday = await wishRow(
      planS,
      ids.b.employeeId,
      "2027-03-03",
      "2027-03-04",
      ids.mg.userId,
    );
    try {
      const wishes = personOf(await read("mg"), "b").wishes;
      const byId = new Map(wishes.map((w) => [w.id, w]));
      expect(byId.get(over.id)?.conflict).toBe(true);
      expect(byId.get(bs.id)?.conflict).toBe(false);
      expect(byId.get(shutdown.id)?.conflict).toBe(false);
      expect(byId.get(holiday.id)?.conflict).toBe(false);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({
        where: { id: { in: [over.id, bs.id, shutdown.id, holiday.id] } },
      });
    }
  });

  it("never flags a taken-over wish and marks the plan partially taken over", async () => {
    const request = await leave(
      ids.b.employeeId,
      one.vacationType.id,
      "PENDING",
      "2027-10-04",
      "2027-10-06",
    );
    const linked = await app.prisma.leavePlanWish.create({
      data: {
        tenantId: one.tenant.id,
        planId: planS,
        employeeId: ids.b.employeeId,
        startDate: day("2027-10-04"),
        endDate: day("2027-10-06"),
        createdByUserId: ids.mg.userId,
        leaveRequestId: request.id,
        takenOverAt: new Date(),
      },
    });
    try {
      const dto = await read("mg");
      const wish = personOf(dto, "b").wishes.find((w) => w.id === linked.id);
      expect(wish).toMatchObject({ conflict: false, editable: false, leaveRequestId: request.id });
      expect(dto.plan.partiallyTakenOver).toBe(true);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: linked.id } });
      await app.prisma.leaveRequest.deleteMany({ where: { id: request.id } });
    }
  });

  it("shows a wish of another open plan read-only where it touches the salon, and only there", async () => {
    // X is homed in S until 30 June and in S2 from 1 July.
    const inS = await wishRow(planS, ids.x.employeeId, "2027-06-28", "2027-07-02", ids.x.userId);
    const inS2Late = await wishRow(
      planS2,
      ids.x.employeeId,
      "2027-08-02",
      "2027-08-06",
      ids.x.userId,
    );
    try {
      const readS = await read("mg", planS);
      const readS2 = await read("mg", planS2);
      // Plan S: its own wish (not foreign); the S2 wish touches no day homed in S -> absent.
      const wishesInS = personOf(readS, "x").wishes;
      expect(wishesInS.map((w) => [w.id, w.foreignPlan])).toEqual([[inS.id, false]]);
      // Plan S2: its own wish, and the S wish because 1-2 July are homed in S2: read-only foreign.
      const wishesInS2 = personOf(readS2, "x").wishes;
      expect(wishesInS2.map((w) => [w.id, w.foreignPlan, w.editable]).sort()).toEqual(
        [
          [inS.id, true, false],
          [inS2Late.id, false, true],
        ].sort(),
      );
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: [inS.id, inS2Late.id] } } });
    }
  });

  it("masks the type by the calendar rule and a sick code on everybody's row but the own", async () => {
    // #840 D-840-20: a plain employee (reach: only themself) no longer reads colleagues' rows in
    // detail - every effective row of B arrives as a MASKED / ABWESEND row without a code.
    const plain = await read("emp");
    const bRows = personOf(plain, "b").rows.filter((r) => r.kind !== "COMPANY_SHUTDOWN");
    expect(bRows.length).toBeGreaterThan(0);
    expect(bRows.every((r) => r.kind === "MASKED" && r.typeCode === null)).toBe(true);
    // ... and their own rows with the code, the sick one included.
    const ownRows = personOf(plain, "emp").rows.filter((r) => r.kind === "LEAVE");
    expect(ownRows).toEqual([
      expect.objectContaining({ typeCode: "SICK", startDate: "2027-08-09" }),
    ]);

    // A holder of leave-request:read reads the colleague's vacation code, never the sick code.
    const reader = await read("rd");
    const readerRows = personOf(reader, "b").rows.filter((r) => r.kind === "LEAVE");
    expect(readerRows.map((r) => [r.startDate, r.typeCode])).toEqual([
      ["2027-05-03", "VACATION"],
      ["2027-07-05", "VACATION"],
      ["2027-08-02", null],
    ]);
    // The reader sees the other person's own-day sick row of EMP masked too.
    expect(
      personOf(reader, "emp")
        .rows.filter((r) => r.kind === "LEAVE")
        .map((r) => r.typeCode),
    ).toEqual([null]);
  });

  it("derives viewer.canWishOwn, canManage and editable per wish from the admission rules", async () => {
    const mine = await wishRow(
      planS,
      ids.emp.employeeId,
      "2027-02-01",
      "2027-02-02",
      ids.emp.userId,
    );
    const bs = await wishRow(planS, ids.b.employeeId, "2027-02-08", "2027-02-09", ids.mg.userId);
    try {
      const asEmp = await read("emp");
      expect(asEmp.viewer).toMatchObject({ canManage: false, canWishOwn: true });
      expect(personOf(asEmp, "emp").wishes.find((w) => w.id === mine.id)?.editable).toBe(true);
      expect(personOf(asEmp, "b").wishes.find((w) => w.id === bs.id)?.editable).toBe(false);

      const asMg = await read("mg");
      expect(asMg.viewer).toMatchObject({ canManage: true, canWishOwn: true });
      expect(personOf(asMg, "b").wishes.find((w) => w.id === bs.id)?.editable).toBe(true);
      expect(personOf(asMg, "emp").wishes.find((w) => w.id === mine.id)?.editable).toBe(true);

      // A reader of the plan of S2 who is not homed there cannot wish there; a person homed there can.
      expect((await read("rd", planS2)).viewer.canWishOwn).toBe(false);
      expect((await read("x", planS2)).viewer.canWishOwn).toBe(true);
    } finally {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: [mine.id, bs.id] } } });
    }
  });
});
