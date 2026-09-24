/**
 * Phase 67b Plan 05 (issue #67) — `deactivateSalon`'s Stammsalon/Einsatzsalon extension:
 *
 * - AC-Deaktiviert-3/D-14: a salon that is, on the deactivation day D (tenant-local "today") or
 *   later, the effective HOME salon of at least one still-employed person cannot be deactivated —
 *   409, message names the COUNT only, never a name.
 * - AC-Deaktiviert-2/D-15: on a successful deactivation, every DEPLOYMENT to that salon effective
 *   on some day `>= D` ends at D or is voided, audited (D-21).
 * - D-02: both race directions between a concurrent Stammsalon change and a deactivation.
 * - Review CR-01: ending an Einsatzsalon assignment concurrently with a deactivation of its salon
 *   evaluates the "only shorten" rule on the row as the deactivation left it, never on a stale read.
 *
 * `seedTestData()` creates ONE active default salon for its tenant (Phase 67b Plan 03, D-24) and
 * its two seeded employees get NO HOME rows (same D-24 convention `salon-assignments.test.ts`
 * documents) — every fixture salon and employee this file needs beyond that default salon is
 * created directly, same convention as `salons.test.ts`/`salon-assignments.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS, deactivateSalon } from "../contexts/platform/facade/salons";
import {
  changeHomeSalon,
  endSalonAssignment,
} from "../contexts/platform/facade/salon-assignment-changes";
import { salonForDay } from "../contexts/platform";
import {
  addDays,
  dayToDate,
  mondayBasedWeekday,
  tenantLocalDay,
  type CalendarDay,
} from "../contexts/platform/salon-assignment-rules";

const TENANT_TZ = "Europe/Berlin";

describe("POST /api/v1/salons/:id/deactivate — Stammsalon in use, Einsatzsalon cascade (Phase 67b Plan 05, issue #67)", () => {
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTestData>>;
  let empCounter = 0;

  async function makeSalon(name: string) {
    return app.prisma.salon.create({
      data: {
        tenantId: tenant.tenant.id,
        name,
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  }

  async function makeEmployee(opts: { hireDate?: Date; exitDate?: Date | null } = {}) {
    empCounter += 1;
    const s = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}-${empCounter}`;
    const user = await app.prisma.user.create({
      data: { email: `sda-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: tenant.tenant.id,
        userId: user.id,
        employeeNumber: `SDA-${s}`,
        firstName: "SDA",
        lastName: "Test",
        hireDate: opts.hireDate ?? new Date("2020-01-01"),
        exitDate: opts.exitDate ?? null,
      },
    });
  }

  async function createHome(
    employeeId: string,
    salonId: string,
    validFrom: CalendarDay,
    validUntil: CalendarDay | null = null,
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: dayToDate(validFrom),
        validUntil: validUntil !== null ? dayToDate(validUntil) : null,
        weekdays: [],
      },
    });
  }

  async function createDeployment(
    salonId: string,
    employeeId: string,
    validFrom: CalendarDay,
    validUntil: CalendarDay | null,
    weekdays: number[] = [],
  ) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: tenant.tenant.id,
        employeeId,
        salonId,
        kind: "DEPLOYMENT",
        validFrom: dayToDate(validFrom),
        validUntil: validUntil !== null ? dayToDate(validUntil) : null,
        weekdays,
      },
    });
  }

  function postDeactivate(id: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/salons/${id}/deactivate`,
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
  }

  function postDeployment(employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/salon-assignments`,
      headers: { authorization: `Bearer ${tenant.adminToken}` },
      payload: body,
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenant = await seedTestData(app, "sda-deact");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenant.tenant.id);
    } catch (err) {
      console.error("salon-deactivation-assignments.test.ts cleanup failed:", err);
    }
  });

  // ── AC-Deaktiviert-3 / D-14 ──────────────────────────────────────────────────────────────────

  it("a salon that is one still-employed person's open HOME salon cannot be deactivated — 409 names only the count (never a name); salon stays active; nothing written", async () => {
    const salonX = await makeSalon("Salon X1");
    const employee = await makeEmployee();
    await createHome(employee.id, salonX.id, "2020-01-01");

    const auditBefore = await app.prisma.auditLog.count({
      where: { entity: "Salon", entityId: salonX.id },
    });
    const assignmentsBefore = await app.prisma.employeeSalonAssignment.count({
      where: { employeeId: employee.id },
    });

    const res = await postDeactivate(salonX.id);

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toBe(
      "Der Salon ist für 1 Mitarbeiter ab dem Deaktivierungsdatum Stammsalon und kann nicht deaktiviert werden.",
    );
    expect(JSON.stringify(body)).not.toContain(employee.firstName);
    expect(JSON.stringify(body)).not.toContain(employee.lastName);

    const salon = await app.prisma.salon.findUnique({ where: { id: salonX.id } });
    expect(salon?.isActive).toBe(true);
    expect(
      await app.prisma.auditLog.count({ where: { entity: "Salon", entityId: salonX.id } }),
    ).toBe(auditBefore);
    expect(
      await app.prisma.employeeSalonAssignment.count({ where: { employeeId: employee.id } }),
    ).toBe(assignmentsBefore);
  });

  it("two blocking employees → the message says 'für 2 Mitarbeiter'", async () => {
    const salonX = await makeSalon("Salon X2");
    const e1 = await makeEmployee();
    const e2 = await makeEmployee();
    await createHome(e1.id, salonX.id, "2020-01-01");
    await createHome(e2.id, salonX.id, "2020-01-01");

    const res = await postDeactivate(salonX.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe(
      "Der Salon ist für 2 Mitarbeiter ab dem Deaktivierungsdatum Stammsalon und kann nicht deaktiviert werden.",
    );
  });

  it("NOT blocking: an exited employee (exitDate D-10, tenant-local) with an open HOME row; a HOME ended before D; a voided HOME row — deactivation succeeds", async () => {
    const salonX = await makeSalon("Salon X3");
    const D = tenantLocalDay(new Date(), TENANT_TZ);

    const exited = await makeEmployee({ exitDate: dayToDate(addDays(D, -10)) });
    await createHome(exited.id, salonX.id, "2020-01-01");

    const endedBefore = await makeEmployee();
    await createHome(endedBefore.id, salonX.id, "2020-01-01", addDays(D, -5));

    const voided = await makeEmployee();
    const voidedFrom = addDays(D, 30);
    await createHome(voided.id, salonX.id, voidedFrom, addDays(voidedFrom, -1));

    const res = await postDeactivate(salonX.id);
    expect(res.statusCode).toBe(200);
    const salon = await app.prisma.salon.findUnique({ where: { id: salonX.id } });
    expect(salon?.isActive).toBe(false);
  });

  it("BLOCKING: an employee whose exitDate is D+10 (tenant-local, still employed at D)", async () => {
    const salonX = await makeSalon("Salon X4");
    const D = tenantLocalDay(new Date(), TENANT_TZ);
    const employee = await makeEmployee({ exitDate: dayToDate(addDays(D, 10)) });
    await createHome(employee.id, salonX.id, "2020-01-01");

    const res = await postDeactivate(salonX.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("für 1 Mitarbeiter");
  });

  it("BLOCKING: an employee whose HOME changes TO X from D+20 (future Stammsalon), even though X is not their CURRENT Stammsalon", async () => {
    const salonX = await makeSalon("Salon X5");
    const salonElsewhere = await makeSalon("Salon Elsewhere 5");
    const D = tenantLocalDay(new Date(), TENANT_TZ);
    const employee = await makeEmployee();
    await createHome(employee.id, salonElsewhere.id, "2020-01-01", addDays(D, 19));
    await createHome(employee.id, salonX.id, addDays(D, 20));

    const res = await postDeactivate(salonX.id);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain("für 1 Mitarbeiter");
  });

  // ── AC-Deaktiviert-2 / D-15 / D-21 ───────────────────────────────────────────────────────────

  it("AC-Deaktiviert-2/D-15/D-21: a successful deactivation ends running DEPLOYMENTs at D, voids future ones, leaves already-ended ones untouched, keeps every other field, and audits exactly one END row per CHANGED assignment", async () => {
    const salonX = await makeSalon("Salon X6");
    const Dbefore = tenantLocalDay(new Date(), TENANT_TZ);

    const running = await makeEmployee();
    const rowOpenFromPast = await createDeployment(
      salonX.id,
      running.id,
      "2020-01-01",
      null,
      [0, 1],
    );

    const runningBounded = await makeEmployee();
    const rowBounded = await createDeployment(
      salonX.id,
      runningBounded.id,
      "2020-01-01",
      addDays(Dbefore, 40),
      [2],
    );

    const future = await makeEmployee();
    const futureFrom = addDays(Dbefore, 30);
    const rowFuture = await createDeployment(salonX.id, future.id, futureFrom, null, [3]);

    const endedBefore = await makeEmployee();
    const rowEndedBefore = await createDeployment(
      salonX.id,
      endedBefore.id,
      "2020-01-01",
      addDays(Dbefore, -3),
      [4],
    );

    const endedAtD = await makeEmployee();
    const rowEndedAtD = await createDeployment(salonX.id, endedAtD.id, "2020-01-01", Dbefore, [5]);

    const res = await postDeactivate(salonX.id);
    const Dafter = tenantLocalDay(new Date(), TENANT_TZ);
    expect(res.statusCode).toBe(200);

    const afterOpenFromPast = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: rowOpenFromPast.id },
    });
    expect([Dbefore, Dafter]).toContain(
      afterOpenFromPast.validUntil ? afterOpenFromPast.validUntil.toISOString().slice(0, 10) : null,
    );
    expect(afterOpenFromPast.salonId).toBe(salonX.id);
    expect(afterOpenFromPast.weekdays).toEqual([0, 1]);
    expect(afterOpenFromPast.validFrom.toISOString().slice(0, 10)).toBe("2020-01-01");

    const afterBounded = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: rowBounded.id },
    });
    expect([Dbefore, Dafter]).toContain(afterBounded.validUntil!.toISOString().slice(0, 10));
    expect(afterBounded.weekdays).toEqual([2]);

    const afterFuture = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: rowFuture.id },
    });
    // Voided: validUntil = validFrom - 1.
    expect(afterFuture.validUntil!.toISOString().slice(0, 10)).toBe(addDays(futureFrom, -1));
    expect(afterFuture.weekdays).toEqual([3]);

    const afterEndedBefore = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: rowEndedBefore.id },
    });
    expect(afterEndedBefore.validUntil!.toISOString().slice(0, 10)).toBe(addDays(Dbefore, -3));
    expect(afterEndedBefore.updatedAt.getTime()).toBe(rowEndedBefore.updatedAt.getTime());

    const afterEndedAtD = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: rowEndedAtD.id },
    });
    expect(afterEndedAtD.validUntil!.toISOString().slice(0, 10)).toBe(Dbefore);
    expect(afterEndedAtD.updatedAt.getTime()).toBe(rowEndedAtD.updatedAt.getTime());

    // D-21: exactly one END audit row per CHANGED assignment; none for the two untouched ones.
    for (const row of [rowOpenFromPast, rowBounded, rowFuture]) {
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "EmployeeSalonAssignment", entityId: row.id, action: "END" },
      });
      expect(audits).toHaveLength(1);
      const newValue = audits[0].newValue as { trigger?: string };
      expect(newValue.trigger).toBe("SALON_DEACTIVATED");
    }
    for (const row of [rowEndedBefore, rowEndedAtD]) {
      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "EmployeeSalonAssignment", entityId: row.id, action: "END" },
      });
      expect(audits).toHaveLength(0);
    }

    // The salon's own DEACTIVATE row is still written.
    const salonAudits = await app.prisma.auditLog.findMany({
      where: { entity: "Salon", entityId: salonX.id, action: "DEACTIVATE" },
    });
    expect(salonAudits).toHaveLength(1);
  });

  it("after deactivation, salonForDay falls back to HOME for the ended DEPLOYMENT's weekday, and a new assignment to the now-inactive salon is rejected 400 (D-13)", async () => {
    const salonX = await makeSalon("Salon X7");
    const D = tenantLocalDay(new Date(), TENANT_TZ);
    const employee = await makeEmployee();
    await createHome(employee.id, tenant.defaultSalon.id, "2020-01-01");

    const dayPlus7 = addDays(D, 7);
    // Europe/Berlin is always ahead of UTC (+1/+2h), so UTC midnight of a calendar day still
    // falls on that SAME tenant-local calendar day — dayToDate(dayPlus7) is a safe instant to ask
    // mondayBasedWeekday about, matching production's own `salonForDay` computation exactly.
    const weekdayPlus7 = mondayBasedWeekday(dayToDate(dayPlus7), TENANT_TZ);

    await createDeployment(salonX.id, employee.id, "2020-01-01", null, [weekdayPlus7]);

    const res = await postDeactivate(salonX.id);
    expect(res.statusCode).toBe(200);

    const answer = await salonForDay(
      app.prisma,
      tenant.tenant.id,
      employee.id,
      dayToDate(dayPlus7),
    );
    expect(answer).toEqual({
      salonId: tenant.defaultSalon.id,
      kind: "HOME",
      assignmentId: expect.any(String),
    });

    const createRes = await postDeployment(employee.id, {
      salonId: salonX.id,
      validFrom: addDays(D, 100),
    });
    expect(createRes.statusCode).toBe(400);
    expect(JSON.parse(createRes.body).error).toBe(
      "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.",
    );
  });

  // ── D-02: both race directions ───────────────────────────────────────────────────────────────

  it("D-02 race A: deactivateSalon(X) first, changeHomeSalon(E -> X) second — the HOME change sees SALON_INACTIVE, and no HOME row to X exists", async () => {
    const salonX = await makeSalon("Salon X-Race-A");
    const salonElsewhere = await makeSalon("Salon Elsewhere Race A");
    const employee = await makeEmployee();
    await createHome(employee.id, salonElsewhere.id, "2020-01-01");

    let releaseTx1: (() => void) | undefined;
    const tx1HoldGate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let signalTx1Locked: ((pid: number) => void) | undefined;
    const tx1Locked = new Promise<number>((resolve) => {
      signalTx1Locked = resolve;
    });
    const tx1Promise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const result = await deactivateSalon(tx, tenant.tenant.id, salonX.id);
        signalTx1Locked?.(pid);
        await tx1HoldGate;
        return result;
      },
      { timeout: 20000 },
    );
    const tx1Pid = await tx1Locked;

    let signalTx2Pid: ((pid: number) => void) | undefined;
    const tx2PidKnown = new Promise<number>((resolve) => {
      signalTx2Pid = resolve;
    });
    let tx2Settled = false;
    const tx2Promise = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalTx2Pid?.(pid);
          return changeHomeSalon(tx, tenant.tenant.id, employee.id, {
            salonId: salonX.id,
            validFrom: tenantLocalDay(new Date(), TENANT_TZ),
          });
        },
        { timeout: 20000 },
      )
      .finally(() => {
        tx2Settled = true;
      });
    const tx2Pid = await tx2PidKnown;

    const deadline = Date.now() + 10000;
    let tx2BlockedByTx1 = false;
    while (!tx2Settled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${tx2Pid}::int) AS blockers`;
      if (blockers.includes(tx1Pid)) {
        tx2BlockedByTx1 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseTx1?.();
    const [result1, result2] = await Promise.all([tx1Promise, tx2Promise]);

    expect(tx2BlockedByTx1, "tx2 was never observed waiting on tx1's salon lock").toBe(true);
    expect(result1.status).toBe("OK");
    expect(result2.status).toBe("SALON_INACTIVE");

    const homeRows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId: employee.id, kind: "HOME", salonId: salonX.id },
    });
    expect(homeRows).toHaveLength(0);
  });

  it("D-02 race B: changeHomeSalon(E -> X) first, deactivateSalon(X) second — the deactivation sees HOME_SALON_IN_USE with employeeCount 1", async () => {
    const salonX = await makeSalon("Salon X-Race-B");
    const salonElsewhere = await makeSalon("Salon Elsewhere Race B");
    const employee = await makeEmployee();
    await createHome(employee.id, salonElsewhere.id, "2020-01-01");

    let releaseTx2: (() => void) | undefined;
    const tx2HoldGate = new Promise<void>((resolve) => {
      releaseTx2 = resolve;
    });
    let signalTx2Locked: ((pid: number) => void) | undefined;
    const tx2Locked = new Promise<number>((resolve) => {
      signalTx2Locked = resolve;
    });
    const tx2Promise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const result = await changeHomeSalon(tx, tenant.tenant.id, employee.id, {
          salonId: salonX.id,
          validFrom: tenantLocalDay(new Date(), TENANT_TZ),
        });
        signalTx2Locked?.(pid);
        await tx2HoldGate;
        return result;
      },
      { timeout: 20000 },
    );
    const tx2Pid = await tx2Locked;

    let signalTx1Pid: ((pid: number) => void) | undefined;
    const tx1PidKnown = new Promise<number>((resolve) => {
      signalTx1Pid = resolve;
    });
    let tx1Settled = false;
    const tx1Promise = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalTx1Pid?.(pid);
          return deactivateSalon(tx, tenant.tenant.id, salonX.id);
        },
        { timeout: 20000 },
      )
      .finally(() => {
        tx1Settled = true;
      });
    const tx1Pid = await tx1PidKnown;

    const deadline = Date.now() + 10000;
    let tx1BlockedByTx2 = false;
    while (!tx1Settled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${tx1Pid}::int) AS blockers`;
      if (blockers.includes(tx2Pid)) {
        tx1BlockedByTx2 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseTx2?.();
    const [result2, result1] = await Promise.all([tx2Promise, tx1Promise]);

    expect(tx1BlockedByTx2, "tx1 was never observed waiting on tx2's salon lock").toBe(true);
    expect(result2.status).toBe("OK_HOME_CHANGED");
    expect(result1.status).toBe("HOME_SALON_IN_USE");
    if (result1.status === "HOME_SALON_IN_USE") {
      expect(result1.employeeCount).toBe(1);
    }
  });

  it("review CR-01: deactivateSalon(X) first, endSalonAssignment(R -> X, D+30) second — the end re-reads R after the salon lock, sees validUntil = D and answers ONLY_SHORTEN; R stays at D", async () => {
    const salonX = await makeSalon("Salon X-Race-CR01");
    const salonElsewhere = await makeSalon("Salon Elsewhere Race CR01");
    const employee = await makeEmployee();
    await createHome(employee.id, salonElsewhere.id, "2020-01-01");
    const D = tenantLocalDay(new Date(), TENANT_TZ);
    const deployment = await createDeployment(salonX.id, employee.id, "2020-01-06", null, [
      mondayBasedWeekday(new Date(), TENANT_TZ),
    ]);

    let releaseTx1: (() => void) | undefined;
    const tx1HoldGate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });
    let signalTx1Locked: ((pid: number) => void) | undefined;
    const tx1Locked = new Promise<number>((resolve) => {
      signalTx1Locked = resolve;
    });
    const tx1Promise = app.prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const result = await deactivateSalon(tx, tenant.tenant.id, salonX.id);
        signalTx1Locked?.(pid);
        await tx1HoldGate;
        return result;
      },
      { timeout: 20000 },
    );
    const tx1Pid = await tx1Locked;

    let signalTx2Pid: ((pid: number) => void) | undefined;
    const tx2PidKnown = new Promise<number>((resolve) => {
      signalTx2Pid = resolve;
    });
    let tx2Settled = false;
    const tx2Promise = app.prisma
      .$transaction(
        async (tx) => {
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          signalTx2Pid?.(pid);
          return endSalonAssignment(
            tx,
            tenant.tenant.id,
            employee.id,
            deployment.id,
            addDays(D, 30),
          );
        },
        { timeout: 20000 },
      )
      .finally(() => {
        tx2Settled = true;
      });
    const tx2Pid = await tx2PidKnown;

    const deadline = Date.now() + 10000;
    let tx2BlockedByTx1 = false;
    while (!tx2Settled && Date.now() < deadline) {
      const [{ blockers }] = await app.prisma.$queryRaw<{ blockers: number[] }[]>`
        SELECT pg_blocking_pids(${tx2Pid}::int) AS blockers`;
      if (blockers.includes(tx1Pid)) {
        tx2BlockedByTx1 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    releaseTx1?.();
    const [result1, result2] = await Promise.all([tx1Promise, tx2Promise]);

    expect(tx2BlockedByTx1, "tx2 was never observed waiting on tx1's salon lock").toBe(true);
    expect(result1.status).toBe("OK");
    expect(result2.status).toBe("ONLY_SHORTEN");

    const after = await app.prisma.employeeSalonAssignment.findUniqueOrThrow({
      where: { id: deployment.id },
    });
    expect(after.validUntil?.toISOString()).toBe(dayToDate(D).toISOString());
  });
});
