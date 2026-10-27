/**
 * Issue #304 - field-by-field comparison of the DATEV LODAS export against the OFFICIAL field list
 * (DATEV Dok.-Nr. 1080789, chapter 6.1 LODAS, "Felder der Importschnittstelle" and the
 * Mustersatzbeschreibung, as quoted in the issue body).
 *
 * The expectations below are typed in from that quotation and deliberately import NOTHING from
 * composition/reports.ts: a test that read our own constant would only check the file against
 * itself. If the official list changes, this literal is what gets updated, with the document.
 *
 * Acceptance basis (owner comment 19.10.2026): the file is not imported into LODAS today and no
 * test import is available, so this field comparison is the proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  configureDatevKanzlei,
} from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { decodeDatev, datevSectionLines } from "./datev-rows";

// ── The official lists, as quoted in the issue ───────────────────────────────

/** Every Bewegungsdaten table of the official list. */
const OFFICIAL_BWD_TABLES = [
  "u_lod_bwd_buchung_akkord",
  "u_lod_bwd_buchung_akkord_nb",
  "u_lod_bwd_buchung_brutto",
  "u_lod_bwd_buchung_kalendarium",
  "u_lod_bwd_buchung_kalendarium_nb",
  "u_lod_bwd_buchung_kilometer",
  "u_lod_bwd_buchung_nachber",
  "u_lod_bwd_buchung_netto",
  "u_lod_bwd_buchung_standard",
  "u_lod_bwd_buchung_stunden",
  "u_lod_bwd_buchung_tage",
  "u_lod_bwd_buchung_vorschuss",
];

/** The fields of u_lod_bwd_buchung_stunden / _tage: identical except for the quantity. */
const COMMON_FIELDS = [
  "abrechnung_zeitraum#bwd",
  "abw_allg_zuschlag#bwd",
  "abw_lohnfaktor#bwd",
  "arbeitsgang_nr#bwd",
  "auftrag_nr#bwd",
  "bemerkung#bwd",
  "benutzername#bwd",
  "kostenstelle#bwd",
  "kostentraeger#bwd",
  "la_eigene#bwd",
  "lohnver_proz_satz#bwd",
  "maschinen_nr#bwd",
  "pers_zuschlag#bwd",
  "pnr#bwd",
];
const OFFICIAL_FIELDS: Record<string, string[]> = {
  u_lod_bwd_buchung_stunden: [...COMMON_FIELDS, "stunden#bwd"],
  u_lod_bwd_buchung_tage: [...COMMON_FIELDS, "tage#bwd"],
};

/** Identifiers the volltext search found ZERO times in the official list. */
const NOT_IN_OFFICIAL_LIST = [
  "u_lod_bwd_buchung_kst",
  "ausfallkennzeichen",
  "u_lod_lna_nr",
  "name#bwd",
];

/** [Allgemein]: the keys and values the official list defines for our use. */
const OFFICIAL_ALLGEMEIN: Record<string, string | RegExp> = {
  Ziel: "LODAS",
  Version_SST: "1.0",
  Version_DB: "15.70",
  BeraterNr: /^\d{1,7}$/,
  MandantenNr: /^\d{1,5}$/,
  Datumsformat: "TTMMJJJJ",
  Stringbegrenzer: "'",
};

describe("Issue #304 - DATEV LODAS export against the official field list", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;
  let text: string;

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "lodas304");
    await configureDatevKanzlei(app, d.tenant.id);
    // Something for BOTH record types: worked hours (Stunden) and a vacation + sick leave (Tage).
    await app.prisma.timeEntry.create({
      data: {
        employeeId: d.employee.id,
        date: new Date("2026-04-07T00:00:00.000Z"),
        startTime: new Date("2026-04-07T07:00:00.000Z"),
        endTime: new Date("2026-04-07T15:30:00.000Z"),
        breakMinutes: 30,
        type: "WORK",
        source: "MANUAL",
        salonId: d.salonId,
      },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: d.employee.id,
        leaveTypeId: d.vacationType.id,
        startDate: new Date("2026-04-13T00:00:00.000Z"),
        endDate: new Date("2026-04-15T00:00:00.000Z"),
        days: 3,
        status: "APPROVED",
      },
    });
    const sick = await app.prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: d.employee.id,
        leaveTypeId: sick.id,
        startDate: new Date("2026-04-20T00:00:00.000Z"),
        endDate: new Date("2026-04-21T00:00:00.000Z"),
        days: 2,
        status: "APPROVED",
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=4",
      headers: { authorization: `Bearer ${d.adminToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    text = decodeDatev(res.rawPayload);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("[Allgemein] carries exactly the official keys with the official values", () => {
    const lines = datevSectionLines(text, "Allgemein");
    const entries = lines.map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)] as const;
    });
    expect(entries.map(([k]) => k).sort()).toEqual(Object.keys(OFFICIAL_ALLGEMEIN).sort());
    for (const [key, value] of entries) {
      const expected = OFFICIAL_ALLGEMEIN[key]!;
      if (typeof expected === "string") expect(value, key).toBe(expected);
      else expect(value, key).toMatch(expected);
    }
    // The German placeholders of the Datumsformat (T/M/J), not DD/MM/JJJJ.
    expect(entries.find(([k]) => k === "Datumsformat")![1]).toMatch(/^[TMJ]+$/);
  });

  it("[Satzbeschreibung] declares only official tables with only official fields, both record types, nothing invented", () => {
    const decl = datevSectionLines(text, "Satzbeschreibung").map((l) => l.split(";"));
    expect(decl.map((f) => f[1]).sort()).toEqual(
      ["u_lod_bwd_buchung_stunden", "u_lod_bwd_buchung_tage"].sort(),
    );
    // Distinct Satz-IDs, numeric.
    expect(new Set(decl.map((f) => f[0])).size).toBe(decl.length);
    for (const f of decl) expect(f[0]).toMatch(/^\d+$/);

    for (const [, table, ...fields] of decl) {
      expect(OFFICIAL_BWD_TABLES, table).toContain(table);
      const official = OFFICIAL_FIELDS[table!]!;
      expect(official, table).toBeDefined();
      for (const field of fields) expect(official, `${table}.${field}`).toContain(field);
      // No field twice.
      expect(new Set(fields).size).toBe(fields.length);
      // The fields this export needs are all present.
      for (const needed of ["pnr#bwd", "abrechnung_zeitraum#bwd", "la_eigene#bwd"]) {
        expect(fields, `${table} needs ${needed}`).toContain(needed);
      }
    }
    const stunden = decl.find((f) => f[1] === "u_lod_bwd_buchung_stunden")!;
    const tage = decl.find((f) => f[1] === "u_lod_bwd_buchung_tage")!;
    expect(stunden).toContain("stunden#bwd");
    expect(stunden).not.toContain("tage#bwd");
    expect(tage).toContain("tage#bwd");
    expect(tage).not.toContain("stunden#bwd");

    for (const forbidden of NOT_IN_OFFICIAL_LIST) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("every data row belongs to a declared record and fills every declared field in the official shape", () => {
    const decl = new Map(
      datevSectionLines(text, "Satzbeschreibung").map((l) => {
        const [id, table, ...fields] = l.split(";");
        return [id!, { table: table!, fields }] as const;
      }),
    );
    const rows = datevSectionLines(text, "Bewegungsdaten").map((l) => l.split(";"));
    expect(rows.length).toBeGreaterThan(0);

    const seenTables = new Set<string>();
    for (const row of rows) {
      const record = decl.get(row[0]!);
      expect(record, `row ${row.join(";")} has an undeclared Satz-ID`).toBeDefined();
      seenTables.add(record!.table);
      // Satz-ID + exactly one value per declared field.
      expect(row.length - 1, row.join(";")).toBe(record!.fields.length);

      record!.fields.forEach((field, i) => {
        const value = row[i + 1]!;
        const raw = value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
        switch (field) {
          case "pnr#bwd":
            expect(raw).toMatch(/^\d+$/);
            break;
          case "abrechnung_zeitraum#bwd":
            // Datumsformat TTMMJJJJ: first day of the exported month (April 2026).
            expect(raw).toBe("01042026");
            break;
          case "la_eigene#bwd":
            expect(raw).toMatch(/^\d+$/);
            break;
          case "stunden#bwd":
            expect(raw).toMatch(/^\d+,\d{2}$/);
            expect(Number(raw.replace(",", ".")), "no zero booking").toBeGreaterThan(0);
            break;
          case "tage#bwd":
            expect(raw).toMatch(/^\d+,\d$/);
            expect(Number(raw.replace(",", ".")), "no zero booking").toBeGreaterThan(0);
            break;
          default:
            throw new Error(`unexpected field ${field}`);
        }
        // The Stringbegrenzer rule: an alphanumeric value must be wrapped in it.
        if (!/^[\d,]+$/.test(raw)) {
          expect(value.startsWith("'") && value.endsWith("'"), `${field} is alphanumeric`).toBe(
            true,
          );
        }
      });
    }
    // Not vacuous: the fixture produces a row of EVERY record type.
    expect([...seenTables].sort()).toEqual(["u_lod_bwd_buchung_stunden", "u_lod_bwd_buchung_tage"]);
  });

  it("no booking line with quantity 0 and no Normalstunden line for a person without worked time", async () => {
    const bare = await seedTestData(app, "lodas304bare");
    try {
      await configureDatevKanzlei(app, bare.tenant.id);
      // Only a vacation, no worked hours.
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: bare.employee.id,
          leaveTypeId: bare.vacationType.id,
          startDate: new Date("2026-04-13T00:00:00.000Z"),
          endDate: new Date("2026-04-14T00:00:00.000Z"),
          days: 2,
          status: "APPROVED",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${bare.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = datevSectionLines(decodeDatev(res.rawPayload), "Bewegungsdaten");
      expect(rows.length).toBeGreaterThan(0);
      // Only Tage rows; not one Stunden row (20), not one zero quantity.
      expect(rows.every((r) => r.startsWith("21;"))).toBe(true);
      for (const r of rows) expect(Number(r.split(";")[4]!.replace(",", "."))).toBeGreaterThan(0);
    } finally {
      await cleanupTestData(app, bare.tenant.id);
    }
  });

  describe("non-numeric personnel number (pnr#bwd is numeric)", () => {
    let t: Awaited<ReturnType<typeof seedTestData>>;
    let badNumber: string;

    beforeAll(async () => {
      t = await seedTestData(app, "lodas304pnr");
      await configureDatevKanzlei(app, t.tenant.id);
      badNumber = `ABC-${Date.now().toString(36)}`;
      await app.prisma.employee.update({
        where: { id: t.employee.id },
        data: { employeeNumber: badNumber },
      });
    });

    afterAll(async () => {
      await cleanupTestData(app, t.tenant.id);
    });

    it("the company export refuses with 422, lists the employee NUMBERS only and writes no file", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${t.adminToken}` },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body) as {
        error: string;
        code: string;
        employeeNumbers: string[];
      };
      expect(body.code).toBe("DATEV_PNR_INVALID");
      expect(body.employeeNumbers).toEqual([badNumber]);
      // Never a name.
      expect(res.body).not.toContain("Max");
      expect(res.body).not.toContain("Test");
      expect(res.headers["content-disposition"]).toBeUndefined();
    });

    it("the per-employee export refuses the same way", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev/employee?employeeId=${t.employee.id}&year=2026&month=4`,
        headers: { authorization: `Bearer ${t.adminToken}` },
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).employeeNumbers).toEqual([badNumber]);
    });

    it("a numeric number (leading zeros kept) is exported", async () => {
      await app.prisma.employee.update({
        where: { id: t.employee.id },
        data: { employeeNumber: "00123" },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: t.employee.id,
          date: new Date("2026-04-07T00:00:00.000Z"),
          startTime: new Date("2026-04-07T07:00:00.000Z"),
          endTime: new Date("2026-04-07T15:00:00.000Z"),
          breakMinutes: 0,
          type: "WORK",
          source: "MANUAL",
          salonId: t.salonId,
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/datev?year=2026&month=4",
        headers: { authorization: `Bearer ${t.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const rows = datevSectionLines(decodeDatev(res.rawPayload), "Bewegungsdaten");
      expect(rows.some((r) => r.split(";")[1] === "00123")).toBe(true);
    });
  });
});
