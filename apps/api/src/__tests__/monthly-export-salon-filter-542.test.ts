/**
 * Issue #542 (OD-2, CTX-1, CTX-3, AC-542-3/4/5; P-04, P-05, P-07, P-09) - the Monatsexport PDF under a
 * chosen salon: `GET /reports/monthly-export/pdf?salonId=`.
 *
 * The filter narrows WHICH persons appear (owner decision 17.10.2026): the persons whose Stammsalon
 * is the chosen salon on the Stichtag of the person - the person's exit day when it lies inside the
 * exported month, else the last calendar day of the month. Every exported row is the person's whole
 * row, never a salon share (the rows deep-equal the unfiltered rows). DATEV is never narrowed.
 *
 * Fixture: the 617 export fixture (nine persons p1..p9 homed in the fixture salon S, export month
 * September 2026, `Date` faked to 2026-10-15) plus salon B and
 *   p3  S until 2026-09-15, B from 2026-09-16       -> B on 30.09.
 *   p4  S until 2026-10-01, B from 2026-10-02       -> S on 30.09.
 *   p5  S until 2026-09-30, B from 2026-10-01       -> S on 30.09. (a change at the month boundary)
 *   p7  leaver, exit 2026-09-15; S until the exit day, B from 2026-09-16
 *                                                   -> S on the exit day (B on 30.09.)
 *   pL  leaver, exit 2026-09-20, homed B
 *   pG  homed S until 2026-09-10 and nowhere after  -> no Stammsalon on 30.09.
 *   pC  homed S, holds a custom `report:export` SALONS [S] role (the scoped caller)
 * The seeded admin and employee have no Stammsalon at all.
 *
 * Mutation proofs (each reverted with `cp`, byte-compared; red tests measured):
 *   M1 the leaver rule dropped (every person judged on the month's last day) -> "salon S lists ...",
 *      "salon B lists ..." and "a leaver is judged on its exit day ..." red (3 failed; p7).
 *   M2 the narrowing passed into the DATEV loader call of GET /datev -> "DATEV is byte-identical
 *      ..." here and "reports.ts: DATEV is never narrowed ..." in report-salon-filter-source-542 red.
 *   M3 an employee read placed before the salon validation -> report-salon-filter-source-542 "get
 *      selectMonthlyExportPersons: validates before any read ..." red.
 *   M4 the PDF label written without a filter -> monthly-export-salon-label-542 "writes no label line
 *      without a salon scope" red.
 *   M5 the non-leavers' Stichtag passed as the INSTANT `end` of the month instead of the calendar day
 *      -> NOT red (29 passed): Prisma truncates a Date given to a @db.Date filter to its UTC date and
 *      the end of a Europe/Berlin month still falls on the same UTC date. The calendar-day form stays
 *      because it is exact in every time zone and does not depend on that truncation.
 *   M6 today (the faked 2026-10-15) instead of the month's last day for the non-leavers -> "salon S
 *      lists ..." and "salon B lists ..." red (2 failed; p4 would move to B).
 */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import iconv from "iconv-lite";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { getTestApp, closeTestApp, cleanupTestData, seedTestData, createTestSalon } from "./setup";
import {
  seedMonthlyExportFixture,
  FAKE_NOW,
  EXPORT_YEAR,
  EXPORT_MONTH,
  type MonthlyExportFixture,
} from "./monthly-export-fixture-617";
import { createPopulationPerson, type PopulationPerson } from "./population-fixtures-613";
import { normalizeRolePermissions, roleNameKey } from "../contexts/platform";
import * as pdfUtils from "../composition/pdf";

vi.mock("../composition/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composition/pdf")>();
  return {
    ...actual,
    generateMonthlyExportPdf: vi.fn(actual.generateMonthlyExportPdf),
  };
});

type ExportPayload = Parameters<typeof pdfUtils.generateMonthlyExportPdf>[0];
type ExportRow = ExportPayload["rows"][number];

const PASSWORD = "test1234";
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const byText = (x: string, y: string) => x.localeCompare(y);

/** The DATEV [Bewegungsdaten] personnel numbers of a file, in file order. */
function datevPnrs(text: string): string[] {
  const body = text.split("[Bewegungsdaten]")[1] ?? "";
  return body
    .split("\r\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(";")[1]);
}

describe("Issue #542 - Monatsexport follows a chosen salon (persons by Stammsalon at the Stichtag)", () => {
  let app: FastifyInstance;
  let fx: MonthlyExportFixture;
  let foreign: Awaited<ReturnType<typeof seedTestData>>;
  let salonS = "";
  let salonB = "";
  let salonSName = "";
  let inactiveSalon = "";
  let pL: PopulationPerson;
  let pG: PopulationPerson;
  let pC: PopulationPerson;
  let scopedToken = "";

  const exportUrl = (qs: string) => `/api/v1/reports/monthly-export/pdf?${qs}`;
  const MONTH_QS = `year=${EXPORT_YEAR}&month=${EXPORT_MONTH}`;

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  /** The payload the route handed to the renderer (call-through spy). */
  async function exportPayload(
    token: string,
    extra = "",
    qs = MONTH_QS,
  ): Promise<{ status: number; data: ExportPayload | null; body: string }> {
    const spy = vi.mocked(pdfUtils.generateMonthlyExportPdf);
    spy.mockClear();
    const res = await get(token, exportUrl(`${qs}${extra}`));
    if (res.statusCode !== 200) return { status: res.statusCode, data: null, body: res.body };
    expect(spy).toHaveBeenCalledTimes(1);
    return { status: 200, data: spy.mock.calls[0][0] as ExportPayload, body: "" };
  }

  async function rowsOf(token: string, extra = "", qs = MONTH_QS): Promise<ExportRow[]> {
    const r = await exportPayload(token, extra, qs);
    expect(r.status, r.body).toBe(200);
    return (r.data as ExportPayload).rows;
  }

  const numbers = (rows: readonly ExportRow[]) => rows.map((r) => r.employeeNumber);

  function endHome(employeeId: string, until: string) {
    return app.prisma.employeeSalonAssignment.updateMany({
      where: { employeeId, kind: "HOME" },
      data: { validUntil: day(until) },
    });
  }
  function startHome(employeeId: string, salonId: string, from: string) {
    return app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: fx.tenantId,
        employeeId,
        salonId,
        kind: "HOME",
        validFrom: day(from),
        validUntil: null,
        weekdays: [],
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FAKE_NOW);
    app = await getTestApp();
    fx = await seedMonthlyExportFixture(app, "sf542x");
    foreign = await seedTestData(app, "sf542xf");
    salonS = fx.salonId;
    salonSName = (await app.prisma.salon.findUniqueOrThrow({ where: { id: salonS } })).name;
    salonB = (await createTestSalon(app.prisma, fx.tenantId, { name: "Sf542x B" })).id;
    inactiveSalon = (
      await createTestSalon(app.prisma, fx.tenantId, { name: "Sf542x off", isActive: false })
    ).id;

    const { p3, p4, p5, p7 } = fx.people;
    await endHome(p3.id, "2026-09-15");
    await startHome(p3.id, salonB, "2026-09-16");
    await endHome(p4.id, "2026-10-01");
    await startHome(p4.id, salonB, "2026-10-02");
    await endHome(p5.id, "2026-09-30");
    await startHome(p5.id, salonB, "2026-10-01");
    await endHome(p7.id, "2026-09-15");
    await startHome(p7.id, salonB, "2026-09-16");

    const hire = day("2025-06-01");
    pL = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: salonB,
      tag: "l",
      hireDate: hire,
      exitDate: day("2026-09-20"),
    });
    pG = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: salonS,
      tag: "g",
      hireDate: hire,
    });
    await endHome(pG.employeeId, "2026-09-10");

    // The scoped caller: a custom role holding only report:export, scope SALONS [S].
    pC = await createPopulationPerson(app, {
      tenantId: fx.tenantId,
      salonId: salonS,
      tag: "c",
      hireDate: hire,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
    });
    const name = `Sf542x ${randomUUID().slice(0, 8)}`;
    const role = await app.prisma.accessRole.create({
      data: {
        tenantId: fx.tenantId,
        name,
        nameKey: roleNameKey(name),
        permissions: normalizeRolePermissions(["report:export:ZUGEWIESEN"]),
      },
    });
    await app.prisma.roleAssignment.create({
      data: {
        tenantId: fx.tenantId,
        userId: pC.userId,
        accessRoleId: role.id,
        scopeType: "SALONS",
        salonIds: [salonS],
        employeeIds: [],
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: pC.email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    scopedToken = (JSON.parse(login.body) as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    vi.useRealTimers();
    for (const tenantId of [fx?.tenantId, foreign?.tenant.id]) {
      if (!tenantId) continue;
      try {
        await app.prisma.roleAssignment.deleteMany({ where: { tenantId } });
        await app.prisma.accessRole.deleteMany({ where: { tenantId } });
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("monthly-export-salon-filter-542 cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  const nums = () => ({
    p1: fx.people.p1.employeeNumber,
    p2: fx.people.p2.employeeNumber,
    p3: fx.people.p3.employeeNumber,
    p4: fx.people.p4.employeeNumber,
    p5: fx.people.p5.employeeNumber,
    p6: fx.people.p6.employeeNumber,
    p7: fx.people.p7.employeeNumber,
    p8: fx.people.p8.employeeNumber,
    p9: fx.people.p9.employeeNumber,
    pL: pL.employeeNumber,
    pG: pG.employeeNumber,
    pC: pC.employeeNumber,
    seedAdmin: fx.seed.adminEmployee.employeeNumber,
    seedEmp: fx.seed.employee.employeeNumber,
  });

  it("salon S lists the persons homed in S on their Stichtag, each row equal to the unfiltered row", async () => {
    const n = nums();
    const unfiltered = await rowsOf(fx.adminToken);
    const payload = (await exportPayload(fx.adminToken, `&salonId=${salonS}`))
      .data as ExportPayload;
    // S: p1 p2 p4 p5 p6 p8 p9 pC on 30.09., p7 on its exit day (the 15th).
    const inS = [n.p1, n.p2, n.p4, n.p5, n.p6, n.p7, n.p8, n.p9, n.pC];
    expect(numbers(payload.rows).sort(byText)).toEqual([...inS].sort(byText));
    // same order as the unfiltered list, full rows
    const expected = unfiltered.filter((r) => inS.includes(r.employeeNumber));
    expect(payload.rows).toEqual(expected);
    expect(payload.salonScope).toEqual({ salonName: salonSName });
  });

  it("salon B lists p3 (moved on the 16th) and the leaver pL; p5 and p7 are not in B", async () => {
    const n = nums();
    const unfiltered = await rowsOf(fx.adminToken);
    const payload = (await exportPayload(fx.adminToken, `&salonId=${salonB}`))
      .data as ExportPayload;
    const inB = [n.p3, n.pL];
    expect(numbers(payload.rows).sort(byText)).toEqual([...inB].sort(byText));
    expect(payload.rows).toEqual(unfiltered.filter((r) => inB.includes(r.employeeNumber)));
    expect(payload.salonScope?.salonName).toBe("Sf542x B");
  });

  it("partitions the persons with a Stammsalon: every such person is in exactly one salon's export; the others only in the unfiltered one", async () => {
    const n = nums();
    const unfiltered = new Set(numbers(await rowsOf(fx.adminToken)));
    const s = new Set(numbers(await rowsOf(fx.adminToken, `&salonId=${salonS}`)));
    const b = new Set(numbers(await rowsOf(fx.adminToken, `&salonId=${salonB}`)));
    for (const id of s) expect(b.has(id), id).toBe(false);
    // A person without a Stammsalon on the Stichtag (pG's assignment ended on the 10th, the seeded
    // admin and employee have none) appears in no salon's export.
    const withoutHome = [n.pG, n.seedAdmin, n.seedEmp];
    for (const id of withoutHome) {
      expect(unfiltered.has(id), id).toBe(true);
      expect(s.has(id) || b.has(id), id).toBe(false);
    }
    const homed = [...unfiltered].filter((id) => !withoutHome.includes(id));
    expect([...s, ...b].sort(byText)).toEqual(homed.sort(byText));
  });

  it("a leaver is judged on its exit day: p7 (S until the 15th, B afterwards) is in S, not in B", async () => {
    const n = nums();
    expect(numbers(await rowsOf(fx.adminToken, `&salonId=${salonS}`))).toContain(n.p7);
    expect(numbers(await rowsOf(fx.adminToken, `&salonId=${salonB}`))).not.toContain(n.p7);
  });

  it("without a filter the payload has no salonScope and the rows are unchanged in count", async () => {
    const r = await exportPayload(fx.adminToken);
    const data = r.data as ExportPayload;
    expect("salonScope" in data).toBe(false);
    expect(data.rows.length).toBeGreaterThanOrEqual(13);
  });

  it("DATEV is byte-identical with or without a salonId and still carries p3", async () => {
    const plain = await get(fx.adminToken, `/api/v1/reports/datev?${MONTH_QS}`);
    const withSalon = await get(
      fx.adminToken,
      `/api/v1/reports/datev?${MONTH_QS}&salonId=${salonB}`,
    );
    expect(plain.statusCode).toBe(200);
    expect(withSalon.statusCode).toBe(200);
    expect(Buffer.compare(plain.rawPayload, withSalon.rawPayload)).toBe(0);
    const pnrs = datevPnrs(iconv.decode(plain.rawPayload, "win1252"));
    expect(pnrs).toContain(fx.people.p3.employeeNumber);
    expect(pnrs).toContain(fx.people.p1.employeeNumber);
  });

  it("answers the one 404 for a foreign, unknown and inactive salon and for a salon outside the caller's reach", async () => {
    const bodies: string[] = [];
    for (const salonId of [foreign.salonId, randomUUID(), inactiveSalon]) {
      const res = await get(fx.adminToken, exportUrl(`${MONTH_QS}&salonId=${salonId}`));
      expect(res.statusCode, salonId).toBe(404);
      bodies.push(res.body);
    }
    const outside = await get(scopedToken, exportUrl(`${MONTH_QS}&salonId=${salonB}`));
    expect(outside.statusCode).toBe(404);
    bodies.push(outside.body);
    for (const body of bodies) expect(body).toBe('{"error":"Salon nicht gefunden"}');
    const bad = await get(fx.adminToken, exportUrl(`${MONTH_QS}&salonId=not-a-uuid`));
    expect(bad.statusCode).toBe(400);
  });

  it("a scoped report:export caller's filtered export is a subset of its unfiltered export", async () => {
    const unfiltered = await rowsOf(scopedToken);
    const filtered = await rowsOf(scopedToken, `&salonId=${salonS}`);
    expect(filtered.length).toBeGreaterThan(0);
    const unfilteredNumbers = new Set(numbers(unfiltered));
    for (const row of filtered) {
      expect(unfilteredNumbers.has(row.employeeNumber), row.employeeNumber).toBe(true);
      expect(row).toEqual(unfiltered.find((u) => u.employeeNumber === row.employeeNumber));
    }
    // never a person of salon B
    expect(numbers(filtered)).not.toContain(fx.people.p3.employeeNumber);
    expect(numbers(filtered)).not.toContain(pL.employeeNumber);
  });

  it("the EXPORT audit row carries salonId only under a filter and the number of included persons", async () => {
    // August is requested by this test only; the export month of the fixture is September.
    const AUG = `year=${EXPORT_YEAR}&month=8`;
    const plain = await rowsOf(fx.adminToken, "", AUG);
    const filtered = await rowsOf(fx.adminToken, `&salonId=${salonS}`, AUG);
    const rows = await app.prisma.auditLog.findMany({
      where: {
        action: "EXPORT",
        entity: "Report",
        userId: fx.adminUserId,
        AND: [
          { newValue: { path: ["type"], equals: "MONTHLY_EXPORT_PDF" } },
          { newValue: { path: ["month"], equals: 8 } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(2);
    const values = rows.map((r) => r.newValue as Record<string, unknown>);
    const withSalon = values.filter((v) => "salonId" in v);
    const without = values.filter((v) => !("salonId" in v));
    expect(withSalon).toHaveLength(1);
    expect(without).toHaveLength(1);
    expect(without[0]).toEqual({
      type: "MONTHLY_EXPORT_PDF",
      year: EXPORT_YEAR,
      month: 8,
      employeesIncluded: plain.length,
    });
    expect(withSalon[0]).toEqual({
      type: "MONTHLY_EXPORT_PDF",
      year: EXPORT_YEAR,
      month: 8,
      employeesIncluded: filtered.length,
      salonId: salonS,
    });
  });
});
