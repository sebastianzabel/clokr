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
    wishes: Array<{ id: string; conflict: boolean; foreignPlan: boolean; editable: boolean }>;
  }>;
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

  it("view=own leaves wishes as they are without the flag", async () => {
    const plain = await read(managerToken);
    const own = await read(managerToken, "?view=own");
    for (const person of plain.persons) {
      const twin = own.persons.find((p) => p.employeeId === person.employeeId);
      expect(twin?.wishes).toEqual(person.wishes);
    }
    expect(plain.persons.find((p) => p.employeeId === emp.c)?.wishes.map((w) => w.id)).toEqual([
      wish.c,
    ]);
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
