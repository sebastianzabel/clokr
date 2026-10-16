/**
 * Issue #81 (AK-3, AK-5; D-09, D-10, D-11, D-17) — the sum per activity kind is retrievable per
 * employee, salon and period through `GET /api/v1/time-entries/summary`: minutes only, over the
 * saldo's own entry set (T1), narrowed as a whole by an optional salon, with a 404 that does not
 * reveal whether a salon exists in another tenant.
 *
 * Harness copied from `time-entries-summary-79.test.ts`: fake clock 2026-06-15T10:00Z installed
 * BEFORE the app boots. No person names in fixtures.
 *
 * Amended 2026-10-16 for #92 (Phase 92b-04, D-07): the `activityMinutes` object of the body gains
 * the key TRAVEL (value 0 for every entry that is not a travel entry), so `KINDS` and the one exact
 * body assertion name it. Case count unchanged; nothing else is loosened. Travel itself is proven
 * in `time-entries-travel-summary-92.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, grantSystemRole } from "./setup";
import { DEFAULT_SALON_OPENING_HOURS } from "../contexts/platform/facade/salons";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const PASSWORD = "test1234";
const KINDS = ["PRODUCTIVE", "SETUP_CLEANING", "TRAVEL", "UNSPECIFIED"];
const BODY_KEYS = [
  "activityMinutes",
  "breakMinutes",
  "employeeId",
  "entryCount",
  "from",
  "presenceMinutes",
  "to",
  "workingMinutes",
];

type Summary = {
  presenceMinutes: number;
  workingMinutes: number;
  breakMinutes: number;
  entryCount: number;
  activityMinutes: Record<string, number>;
};

describe("Issue #81 — GET /api/v1/time-entries/summary per activity kind", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let foreignSalon: { id: string };

  function uniqueSuffix(label: string): string {
    return `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  // grant: false for a person whose stored assignment is the one the caller adds (no system-role grant).
  async function createEmployee(label: string, grant = true) {
    const s = uniqueSuffix(label);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await app.prisma.user.create({
      data: { email: `${s}@test.de`, passwordHash, role: "EMPLOYEE", isActive: true },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "Activity81",
        hireDate: new Date("2025-01-01"),
      },
    });
    if (grant) {
      await grantSystemRole(app.prisma, {
        tenantId: data.tenant.id,
        userId: user.id,
        role: "EMPLOYEE",
      });
    }
    return { user, employee };
  }

  function createEntry(
    employeeId: string,
    salonId: string,
    date: string,
    opts: {
      start?: string;
      end?: string | null;
      breakMinutes?: number;
      isInvalid?: boolean;
      deletedAt?: Date;
      type?: "WORK" | "OVERTIME";
      activityKind?: "UNSPECIFIED" | "PRODUCTIVE" | "SETUP_CLEANING";
      shares?: { kind: "PRODUCTIVE" | "SETUP_CLEANING"; minutes: number }[];
    } = {},
  ) {
    const end = opts.end === undefined ? "16:00:00Z" : opts.end;
    return app.prisma.timeEntry.create({
      data: {
        employeeId,
        salonId,
        date: new Date(`${date}T00:00:00Z`),
        startTime: new Date(`${date}T${opts.start ?? "08:00:00Z"}`),
        endTime: end === null ? null : new Date(`${date}T${end}`),
        breakMinutes: opts.breakMinutes ?? 0,
        type: opts.type ?? "WORK",
        isInvalid: opts.isInvalid ?? false,
        deletedAt: opts.deletedAt ?? null,
        source: "MANUAL",
        activityKind: opts.activityKind ?? "UNSPECIFIED",
        ...(opts.shares && { activityShares: { create: opts.shares } }),
      },
    });
  }

  async function createScopedUser(
    label: string,
    permissions: string[],
    scope: { scopeType: "SALONS" | "PERSONS"; salonIds?: string[]; employeeIds?: string[] },
  ) {
    const { user } = await createEmployee(label, false);
    const name = `Activity ${crypto.randomBytes(3).toString("hex")}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: data.tenant.id,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(permissions),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        accessRoleId: role.id,
        scopeType: scope.scopeType,
        salonIds: scope.salonIds ?? [],
        employeeIds: scope.employeeIds ?? [],
      },
    });
    return { user };
  }

  async function login(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { accessToken: string }).accessToken;
  }

  function summary(token: string, qs: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/time-entries/summary?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function summaryBody(token: string, qs: string): Promise<Summary> {
    const res = await summary(token, qs);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Summary;
  }

  const kindSum = (b: Summary) =>
    b.activityMinutes.PRODUCTIVE + b.activityMinutes.SETUP_CLEANING + b.activityMinutes.UNSPECIFIED;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));
    app = await getTestApp();
    data = await seedTestData(app, "act81sum");
    otherData = await seedTestData(app, "act81sumb");
    const mkSalon = (tenantId: string, name: string) =>
      app.prisma.salon.create({
        data: {
          tenantId,
          name,
          openingHours: DEFAULT_SALON_OPENING_HOURS,
          isActive: true,
          federalState: "NIEDERSACHSEN",
        },
      });
    salonA = await mkSalon(data.tenant.id, "ACT81 Salon A");
    salonB = await mkSalon(data.tenant.id, "ACT81 Salon B");
    foreignSalon = await mkSalon(otherData.tenant.id, "ACT81 foreign salon");
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("time-entries-activity-summary-81 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("tracer — minutes per kind (AK-3)", () => {
    it("a classified entry: PRODUCTIVE 435, SETUP_CLEANING 60, UNSPECIFIED 0", async () => {
      const { user, employee } = await createEmployee("tracer");
      const entry = await createEntry(employee.id, data.salonId, "2026-06-10", {
        end: "17:00:00Z",
        breakMinutes: 45,
      });
      // Classified through the real write path (PUT, activity-only — D-20).
      const put = await app.inject({
        method: "PUT",
        url: `/api/v1/time-entries/${entry.id}`,
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          activityKind: "PRODUCTIVE",
          activityShares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
        },
      });
      expect(put.statusCode, put.body).toBe(200);

      const body = await summaryBody(
        await login(user.email),
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      expect(body.workingMinutes).toBe(495);
      expect(body.activityMinutes).toEqual({
        PRODUCTIVE: 435,
        SETUP_CLEANING: 60,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
    });

    it("an unclassified period is entirely UNSPECIFIED", async () => {
      const { employee } = await createEmployee("unclassified");
      await createEntry(employee.id, data.salonId, "2026-06-02", { breakMinutes: 30 });
      const body = await summaryBody(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      expect(body.activityMinutes).toEqual({
        PRODUCTIVE: 0,
        SETUP_CLEANING: 0,
        TRAVEL: 0,
        UNSPECIFIED: body.workingMinutes,
      });
    });

    it("invalid, open, deleted and non-WORK entries contribute to no kind", async () => {
      const { employee } = await createEmployee("excluded");
      const sid = data.salonId;
      await createEntry(employee.id, sid, "2026-06-02", { activityKind: "PRODUCTIVE" });
      for (const [date, extra] of [
        ["2026-06-03", { isInvalid: true }],
        ["2026-06-04", { end: null }],
        ["2026-06-05", { deletedAt: new Date() }],
        ["2026-06-08", { type: "OVERTIME" as const }],
      ] as const) {
        await createEntry(employee.id, sid, date, { activityKind: "SETUP_CLEANING", ...extra });
      }
      const body = await summaryBody(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      expect(body.entryCount).toBe(1);
      expect(body.activityMinutes).toEqual({
        PRODUCTIVE: 480,
        SETUP_CLEANING: 0,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
    });
  });

  describe("salon filter over the whole body (D-17) and the identical 404 (D-09)", () => {
    let emp: { id: string; email: string };

    beforeAll(async () => {
      const { user, employee } = await createEmployee("salons");
      emp = { id: employee.id, email: user.email };
      await createEntry(employee.id, salonA.id, "2026-06-08", { activityKind: "PRODUCTIVE" });
      await createEntry(employee.id, salonA.id, "2026-06-09", {
        breakMinutes: 30,
        activityKind: "SETUP_CLEANING",
      });
      await createEntry(employee.id, salonB.id, "2026-06-10", {
        activityKind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 100 }],
      });
    });

    const range = "from=2026-06-01&to=2026-06-30";

    it("salonId narrows every figure; Σ activityMinutes = workingMinutes", async () => {
      const a = await summaryBody(
        data.adminToken,
        `employeeId=${emp.id}&${range}&salonId=${salonA.id}`,
      );
      expect(a.entryCount).toBe(2);
      expect(a.presenceMinutes).toBe(960);
      expect(a.workingMinutes).toBe(930);
      expect(a.breakMinutes).toBe(30);
      expect(a.activityMinutes).toEqual({
        PRODUCTIVE: 480,
        SETUP_CLEANING: 450,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
      expect(kindSum(a)).toBe(a.workingMinutes);

      const all = await summaryBody(data.adminToken, `employeeId=${emp.id}&${range}`);
      expect(all.entryCount).toBe(3);
      expect(all.activityMinutes).toEqual({
        PRODUCTIVE: 860,
        SETUP_CLEANING: 550,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
      expect(kindSum(all)).toBe(all.workingMinutes);
    });

    it("a foreign tenant's salon and an unknown id answer byte-identical 404 bodies; a malformed id is 400", async () => {
      const foreign = await summary(
        data.adminToken,
        `employeeId=${emp.id}&${range}&salonId=${foreignSalon.id}`,
      );
      const unknown = await summary(
        data.adminToken,
        `employeeId=${emp.id}&${range}&salonId=${crypto.randomUUID()}`,
      );
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(foreign.body).toBe(unknown.body);
      expect(JSON.parse(foreign.body)).toEqual({ error: "Salon nicht gefunden" });

      const malformed = await summary(data.adminToken, `employeeId=${emp.id}&${range}&salonId=abc`);
      expect(malformed.statusCode).toBe(400);
    });

    it("a deactivated salon stays reportable", async () => {
      await app.prisma.salon.update({ where: { id: salonB.id }, data: { isActive: false } });
      try {
        const b = await summaryBody(
          data.adminToken,
          `employeeId=${emp.id}&${range}&salonId=${salonB.id}`,
        );
        expect(b.entryCount).toBe(1);
        expect(b.activityMinutes).toEqual({
          PRODUCTIVE: 380,
          SETUP_CLEANING: 100,
          TRAVEL: 0,
          UNSPECIFIED: 0,
        });
      } finally {
        await app.prisma.salon.update({ where: { id: salonB.id }, data: { isActive: true } });
      }
    });

    it("the employee's own summary accepts salonId; a SALONS-scoped manager outside the salon gets zeros", async () => {
      const own = await summaryBody(
        await login(emp.email),
        `employeeId=${emp.id}&${range}&salonId=${salonA.id}`,
      );
      expect(own.entryCount).toBe(2);

      const mgr = await createScopedUser("mgr-a", ["time-entry:read:ZUGEWIESEN"], {
        scopeType: "SALONS",
        salonIds: [salonA.id],
      });
      const scoped = await summaryBody(
        await login(mgr.user.email),
        `employeeId=${emp.id}&${range}&salonId=${salonB.id}`,
      );
      expect(scoped.entryCount).toBe(0);
      expect(scoped.workingMinutes).toBe(0);
      expect(scoped.activityMinutes).toEqual({
        PRODUCTIVE: 0,
        SETUP_CLEANING: 0,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
    });
  });

  describe("rounding and the minutes-only shape (D-10, AK-5)", () => {
    it("millisecond precision: the three kinds sum to workingMinutes within one rounding step", async () => {
      const { employee } = await createEmployee("ms");
      await createEntry(employee.id, data.salonId, "2026-06-11", {
        start: "07:58:20Z",
        end: "16:31:00Z",
        breakMinutes: 37,
        activityKind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
      });
      const body = await summaryBody(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      expect(Math.abs(kindSum(body) - body.workingMinutes)).toBeLessThanOrEqual(1);
    });

    it("the body carries times only: fixed key set, integer values, no amount or ratio anywhere", async () => {
      const { employee } = await createEmployee("shape");
      await createEntry(employee.id, data.salonId, "2026-06-12", {
        end: "17:00:00Z",
        breakMinutes: 45,
        activityKind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
      });
      const res = await summary(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      const body = JSON.parse(res.body) as Record<string, unknown> & Summary;
      expect(body).toEqual({
        employeeId: employee.id,
        from: "2026-06-01",
        to: "2026-06-30",
        presenceMinutes: 540,
        workingMinutes: 495,
        breakMinutes: 45,
        entryCount: 1,
        activityMinutes: { PRODUCTIVE: 435, SETUP_CLEANING: 60, TRAVEL: 0, UNSPECIFIED: 0 },
      });
      expect(Object.keys(body).sort()).toEqual(BODY_KEYS);
      expect(Object.keys(body.activityMinutes).sort()).toEqual([...KINDS].sort());
      for (const v of Object.values(body.activityMinutes)) expect(Number.isInteger(v)).toBe(true);
      const forbidden = /(rate|ratio|percent|quot|amount|betrag|euro|kennzahl|score)/i;
      const keys: string[] = [];
      const walk = (o: unknown) => {
        if (o && typeof o === "object") {
          for (const [k, v] of Object.entries(o)) {
            keys.push(k);
            walk(v);
          }
        }
      };
      walk(body);
      expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
    });

    // Plan-checker W1: the legacy REOPEN corner of 81-03 can leave Σ shares > working minutes in
    // storage. The evaluation reports that as-is — a decision, not an accident: no clamp, still 200.
    it("a stored over-allocation is reported as a negative remainder, never clamped", async () => {
      const { employee } = await createEmployee("negative");
      // Constructed by direct Prisma write (the API refuses it): 480 working, shares 500.
      await createEntry(employee.id, data.salonId, "2026-06-12", {
        activityKind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 500 }],
      });
      const body = await summaryBody(
        data.adminToken,
        `employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
      );
      expect(body.activityMinutes).toEqual({
        PRODUCTIVE: -20,
        SETUP_CLEANING: 500,
        TRAVEL: 0,
        UNSPECIFIED: 0,
      });
      expect(kindSum(body)).toBe(body.workingMinutes);
    });
  });

  describe("list items expose kind and shares (D-11)", () => {
    it("GET /time-entries returns activityKind and activityShares in the write shape", async () => {
      const { user, employee } = await createEmployee("list");
      const classified = await createEntry(employee.id, data.salonId, "2026-06-03", {
        end: "17:00:00Z",
        breakMinutes: 45,
        activityKind: "PRODUCTIVE",
        shares: [{ kind: "SETUP_CLEANING", minutes: 60 }],
      });
      const plain = await createEntry(employee.id, data.salonId, "2026-06-04");
      for (const token of [data.adminToken, await login(user.email)]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/time-entries?employeeId=${employee.id}&from=2026-06-01&to=2026-06-30`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode, res.body).toBe(200);
        const items = JSON.parse(res.body) as Array<{
          id: string;
          activityKind: string;
          activityShares: Array<Record<string, unknown>>;
        }>;
        const c = items.find((i) => i.id === classified.id)!;
        expect(c.activityKind).toBe("PRODUCTIVE");
        expect(c.activityShares).toEqual([{ kind: "SETUP_CLEANING", minutes: 60 }]);
        expect(Object.keys(c.activityShares[0]).sort()).toEqual(["kind", "minutes"]);
        const p = items.find((i) => i.id === plain.id)!;
        expect(p.activityKind).toBe("UNSPECIFIED");
        expect(p.activityShares).toEqual([]);
      }
    });
  });
});
