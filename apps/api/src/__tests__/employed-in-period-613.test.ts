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
import iconv from "iconv-lite";
import * as pdfModule from "../composition/pdf";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
  configureDatevKanzlei,
} from "./setup";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";

// Spy that still calls through: the company PDF only exposes its rows by feeding them into pdfkit,
// which compresses its content streams, so the test reads the payload the route built.
vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    streamCompanyMonthlyReportPdf: vi.fn(actual.streamCompanyMonthlyReportPdf),
  };
});

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
  describe("monthly PDFs", () => {
    async function companyPdfNumbers(year: number, month: number, extra = ""): Promise<string[]> {
      const spy = vi.mocked(pdfModule.streamCompanyMonthlyReportPdf);
      spy.mockClear();
      const res = await withClock(d.adminToken, (t) =>
        app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly/pdf/all?year=${year}&month=${month}${extra}`,
          headers: { authorization: `Bearer ${t}` },
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0][1].rows.map((r) => r.employeeNumber);
    }

    async function singlePdf(employeeId: string, month: number, token = d.adminToken) {
      return withClock(token, (t) =>
        app.inject({
          method: "GET",
          url: `/api/v1/reports/monthly/pdf?employeeId=${employeeId}&year=2026&month=${month}`,
          headers: { authorization: `Bearer ${t}` },
        }),
      );
    }

    it("the company PDF of September lists E1, E2, D, C and neither A nor H", async () => {
      const numbers = await companyPdfNumbers(2026, 9);
      expect(numbers).toEqual(
        expect.arrayContaining([
          p.E1.employeeNumber,
          p.E2.employeeNumber,
          p.D.employeeNumber,
          p.C.employeeNumber,
        ]),
      );
      expect(numbers).not.toContain(p.A.employeeNumber);
      expect(numbers).not.toContain(p.H.employeeNumber);
    });

    it("the company PDF of October lists D, H, C and neither E1, E2 nor A", async () => {
      const numbers = await companyPdfNumbers(2026, 10);
      expect(numbers).toEqual(
        expect.arrayContaining([p.D.employeeNumber, p.H.employeeNumber, p.C.employeeNumber]),
      );
      for (const gone of [p.E1, p.E2, p.A]) expect(numbers).not.toContain(gone.employeeNumber);
    });

    it("the compat role filter of the company PDF still narrows", async () => {
      const manager = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        tag: "pdfmgr",
        hireDate: new Date("2025-01-01T00:00:00.000Z"),
        userRole: "MANAGER",
      });
      const numbers = await companyPdfNumbers(2026, 9, "&role=MANAGER");
      expect(numbers).toContain(manager.employeeNumber);
      expect(numbers).not.toContain(p.E1.employeeNumber);
      expect(numbers).not.toContain(p.D.employeeNumber);
    });

    it("the single PDF answers for a person in the month and 404s outside it", async () => {
      const september = await singlePdf(p.E1.employeeId, 9);
      expect(september.statusCode).toBe(200);
      expect(String(september.headers["content-type"])).toContain("application/pdf");

      const october = await singlePdf(p.E1.employeeId, 10);
      const unknown = await singlePdf(crypto.randomUUID(), 10);
      expect(october.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      // Byte-identical: "exists, but not in this month" cannot be told from "unknown".
      expect(october.body).toBe(unknown.body);
      expect(october.body).toBe(JSON.stringify({ error: "Mitarbeiter nicht gefunden" }));
    });

    it("the single PDF of an anonymised person is the unknown-id 404 in any month", async () => {
      const unknown = await singlePdf(crypto.randomUUID(), 9);
      for (const month of [9, 10]) {
        const res = await singlePdf(p.A.employeeId, month);
        expect(res.statusCode).toBe(404);
        expect(res.body).toBe(unknown.body);
      }
    });

    it("the self download follows the same population", async () => {
      const own = app.jwt.sign({
        sub: p.E1.userId,
        tenantId: d.tenant.id,
        employeeId: p.E1.employeeId,
      });
      expect((await singlePdf(p.E1.employeeId, 9, own)).statusCode).toBe(200);
      expect((await singlePdf(p.E1.employeeId, 10, own)).statusCode).toBe(404);
      // The 403 before it is unchanged: someone else's PDF stays refused for an employee.
      expect((await singlePdf(p.D.employeeId, 9, own)).statusCode).toBe(403);
    });
  });
  describe("DATEV keeps the employment core", () => {
    /** Personalnummern (column 1 of the Bewegungsdaten rows) of the company export. */
    async function datevPnrs(month: number): Promise<string[]> {
      const res = await withClock(d.adminToken, (t) =>
        app.inject({
          method: "GET",
          url: `/api/v1/reports/datev?year=2026&month=${month}`,
          headers: { authorization: `Bearer ${t}` },
        }),
      );
      expect(res.statusCode).toBe(200);
      const text = iconv.decode(res.rawPayload, "win1252");
      return text
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => l.split(";")[1]);
    }

    it("keeps an anonymised person with an exit date in the months of the employment (§ 41 EStG)", async () => {
      await configureDatevKanzlei(app, d.tenant.id);
      const a2 = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId: d.salonId,
        tag: "a2",
        hireDate: new Date("2025-01-01T00:00:00.000Z"),
        exitDate: new Date("2026-09-30T00:00:00.000Z"),
        anonymized: true,
      });
      const september = await datevPnrs(9);
      expect(september).toContain(a2.employeeNumber);
      expect(september).toContain(p.E1.employeeNumber);
      expect(september).toContain(p.D.employeeNumber);
      // The sentinel without any exit date is not in the monthly report, but DATEV reads the core
      // alone: it stays in every month of its (open) employment.
      expect(september).toContain(p.A.employeeNumber);
      const october = await datevPnrs(10);
      expect(october).not.toContain(a2.employeeNumber);
      expect(october).not.toContain(p.E1.employeeNumber);
      expect(october).toContain(p.D.employeeNumber);
    });
  });
});
