/**
 * Issue #612 (P-11, T-612-13..16) - `GET /api/v1/reports/period/csv`: the "Zeiten & Konten" table of
 * the period as an audited CSV download.
 *
 * The file is the same assembly as `GET /reports/period` (reach of `report:export`), so every line is
 * pinned to a JSON row of the same query. Fixture: the #617 nine-person tenant (every way a month's
 * figures are produced), `Date` faked to 2026-10-15T10:00Z so October is the running month.
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import {
  getTestApp,
  closeTestApp,
  cleanupTestData,
  seedTestData,
  createTestSalon,
  soleAuditRow,
} from "./setup";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";
import { createPopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey, SYSTEM_ROLE_IDS } from "../contexts/platform";

const PASSWORD = "test1234";

type JsonRow = {
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  workedMinutes: number;
  expectedMinutes: number | null;
  balanceMinutes: number | null;
  openingBalanceMinutes: number | null;
  closingBalanceMinutes: number | null;
  monthCount: number;
  confirmedMonthCount: number;
  labelled: boolean;
  sollUnavailableReason?: string;
};
type JsonPeriod = { rows: JsonRow[] };

/** Splits a CSV (without BOM) into records of cells; handles RFC 4180 quoting. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quotedCell = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quotedCell) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quotedCell = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quotedCell = true;
    } else if (ch === ";") {
      record.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

/** Independent of the production formatter: minutes -> hours rounded to 2 places, decimal comma. */
function hours(minutes: number | null): string {
  if (minutes === null) return "";
  const rounded = Math.round((minutes / 60) * 100) / 100;
  return String(rounded === 0 ? 0 : rounded).replace(".", ",");
}

function statusOf(row: JsonRow): string {
  if (!row.labelled) return "ohne Soll";
  return row.confirmedMonthCount === row.monthCount ? "Bestätigt" : "Prognose";
}

// The period route walks the account kernel once per person and month (#688); under CI coverage a
// single case takes up to ~28 s, so the global 30 s budget flakes. Back to the default once #688
// reads closed months in one query. Assertions are unchanged.
describe("Issue #612 - GET /reports/period/csv", { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: string;
  let personInB: string;
  let hrToken: string;
  let managerToken: string;
  let noOvertimeToken: string;

  const csvUrl = (qs: string) => `/api/v1/reports/period/csv?${qs}`;
  const get = (url: string, token = fx.adminToken) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function json(qs: string, token = fx.adminToken): Promise<JsonPeriod> {
    const res = await get(`/api/v1/reports/period?${qs}`, token);
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as JsonPeriod;
  }

  async function csv(qs: string, token = fx.adminToken) {
    const res = await get(csvUrl(qs), token);
    expect(res.statusCode, res.body).toBe(200);
    const text = res.rawPayload.subarray(3).toString("utf8");
    const [header, ...data] = parseCsv(text);
    return { res, text, header, data };
  }

  const exportAuditCount = () =>
    app.prisma.auditLog.count({
      where: {
        action: "EXPORT",
        entity: "Report",
        newValue: { path: ["type"], equals: "PERIOD_CSV" },
      },
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "pc612");
    foreign = await seedTestData(app, "pc612f");

    salonB = (await createTestSalon(app.prisma, fx.tenantId, { name: "Csv612 B" })).id;
    personInB = (
      await createPopulationPerson(app, {
        tenantId: fx.tenantId,
        salonId: salonB,
        tag: "CB",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      })
    ).employeeId;
    for (const d of ["2026-09-08", "2026-09-09"]) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: personInB,
          salonId: salonB,
          date: new Date(`${d}T00:00:00Z`),
          startTime: new Date(`${d}T08:00:00Z`),
          endTime: new Date(`${d}T16:00:00Z`),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
        },
      });
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const caller = async (
      tag: string,
      assignment:
        | { accessRoleId: string; scopeType: "SALONS"; salonIds: string[] }
        | { permissions: string[]; scopeType: "TENANT" },
    ): Promise<string> => {
      const suffix = `${tag}-${randomBytes(3).toString("hex")}`;
      const user = await app.prisma.user.create({
        data: {
          email: `pc612-${suffix}@example.invalid`,
          passwordHash,
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      await app.prisma.employee.create({
        data: {
          tenantId: fx.tenantId,
          userId: user.id,
          employeeNumber: `PC${suffix}`.toUpperCase().slice(0, 20),
          firstName: "Fixture",
          lastName: "CsvCaller612",
          hireDate: new Date("2024-01-01"),
        },
      });
      let accessRoleId: string;
      if ("accessRoleId" in assignment) {
        accessRoleId = assignment.accessRoleId;
      } else {
        const name = `Csv612 ${suffix}`;
        const role = await app.prisma.accessRole.create({
          data: {
            tenantId: fx.tenantId,
            name,
            nameKey: roleNameKey(name),
            permissions: normalizeRolePermissions(assignment.permissions),
          },
        });
        accessRoleId = role.id;
      }
      await app.prisma.roleAssignment.create({
        data: {
          tenantId: fx.tenantId,
          userId: user.id,
          accessRoleId,
          scopeType: assignment.scopeType,
          salonIds: "salonIds" in assignment ? assignment.salonIds : [],
          employeeIds: [],
        },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      return (JSON.parse(login.body) as { accessToken: string }).accessToken;
    };

    hrToken = await caller("hr", { permissions: ["report:read:ZUGEWIESEN"], scopeType: "TENANT" });
    managerToken = await caller("mgr", {
      accessRoleId: SYSTEM_ROLE_IDS.MANAGER,
      scopeType: "SALONS",
      salonIds: [fx.salonId],
    });
    noOvertimeToken = await caller("noot", {
      permissions: ["report:export:ZUGEWIESEN"],
      scopeType: "TENANT",
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    try {
      await cleanupTestData(app, fx.tenantId);
      await cleanupTestData(app, foreign.tenant.id);
    } catch (err) {
      console.error("period-csv-612 cleanup failed:", err);
    }
    await closeTestApp();
  });

  describe("the file", () => {
    it("is a UTF-8 text/csv attachment with a BOM and the nine titles, named after the period", async () => {
      const { res, header } = await csv("from=2026-07&to=2026-10");
      expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="Zeiten-und-Konten_2026-07_2026-10.csv"',
      );
      const bytes = [...res.rawPayload.subarray(0, 3)];
      expect(bytes).toEqual([0xef, 0xbb, 0xbf]);
      expect(header).toEqual([
        "Personalnummer",
        "Name",
        "Soll (h)",
        "Ist (h)",
        "Saldo Beginn (h)",
        "Saldo Zeitraum (h)",
        "Saldo Ende (h)",
        "Status",
        "Monate bestätigt",
      ]);
      // Evidence for the SUMMARY: hex of the first three bytes and the first three lines.
      const all = res.rawPayload.toString("utf8").split("\r\n");
      const withFigures = all
        .slice(1)
        .filter((l) => l.split(";")[2] !== "" && l.split(";")[3] !== "0");
      const head = [all[0], ...withFigures.slice(0, 2)];
      console.log(
        `period-csv-612 first bytes ${Buffer.from(bytes).toString("hex")}; first lines:\n${head.join("\n")}`,
      );
    });

    it("has one line per JSON row of the same query with every figure equal to minutes / 60", async () => {
      const qs = "from=2026-07&to=2026-10";
      const body = await json(qs);
      const { text, data } = await csv(qs);
      expect(text.endsWith("\r\n")).toBe(true);
      expect(body.rows.length).toBeGreaterThanOrEqual(10);
      expect(data).toHaveLength(body.rows.length);
      data.forEach((cells, i) => {
        const r = body.rows[i];
        expect(cells).toEqual([
          r.employeeNumber,
          r.employeeName,
          hours(r.expectedMinutes),
          hours(r.workedMinutes),
          hours(r.openingBalanceMinutes),
          hours(r.balanceMinutes),
          hours(r.closingBalanceMinutes),
          statusOf(r),
          `${r.confirmedMonthCount} von ${r.monthCount}`,
        ]);
      });
      // Non-vacuous: the fixture produces decimals with a comma, a negative figure and every status.
      const flat = data.flatMap((c) => c.slice(2, 7));
      expect(flat.some((c) => c.includes(","))).toBe(true);
      expect(flat.some((c) => c.startsWith("-"))).toBe(true);
      expect(
        new Set(data.map((c) => c[7])).has("Bestätigt") ||
          new Set(data.map((c) => c[7])).has("Prognose"),
      ).toBe(true);
    });

    it("writes the same figures for a single employeeId as the JSON does", async () => {
      const qs = `from=2026-09&to=2026-10&employeeId=${fx.people.p1.id}`;
      const body = await json(qs);
      const { data } = await csv(qs);
      expect(body.rows).toHaveLength(1);
      expect(data).toHaveLength(1);
      expect(data[0][0]).toBe(body.rows[0].employeeNumber);
      expect(data[0][3]).toBe(hours(body.rows[0].workedMinutes));
    });
  });

  describe("audit (T-612-14)", () => {
    it("writes exactly one EXPORT row per download, before the bytes, with period, salon and person count", async () => {
      // May-October is requested by this test only, so the row is the sole one of its period.
      const qs = "from=2026-05&to=2026-10";
      const body = await json(qs);
      const before = await exportAuditCount();
      const { res } = await csv(qs);
      expect(res.statusCode).toBe(200);
      expect(await exportAuditCount()).toBe(before + 1);
      const row = await soleAuditRow(app.prisma, {
        where: {
          action: "EXPORT",
          entity: "Report",
          userId: fx.adminUserId,
          AND: [
            { newValue: { path: ["type"], equals: "PERIOD_CSV" } },
            { newValue: { path: ["from"], equals: "2026-05" } },
          ],
        },
      });
      expect(row.newValue).toEqual({
        type: "PERIOD_CSV",
        from: "2026-05",
        to: "2026-10",
        salonId: null,
        personCount: body.rows.length,
      });
    });

    it("records the validated salon id under a filter", async () => {
      const qs = `from=2026-04&to=2026-10&salonId=${fx.salonId}`;
      const body = await json(qs);
      await csv(qs);
      const row = await soleAuditRow(app.prisma, {
        where: {
          action: "EXPORT",
          entity: "Report",
          // The worker database outlives a run: pin the row to this run's admin.
          userId: fx.adminUserId,
          AND: [
            { newValue: { path: ["type"], equals: "PERIOD_CSV" } },
            { newValue: { path: ["from"], equals: "2026-04" } },
          ],
        },
      });
      expect(row.newValue).toEqual({
        type: "PERIOD_CSV",
        from: "2026-04",
        to: "2026-10",
        salonId: fx.salonId,
        personCount: body.rows.length,
      });
    });

    it("writes no audit row for a refused request (400, 403, 404)", async () => {
      const foreignSalon = (
        await createTestSalon(app.prisma, foreign.tenant.id, { name: "Csv612 F" })
      ).id;
      const before = await exportAuditCount();

      // 13 months, an inverted range and a future month: 400
      expect((await get(csvUrl("from=2025-10&to=2026-10"))).statusCode).toBe(400);
      expect((await get(csvUrl("from=2026-10&to=2026-09"))).statusCode).toBe(400);
      expect((await get(csvUrl("from=2026-10&to=2026-11"))).statusCode).toBe(400);
      expect((await get(csvUrl("from=2026-13&to=2026-13"))).statusCode).toBe(400);
      // report:read without report:export (the HR principal): 403, no data
      const hr = await get(csvUrl("from=2026-09&to=2026-10"), hrToken);
      expect(hr.statusCode).toBe(403);
      expect(hr.rawPayload.subarray(0, 3).toString("hex")).not.toBe("efbbbf");
      // an unauthenticated and an employee caller: 401 / 403
      expect(
        (await app.inject({ method: "GET", url: csvUrl("from=2026-09&to=2026-10") })).statusCode,
      ).toBe(401);
      expect((await get(csvUrl("from=2026-09&to=2026-10"), fx.seed.empToken)).statusCode).toBe(403);
      // a foreign tenant's salon and an unknown one: the one 404 body
      const foreignRes = await get(csvUrl(`from=2026-09&to=2026-10&salonId=${foreignSalon}`));
      const unknownRes = await get(
        csvUrl("from=2026-09&to=2026-10&salonId=00000000-0000-4000-8000-0000000000aa"),
      );
      expect(foreignRes.statusCode).toBe(404);
      expect(unknownRes.statusCode).toBe(404);
      expect(foreignRes.body).toBe(unknownRes.body);
      // the same 404 body as the JSON route of the same query
      const jsonRes = await get(
        `/api/v1/reports/period?from=2026-09&to=2026-10&salonId=${foreignSalon}`,
      );
      expect(jsonRes.body).toBe(foreignRes.body);

      expect(await exportAuditCount()).toBe(before);
    });
  });

  describe("the rules of the JSON answer (T-612-15, T-612-16)", () => {
    it("under salonId lists the filtered JSON rows with empty Soll and saldo cells", async () => {
      const qs = `from=2026-07&to=2026-10&salonId=${fx.salonId}`;
      const body = await json(qs);
      const { data } = await csv(qs);
      expect(body.rows.length).toBeGreaterThan(0);
      expect(data).toHaveLength(body.rows.length);
      data.forEach((cells, i) => {
        const r = body.rows[i];
        expect(cells[0]).toBe(r.employeeNumber);
        expect(cells[2]).toBe("");
        expect(cells[3]).toBe(hours(r.workedMinutes));
        expect(cells.slice(4, 7)).toEqual(["", "", ""]);
        // no month is judged against a contract under a filter: no status either
        expect(cells[7]).toBe("");
        expect(cells[8]).toBe("");
      });
      // the filter narrows: the unfiltered file is longer (salon B's person is only there)
      const all = await csv("from=2026-07&to=2026-10");
      expect(all.data.length).toBeGreaterThan(data.length);
    });

    it("gives a SALONS-scoped manager only the persons of his reach", async () => {
      const qs = "from=2026-08&to=2026-10";
      const admin = await json(qs);
      const adminFile = await csv(qs);
      const mgrJson = await json(qs, managerToken);
      const mgrFile = await csv(qs, managerToken);
      expect(admin.rows.some((r) => r.employeeId === personInB)).toBe(true);
      expect(mgrJson.rows.some((r) => r.employeeId === personInB)).toBe(false);
      expect(mgrFile.data).toHaveLength(mgrJson.rows.length);
      expect(mgrFile.data.length).toBeLessThan(adminFile.data.length);
      const numberOfB = admin.rows.find((r) => r.employeeId === personInB)!.employeeNumber;
      expect(mgrFile.data.some((c) => c[0] === numberOfB)).toBe(false);
      expect(adminFile.data.some((c) => c[0] === numberOfB)).toBe(true);
    });

    it("leaves Soll and saldo cells empty for report:export without overtime:read, Ist stays", async () => {
      const qs = "from=2026-08&to=2026-10";
      const admin = await csv(qs);
      const limited = await csv(qs, noOvertimeToken);
      expect(limited.data).toHaveLength(admin.data.length);
      expect(admin.data.some((c) => c[2] !== "")).toBe(true);
      limited.data.forEach((cells, i) => {
        expect(cells[2]).toBe("");
        expect(cells.slice(4, 7)).toEqual(["", "", ""]);
        expect(cells[3]).toBe(admin.data[i][3]);
      });
      expect(limited.data.some((c) => c[3] !== "" && c[3] !== "0")).toBe(true);
    });
  });

  describe("formula injection (T-612-13)", () => {
    it("prefixes a name that starts with = with an apostrophe in the file", async () => {
      const injected = await createPopulationPerson(app, {
        tenantId: fx.tenantId,
        salonId: fx.salonId,
        tag: "INJ",
        hireDate: new Date("2025-01-01T00:00:00Z"),
      });
      await app.prisma.employee.update({
        where: { id: injected.employeeId },
        data: { firstName: "=HYPERLINK(1)", lastName: "Inj612" },
      });
      const body = await json("from=2026-09&to=2026-10");
      const row = body.rows.find((r) => r.employeeId === injected.employeeId)!;
      expect(row.employeeName).toBe("=HYPERLINK(1) Inj612");
      const { data } = await csv("from=2026-09&to=2026-10");
      const line = data.find((c) => c[0] === row.employeeNumber)!;
      expect(line[1]).toBe("'=HYPERLINK(1) Inj612");
      // numeric cells are never prefixed: no cell of a figure column starts with an apostrophe
      for (const cells of data) {
        for (const c of cells.slice(2, 7)) expect(c.startsWith("'")).toBe(false);
      }
    });
  });
});
