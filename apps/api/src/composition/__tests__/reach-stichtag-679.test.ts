/**
 * Issue #679 - the Stammsalon reach of a month-bound read is judged on a CALENDAR day: the exit day
 * when the person left inside the month, else the month's last calendar day (owner decision
 * 17.10.2026). `contexts/platform/scope-filter.ts` is unchanged; the callers choose the day.
 *
 * Fixture, September 2026 (hire 2020-01-01, FIXED default schedule, synthetic names only):
 *   LV  leaver: exit 15.09., HOME S until the exit day, HOME B from 16.09.
 *   SW  non-leaver: HOME S until 15.09., HOME B from 16.09. (month end: B)
 *   BD  non-leaver: HOME S until 30.09., HOME B from 01.10. (month end: S)
 *   CS  caller, SALONS [S];  CB  caller, SALONS [B]  (report:read, report:export, overtime:read)
 * Expected: S sees LV and BD; B sees SW and not LV, not BD.
 *
 * The same fixture is built twice, in Europe/Berlin and America/New_York, with the clock faked into
 * the past of the real run. In New York the instant `end` of September (2026-10-01T03:59:59.999Z)
 * lies on the NEXT UTC day, which is where the old instant-based call judged BD in salon B.
 *
 * Mutation proofs (each reverted with `cp`, byte-compared; red tests measured in the PR):
 *   M1 monthReachDay always returns lastDay -> the leaver cases red.
 *   M2 resolveMonthReachIds' month-end lookup passes `end` instead of `lastDay` -> the New York
 *      cases red, Berlin stays green.
 *   M3 /overtime-trend passes `new Date()` instead of the tenant-local day -> the today case red.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
  reissueTokenNow,
} from "../../__tests__/setup";
import { createPopulationPerson } from "../../__tests__/population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../../contexts/platform";
import * as pdfUtils from "../pdf";

vi.mock("../pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pdf")>();
  return { ...actual, generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf) };
});

const PASSWORD = "test1234";
const HIRE = new Date("2020-01-01T00:00:00Z");
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const sorted = (xs: readonly string[]) => [...xs].sort((a, b) => a.localeCompare(b));
// A clock in the past of the real run: 2026-10-05 12:00 UTC (September is closed, not today).
const CLOCK = "2026-10-05T12:00:00Z";

type World = {
  tenantId: string;
  salonS: string;
  salonB: string;
  ids: Record<"LV" | "SW" | "BD", string>;
  numbers: Record<"LV" | "SW" | "BD", string>;
  csToken: string;
  cbToken: string;
};

describe.each([["Europe/Berlin"], ["America/New_York"]])(
  "Issue #679 - reach day of a person in a month (%s)",
  (tz) => {
    let app: FastifyInstance;
    let d: Awaited<ReturnType<typeof seedTestData>>;
    let w: World;

    async function at<T>(clock: string, fn: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({ now: new Date(clock), toFake: ["Date"] });
      try {
        return await fn();
      } finally {
        vi.useRealTimers();
      }
    }

    const get = (url: string, token: string, clock = CLOCK) =>
      at(clock, () =>
        app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${reissueTokenNow(app, token)}` },
        }),
      );

    async function assign(employeeId: string, salonId: string, from: string, until: string | null) {
      await app.prisma.employeeSalonAssignment.create({
        data: {
          tenantId: d.tenant.id,
          employeeId,
          salonId,
          kind: "HOME",
          validFrom: day(from),
          validUntil: until ? day(until) : null,
          weekdays: [],
        },
      });
    }

    async function scopedCaller(label: string, salonId: string): Promise<string> {
      const person = await createPopulationPerson(app, {
        tenantId: d.tenant.id,
        salonId,
        tag: label,
        hireDate: HIRE,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
      });
      const name = `Reach679 ${crypto.randomBytes(3).toString("hex")}`;
      const role = await app.prisma.accessRole.create({
        data: {
          tenantId: d.tenant.id,
          name,
          nameKey: roleNameKey(name),
          permissions: normalizeRolePermissions([
            "report:read:ZUGEWIESEN",
            "report:export:ZUGEWIESEN",
            "overtime:read:ZUGEWIESEN",
          ]),
        },
      });
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: d.tenant.id,
          userId: person.userId,
          accessRoleId: role.id,
          scopeType: "SALONS",
          salonIds: [salonId],
          employeeIds: [],
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: person.email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (JSON.parse(res.body) as { accessToken: string }).accessToken;
    }

    beforeAll(async () => {
      app = await getTestApp();
      d = await seedTestData(app, "r679");
      await app.prisma.tenantConfig.update({
        where: { tenantId: d.tenant.id },
        data: { timezone: tz, datevBeraterNr: 12345, datevMandantenNr: 6789 },
      });
      const salonS = (await createTestSalon(app.prisma, d.tenant.id, { name: "R679 S" })).id;
      const salonB = (await createTestSalon(app.prisma, d.tenant.id, { name: "R679 B" })).id;

      const mk = (tag: string, exitDate?: Date) =>
        createPopulationPerson(app, {
          tenantId: d.tenant.id,
          salonId: salonS,
          tag,
          hireDate: HIRE,
          exitDate: exitDate ?? null,
        });
      const lv = await mk("lv", new Date("2026-09-15T10:00:00Z"));
      const sw = await mk("sw");
      const bd = await mk("bd");
      // createPopulationPerson wrote an open HOME row in S; replace it with the fixture's two-row history.
      await app.prisma.employeeSalonAssignment.deleteMany({
        where: {
          tenantId: d.tenant.id,
          employeeId: { in: [lv.employeeId, sw.employeeId, bd.employeeId] },
        },
      });
      await assign(lv.employeeId, salonS, "2020-01-01", "2026-09-15");
      await assign(lv.employeeId, salonB, "2026-09-16", null);
      await assign(sw.employeeId, salonS, "2020-01-01", "2026-09-15");
      await assign(sw.employeeId, salonB, "2026-09-16", null);
      await assign(bd.employeeId, salonS, "2020-01-01", "2026-09-30");
      await assign(bd.employeeId, salonB, "2026-10-01", null);
      for (const p of [lv, sw, bd]) {
        await app.prisma.overtimeAccount.upsert({
          where: { employeeId: p.employeeId },
          create: { employeeId: p.employeeId, balanceHours: 1 },
          update: { balanceHours: 1 },
        });
      }
      const emps = await app.prisma.employee.findMany({
        where: { id: { in: [lv.employeeId, sw.employeeId, bd.employeeId] } },
        select: { id: true, employeeNumber: true },
      });
      const num = (id: string) => emps.find((e) => e.id === id)!.employeeNumber;
      w = {
        tenantId: d.tenant.id,
        salonS,
        salonB,
        ids: { LV: lv.employeeId, SW: sw.employeeId, BD: bd.employeeId },
        numbers: { LV: num(lv.employeeId), SW: num(sw.employeeId), BD: num(bd.employeeId) },
        csToken: await scopedCaller("cs", salonS),
        cbToken: await scopedCaller("cb", salonB),
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

    const fixtureIds = () => new Set(Object.values(w.ids));
    const monthlyIds = async (token: string) => {
      const res = await get("/api/v1/reports/monthly?year=2026&month=9", token);
      expect(res.statusCode, res.body).toBe(200);
      const rows = (JSON.parse(res.body) as { rows: Array<{ employeeId: string }> }).rows;
      return sorted(rows.map((r) => r.employeeId).filter((id) => fixtureIds().has(id)));
    };
    const exportNumbers = async (token: string) => {
      const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
      spy.mockClear();
      const res = await get("/api/v1/reports/monthly-export/pdf?year=2026&month=9", token);
      expect(res.statusCode, String(res.body)).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const all = new Set(Object.values(w.numbers));
      return sorted(
        spy.mock.calls[0][0].rows.map((r) => r.employeeNumber).filter((n) => all.has(n)),
      );
    };

    it("GET /reports/monthly: S sees the leaver and the month-end member, B sees the other", async () => {
      expect(await monthlyIds(w.csToken)).toEqual(sorted([w.ids.LV, w.ids.BD]));
      expect(await monthlyIds(w.cbToken)).toEqual([w.ids.SW]);
    });

    it("GET /reports/monthly-export/pdf: the same persons per caller", async () => {
      expect(await exportNumbers(w.csToken)).toEqual(sorted([w.numbers.LV, w.numbers.BD]));
      expect(await exportNumbers(w.cbToken)).toEqual([w.numbers.SW]);
    });

    it("GET /reports/monthly-export/pdf?salonId=S narrows within the reach, never beyond", async () => {
      const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
      spy.mockClear();
      const res = await get(
        `/api/v1/reports/monthly-export/pdf?year=2026&month=9&salonId=${w.salonS}`,
        w.csToken,
      );
      expect(res.statusCode, String(res.body)).toBe(200);
      const all = new Set(Object.values(w.numbers));
      const got = sorted(
        spy.mock.calls[0][0].rows.map((r) => r.employeeNumber).filter((n) => all.has(n)),
      );
      expect(got).toEqual(sorted([w.numbers.LV, w.numbers.BD]));
    });

    it("single-person routes decide with the same day", async () => {
      const pdf = (id: string, token: string) =>
        get(`/api/v1/reports/monthly/pdf?employeeId=${id}&year=2026&month=9`, token);
      const datev = (id: string, token: string) =>
        get(`/api/v1/reports/datev/employee?employeeId=${id}&year=2026&month=9`, token);
      for (const call of [pdf, datev]) {
        expect((await call(w.ids.LV, w.csToken)).statusCode).toBe(200);
        expect((await call(w.ids.BD, w.csToken)).statusCode).toBe(200);
        expect((await call(w.ids.SW, w.csToken)).statusCode).not.toBe(200);
        expect((await call(w.ids.SW, w.cbToken)).statusCode).toBe(200);
        expect((await call(w.ids.LV, w.cbToken)).statusCode).not.toBe(200);
        expect((await call(w.ids.BD, w.cbToken)).statusCode).not.toBe(200);
      }
    });

    it("GET /dashboard/overtime-trend judges the reach on the tenant-local day, not the UTC day", async () => {
      // Tenant-local 2026-06-16 23:30 in New York is 2026-06-17 03:30Z; in Berlin 06-17 is the same
      // local and UTC day. A person homed S until 06-16 and B from 06-17 is therefore in S's reach
      // at that clock only for New York.
      const person = await createPopulationPerson(app, {
        tenantId: w.tenantId,
        salonId: w.salonS,
        tag: `tz-${tz.slice(0, 2).toLowerCase()}`,
        hireDate: HIRE,
      });
      await app.prisma.employeeSalonAssignment.deleteMany({
        where: { tenantId: w.tenantId, employeeId: person.employeeId },
      });
      await assign(person.employeeId, w.salonS, "2020-01-01", "2026-06-16");
      await assign(person.employeeId, w.salonB, "2026-06-17", null);
      await app.prisma.overtimeAccount.upsert({
        where: { employeeId: person.employeeId },
        create: { employeeId: person.employeeId, balanceHours: 100 },
        update: { balanceHours: 100 },
      });
      const res = await get("/api/v1/dashboard/overtime-trend", w.csToken, "2026-06-17T03:30:00Z");
      expect(res.statusCode, res.body).toBe(200);
      const minutes = (JSON.parse(res.body) as { currentTeamBalanceMinutes: number })
        .currentTeamBalanceMinutes;
      // The 100 h person is inside S's reach only when the local day (06-16) decides.
      const includesBig = minutes >= 6000;
      expect(includesBig).toBe(tz === "America/New_York");
    });
  },
);

describe("Issue #679 - no composition call hands the reach resolution an instant", () => {
  it("every Stammsalon resolution call in composition/ passes a calendar day", () => {
    const dir = join(__dirname, "..");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    let calls = 0;
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      const re =
        /(resolveStammsalonScopedEmployeeIds|isStammsalonScopeMatch)\(([^;]*?)\)\s*[;)\n]/gs;
      for (const m of src.matchAll(re)) {
        calls += 1;
        const args = m[2].replace(/\/\/[^\n]*/g, "");
        const last =
          args
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
            .pop() ?? "";
        if (/new Date\(\)|\bend\b|\bweekEnd\b|\bnow\b|23:59:59/.test(last))
          offenders.push(`${f}: ${last}`);
      }
    }
    expect(files.length, "no composition file scanned at all").toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
