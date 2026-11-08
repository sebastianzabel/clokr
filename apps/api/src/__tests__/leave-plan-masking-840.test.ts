/**
 * Issue #840 (AC-2, AC-3, AC-4; D-840-20/23/25/30) — the planner read (`GET /leave/plans/:id`)
 * masks the rows of a person outside the reader's `leave-request:read` reach with the SAME
 * per-person rule as the calendar: a foreign LEAVE or ABSENCE row becomes a `MASKED` / `ABWESEND`
 * row, a PENDING row of such a person is dropped, adjacent masked ranges are merged. `?view=own`
 * (the personal planner) masks every foreign row whatever the reach.
 *
 * Fixture (fake clock 2026-11-03, installed BEFORE the app boots; plan year 2027): one tenant with
 * the default salon S; EMP (system role EMPLOYEE) and C (no role) homed in S; MG, a Salonmanager of
 * S (stored SALONS role assignment). C holds a SICK row Mon-Wed and a VACATION row Thu-Fri of one
 * week (adjacent), a PENDING vacation, a Berufsschule day, a half-day vacation and a wish over the
 * PENDING row; EMP and MG each hold an own APPROVED and an own PENDING vacation. A Betriebsurlaub
 * covers everybody. No person names.
 *
 * Mutation proof (Phase 840-04, 2026-11-08) — recorded here, not re-run by CI; reverted with cp:
 * M1 planner-read.ts: the per-row decision forced to detailed (everyone sees everything) -> red:
 *    the plain employee's masked rows, the `view=own` case and the conflict-flag case (3 failed |
 *    6 passed).
 * M2 planner-read.ts: the `forceNeutral` line removed from the decision -> red: the `view=own`
 *    manager case only (1 failed | 8 passed).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  tokenWithoutSignIn,
} from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import { leaveTypeFields } from "../contexts/absence/leave-type";

const YEAR = 2027;
const ROW_KEYS = ["endDate", "halfDay", "kind", "startDate", "state", "typeCode"];

type Row = {
  kind: string;
  state: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  typeCode: string | null;
};
type Dto = {
  salon: { id: string; name: string; openingHours: unknown };
  persons: Array<{
    employeeId: string;
    rows: Row[];
    forecast: unknown;
    wishes: Array<{
      id: string;
      startDate: string;
      endDate: string;
      halfDay: boolean;
      conflict: boolean;
      foreignPlan: boolean;
      editable: boolean;
      leaveRequestId: string | null;
      leaveRequestStatus: string | null;
      refusalCode: string | null;
      refusalMessage: string | null;
    }>;
  }>;
  dayLoad: Array<{ day: string; count: number; limits: unknown[] | null }>;
};

describe("Issue #840 - the planner masks foreign rows per person", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let planId: string;
  let managerToken: string;
  let salonName: string;
  const emp: Record<string, string> = {};
  const wish: Record<string, string> = {};

  function day(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
  }

  async function homedPerson(label: string) {
    const s = `${label}-${crypto.randomBytes(3).toString("hex")}`;
    const email = `${s}@example.invalid`;
    const user = await app.prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash("test1234", 4), isActive: true },
    });
    const userId = user.id;
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Plm840",
        hireDate: new Date("2024-01-01"),
      },
    });
    await home(employee.id);
    return { employeeId: employee.id, userId, email };
  }

  function home(employeeId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: data.tenant.id,
        employeeId,
        salonId: data.salonId,
        kind: "HOME",
        validFrom: day("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  function leave(
    employeeId: string,
    leaveTypeId: string,
    status: "APPROVED" | "PENDING",
    start: string,
    end: string,
    halfDay = false,
  ) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId,
        startDate: day(start),
        endDate: day(end),
        days: 1,
        status,
        halfDay,
      },
    });
  }

  async function read(token: string, qs = ""): Promise<Dto> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Dto;
  }

  const rowsOf = (dto: Dto, employeeId: string) =>
    dto.persons.find((p) => p.employeeId === employeeId)?.rows ?? [];

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "plm840");
    const salon = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId } });
    salonName = salon.name;

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });

    // EMP is the seeded employee (system role EMPLOYEE).
    emp.emp = data.employee.id;
    await home(data.employee.id);

    const manager = await homedPerson("mg");
    emp.mg = manager.employeeId;
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: manager.userId,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [data.salonId],
        employeeIds: [],
      },
    });
    managerToken = await tokenWithoutSignIn(app, manager.email);

    const colleague = await homedPerson("c");
    emp.c = colleague.employeeId;

    planId = (
      await app.prisma.leavePlan.create({
        data: {
          tenantId: data.tenant.id,
          salonId: data.salonId,
          year: YEAR,
          openedByUserId: manager.userId,
        },
      })
    ).id;

    // C: SICK Mon-Wed + VACATION Thu-Fri of one week (adjacent), PENDING vacation, Berufsschule
    // day, a half-day vacation.
    await leave(emp.c, sickType.id, "APPROVED", "2027-05-03", "2027-05-05");
    await leave(emp.c, data.vacationType.id, "APPROVED", "2027-05-06", "2027-05-07");
    await leave(emp.c, data.vacationType.id, "PENDING", "2027-06-07", "2027-06-08");
    await leave(emp.c, data.vacationType.id, "APPROVED", "2027-11-01", "2027-11-01", true);
    await app.prisma.absence.create({
      data: {
        employeeId: emp.c,
        type: "VOCATIONAL_SCHOOL",
        startDate: day("2027-09-06"),
        endDate: day("2027-09-06"),
        days: 1,
        createdBy: manager.userId,
      },
    });
    // Own rows of EMP and MG.
    for (const key of ["emp", "mg"]) {
      await leave(emp[key], data.vacationType.id, "APPROVED", "2027-02-01", "2027-02-02");
      await leave(emp[key], data.vacationType.id, "PENDING", "2027-03-01", "2027-03-02");
    }
    await app.prisma.companyShutdown.create({
      data: {
        tenantId: data.tenant.id,
        name: "Plm840 Betriebsurlaub",
        startDate: day("2027-12-27"),
        endDate: day("2027-12-30"),
      },
    });
    // C's wish over the PENDING vacation (a conflict from the unmasked ranges).
    wish.c = (
      await app.prisma.leavePlanWish.create({
        data: {
          tenantId: data.tenant.id,
          planId,
          employeeId: emp.c,
          startDate: day("2027-06-07"),
          endDate: day("2027-06-08"),
          createdByUserId: manager.userId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("leave-plan-masking-840 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("a plain employee sees a colleague's absences only as merged MASKED/ABWESEND rows, PENDING dropped", async () => {
    const dto = await read(data.empToken);
    const rows = rowsOf(dto, emp.c).filter((r) => r.kind !== "COMPANY_SHUTDOWN");
    // SICK Mon-Wed and VACATION Thu-Fri arrive as ONE masked range; the PENDING row is absent.
    expect(rows).toEqual([
      {
        kind: "MASKED",
        state: "ABWESEND",
        startDate: "2027-05-03",
        endDate: "2027-05-07",
        halfDay: false,
        typeCode: null,
      },
      {
        kind: "MASKED",
        state: "ABWESEND",
        startDate: "2027-09-06",
        endDate: "2027-09-06",
        halfDay: false,
        typeCode: null,
      },
      {
        kind: "MASKED",
        state: "ABWESEND",
        startDate: "2027-11-01",
        endDate: "2027-11-01",
        halfDay: false,
        typeCode: null,
      },
    ]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(rows.some((r) => r.startDate === "2027-06-07")).toBe(false);
  });

  it("a plain employee keeps their own rows complete (kind, state, type)", async () => {
    const dto = await read(data.empToken);
    expect(rowsOf(dto, emp.emp)).toEqual([
      expect.objectContaining({
        kind: "LEAVE",
        state: "GESETZT",
        startDate: "2027-02-01",
        typeCode: "VACATION",
      }),
      expect.objectContaining({
        kind: "LEAVE",
        state: "BEANTRAGT",
        startDate: "2027-03-01",
        typeCode: "VACATION",
      }),
      expect.objectContaining({ kind: "COMPANY_SHUTDOWN" }),
    ]);
  });

  it("a Salonmanager of the plan salon sees the colleague's rows in detail, a sick type stays null", async () => {
    const dto = await read(managerToken);
    const rows = rowsOf(dto, emp.c).filter((r) => r.kind !== "COMPANY_SHUTDOWN");
    expect(
      rows.map((r) => [r.kind, r.state, r.startDate, r.endDate, r.halfDay, r.typeCode]),
    ).toEqual([
      ["LEAVE", "GESETZT", "2027-05-03", "2027-05-05", false, null],
      ["LEAVE", "GESETZT", "2027-05-06", "2027-05-07", false, "VACATION"],
      ["LEAVE", "BEANTRAGT", "2027-06-07", "2027-06-08", false, "VACATION"],
      ["ABSENCE", "GESETZT", "2027-09-06", "2027-09-06", false, "VOCATIONAL_SCHOOL"],
      ["LEAVE", "GESETZT", "2027-11-01", "2027-11-01", true, "VACATION"],
    ]);
    expect(rows.some((r) => r.kind === "MASKED")).toBe(false);
  });

  it("view=own masks every foreign row of the same manager and keeps own rows complete", async () => {
    const dto = await read(managerToken, "?view=own");
    const colleague = rowsOf(dto, emp.c).filter((r) => r.kind !== "COMPANY_SHUTDOWN");
    expect(colleague.map((r) => [r.kind, r.state, r.startDate, r.endDate])).toEqual([
      ["MASKED", "ABWESEND", "2027-05-03", "2027-05-07"],
      ["MASKED", "ABWESEND", "2027-09-06", "2027-09-06"],
      ["MASKED", "ABWESEND", "2027-11-01", "2027-11-01"],
    ]);
    expect(colleague.every((r) => r.typeCode === null && r.halfDay === false)).toBe(true);
    expect(rowsOf(dto, emp.mg).map((r) => [r.kind, r.state, r.startDate, r.typeCode])).toEqual([
      ["LEAVE", "GESETZT", "2027-02-01", "VACATION"],
      ["LEAVE", "BEANTRAGT", "2027-03-01", "VACATION"],
      ["COMPANY_SHUTDOWN", "GESETZT", "2027-12-27", null],
    ]);
  });

  it("view=own keeps the caller's own wishes complete and gives a colleague's wish the period only (WR-02)", async () => {
    const plain = await read(managerToken);
    const own = await read(managerToken, "?view=own");
    // Without the flag the manager holds the manage reach over the colleague's wish.
    const plainWish = plain.persons.find((p) => p.employeeId === emp.c)?.wishes ?? [];
    expect(plainWish.map((w) => w.id)).toEqual([wish.c]);
    expect(plainWish[0].editable).toBe(true);
    expect(plainWish[0].conflict).toBe(true);
    // With the flag the same wish is a period and nothing else.
    const ownWish = own.persons.find((p) => p.employeeId === emp.c)?.wishes ?? [];
    expect(ownWish).toHaveLength(1);
    expect(ownWish[0]).toMatchObject({
      id: wish.c,
      startDate: "2027-06-07",
      endDate: "2027-06-08",
      editable: false,
      conflict: false,
      leaveRequestId: null,
      leaveRequestStatus: null,
      refusalCode: null,
      refusalMessage: null,
    });
  });

  describe("WR-02: view=own is neutral for every foreign person", () => {
    const extra: { wishIds: string[]; ruleId: string | null } = { wishIds: [], ruleId: null };

    beforeAll(async () => {
      // A colleague's wish that was taken over and refused (status REJECTED, a refusal text), the
      // manager's own open wish, and a limit rule the colleague's wish counts against.
      const rejected = await app.prisma.leaveRequest.create({
        data: {
          employeeId: emp.c,
          leaveTypeId: (
            await app.prisma.leaveType.findFirstOrThrow({
              where: { tenantId: data.tenant.id, code: "VACATION" },
            })
          ).id,
          startDate: day("2027-07-05"),
          endDate: day("2027-07-06"),
          days: 2,
          status: "REJECTED",
        },
      });
      const linked = await app.prisma.leavePlanWish.create({
        data: {
          tenantId: data.tenant.id,
          planId,
          employeeId: emp.c,
          startDate: day("2027-07-05"),
          endDate: day("2027-07-06"),
          createdByUserId: emp.mg,
          leaveRequestId: rejected.id,
          takenOverAt: new Date("2026-11-03T09:00:00Z"),
        },
      });
      const refused = await app.prisma.leavePlanWish.create({
        data: {
          tenantId: data.tenant.id,
          planId,
          employeeId: emp.c,
          startDate: day("2027-07-19"),
          endDate: day("2027-07-20"),
          createdByUserId: emp.mg,
          refusalCode: "ENTITLEMENT_EXCEEDED",
          refusalMessage: "Kein Resturlaub mehr",
          refusedAt: new Date("2026-11-03T09:00:00Z"),
        },
      });
      const mine = await app.prisma.leavePlanWish.create({
        data: {
          tenantId: data.tenant.id,
          planId,
          employeeId: emp.emp,
          startDate: day("2027-08-02"),
          endDate: day("2027-08-03"),
          createdByUserId: emp.emp,
        },
      });
      extra.wishIds = [linked.id, refused.id, mine.id];
      extra.ruleId = (
        await app.prisma.leaveLimitRule.create({
          data: {
            tenantId: data.tenant.id,
            salonId: data.salonId,
            groupKind: "ALL",
            maxPersons: 1,
            name: "Plm840 rule",
          },
        })
      ).id;
    });

    afterAll(async () => {
      await app.prisma.leavePlanWish.deleteMany({ where: { id: { in: extra.wishIds } } });
      if (extra.ruleId) await app.prisma.leaveLimitRule.delete({ where: { id: extra.ruleId } });
    });

    const wishOf = (dto: Dto, employeeId: string, from: string) =>
      dto.persons
        .find((p) => p.employeeId === employeeId)
        ?.wishes.find((w) => w.startDate === from);

    it("control: without the flag the manager sees status, refusal, forecast and rule data", async () => {
      const dto = await read(managerToken);
      expect(wishOf(dto, emp.c, "2027-07-05")).toMatchObject({ leaveRequestStatus: "REJECTED" });
      expect(wishOf(dto, emp.c, "2027-07-19")).toMatchObject({
        refusalCode: "ENTITLEMENT_EXCEEDED",
        refusalMessage: "Kein Resturlaub mehr",
      });
      expect(dto.persons.find((p) => p.employeeId === emp.c)?.forecast).not.toBeNull();
      expect(dto.dayLoad.some((d) => d.limits !== null)).toBe(true);
    });

    it("a colleague's wish carries no request status, refusal or edit right", async () => {
      const dto = await read(managerToken, "?view=own");
      for (const person of dto.persons.filter((p) => p.employeeId !== emp.mg)) {
        for (const w of person.wishes) {
          expect(w.editable).toBe(false);
          expect(w.leaveRequestStatus).toBeNull();
          expect(w.leaveRequestId).toBeNull();
          expect(w.refusalCode).toBeNull();
          expect(w.refusalMessage).toBeNull();
          expect(w.conflict).toBe(false);
        }
      }
      expect(wishOf(dto, emp.c, "2027-07-05")).toMatchObject({
        endDate: "2027-07-06",
        editable: false,
        leaveRequestStatus: null,
      });
      expect(wishOf(dto, emp.c, "2027-07-19")).toMatchObject({
        endDate: "2027-07-20",
        editable: false,
        refusalMessage: null,
      });
      expect(JSON.stringify(dto)).not.toContain("Kein Resturlaub mehr");
    });

    it("no forecast for a colleague, the caller's own forecast stays", async () => {
      const dto = await read(managerToken, "?view=own");
      for (const person of dto.persons.filter((p) => p.employeeId !== emp.mg)) {
        expect(person.forecast).toBeNull();
      }
      expect(dto.persons.find((p) => p.employeeId === emp.mg)?.forecast).not.toBeNull();
    });

    it("no limit rule data in the day load, the per-day count stays", async () => {
      const dto = await read(managerToken, "?view=own");
      expect(dto.dayLoad.length).toBeGreaterThan(0);
      expect(dto.dayLoad.every((d) => d.limits === null)).toBe(true);
      expect(JSON.stringify(dto)).not.toContain("Plm840 rule");
    });

    it("the caller's own wish stays complete and editable", async () => {
      const dto = await read(data.empToken, "?view=own");
      expect(wishOf(dto, emp.emp, "2027-08-02")).toMatchObject({
        endDate: "2027-08-03",
        editable: true,
        foreignPlan: false,
      });
    });
  });

  it("an unknown view value answers 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/leave/plans/${planId}?view=foo`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("COMPANY_SHUTDOWN rows are unchanged for the plain employee, the manager and view=own", async () => {
    const shutdown = (dto: Dto) => rowsOf(dto, emp.c).filter((r) => r.kind === "COMPANY_SHUTDOWN");
    const expected = [
      {
        kind: "COMPANY_SHUTDOWN",
        state: "GESETZT",
        startDate: "2027-12-27",
        endDate: "2027-12-30",
        halfDay: false,
        typeCode: null,
      },
    ];
    expect(shutdown(await read(data.empToken))).toEqual(expected);
    expect(shutdown(await read(managerToken))).toEqual(expected);
    expect(shutdown(await read(managerToken, "?view=own"))).toEqual(expected);
  });

  it("the conflict flag of a colleague's wish comes from the unmasked rows", async () => {
    const asEmp = await read(data.empToken);
    const mine = asEmp.persons
      .find((p) => p.employeeId === emp.c)
      ?.wishes.find((w) => w.id === wish.c);
    // The PENDING row under the wish is not served to EMP, the flag still names the overlap.
    expect(mine?.conflict).toBe(true);
    expect(rowsOf(asEmp, emp.c).some((r) => r.startDate === "2027-06-07")).toBe(false);
  });

  it("the DTO carries the plan salon with id, name and opening hours", async () => {
    const dto = await read(data.empToken);
    const stored = await app.prisma.salon.findUniqueOrThrow({ where: { id: data.salonId } });
    expect(Object.keys(dto.salon).sort()).toEqual(["id", "name", "openingHours"]);
    expect(dto.salon).toEqual({
      id: data.salonId,
      name: salonName,
      openingHours: JSON.parse(JSON.stringify(stored.openingHours)),
    });
  });
});
