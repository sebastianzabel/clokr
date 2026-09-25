/**
 * Phase 68b (issue #68), D-06/D-08/D-09/D-13 — end-to-end tracer for `resolveEntrySalon` through
 * the clock resolver's START branch: a MOBILE clock-in on a Thursday lands on the employee's
 * DEPLOYMENT salon for that weekday, on a Monday it lands on the HOME salon, an employee with no
 * assignment row at all falls back to the tenant's default salon, and a tenant with no active
 * salon gets a clean 409 with no row written. Plan 02 extends this file with the explicit
 * `salonId` input paths (POST, CSV, PUT).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, pastDateStr, daysAgoStrInTz, TEST_TZ } from "./test-dates";

describe("time-entry-salon tracer (Phase 68b, issue #68)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let noSalonTenant: Awaited<ReturnType<typeof seedTestData>>;

  // Last week's Monday/Thursday — always in the past, regardless of when the suite runs.
  const monday = addDaysStr(mondayOfWeekStr(), -7);
  const thursday = addDaysStr(monday, 3);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tes"); // seed.salonId = the tenant's default salon (D)

    // A and B are created AFTER the default salon D (seedTestData already ran), so D stays the
    // earliest-created ACTIVE salon — the fallback `findDefaultSalon` answer.
    salonA = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon A",
      createdAt: new Date(),
    });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B",
      createdAt: new Date(),
    });

    // HOME -> A, open-ended from 2024-01-01.
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    // DEPLOYMENT -> B on Thursdays only (weekdays: 0=Monday..6=Sunday, so Thursday = 3).
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3],
      },
    });

    // A second tenant whose only salon is deactivated directly — NO_ACTIVE_SALON fixture.
    noSalonTenant = await seedTestData(app, "tes-none");
    await app.prisma.salon.updateMany({
      where: { tenantId: noSalonTenant.tenant.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    try {
      await cleanupTestData(app, noSalonTenant.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("D-08/D-09: Thursday MOBILE clock-in lands on the DEPLOYMENT salon (B)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${thursday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(salonB.id);

      const row = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: body.resolution.entry.id },
      });
      expect(row.salonId).toBe(salonB.id);

      // D-13: the CLOCK_IN audit's newValue is the full row, so it carries salonId too.
      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "TimeEntry", entityId: row.id, action: "CLOCK_IN" },
        orderBy: { createdAt: "desc" },
      });
      expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonB.id);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.employee.id } });
    }
  });

  it("D-08/D-09: Monday MOBILE clock-in lands on the HOME salon (A)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(salonA.id);

      const row = await app.prisma.timeEntry.findUniqueOrThrow({
        where: { id: body.resolution.entry.id },
      });
      expect(row.salonId).toBe(salonA.id);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.employee.id } });
    }
  });

  it("D-08: an employee with no assignment row at all falls back to the tenant default salon (D)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: { employeeId: seed.adminEmployee.id, source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(body.resolution.kind).toBe("CLOCKED_IN");
      expect(body.resolution.entry.salonId).toBe(seed.salonId);
    } finally {
      vi.useRealTimers();
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: seed.adminEmployee.id } });
    }
  });

  it("D-08: a tenant with no active salon answers 409 NO_ACTIVE_SALON and writes no row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fromZonedTime(`${monday}T09:00:00`, TEST_TZ));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${noSalonTenant.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Kein aktiver Salon vorhanden.",
        code: "NO_ACTIVE_SALON",
        resolution: { kind: "CONFLICT", reason: "NO_ACTIVE_SALON" },
      });

      const rows = await app.prisma.timeEntry.findMany({
        where: { employeeId: noSalonTenant.employee.id },
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Phase 68b Plan 02, Task 1 — explicit `salonId` on POST /time-entries (D-07/D-08/D-10),
 * across all three create branches (plain manual, grant/CORRECTION, pending Zeitnachtrag),
 * plus the T-100-09 tenant-boundary byte-compare and the zero-state-on-rejection proofs.
 */
describe("explicit salonId on POST /time-entries (Phase 68b, issue #68, D-07/D-08/D-10)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let noneTenant: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let salonX: { id: string };
  const ghost = randomUUID();

  // TenantConfig.retroEntryWindowDays default (retro-config.ts DEFAULT_WINDOW_DAYS).
  const WINDOW_DAYS = 10;
  // Frozen "now" so the out-of-window Zeitnachtrag cases are deterministic (mirrors
  // retro-entry-first.test.ts's FROZEN_NOW).
  const FROZEN_NOW = new Date("2024-04-14T22:00:00.000Z"); // Berlin: 2024-04-15 00:00

  // A run of distinct past Mondays, always safely after the fixture employee's 2024-01-01
  // hire date, one per admin-correction case (corrections bypass the retro-window guard, so
  // "how far in the past" does not matter — only "distinct" does, one entry per employee/day).
  const baseMonday = addDaysStr(mondayOfWeekStr(), -7);
  const mondayWeeksAgo = (n: number) => addDaysStr(baseMonday, -7 * (n - 1));

  const mondayPlainC = mondayWeeksAgo(1);
  const mondayNoSalon = mondayWeeksAgo(2);
  const thursdayNoSalon = addDaysStr(mondayNoSalon, 3); // 0=Mon..6=Sun -> Thursday = +3
  const mondayXInactive = mondayWeeksAgo(3);
  const mondayT10009Plain = mondayWeeksAgo(4);
  const mondayDerivedInactive = mondayWeeksAgo(5);
  const mondayNullSalon = mondayWeeksAgo(6);

  // Employee-own and grant-backed cases use the real clock, within the retro window.
  const dateEmpOwnC = pastDateStr(2);
  const dateGrantC = pastDateStr(4);
  const dateGrantZero = pastDateStr(5);
  const dateT10009Grant = pastDateStr(6);

  // Pending-Zeitnachtrag cases use the frozen clock, OUTSIDE the retro window.
  const dateZeitnachtragC = daysAgoStrInTz(FROZEN_NOW, WINDOW_DAYS + 3);
  const dateZeitnachtragZero = daysAgoStrInTz(FROZEN_NOW, WINDOW_DAYS + 4);
  const dateT10009Zeitnachtrag = daysAgoStrInTz(FROZEN_NOW, WINDOW_DAYS + 5);

  // The "tenant with no active salon" fixture uses its own tenant+employee.
  const dateNoActiveSalon = pastDateStr(1);

  function iso(dateStr: string, hhmm: string): string {
    return `${dateStr}T${hhmm}:00.000Z`;
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tes-post"); // seed.salonId = the tenant's default salon (D)
    foreign = await seedTestData(app, "tes-post-foreign"); // foreign.salonId = F
    noneTenant = await seedTestData(app, "tes-post-none");

    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon C (no assignment)" });
    salonX = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X (inactive)",
      isActive: false,
    });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2024-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });

    // A tenant whose every salon is inactive AND whose employee has no assignment row.
    await app.prisma.salon.updateMany({
      where: { tenantId: noneTenant.tenant.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
  });

  afterAll(async () => {
    for (const t of [seed, foreign, noneTenant]) {
      try {
        // Local cleanup first: TimeEntry (frees the retroRequestId FK), then
        // RetroEntryRequest — BEFORE the shared cleanupTestData() deletes employees.
        // RetroEntryRequest.employee AND TimeEntry.retroRequest are both onDelete:Restrict,
        // and cleanupTestData() does not delete RetroEntryRequest rows itself (mirrors
        // retro-entry-first.test.ts's own afterAll).
        await app.prisma.timeEntry.deleteMany({ where: { employee: { tenantId: t.tenant.id } } });
        await app.prisma.retroEntryRequest.deleteMany({
          where: { employee: { tenantId: t.tenant.id } },
        });
        await cleanupTestData(app, t.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("D-07/D-10: ADMIN plain manual entry with explicit salon C is stored unchanged although salonForDay says A", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayPlainC,
        startTime: iso(mondayPlainC, "08:00"),
        endTime: iso(mondayPlainC, "16:00"),
        salonId: salonC.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      entry: { id: string; salonId: string; isInvalid: boolean };
    };
    expect(body.entry.salonId).toBe(salonC.id);
    expect(body.entry.isInvalid).toBe(false);

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "TimeEntry", entityId: body.entry.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
  });

  it("D-07/D-10: EMPLOYEE's own plain entry inside the retro window with explicit salon C is stored unchanged", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: dateEmpOwnC,
        startTime: iso(dateEmpOwnC, "08:00"),
        endTime: iso(dateEmpOwnC, "16:00"),
        salonId: salonC.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { entry: { salonId: string } };
    expect(body.entry.salonId).toBe(salonC.id);
  });

  it("D-07/D-10: grant-backed correction with explicit salon C is stored unchanged, source CORRECTION, grant flips to USED", async () => {
    const grant = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: new Date(dateGrantC),
        reason: "68b-02 grant fixture",
        status: "APPROVED",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: dateGrantC,
        startTime: iso(dateGrantC, "08:00"),
        endTime: iso(dateGrantC, "16:00"),
        grantId: grant.id,
        salonId: salonC.id,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      entry: { id: string; salonId: string; source: string; isInvalid: boolean };
    };
    expect(body.entry.source).toBe("CORRECTION");
    expect(body.entry.salonId).toBe(salonC.id);
    expect(body.entry.isInvalid).toBe(false);

    const grantAfter = await app.prisma.retroEntryRequest.findUnique({ where: { id: grant.id } });
    expect(grantAfter?.status).toBe("USED");

    const audit = await app.prisma.auditLog.findFirst({
      where: { entity: "TimeEntry", entityId: body.entry.id, action: "CREATE" },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
  });

  it("D-07/D-10: pending Zeitnachtrag with explicit salon C is stored unchanged, isInvalid RETRO_APPROVAL_PENDING", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: dateZeitnachtragC,
          startTime: iso(dateZeitnachtragC, "08:00"),
          endTime: iso(dateZeitnachtragC, "16:00"),
          reason: "vergessen einzutragen (68b-02)",
          salonId: salonC.id,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as {
        entry: { id: string; salonId: string; isInvalid: boolean; invalidReasonCode: string };
      };
      expect(body.entry.salonId).toBe(salonC.id);
      expect(body.entry.isInvalid).toBe(true);
      expect(body.entry.invalidReasonCode).toBe("RETRO_APPROVAL_PENDING");

      const audit = await app.prisma.auditLog.findFirst({
        where: { entity: "TimeEntry", entityId: body.entry.id, action: "CREATE" },
        orderBy: { createdAt: "desc" },
      });
      expect((audit?.newValue as { salonId?: string } | null)?.salonId).toBe(salonC.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("D-08: without an explicit salonId, POST still lands on A (Monday) / B (Thursday) — re-asserted through POST", async () => {
    const resMonday = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayNoSalon,
        startTime: iso(mondayNoSalon, "08:00"),
        endTime: iso(mondayNoSalon, "16:00"),
      },
    });
    expect(resMonday.statusCode).toBe(201);
    expect((JSON.parse(resMonday.body) as { entry: { salonId: string } }).entry.salonId).toBe(
      salonA.id,
    );

    const resThursday = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: thursdayNoSalon,
        startTime: iso(thursdayNoSalon, "08:00"),
        endTime: iso(thursdayNoSalon, "16:00"),
      },
    });
    expect(resThursday.statusCode).toBe(201);
    expect((JSON.parse(resThursday.body) as { entry: { salonId: string } }).entry.salonId).toBe(
      salonB.id,
    );
  });

  it("D-07: an explicit inactive salon (X) is rejected with 400 SALON_INACTIVE, no entry created", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayXInactive,
        startTime: iso(mondayXInactive, "08:00"),
        endTime: iso(mondayXInactive, "16:00"),
        salonId: salonX.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Salon ist deaktiviert",
      code: "SALON_INACTIVE",
    });

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(mondayXInactive) },
    });
    expect(rows).toHaveLength(0);
  });

  it("T-100-09 (plain): a foreign tenant's real salon and a nonexistent id answer byte-identical 404", async () => {
    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayT10009Plain,
        startTime: iso(mondayT10009Plain, "08:00"),
        endTime: iso(mondayT10009Plain, "16:00"),
        salonId: foreign.salonId,
      },
    });
    const ghostRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayT10009Plain,
        startTime: iso(mondayT10009Plain, "08:00"),
        endTime: iso(mondayT10009Plain, "16:00"),
        salonId: ghost,
      },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(ghostRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(ghostRes.body);
    expect(foreignRes.body).toBe('{"error":"Salon nicht gefunden"}');

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(mondayT10009Plain) },
    });
    expect(rows).toHaveLength(0);
  });

  it("T-100-09 (grant) + zero-state: a foreign salon and a nonexistent id answer byte-identical 404, grant stays APPROVED, no entry", async () => {
    const grant = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: new Date(dateT10009Grant),
        reason: "68b-02 T-100-09 grant fixture",
        status: "APPROVED",
      },
    });
    const foreignRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: dateT10009Grant,
        startTime: iso(dateT10009Grant, "08:00"),
        endTime: iso(dateT10009Grant, "16:00"),
        grantId: grant.id,
        salonId: foreign.salonId,
      },
    });
    const ghostRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: dateT10009Grant,
        startTime: iso(dateT10009Grant, "08:00"),
        endTime: iso(dateT10009Grant, "16:00"),
        grantId: grant.id,
        salonId: ghost,
      },
    });
    expect(foreignRes.statusCode).toBe(404);
    expect(ghostRes.statusCode).toBe(404);
    expect(foreignRes.body).toBe(ghostRes.body);
    expect(foreignRes.body).toBe('{"error":"Salon nicht gefunden"}');

    const grantAfter = await app.prisma.retroEntryRequest.findUnique({ where: { id: grant.id } });
    expect(grantAfter?.status).toBe("APPROVED");

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(dateT10009Grant) },
    });
    expect(rows).toHaveLength(0);
  });

  it("D-10 zero-state: a grant request with a foreign salon leaves the grant APPROVED and creates no entry", async () => {
    const grant = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: new Date(dateGrantZero),
        reason: "68b-02 grant zero-state fixture",
        status: "APPROVED",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.empToken}` },
      payload: {
        date: dateGrantZero,
        startTime: iso(dateGrantZero, "08:00"),
        endTime: iso(dateGrantZero, "16:00"),
        grantId: grant.id,
        salonId: foreign.salonId,
      },
    });
    expect(res.statusCode).toBe(404);

    const grantAfter = await app.prisma.retroEntryRequest.findUnique({ where: { id: grant.id } });
    expect(grantAfter?.status).toBe("APPROVED");

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(dateGrantZero) },
    });
    expect(rows).toHaveLength(0);
  });

  it("T-100-09 (Zeitnachtrag): a foreign salon and a nonexistent id answer byte-identical 404 on the pending path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const foreignRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: dateT10009Zeitnachtrag,
          startTime: iso(dateT10009Zeitnachtrag, "08:00"),
          endTime: iso(dateT10009Zeitnachtrag, "16:00"),
          reason: "68b-02 T-100-09 Zeitnachtrag fixture",
          salonId: foreign.salonId,
        },
      });
      const ghostRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: dateT10009Zeitnachtrag,
          startTime: iso(dateT10009Zeitnachtrag, "08:00"),
          endTime: iso(dateT10009Zeitnachtrag, "16:00"),
          reason: "68b-02 T-100-09 Zeitnachtrag fixture",
          salonId: ghost,
        },
      });
      expect(foreignRes.statusCode).toBe(404);
      expect(ghostRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(ghostRes.body);
      expect(foreignRes.body).toBe('{"error":"Salon nicht gefunden"}');
    } finally {
      vi.useRealTimers();
    }
  });

  it("D-10 zero-state: a pending Zeitnachtrag with an inactive salon creates neither a RetroEntryRequest nor a TimeEntry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FROZEN_NOW);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          date: dateZeitnachtragZero,
          startTime: iso(dateZeitnachtragZero, "08:00"),
          endTime: iso(dateZeitnachtragZero, "16:00"),
          reason: "68b-02 Zeitnachtrag zero-state fixture",
          salonId: salonX.id,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "Salon ist deaktiviert",
        code: "SALON_INACTIVE",
      });

      const requests = await app.prisma.retroEntryRequest.findMany({
        where: { employeeId: seed.employee.id, targetDate: new Date(dateZeitnachtragZero) },
      });
      expect(requests).toHaveLength(0);
      const rows = await app.prisma.timeEntry.findMany({
        where: { employeeId: seed.employee.id, date: new Date(dateZeitnachtragZero) },
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("D-08: a derived salon that has since been deactivated is still stored as-is (no 400)", async () => {
    // Deactivate A AFTER the earlier Monday/Thursday assertions above — this is the LAST
    // case in this file to rely on A being active.
    await app.prisma.salon.update({
      where: { id: salonA.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries",
        headers: { authorization: `Bearer ${seed.adminToken}` },
        payload: {
          employeeId: seed.employee.id,
          date: mondayDerivedInactive,
          startTime: iso(mondayDerivedInactive, "08:00"),
          endTime: iso(mondayDerivedInactive, "16:00"),
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body) as { entry: { salonId: string } };
      expect(body.entry.salonId).toBe(salonA.id);
    } finally {
      // Restore for any later assertion in this describe block that still expects A active.
      await app.prisma.salon.update({
        where: { id: salonA.id },
        data: { isActive: true, deactivatedAt: null },
      });
    }
  });

  it("D-08: a tenant whose every salon is inactive and whose employee has no assignment answers 409 NO_ACTIVE_SALON, no entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${noneTenant.empToken}` },
      payload: {
        date: dateNoActiveSalon,
        startTime: iso(dateNoActiveSalon, "08:00"),
        endTime: iso(dateNoActiveSalon, "16:00"),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "Kein aktiver Salon vorhanden.",
      code: "NO_ACTIVE_SALON",
    });

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: noneTenant.employee.id },
    });
    expect(rows).toHaveLength(0);
  });

  it("D-07: a sent salonId:null is rejected with 400 Validierungsfehler (null is deliberately not accepted), no entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${seed.adminToken}` },
      payload: {
        employeeId: seed.employee.id,
        date: mondayNullSalon,
        startTime: iso(mondayNullSalon, "08:00"),
        endTime: iso(mondayNullSalon, "16:00"),
        salonId: null,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Validierungsfehler");

    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(mondayNullSalon) },
    });
    expect(rows).toHaveLength(0);
  });
});
