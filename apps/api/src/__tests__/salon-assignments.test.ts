/**
 * Phase 67b Plan 02 (issue #67) — the write-surface AC proof: create an Einsatzsalon (DEPLOYMENT,
 * Task 1), change the Stammsalon (HOME) and end an assignment (Task 2).
 *
 * `seedTestData()` does NOT create a Salon for its tenant (D-18 exemption) — every fixture salon
 * this file needs is created directly via `app.prisma.salon.create(...)`, same convention as
 * `salons.test.ts` / `salon-for-day.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, salonIdForEmployee } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { salonForDay } from "../contexts/platform";

describe("POST /api/v1/employees/:id/salon-assignments — create Einsatzsalon (Phase 67b Plan 02 Task 1)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: { id: string };
  let salonC: { id: string };
  let salonD: { id: string };
  let salonE: { id: string };
  let salonInactive: { id: string };
  let foreignSalon: { id: string };

  const UNKNOWN_SALON_ID = "00000000-0000-4000-8000-000000000401";

  function postDeployment(token: string, employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/salon-assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  /**
   * D-21: the write route only ever calls `auditSalonAssignmentEvent` for `OK_CREATED` (gated
   * inside the SAME `$transaction`, `api/salon-assignments.ts`) — so a rejected create can only
   * change the audit count if it ALSO wrote a row, making the assignment-row count the single
   * sufficient witness for "nothing was written" (AC-Aenderung-3).
   */
  async function assignmentCount(employeeId: string) {
    return app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sa-create-a");
    tenantB = await seedTestData(app, "sa-create-b");

    const makeSalon = (name: string, isActive = true) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          federalState: "NIEDERSACHSEN",
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive,
        },
      });

    salonB = await makeSalon("Salon B");
    salonC = await makeSalon("Salon C");
    salonD = await makeSalon("Salon D");
    salonE = await makeSalon("Salon E");
    salonInactive = await makeSalon("Salon Inaktiv", false);
    foreignSalon = await app.prisma.salon.create({
      data: {
        tenantId: tenantB.tenant.id,
        federalState: "NIEDERSACHSEN",
        name: "Fremder Salon",
        openingHours: DEFAULT_SALON_OPENING_HOURS,
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  it("AC-Einsatz-1/D-08: three DEPLOYMENTs with overlapping periods and disjoint weekdays, plus one with [] weekdays, are all 201; GET lists them; weekdays [4,3,3] are stored sorted+deduplicated as [3,4]", async () => {
    const resB = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonB.id,
      validFrom: "2026-02-01",
      validUntil: "2026-03-01",
      weekdays: [4, 3, 3],
    });
    expect(resB.statusCode).toBe(201);
    expect(JSON.parse(resB.body).weekdays).toEqual([3, 4]);

    const resC = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonC.id,
      validFrom: "2026-02-01",
      validUntil: "2026-03-01",
      weekdays: [0, 1],
    });
    expect(resC.statusCode).toBe(201);

    const resD = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonD.id,
      validFrom: "2026-02-01",
      validUntil: "2026-03-01",
      weekdays: [2],
    });
    expect(resD.statusCode).toBe(201);

    const resE = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonE.id,
      validFrom: "2026-02-01",
      validUntil: "2026-03-01",
      weekdays: [],
    });
    expect(resE.statusCode).toBe(201);
    expect(JSON.parse(resE.body).weekdays).toEqual([]);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${tenantA.employee.id}/salon-assignments`,
      headers: { authorization: `Bearer ${tenantA.adminToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const ids = JSON.parse(listRes.body).assignments.map((a: { salonId: string }) => a.salonId);
    expect(ids).toEqual(expect.arrayContaining([salonB.id, salonC.id, salonD.id, salonE.id]));
  });

  it("D-08: validFrom before the tenant-local hireDate → 400", async () => {
    const res = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonB.id,
      validFrom: "2023-12-31",
      validUntil: "2024-01-05",
      weekdays: [6],
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Die Zuordnung darf nicht vor dem Eintrittsdatum beginnen.",
    );
  });

  it("D-08: validUntil before validFrom → 400", async () => {
    const res = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonB.id,
      validFrom: "2026-05-10",
      validUntil: "2026-05-01",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Das Ende der Zuordnung darf nicht vor ihrem Beginn liegen.",
    );
  });

  it("D-08: a malformed/impossible calendar day ('2026-02-30') → 400", async () => {
    const res = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonB.id,
      validFrom: "2026-02-30",
    });
    expect(res.statusCode).toBe(400);
  });

  it("D-08: unknown body keys are rejected by the strict schema → 400", async () => {
    const res = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonB.id,
      validFrom: "2026-05-01",
      extraField: "not allowed",
    });
    expect(res.statusCode).toBe(400);
  });

  describe("AC-Einsatz-2/D-09: same-salon overlap across both kinds", () => {
    let employeeId: string;
    let homeSalonId: string;

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const user = await app.prisma.user.create({
        data: { email: `sa-d09-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: tenantA.tenant.id,
          userId: user.id,
          employeeNumber: `SA-D09-${s}`,
          firstName: "D09",
          lastName: "Overlap",
          hireDate: new Date("2024-01-01"),
        },
      });
      employeeId = employee.id;
      homeSalonId = salonC.id;
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenantA.tenant.id,
          employeeId,
          salonId: homeSalonId,
          kind: "HOME",
          validFrom: new Date("2024-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
    });

    it("overlapping DEPLOYMENT to the same salon as an existing DEPLOYMENT → 409", async () => {
      const first = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonB.id,
        validFrom: "2026-06-01",
        validUntil: "2026-06-30",
      });
      expect(first.statusCode).toBe(201);

      const before = await assignmentCount(employeeId);
      const overlapping = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonB.id,
        validFrom: "2026-06-15",
        validUntil: "2026-07-15",
      });
      expect(overlapping.statusCode).toBe(409);
      expect(JSON.parse(overlapping.body).error).toBe(
        "Der Mitarbeiter ist diesem Salon im gewählten Zeitraum bereits zugeordnet.",
      );
      expect(await assignmentCount(employeeId)).toBe(before);

      // A NON-overlapping later period to the SAME salon is fine (D-09 only forbids overlap).
      const later = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonB.id,
        validFrom: "2026-08-01",
        validUntil: "2026-08-31",
      });
      expect(later.statusCode).toBe(201);
    });

    it("a DEPLOYMENT to the employee's HOME salon, in a period overlapping the (open-ended) HOME row, → 409", async () => {
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: homeSalonId,
        validFrom: "2026-09-01",
        validUntil: "2026-09-30",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Der Mitarbeiter ist diesem Salon im gewählten Zeitraum bereits zugeordnet.",
      );
    });

    it("a VOIDED row never conflicts — a new DEPLOYMENT overlapping a voided row's nominal period succeeds", async () => {
      // A voided row (validUntil = validFrom − 1, D-03) inserted directly — the API itself never
      // produces one at create time; only `end` can void an existing row (Task 2).
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenantA.tenant.id,
          employeeId,
          salonId: salonD.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2027-01-10"),
          validUntil: new Date("2027-01-09"),
          weekdays: [],
        },
      });
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonD.id,
        validFrom: "2027-01-01",
        validUntil: "2027-01-31",
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("AC-Einsatz-3/D-10: weekday conflict", () => {
    let employeeId: string;

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const user = await app.prisma.user.create({
        data: { email: `sa-d10-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: tenantA.tenant.id,
          userId: user.id,
          employeeNumber: `SA-D10-${s}`,
          firstName: "D10",
          lastName: "Weekday",
          hireDate: new Date("2024-01-01"),
        },
      });
      employeeId = employee.id;
    });

    it("two overlapping DEPLOYMENTs (different salons) sharing weekday 3 (Thursday) → 409 naming 'donnerstags'", async () => {
      const first = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonB.id,
        validFrom: "2026-04-01",
        validUntil: "2026-04-30",
        weekdays: [2, 3], // Wed, Thu
      });
      expect(first.statusCode).toBe(201);

      const conflicting = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonC.id,
        validFrom: "2026-04-10",
        validUntil: "2026-05-10",
        weekdays: [3, 5], // Thu, Sat — common with [2,3] is {3} = Thursday
      });
      expect(conflicting.statusCode).toBe(409);
      expect(JSON.parse(conflicting.body).error).toBe(
        "Der Mitarbeiter ist donnerstags im gewählten Zeitraum bereits einem anderen Einsatzsalon zugeordnet.",
      );
    });

    it("the SAME weekday in a NON-overlapping period → 201", async () => {
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonD.id,
        validFrom: "2026-06-01",
        validUntil: "2026-06-30",
        weekdays: [3],
      });
      expect(res.statusCode).toBe(201);
    });

    it("an EMPTY-weekday DEPLOYMENT overlapping an existing weekday-restricted DEPLOYMENT never weekday-conflicts", async () => {
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonE.id,
        validFrom: "2026-04-05",
        validUntil: "2026-04-20",
        weekdays: [],
      });
      expect(res.statusCode).toBe(201);
    });
  });

  it("AC-Deaktiviert-1/D-13: a new assignment to an INACTIVE salon → 400", async () => {
    const res = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: salonInactive.id,
      validFrom: "2026-07-01",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(
      "Einem deaktivierten Salon kann keine neue Zuordnung zugewiesen werden.",
    );
  });

  it("AC-Mandant-1/D-19: a foreign tenant's real salonId and a nonexistent salonId get byte-identical 400s; CROSS_TENANT_ACCESS_DENIED is audited only for the foreign one", async () => {
    const foreignRes = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: foreignSalon.id,
      validFrom: "2026-07-01",
    });
    const unknownRes = await postDeployment(tenantA.adminToken, tenantA.employee.id, {
      salonId: UNKNOWN_SALON_ID,
      validFrom: "2026-07-01",
    });
    expect(foreignRes.statusCode).toBe(400);
    expect(unknownRes.statusCode).toBe(400);
    expect(foreignRes.body).toBe(unknownRes.body);
    expect(JSON.parse(foreignRes.body).error).toBe("Salon nicht gefunden");

    const foreignAudit = await app.prisma.auditLog.count({
      where: {
        entity: "Salon",
        entityId: foreignSalon.id,
        action: "CROSS_TENANT_ACCESS_DENIED",
      },
    });
    expect(foreignAudit).toBeGreaterThanOrEqual(1);
    const unknownAudit = await app.prisma.auditLog.count({
      where: {
        entity: "Salon",
        entityId: UNKNOWN_SALON_ID,
        action: "CROSS_TENANT_ACCESS_DENIED",
      },
    });
    expect(unknownAudit).toBe(0);
  });

  describe("AC-Aenderung-2/D-12: closed-month lock check", () => {
    let employeeId: string;

    async function lockDay(date: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:00:00.000Z`),
          isLocked: true,
          salonId: await salonIdForEmployee(app.prisma, employeeId), // Phase 68b (issue #68)
        },
      });
    }

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const user = await app.prisma.user.create({
        data: { email: `sa-d12-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
      });
      const employee = await app.prisma.employee.create({
        data: {
          tenantId: tenantA.tenant.id,
          userId: user.id,
          employeeNumber: `SA-D12-${s}`,
          firstName: "D12",
          lastName: "Lock",
          hireDate: new Date("2024-01-01"),
        },
      });
      employeeId = employee.id;
    });

    it("a locked entry on 2025-03-10 blocks a DEPLOYMENT starting 2025-03-15 (same month) → 409", async () => {
      await lockDay("2025-03-10");
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonB.id,
        validFrom: "2025-03-15",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Der Zeitraum betrifft einen abgeschlossenen Monat. Rückwirkende Zuordnungen sind dort nicht möglich.",
      );
    });

    it("a locked entry on 2025-03-31 does NOT block a DEPLOYMENT starting 2025-04-01 — lower month bound, proves the check widens to CALENDAR months rather than raw monthRangeUtc instants → 201", async () => {
      await lockDay("2025-03-31");
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonC.id,
        validFrom: "2025-04-01",
      });
      expect(res.statusCode).toBe(201);
    });

    it("a locked entry on 2025-05-01 does NOT block a DEPLOYMENT confined to 2025-04-01..2025-04-30 — upper month bound → 201", async () => {
      await lockDay("2025-05-01");
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonD.id,
        validFrom: "2025-04-01",
        validUntil: "2025-04-30",
      });
      expect(res.statusCode).toBe(201);
    });

    it("an OPEN-ENDED DEPLOYMENT starting before a locked month → 409", async () => {
      await lockDay("2025-06-15");
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: salonE.id,
        validFrom: "2025-06-01",
      });
      expect(res.statusCode).toBe(409);
    });
  });

  it("AC-Aenderung-3/D-21: a successful create writes exactly one CREATE audit row for that assignment, with YYYY-MM-DD dates", async () => {
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: { email: `sa-audit-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: user.id,
        employeeNumber: `SA-AUDIT-${s}`,
        firstName: "Audit",
        lastName: "Proof",
        hireDate: new Date("2024-01-01"),
      },
    });

    const res = await postDeployment(tenantA.adminToken, employee.id, {
      salonId: salonB.id,
      validFrom: "2026-10-01",
      validUntil: "2026-10-31",
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);

    const audits = await app.prisma.auditLog.findMany({
      where: { entity: "EmployeeSalonAssignment", entityId: created.id, action: "CREATE" },
    });
    expect(audits).toHaveLength(1);
    const newValue = audits[0].newValue as { validFrom: string; validUntil: string };
    expect(newValue.validFrom).toBe("2026-10-01");
    expect(newValue.validUntil).toBe("2026-10-31");
  });

  it("D-02 concurrency: two real interleaved transactions creating overlapping, weekday-sharing DEPLOYMENTs for the SAME employee resolve to exactly one OK and one WEEKDAY_CONFLICT — never two rows", async () => {
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: { email: `sa-race-${s}@test.de`, passwordHash: "x", role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: user.id,
        employeeNumber: `SA-RACE-${s}`,
        firstName: "Race",
        lastName: "Condition",
        hireDate: new Date("2024-01-01"),
      },
    });

    const { createDeploymentAssignment } =
      await import("../contexts/platform/facade/salon-assignment-changes");

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
        const result = await createDeploymentAssignment(tx, tenantA.tenant.id, employee.id, {
          salonId: salonB.id,
          validFrom: "2026-11-01",
          validUntil: "2026-11-30",
          weekdays: [3],
        });
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
          return createDeploymentAssignment(tx, tenantA.tenant.id, employee.id, {
            salonId: salonC.id,
            validFrom: "2026-11-10",
            validUntil: "2026-12-10",
            weekdays: [3],
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

    expect(tx2BlockedByTx1, "tx2 was never observed waiting on tx1's employee row lock").toBe(true);
    expect(result1.status).toBe("OK_CREATED");
    expect(result2.status).toBe("WEEKDAY_CONFLICT");

    const rowCount = await app.prisma.employeeSalonAssignment.count({
      where: { employeeId: employee.id },
    });
    expect(rowCount).toBe(1);
  });
});

describe("POST .../salon-assignments/home & .../:assignmentId/end — Stammsalon change and end an assignment (Phase 67b Plan 02 Task 2)", () => {
  let app: FastifyInstance;
  let tenantA: Awaited<ReturnType<typeof seedTestData>>;
  let tenantB: Awaited<ReturnType<typeof seedTestData>>;
  let home1: { id: string };
  let home2: { id: string };
  let home3: { id: string };
  let home4: { id: string };
  let deploySalon: { id: string };

  function postHome(token: string, employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/salon-assignments/home`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function postEnd(
    token: string,
    employeeId: string,
    assignmentId: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/salon-assignments/${assignmentId}/end`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  function postDeployment(token: string, employeeId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/employees/${employeeId}/salon-assignments`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  async function getAssignments(token: string, employeeId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${employeeId}/salon-assignments`,
      headers: { authorization: `Bearer ${token}` },
    });
    return JSON.parse(res.body).assignments as {
      id: string;
      salonId: string;
      kind: "HOME" | "DEPLOYMENT";
      validFrom: string;
      validUntil: string | null;
    }[];
  }

  /** AC-Stamm-3: every calendar day in [2024-01-01, 2026-12-31] (1096 days — 2024 is a leap year)
   * has EXACTLY one effective HOME row for `employeeId`. One `findMany`, then pure in-memory
   * iteration — the same `isEffectiveOn` definition as the production code, restated here so the
   * test does not depend on importing production internals. */
  async function assertGaplessHomeTiling(employeeId: string) {
    const rows = await app.prisma.employeeSalonAssignment.findMany({
      where: { employeeId, kind: "HOME" },
    });
    const from = new Date("2024-01-01T00:00:00Z").getTime();
    const to = new Date("2026-12-31T00:00:00Z").getTime();
    let iterated = 0;
    for (let t = from; t <= to; t += 86400000) {
      const count = rows.filter(
        (row) =>
          row.validFrom.getTime() <= t &&
          (row.validUntil === null || row.validUntil.getTime() >= t),
      ).length;
      expect(
        count,
        `day ${new Date(t).toISOString().slice(0, 10)} has ${count} effective HOME row(s)`,
      ).toBe(1);
      iterated += 1;
    }
    expect(iterated).toBe(1096);
  }

  async function createEmployee(namePrefix: string, hireDate = "2024-01-01") {
    const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await app.prisma.user.create({
      data: {
        email: `${namePrefix}-${s}@test.de`,
        passwordHash: "x",
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: tenantA.tenant.id,
        userId: user.id,
        employeeNumber: `${namePrefix.toUpperCase()}-${s}`,
        firstName: namePrefix,
        lastName: "Test",
        hireDate: new Date(hireDate),
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    tenantA = await seedTestData(app, "sa-home-a");
    tenantB = await seedTestData(app, "sa-home-b");

    const makeSalon = (name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId: tenantA.tenant.id,
          federalState: "NIEDERSACHSEN",
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
    home1 = await makeSalon("Home Salon 1");
    home2 = await makeSalon("Home Salon 2");
    home3 = await makeSalon("Home Salon 3");
    home4 = await makeSalon("Home Salon 4");
    deploySalon = await makeSalon("Deploy Salon (D-09 overlap)");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, tenantA.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantA):", err);
    }
    try {
      await cleanupTestData(app, tenantB.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (tenantB):", err);
    }
  });

  describe("AC-Stamm-3/D-05/AC-Aenderung-4: gapless HOME tiling across four changes", () => {
    let employeeId: string;

    beforeAll(async () => {
      const employee = await createEmployee("tiling");
      employeeId = employee.id;
    });

    it("first HOME at the hire date → 201, ended: null; every day has exactly one effective HOME row", async () => {
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home1.id,
        validFrom: "2024-01-01",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ended).toBeNull();
      expect(body.created.salonId).toBe(home1.id);
      expect(body.created.validFrom).toBe("2024-01-01");
      expect(body.created.validUntil).toBeNull();
      await assertGaplessHomeTiling(employeeId);
    });

    it("change to Home Salon 2 at 2024-06-15 → salon 1 ends 2024-06-14, salon 2 open from 2024-06-15; tiling holds", async () => {
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home2.id,
        validFrom: "2024-06-15",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ended.salonId).toBe(home1.id);
      expect(body.ended.validUntil).toBe("2024-06-14");
      expect(body.created.salonId).toBe(home2.id);
      expect(body.created.validFrom).toBe("2024-06-15");
      await assertGaplessHomeTiling(employeeId);
    });

    it("change to Home Salon 3 at 2025-01-01 → salon 2 ends 2024-12-31; tiling holds", async () => {
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2025-01-01",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ended.salonId).toBe(home2.id);
      expect(body.ended.validUntil).toBe("2024-12-31");
      await assertGaplessHomeTiling(employeeId);
    });

    it("change to Home Salon 4 at 2025-01-01 (SAME day as salon 3's own validFrom) → salon 3 is VOIDED (validUntil 2024-12-31), salon 4 open; tiling holds", async () => {
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home4.id,
        validFrom: "2025-01-01",
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.ended.salonId).toBe(home3.id);
      expect(body.ended.validUntil).toBe("2024-12-31");
      expect(body.created.salonId).toBe(home4.id);
      await assertGaplessHomeTiling(employeeId);
    });

    it("AC-Aenderung-4: GET still lists the ended salon-1 row with its ORIGINAL validFrom and its new validUntil; salonForDay answers salon 1 on 2024-06-14 and salon 2 on 2024-06-15", async () => {
      const assignments = await getAssignments(tenantA.adminToken, employeeId);
      const endedFirst = assignments.find((a) => a.salonId === home1.id);
      expect(endedFirst?.validFrom).toBe("2024-01-01");
      expect(endedFirst?.validUntil).toBe("2024-06-14");

      const dayBefore = await salonForDay(
        app.prisma,
        tenantA.tenant.id,
        employeeId,
        new Date("2024-06-14T10:00:00Z"),
      );
      expect(dayBefore?.salonId).toBe(home1.id);
      const dayAfter = await salonForDay(
        app.prisma,
        tenantA.tenant.id,
        employeeId,
        new Date("2024-06-15T10:00:00Z"),
      );
      expect(dayAfter?.salonId).toBe(home2.id);
    });
  });

  describe("AC-Stamm-4/D-05/D-09: HOME change rejections", () => {
    let employeeId: string;

    beforeAll(async () => {
      const employee = await createEmployee("stamm4");
      employeeId = employee.id;
      const first = await postHome(tenantA.adminToken, employeeId, {
        salonId: home1.id,
        validFrom: "2024-01-01",
      });
      expect(first.statusCode).toBe(201);
      // The OPEN row is now Home Salon 2, validFrom 2024-06-01 — leaves a real gap
      // [2024-01-01, 2024-06-01) to probe HOME_OVERLAP against.
      const second = await postHome(tenantA.adminToken, employeeId, {
        salonId: home2.id,
        validFrom: "2024-06-01",
      });
      expect(second.statusCode).toBe(201);
    });

    it("D before the open row's own validFrom (but >= hireDate) → 409 HOME_OVERLAP; nothing written", async () => {
      const before = await app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2024-03-01",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Der Stammsalon-Wechsel überschneidet sich mit einer bestehenden Stammsalon-Zuordnung.",
      );
      expect(await app.prisma.employeeSalonAssignment.count({ where: { employeeId } })).toBe(
        before,
      );
    });

    it("the open row's own salon, D >= its validFrom → 409 ALREADY_HOME; nothing written", async () => {
      const before = await app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home2.id,
        validFrom: "2024-07-01",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("Der Salon ist ab diesem Datum bereits Stammsalon.");
      expect(await app.prisma.employeeSalonAssignment.count({ where: { employeeId } })).toBe(
        before,
      );
    });

    it("D before the hire date → 400; nothing written", async () => {
      const before = await app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2023-12-31",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(
        "Die Zuordnung darf nicht vor dem Eintrittsdatum beginnen.",
      );
      expect(await app.prisma.employeeSalonAssignment.count({ where: { employeeId } })).toBe(
        before,
      );
    });

    it("a legacy employee with NO HOME rows, D != hireDate → 400 FIRST_HOME_NOT_AT_HIRE_DATE; nothing written", async () => {
      const legacyEmployee = await createEmployee("legacy");
      const before = await app.prisma.employeeSalonAssignment.count({
        where: { employeeId: legacyEmployee.id },
      });
      const res = await postHome(tenantA.adminToken, legacyEmployee.id, {
        salonId: home1.id,
        validFrom: "2024-06-01",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(
        "Die erste Stammsalon-Zuordnung muss am Eintrittsdatum beginnen.",
      );
      expect(
        await app.prisma.employeeSalonAssignment.count({
          where: { employeeId: legacyEmployee.id },
        }),
      ).toBe(before);
    });

    it("D-04/D-05: a HOME body carrying validUntil or weekdays is rejected by the strict schema → 400", async () => {
      const withValidUntil = await postHome(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2024-09-01",
        validUntil: "2024-09-30",
      });
      expect(withValidUntil.statusCode).toBe(400);

      const withWeekdays = await postHome(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2024-09-01",
        weekdays: [1],
      });
      expect(withWeekdays.statusCode).toBe(400);
    });

    it("D-09: HOME change to a salon with an overlapping DEPLOYMENT → 409 same-salon message, nothing written (no auto-ending)", async () => {
      const dep = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: deploySalon.id,
        validFrom: "2024-08-01",
        validUntil: "2024-08-31",
      });
      expect(dep.statusCode).toBe(201);

      const before = await app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: deploySalon.id,
        validFrom: "2024-08-15",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Der Mitarbeiter ist diesem Salon im gewählten Zeitraum bereits zugeordnet.",
      );
      expect(await app.prisma.employeeSalonAssignment.count({ where: { employeeId } })).toBe(
        before,
      );
    });

    it("AC-Stamm-4/D-06: ending a HOME row → 409 HOME_NEEDS_SUCCESSOR, nothing written", async () => {
      const assignments = await getAssignments(tenantA.adminToken, employeeId);
      const openHome = assignments.find((a) => a.kind === "HOME" && a.validUntil === null)!;
      const before = await app.prisma.employeeSalonAssignment.count({ where: { employeeId } });
      const res = await postEnd(tenantA.adminToken, employeeId, openHome.id, {
        validUntil: "2024-09-01",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Ein Stammsalon kann nur durch einen neuen Stammsalon beendet werden.",
      );
      expect(await app.prisma.employeeSalonAssignment.count({ where: { employeeId } })).toBe(
        before,
      );
    });
  });

  describe("D-11: ending a DEPLOYMENT — shorten only", () => {
    let employeeId: string;
    let assignmentId: string;

    beforeAll(async () => {
      const employee = await createEmployee("end-d11");
      employeeId = employee.id;
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: home1.id,
        validFrom: "2026-01-01",
      });
      expect(res.statusCode).toBe(201);
      assignmentId = JSON.parse(res.body).id;
    });

    it("ending an open DEPLOYMENT at T → 200, validUntil = T", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2026-03-31",
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).validUntil).toBe("2026-03-31");
    });

    it("a second end with a later OR EQUAL T → 409 ONLY_SHORTEN", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2026-03-31",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Eine Zuordnung kann nur verkürzt, nicht verlängert werden.",
      );
    });

    it("T < validFrom - 1 → 400 END_BEFORE_START", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2025-01-01",
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe(
        "Eine Zuordnung kann frühestens am Tag vor ihrem Beginn enden.",
      );
    });

    it("T = validFrom - 1 → voids the row; salonForDay never returns it", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2025-12-31",
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).validUntil).toBe("2025-12-31");

      const day = await salonForDay(
        app.prisma,
        tenantA.tenant.id,
        employeeId,
        new Date("2026-01-01T10:00:00Z"),
      );
      expect(day).toBeNull();
    });
  });

  describe("AC-Aenderung-1: end changes only validUntil (and updatedAt); no DELETE route exists", () => {
    let employeeId: string;
    let assignmentId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let before: any;

    beforeAll(async () => {
      const employee = await createEmployee("aend1");
      employeeId = employee.id;
      const res = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: home2.id,
        validFrom: "2026-04-01",
        validUntil: "2026-04-30",
        weekdays: [2],
      });
      expect(res.statusCode).toBe(201);
      before = JSON.parse(res.body);
      assignmentId = before.id;
    });

    it("every field except validUntil (and updatedAt) equals the row before the end", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2026-04-20",
      });
      expect(res.statusCode).toBe(200);
      const after = JSON.parse(res.body);
      expect(after.validUntil).toBe("2026-04-20");
      expect(after.id).toBe(before.id);
      expect(after.employeeId).toBe(before.employeeId);
      expect(after.salonId).toBe(before.salonId);
      expect(after.kind).toBe(before.kind);
      expect(after.validFrom).toBe(before.validFrom);
      expect(after.weekdays).toEqual(before.weekdays);
      expect(after.createdAt).toBe(before.createdAt);
    });

    it("no DELETE route exists for an assignment — 404, and the row still exists unchanged", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/v1/employees/${employeeId}/salon-assignments/${assignmentId}`,
        headers: { authorization: `Bearer ${tenantA.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
      const row = await app.prisma.employeeSalonAssignment.findUnique({
        where: { id: assignmentId },
      });
      expect(row).not.toBeNull();
    });
  });

  describe("AC-Aenderung-2/D-12: closed-month lock on HOME change and end", () => {
    let employeeId: string;
    let assignmentId: string;

    async function lockDay(id: string, date: string) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T16:00:00.000Z`),
          isLocked: true,
          salonId: await salonIdForEmployee(app.prisma, id), // Phase 68b (issue #68)
        },
      });
    }

    beforeAll(async () => {
      const employee = await createEmployee("lock-t2");
      employeeId = employee.id;
      const home = await postHome(tenantA.adminToken, employeeId, {
        salonId: home1.id,
        validFrom: "2024-01-01",
      });
      expect(home.statusCode).toBe(201);

      const dep = await postDeployment(tenantA.adminToken, employeeId, {
        salonId: home3.id,
        validFrom: "2025-01-01",
      });
      expect(dep.statusCode).toBe(201);
      assignmentId = JSON.parse(dep.body).id;
    });

    it("a locked entry on 2025-05-10 blocks ending the DEPLOYMENT at 2025-05-20 (affected days lie in May) → 409", async () => {
      await lockDay(employeeId, "2025-05-10");
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2025-05-20",
      });
      expect(res.statusCode).toBe(409);
    });

    it("ending at 2025-06-30 does not touch the locked May entry → 200", async () => {
      const res = await postEnd(tenantA.adminToken, employeeId, assignmentId, {
        validUntil: "2025-06-30",
      });
      expect(res.statusCode).toBe(200);
    });

    it("a HOME change with D inside a locked month → 409", async () => {
      await lockDay(employeeId, "2025-08-15");
      const res = await postHome(tenantA.adminToken, employeeId, {
        salonId: home4.id,
        validFrom: "2025-08-01",
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe(
        "Der Zeitraum betrifft einen abgeschlossenen Monat. Rückwirkende Zuordnungen sind dort nicht möglich.",
      );
    });
  });

  describe("AC-Aenderung-3/D-21: audit rows", () => {
    it("an end writes exactly one END audit row (oldValue = before, newValue = after)", async () => {
      const employee = await createEmployee("audit-end");
      const dep = await postDeployment(tenantA.adminToken, employee.id, {
        salonId: home1.id,
        validFrom: "2026-05-01",
        validUntil: "2026-05-31",
      });
      const assignmentId = JSON.parse(dep.body).id;

      const res = await postEnd(tenantA.adminToken, employee.id, assignmentId, {
        validUntil: "2026-05-20",
      });
      expect(res.statusCode).toBe(200);

      const audits = await app.prisma.auditLog.findMany({
        where: { entity: "EmployeeSalonAssignment", entityId: assignmentId, action: "END" },
      });
      expect(audits).toHaveLength(1);
      const oldValue = audits[0].oldValue as { validUntil: string | null };
      const newValue = audits[0].newValue as { validUntil: string | null };
      expect(oldValue.validUntil).toBe("2026-05-31");
      expect(newValue.validUntil).toBe("2026-05-20");
    });

    it("a HOME change writes END (old row) + CREATE (new row)", async () => {
      const employee = await createEmployee("audit-home-change");
      const first = await postHome(tenantA.adminToken, employee.id, {
        salonId: home1.id,
        validFrom: "2024-01-01",
      });
      const firstId = JSON.parse(first.body).created.id;

      const change = await postHome(tenantA.adminToken, employee.id, {
        salonId: home2.id,
        validFrom: "2024-07-01",
      });
      expect(change.statusCode).toBe(201);
      const created = JSON.parse(change.body);

      const endAudits = await app.prisma.auditLog.count({
        where: { entity: "EmployeeSalonAssignment", entityId: firstId, action: "END" },
      });
      expect(endAudits).toBe(1);
      const createAudits = await app.prisma.auditLog.count({
        where: {
          entity: "EmployeeSalonAssignment",
          entityId: created.created.id,
          action: "CREATE",
        },
      });
      expect(createAudits).toBe(1);
    });

    it("a first HOME (no predecessor) writes only CREATE", async () => {
      const employee = await createEmployee("audit-home-first");
      const res = await postHome(tenantA.adminToken, employee.id, {
        salonId: home1.id,
        validFrom: "2024-01-01",
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.body).created;

      const createAudits = await app.prisma.auditLog.count({
        where: { entity: "EmployeeSalonAssignment", entityId: created.id, action: "CREATE" },
      });
      expect(createAudits).toBe(1);
      const endAudits = await app.prisma.auditLog.count({
        where: { entity: "EmployeeSalonAssignment", entityId: created.id, action: "END" },
      });
      expect(endAudits).toBe(0);
    });
  });

  describe("D-19: assignment-level T-100-09 (own employee id; foreign / other-employee / nonexistent assignmentId)", () => {
    let employeeId: string;
    let otherEmployeeAssignmentId: string;
    let foreignAssignmentId: string;

    beforeAll(async () => {
      const employee = await createEmployee("d19-own");
      employeeId = employee.id;

      const otherEmployee = await createEmployee("d19-other");
      const otherAssignment = await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenantA.tenant.id,
          employeeId: otherEmployee.id,
          salonId: home1.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
      otherEmployeeAssignmentId = otherAssignment.id;

      const foreignSalon = await app.prisma.salon.create({
        data: {
          tenantId: tenantB.tenant.id,
          federalState: "NIEDERSACHSEN",
          name: "D-19 Foreign Salon",
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
        },
      });
      const foreignAssignment = await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: tenantB.tenant.id,
          employeeId: tenantB.employee.id,
          salonId: foreignSalon.id,
          kind: "DEPLOYMENT",
          validFrom: new Date("2026-01-01"),
          validUntil: null,
          weekdays: [],
        },
      });
      foreignAssignmentId = foreignAssignment.id;
    });

    it("a foreign tenant's real assignmentId, a nonexistent one, and another own-tenant employee's assignmentId are all byte-identical 404s; CROSS_TENANT_ACCESS_DENIED only for the foreign one; the other employee's row is unchanged", async () => {
      const unknownId = "00000000-0000-4000-8000-000000000402";
      const foreignRes = await postEnd(tenantA.adminToken, employeeId, foreignAssignmentId, {
        validUntil: "2026-06-01",
      });
      const unknownRes = await postEnd(tenantA.adminToken, employeeId, unknownId, {
        validUntil: "2026-06-01",
      });
      const otherEmpRes = await postEnd(tenantA.adminToken, employeeId, otherEmployeeAssignmentId, {
        validUntil: "2026-06-01",
      });

      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(otherEmpRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
      expect(otherEmpRes.body).toBe(unknownRes.body);
      expect(JSON.parse(unknownRes.body).error).toBe("Zuordnung nicht gefunden");

      const foreignAudit = await app.prisma.auditLog.count({
        where: {
          entity: "EmployeeSalonAssignment",
          entityId: foreignAssignmentId,
          action: "CROSS_TENANT_ACCESS_DENIED",
        },
      });
      expect(foreignAudit).toBeGreaterThanOrEqual(1);
      const otherEmpAudit = await app.prisma.auditLog.count({
        where: {
          entity: "EmployeeSalonAssignment",
          entityId: otherEmployeeAssignmentId,
          action: "CROSS_TENANT_ACCESS_DENIED",
        },
      });
      expect(otherEmpAudit).toBe(0);

      const otherRow = await app.prisma.employeeSalonAssignment.findUnique({
        where: { id: otherEmployeeAssignmentId },
      });
      expect(otherRow?.validUntil).toBeNull();
    });
  });
});
