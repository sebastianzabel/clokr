/**
 * Issue #82 (AK-5, AK-6; D-05, D-06) — a manipulated salon context yields no foreign data. The
 * salon context of the web is comfort and presentation only (DSGVO Art. 32: the access boundary is
 * enforced server-side). "Manipulated" here means the frontend sends a `salonId` it should not
 * have — a salon outside the caller's scope, a salon of another tenant, or an id that exists
 * nowhere — and the server must not care what the frontend believes.
 *
 * Fixture: manager M holds SALONS [A] (system template Salonmanager); employee E belongs to salon
 * B (Stammsalon B) and worked one day in A. E's Stammsalon is B on purpose: a manager scoped on A
 * legitimately sees the entries of an A-Stammsalon employee in another salon (91b D-09), so only
 * an employee of B makes B's data truly foreign to M. E has no DEPLOYMENT in A for the same reason
 * on the planning side (an active deployment in A would put E into M's plannable staff, 91b D-12).
 * A tenant-wide admin sends the same requests as the control: the data exists, the zero for M is
 * the scope, not an empty fixture.
 *
 * Mutation proof (Phase 82, 2026-10-12) — recorded here, not re-run by CI; each change was
 * reverted after confirming the observed failures:
 * M1 summary scope filter disabled (`if (isManager && false)`) → red: "summary with salonId=B
 *    returns nothing from B for the manager" (M saw 300 min of B).
 * M2 planning-overview trusts the client salon (`homeIds` instead of the intersection with the
 *    person reach) → red: "planning-overview for salonId=B lists no row for E …".
 * M3 summary salon lookup without tenant (`salon.findUnique({ where: { id } })`) → red: "a foreign
 *    tenant's salon and an unknown id are indistinguishable …" (F answered 200).
 * M4 planning-overview HOME query and candidate query without `tenantId` → red: the same T-100-09
 *    test (F listed the foreign employee's row).
 * M5 `contextSalonIds` treats a SALONS row like TENANT → red: "the manager's own context lists
 *    only salon A …" (B appeared).
 *
 * Amendment Issue #558 D-07 (2026-10-16) — hardening, not a weakening: `planning-overview` now
 * validates `salonId` like every other view endpoint (`resolveSalonInReach`), so a salon outside
 * the reach, a foreign tenant's salon, an inactive salon and an unknown id answer the identical 404
 * instead of 200 + []; the T-100-09 property (foreign == unknown, byte-identical) is kept and
 * strengthened. Changed assertions: manager-for-B 200 → 404; foreign/unknown 200 → 404 (status,
 * body and the literal body). Mutation proofs M2/M4 above describe the Phase-82 code; the #558
 * proofs are M6/M7 below (recorded 2026-10-16, not re-run by CI):
 * M6 the new validator removed from `planning-overview` (`if (!planningSalon.ok) return …`
 *    commented out) → red: "planning-overview for salonId=B answers 404 for the manager; the admin
 *    sees E" and "a foreign tenant's salon and an unknown id are indistinguishable on both
 *    endpoints (T-100-09)" (here), plus the 430-05 "a salon-A-only planner …" case and the 558
 *    "an inactive salon answers the identical 404 for admin and manager" case.
 * M7 the caller's `reach` passed to `resolveStammsalonScopedEmployeeIds` instead of
 *    `salonOnlyReach(chosen)` → red: "salonId query param narrows to that salon's employees only;
 *    omitted -> all salons in scope" (shifts-planning-overview.test.ts; an admin's whole-tenant
 *    reach narrows to no salon).
 *
 * Harness: fake clock 2026-06-15T10:00Z installed BEFORE the app boots. No person names in
 * fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";
const MONTH = "from=2026-06-01&to=2026-06-30";
const WEEK = "weekStart=2026-06-08";

describe("Issue #82 — a manipulated salon context yields no foreign data", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonF: { id: string };
  let employeeE: { id: string };
  let managerToken: string;

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, tenantId: string, shiftBased = false) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Ctx82m",
        hireDate: new Date("2024-01-01"),
      },
    });
    if (shiftBased) {
      await app.prisma.workSchedule.create({
        data: {
          employeeId: employee.id,
          type: "SHIFT_BASED",
          weeklyHours: 32,
          contractWorkDaysPerWeek: 5,
          validFrom: new Date("2025-01-01"),
        },
      });
    }
    return { user, employee };
  }

  function home(tenantId: string, employeeId: string, salonId: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: new Date("2024-01-01T00:00:00Z"),
        validUntil: null,
      },
    });
  }

  function entry(employeeId: string, salonId: string, date: string, end: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T08:00:00Z`),
        endTime: new Date(`${date}T${end}:00Z`),
        breakMinutes: 0,
        type: "WORK",
        source: "MANUAL",
      },
    });
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  async function summary(token: string, salonId?: string) {
    const qs = `employeeId=${employeeE.id}&${MONTH}${salonId ? `&salonId=${salonId}` : ""}`;
    const res = await get(token, `/api/v1/time-entries/summary?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as { entryCount: number; workingMinutes: number };
  }

  function planning(token: string, salonId: string) {
    return get(token, `/api/v1/shifts/planning-overview?${WEEK}&salonId=${salonId}`);
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "ctx82m");
    foreign = await seedTestData(app, "ctx82n");
    salonA = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Nord" });
    salonB = await createTestSalon(app.prisma, data.tenant.id, { name: "Salon Ost" });
    salonF = await createTestSalon(app.prisma, foreign.tenant.id, { name: "Salon Fremd" });

    const manager = await createEmployee("manager", data.tenant.id);
    await home(data.tenant.id, manager.employee.id, salonA.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: manager.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds: [salonA.id],
        employeeIds: [],
      },
    });
    managerToken = await login(manager.user.email);

    const e = await createEmployee("employeeE", data.tenant.id, true);
    employeeE = e.employee;
    await home(data.tenant.id, employeeE.id, salonB.id);
    await entry(employeeE.id, salonA.id, "2026-06-10", "12:00"); // 240 min in A
    await entry(employeeE.id, salonB.id, "2026-06-11", "13:00"); // 300 min in B
    await app.prisma.shift.create({
      data: {
        employeeId: employeeE.id,
        salonId: salonB.id,
        date: new Date("2026-06-09T00:00:00Z"),
        startTime: "09:00",
        endTime: "17:00",
      },
    });

    // A foreign SHIFT_BASED employee with Stammsalon F: makes the foreign-vs-unknown identity on
    // planning-overview non-vacuous (a missing tenant filter would list this row for salonId=F).
    const ef = await createEmployee("employeeF", foreign.tenant.id, true);
    await home(foreign.tenant.id, ef.employee.id, salonF.id);
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("salon-context-manipulation-82 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("the manager's own context lists only salon A — never B, never F", async () => {
    const res = await get(managerToken, "/api/v1/me/context");
    expect(res.statusCode, res.body).toBe(200);
    const ids = (JSON.parse(res.body) as { salons: { id: string }[] }).salons.map((s) => s.id);
    expect(ids).toEqual([salonA.id]);
    expect(ids).not.toContain(salonB.id);
    expect(ids).not.toContain(salonF.id);
  });

  it("summary with salonId=B returns nothing from B for the manager", async () => {
    expect(await summary(managerToken, salonB.id)).toMatchObject({
      entryCount: 0,
      workingMinutes: 0,
    });
    // The zero is the scope, not a missing reach: M does see E's entry in its own salon A.
    expect(await summary(managerToken, salonA.id)).toMatchObject({
      entryCount: 1,
      workingMinutes: 240,
    });
  });

  it("control: a tenant-wide admin sees B's data with the same request", async () => {
    expect(await summary(data.adminToken, salonB.id)).toMatchObject({
      entryCount: 1,
      workingMinutes: 300,
    });
    expect(await summary(data.adminToken)).toMatchObject({ entryCount: 2, workingMinutes: 540 });
  });

  it("planning-overview for salonId=B answers 404 for the manager; the admin sees E", async () => {
    // Amendment Issue #558 D-07: was 200 + [] — a salon outside the reach is now the one 404.
    const managerRes = await planning(managerToken, salonB.id);
    expect(managerRes.statusCode, managerRes.body).toBe(404);
    expect(managerRes.body).toBe('{"error":"Salon nicht gefunden"}');
    expect(managerRes.body).not.toContain(employeeE.id);

    const adminRes = await planning(data.adminToken, salonB.id);
    expect(adminRes.statusCode, adminRes.body).toBe(200);
    const adminRow = (
      JSON.parse(adminRes.body) as { employees: { employeeId: string; plannedDays?: number }[] }
    ).employees.find((r) => r.employeeId === employeeE.id);
    expect(adminRow?.plannedDays).toBe(1);
  });

  it("a foreign tenant's salon and an unknown id are indistinguishable on both endpoints (T-100-09)", async () => {
    for (const token of [managerToken, data.adminToken]) {
      const unknown = randomUUID();
      const sumForeign = await get(
        token,
        `/api/v1/time-entries/summary?employeeId=${employeeE.id}&${MONTH}&salonId=${salonF.id}`,
      );
      const sumUnknown = await get(
        token,
        `/api/v1/time-entries/summary?employeeId=${employeeE.id}&${MONTH}&salonId=${unknown}`,
      );
      expect(sumForeign.statusCode).toBe(404);
      expect(sumForeign.statusCode).toBe(sumUnknown.statusCode);
      expect(sumForeign.body).toBe('{"error":"Salon nicht gefunden"}');
      expect(sumForeign.body).toBe(sumUnknown.body);

      // Amendment Issue #558 D-07: both planning requests are the 404 now (was 200 + the same body).
      const planForeign = await planning(token, salonF.id);
      const planUnknown = await planning(token, unknown);
      expect(planForeign.statusCode).toBe(404);
      expect(planForeign.statusCode).toBe(planUnknown.statusCode);
      expect(planForeign.body).toBe('{"error":"Salon nicht gefunden"}');
      expect(planForeign.body).toBe(planUnknown.body);
    }
  });

  describe("D-05 tripwire: no production code reads a salon from a header, cookie or session", () => {
    /**
     * Scope: every non-test `.ts` file under apps/api/src; comment lines are skipped so prose may
     * explain the rule. Floor: 213 files were measured at 47cfcfbf; 180 keeps a margin for
     * deletions and still turns red when the walk silently covers a fraction of the tree. Blind
     * spot: a salon value read through a renamed intermediate (e.g. a helper returning a header by
     * key) is not seen — the tripwire stops re-growth, it does not prove absence.
     */
    const isHit = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return false;
      }
      return /(headers|cookie|session)/i.test(line) && /salon/i.test(line);
    };

    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
        return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
      });
    }

    it("the matcher flags the forbidden shapes and skips comments and plain parameters", () => {
      expect(isHit('const id = req.headers["x-salon-id"];')).toBe(true);
      expect(isHit('reply.setCookie("salon", id)')).toBe(true);
      expect(isHit('const salonId = req.cookies["salon"];')).toBe(true);
      expect(isHit("// headers carry no salon")).toBe(false);
      expect(isHit("const salonId = q.salonId;")).toBe(false);
    });

    it("finds no hit in at least 180 production files", () => {
      const root = join(__dirname, "..");
      expect(existsSync(join(root, "app.ts"))).toBe(true);
      const files = walk(root);
      expect(files).toContain(join(root, "app.ts"));
      expect(files.length).toBeGreaterThanOrEqual(180);
      const hits = files.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter((l) => isHit(l.text)),
      );
      expect(hits).toEqual([]);
    });
  });
});
