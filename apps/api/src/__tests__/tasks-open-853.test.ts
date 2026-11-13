/**
 * Issue #853 (Phase 853-18, D-853-21a/22/23) — `GET /api/v1/tasks/open`, the read-only work queue
 * of the Aufgaben page. Today it answers one task type, `ausstempeln` (a missing clock-out: a
 * non-deleted WORK entry without an end on a tenant-local day before today, at most 62 days back),
 * and only for entries inside the caller's `time-entry:read` reach (the Unterbau's per-entry rule,
 * Issue #85).
 *
 * Fixture: salons A and B of one tenant, A1 homed in A and B1 homed in B, each with an open entry
 * three days ago. Noise that must never become a task: a closed entry, a soft-deleted open entry,
 * today's running entry, an open entry older than the window, and a foreign tenant's open entry.
 * MA holds SALONS [A], MB SALONS [B]; the tenant admin is the whole-tenant control. No person
 * names in fixtures.
 *
 * D-853-23 state: #599's Arbeitszeitkonto facade export for open Zeitkorrektur-Anfragen is not on
 * the base branch, so the type `zeitkorrektur` is absent; the `types` case pins exactly that.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";
import {
  addDaysUtc,
  dateStrInTz,
  getTenantTimezone,
  timeStrInTz,
  todayInTz,
} from "../contexts/working-time-account";

const PASSWORD = "test1234";

interface Task {
  type: string;
  id: string;
  employeeId: string;
  personName: string;
  day: string;
  startTime?: string;
  label: string;
  link: string;
}
interface OpenTasksBody {
  types: string[];
  tasks: Task[];
}

describe("Issue #853 (Phase 853-18) — GET /api/v1/tasks/open", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;
  let empA1: { id: string };
  let empB1: { id: string };
  let tokenMA: string;
  let tokenMB: string;
  let threeDaysAgo: string;
  let tz: string;
  const entryIds: Record<string, string> = {};

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  async function createEmployee(label: string, lastName: string, tenantId: string) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName,
        hireDate: new Date("2024-01-01T00:00:00Z"),
      },
    });
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

  async function entry(
    key: string,
    employeeId: string,
    salonId: string,
    day: string,
    opts: { open: boolean; deleted?: boolean },
  ) {
    const row = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T08:00:00Z`),
        endTime: opts.open ? null : new Date(`${day}T16:00:00Z`),
        type: "WORK",
        source: "MANUAL",
        ...(opts.deleted ? { deletedAt: new Date() } : {}),
      },
    });
    entryIds[key] = row.id;
    return row;
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

  async function salonManager(label: string, salonIds: string[]): Promise<string> {
    const m = await createEmployee(label, "Mgr853", data.tenant.id);
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: m.user.id,
        accessRoleId: SYSTEM_ROLE_IDS.SALON_MANAGER,
        scopeType: "SALONS",
        salonIds,
        employeeIds: [],
      },
    });
    return login(m.user.email);
  }

  function open(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/tasks/open",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function dayOffset(n: number): string {
    return dateStrInTz(addDaysUtc(todayInTz(tz), n), "UTC");
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "to853t");
    foreign = await seedTestData(app, "to853f");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "TO853 B" })).id;
    const tenantId = data.tenant.id;
    tz = await getTenantTimezone(app.prisma, tenantId);
    threeDaysAgo = dayOffset(-3);

    // Names sort A1 before B1 (last name) only where the day ties; the days differ below.
    const a1 = await createEmployee("Aone", "Aa853", tenantId);
    empA1 = a1.employee;
    await home(tenantId, empA1.id, salonA);
    const b1 = await createEmployee("Bone", "Bb853", tenantId);
    empB1 = b1.employee;
    await home(tenantId, empB1.id, salonB);

    await entry("A1_open", empA1.id, salonA, threeDaysAgo, { open: true });
    await entry("B1_open", empB1.id, salonB, dayOffset(-4), { open: true });
    // Noise: never a task.
    await entry("A1_closed", empA1.id, salonA, dayOffset(-2), { open: false });
    await entry("A1_deleted", empA1.id, salonA, dayOffset(-6), { open: true, deleted: true });
    await entry("A1_today", empA1.id, salonA, dayOffset(0), { open: true });
    await entry("B1_old", empB1.id, salonB, dayOffset(-70), { open: true });

    // A foreign tenant's open entry three days ago.
    const f = await createEmployee("Fone", "Ff853", foreign.tenant.id);
    await entry("F_open", f.employee.id, foreign.salonId, threeDaysAgo, { open: true });

    tokenMA = await salonManager("MgrA", [salonA]);
    tokenMB = await salonManager("MgrB", [salonB]);
  });

  afterAll(async () => {
    try {
      await app.prisma.roleAssignment.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("tasks-open-853 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("MA (SALONS [A]): exactly A1's missing clock-out, in the documented shape", async () => {
    const res = await open(tokenMA);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as OpenTasksBody;
    expect(body.tasks).toEqual([
      {
        type: "ausstempeln",
        id: entryIds.A1_open,
        employeeId: empA1.id,
        personName: "Aone Aa853",
        day: threeDaysAgo,
        startTime: timeStrInTz(new Date(`${threeDaysAgo}T08:00:00Z`), tz),
        label: "Ausstempeln fehlt",
        link: `/team/zeiten?employeeId=${empA1.id}&date=${threeDaysAgo}`,
      },
    ]);
  });

  it("MB (SALONS [B]): only B1's task, never salon A's", async () => {
    const res = await open(tokenMB);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as OpenTasksBody;
    expect(body.tasks.map((t) => t.id)).toEqual([entryIds.B1_open]);
    expect(body.tasks[0]?.employeeId).toBe(empB1.id);
  });

  it("admin (whole tenant): both open entries of the window, oldest day first", async () => {
    const res = await open(data.adminToken);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as OpenTasksBody;
    // B1 (4 days ago) before A1 (3 days ago).
    expect(body.tasks.map((t) => t.id)).toEqual([entryIds.B1_open, entryIds.A1_open]);
  });

  it("noise never becomes a task: closed, soft-deleted, today's running and out-of-window entries", async () => {
    const res = await open(data.adminToken);
    const ids = (JSON.parse(res.body) as OpenTasksBody).tasks.map((t) => t.id);
    for (const noise of ["A1_closed", "A1_deleted", "A1_today", "B1_old"]) {
      expect(ids, noise).not.toContain(entryIds[noise]);
    }
  });

  it("another tenant's open entry never appears, in either direction", async () => {
    const own = JSON.parse((await open(data.adminToken)).body) as OpenTasksBody;
    expect(own.tasks.map((t) => t.id)).not.toContain(entryIds.F_open);

    const theirs = JSON.parse((await open(foreign.adminToken)).body) as OpenTasksBody;
    expect(theirs.tasks.map((t) => t.id)).toEqual([entryIds.F_open]);
  });

  it("a caller without time-entry:read:ZUGEWIESEN (plain employee) gets 403", async () => {
    const res = await open(data.empToken);
    expect(res.statusCode, res.body).toBe(403);
  });

  it("an unauthenticated request gets 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/tasks/open" });
    expect(res.statusCode).toBe(401);
  });

  it("types: exactly the ausstempeln type today (#599's zeitkorrektur export is not on the base branch)", async () => {
    for (const token of [tokenMA, tokenMB, data.adminToken]) {
      const body = JSON.parse((await open(token)).body) as OpenTasksBody;
      expect(body.types).toEqual(["ausstempeln"]);
    }
  });
});
