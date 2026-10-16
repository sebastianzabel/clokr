/**
 * Issue #613 (Phase 613, plan 01) — one population rule for the period reports.
 *
 * Tenant time zone Europe/Berlin, clock faked to 2026-11-18T10:00:00Z (only `Date`). Persons
 * around the CEST boundary 30.09. and the CET boundary 31.10.:
 *   E1  exit 2026-09-30T00:00:00Z (the shape PATCH /employees writes)
 *   E2  exit 2026-09-29T22:00:00Z (tenant-local midnight of 30.09.)
 *   D   login deactivated, no exit date (the Elternzeit case)
 *   A   anonymised sentinel, no exit date
 *   H   hired 2026-10-01T00:00:00Z
 *   C   exit 2026-10-31T00:00:00Z (CET boundary October -> November)
 * No person names, no real e-mails (synthetic fixture).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData, reissueTokenNow } from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

const FAKE_NOW = new Date("2026-11-18T10:00:00Z");

type Persons = Record<"E1" | "E2" | "D" | "A" | "H" | "C", PopulationPerson>;

describe("Issue #613 — the period population", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let p: Persons;

  /** Runs `fn` with the faked clock and a token valid under it. */
  async function withClock<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    try {
      return await fn(reissueTokenNow(app, token));
    } finally {
      vi.useRealTimers();
    }
  }

  async function getJson<T>(url: string, token = d.adminToken) {
    return withClock(token, async (t) => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${t}` },
      });
      return { status: res.statusCode, body: JSON.parse(res.body) as T };
    });
  }

  async function monthlyIds(year: number, month: number, extra = "", token = d.adminToken) {
    const res = await getJson<{ rows: Array<{ employeeId: string }> }>(
      `/api/v1/reports/monthly?year=${year}&month=${month}${extra}`,
      token,
    );
    expect(res.status).toBe(200);
    return res.body.rows.map((r) => r.employeeId);
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "pop613");
    const base = { tenantId: d.tenant.id, salonId: d.salonId };
    const hire = new Date("2025-01-01T00:00:00.000Z");
    p = {
      E1: await createPopulationPerson(app, {
        ...base,
        tag: "e1",
        hireDate: hire,
        exitDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
      E2: await createPopulationPerson(app, {
        ...base,
        tag: "e2",
        hireDate: hire,
        exitDate: new Date("2026-09-29T22:00:00.000Z"),
      }),
      D: await createPopulationPerson(app, {
        ...base,
        tag: "d",
        hireDate: hire,
        loginActive: false,
      }),
      A: await createPopulationPerson(app, {
        ...base,
        tag: "a",
        hireDate: hire,
        anonymized: true,
      }),
      H: await createPopulationPerson(app, {
        ...base,
        tag: "h",
        hireDate: new Date("2026-10-01T00:00:00.000Z"),
      }),
      C: await createPopulationPerson(app, {
        ...base,
        tag: "c",
        hireDate: hire,
        exitDate: new Date("2026-10-31T00:00:00.000Z"),
      }),
    };
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("monthly report JSON", () => {
    it("September lists E1, E2, D, C and neither A nor H", async () => {
      const ids = await monthlyIds(2026, 9);
      expect(ids).toEqual(
        expect.arrayContaining([p.E1.employeeId, p.E2.employeeId, p.D.employeeId, p.C.employeeId]),
      );
      expect(ids).not.toContain(p.A.employeeId);
      expect(ids).not.toContain(p.H.employeeId);
    });

    it("October lists D, H, C and neither E1, E2 nor A", async () => {
      const ids = await monthlyIds(2026, 10);
      expect(ids).toEqual(expect.arrayContaining([p.D.employeeId, p.H.employeeId, p.C.employeeId]));
      for (const gone of [p.E1, p.E2, p.A]) expect(ids).not.toContain(gone.employeeId);
    });

    it("November lists D and H and not C (CET boundary)", async () => {
      const ids = await monthlyIds(2026, 11);
      expect(ids).toEqual(expect.arrayContaining([p.D.employeeId, p.H.employeeId]));
      expect(ids).not.toContain(p.C.employeeId);
    });

    it("an explicit employeeId follows the same population", async () => {
      expect(await monthlyIds(2026, 9, `&employeeId=${p.E1.employeeId}`)).toEqual([
        p.E1.employeeId,
      ]);
      const october = await getJson<{ rows: unknown[] }>(
        `/api/v1/reports/monthly?year=2026&month=10&employeeId=${p.E1.employeeId}`,
      );
      expect(october.status).toBe(200);
      expect(october.body.rows).toEqual([]);
      for (const month of [9, 10]) {
        const anonymised = await getJson<{ rows: unknown[] }>(
          `/api/v1/reports/monthly?year=2026&month=${month}&employeeId=${p.A.employeeId}`,
        );
        expect(anonymised.body.rows).toEqual([]);
      }
    });

    it("a Stammsalon-scoped caller combines scope and population in one AND", async () => {
      const manager = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        tag: "mgr",
        hireDate: new Date("2024-01-01T00:00:00.000Z"),
      });
      const roleName = `Pop613 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: d.tenant.id,
          name: roleName,
          nameKey: roleNameKey(roleName),
          permissions: normalizeRolePermissions(["report:read:ZUGEWIESEN"]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: d.tenant.id,
          userId: manager.userId,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [d.salonId],
          employeeIds: [],
        },
      });
      const token = app.jwt.sign({
        sub: manager.userId,
        tenantId: d.tenant.id,
        employeeId: manager.employeeId,
      });
      const september = await monthlyIds(2026, 9, "", token);
      expect(september).toContain(p.E1.employeeId);
      expect(september).not.toContain(p.A.employeeId);
      const october = await monthlyIds(2026, 10, "", token);
      expect(october).not.toContain(p.E1.employeeId);
      expect(october).toContain(p.H.employeeId);
    });
  });
});
