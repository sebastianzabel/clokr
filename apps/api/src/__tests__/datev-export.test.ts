/**
 * datev-export.test.ts — dedicated coverage for the DATEV Ausfalltage export
 * (GET /api/v1/reports/datev, GET /api/v1/reports/datev/employee).
 *
 * Phase 104's RESEARCH.md noted that `find -iname "*datev*"` returns no dedicated test
 * FILE for this payroll-relevant endpoint — the pre-existing coverage (DATEV-01..04,
 * apps/api/src/routes/__tests__/reports.test.ts) lives inside the general reports test
 * file, not under its own name. This file gives the export a home of its own and,
 * because a payroll figure that goes to a tax advisor under the §-147-AO ten-year
 * retention bucket deserves more than incidental coverage, pins the line shape, the
 * Lohnart numbers and the German decimal formatting as an explicit BASELINE (Tests 4-6)
 * before adding the § 9 BUrlG correction on top (Test 3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import iconv from "iconv-lite";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { DATEV_BWD_SATZ_ID } from "../composition/reports";
import type { FastifyInstance } from "fastify";

// Issue #256 (Befund 1): a Bewegungsdaten row is the Satz-ID followed by the 12 values
// declared in [Satzbeschreibung] — 13 fields in total. Named offsets instead of bare
// indices, so the next shift of the row shape breaks a name, not a silent off-by-one.
const F_SATZ_ID = 0;
const F_AUSFALL = 4;
const F_LOHNART = 5;
const F_STUNDEN = 6;
const F_TAGE = 7;
const DATA_ROW_FIELDS = 13;

describe("DATEV export — FIRST automated coverage in its own file (Phase 104)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  // ── Test 3: § 9 BUrlG conservation (the payroll case) ────────────────────────
  describe("§ 9 BUrlG conservation (T-104-09-PAYROLL)", () => {
    let d: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      d = await seedTestData(app, "datev-s9");
    });

    afterAll(async () => {
      try {
        await app.prisma.section9Credit.deleteMany({ where: { employeeId: d.employee.id } });
        await cleanupTestData(app, d.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    async function createRequest(payload: Record<string, unknown>) {
      return app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${d.empToken}` },
        payload,
      });
    }
    async function approve(id: string) {
      return app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${id}/review`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: { status: "APPROVED" },
      });
    }

    it("Test 3: a confirmed credit reduces the Urlaub line's tage and increases Krankheit's by the same amount — the sum is conserved", async () => {
      // 2026-06-01 (Mon) .. 2026-06-05 (Fri) — 5 work days, no weekend inside the range.
      const vac = await createRequest({
        type: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-05",
      });
      expect(vac.statusCode).toBe(201);
      const vacId = JSON.parse(vac.body).id as string;
      expect((await approve(vacId)).statusCode).toBe(200);

      const sick = await createRequest({
        type: "SICK",
        startDate: "2026-06-03", // Wed
        endDate: "2026-06-04", // Thu — overlaps
      });
      expect(sick.statusCode).toBe(201);
      const sickId = JSON.parse(sick.body).id as string;
      expect((await approve(sickId)).statusCode).toBe(200);

      const credit = await app.prisma.section9Credit.findFirstOrThrow({
        where: { sickRequestId: sickId },
      });
      const confirmRes = await app.inject({
        method: "POST",
        url: `/api/v1/leave/section9/${credit.id}/confirm`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: {
          attestSource: "EAU",
          attestValidFrom: "2026-06-03",
          attestValidTo: "2026-06-04",
          reason: "AU für Mi/Do eingereicht",
        },
      });
      expect(confirmRes.statusCode).toBe(200);
      expect(JSON.parse(confirmRes.body).creditedDays).toBe(2);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev/employee?employeeId=${d.employee.id}&year=2026&month=6`,
        headers: { authorization: `Bearer ${d.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = iconv.decode(res.rawPayload, "win1252");
      const rows = body
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0);

      const urlaubRow = rows.find((r) => r.includes(";U;") && r.split(";")[F_LOHNART] === "300");
      const krankRow = rows.find((r) => r.includes(";K;") && r.split(";")[F_LOHNART] === "200");
      expect(urlaubRow).toBeDefined();
      expect(krankRow).toBeDefined();

      const urlaubTage = Number(urlaubRow!.split(";")[F_TAGE].replace(",", "."));
      const krankTage = Number(krankRow!.split(";")[F_TAGE].replace(",", "."));
      // Without the fix: urlaubTage=5, krankTage=0 (the credited days double-booked
      // under Urlaub only). With the fix: 5-2=3 and 0+2=2 — the sum is conserved.
      expect(urlaubTage).toBe(3);
      expect(krankTage).toBe(2);
      expect(urlaubTage + krankTage).toBe(5);
    });
  });

  // ── Tests 4-6: format baseline, independent of § 9 ───────────────────────────
  describe("Line shape, Lohnart numbers and German decimal formatting (baseline)", () => {
    let d: Awaited<ReturnType<typeof seedTestData>>;

    beforeAll(async () => {
      d = await seedTestData(app, "datev-baseline");

      await app.prisma.tenantConfig.update({
        where: { tenantId: d.tenant.id },
        data: {
          datevNormalstundenNr: 111,
          datevUrlaubNr: 222,
          datevKrankNr: 333,
          datevSonderurlaubNr: 444,
        },
      });

      // Worked time entry: 2026-07-01, 07:00-15:30, no break -> 8.5h.
      await app.prisma.timeEntry.create({
        data: {
          employeeId: d.employee.id,
          date: new Date("2026-07-01T00:00:00.000Z"),
          startTime: new Date("2026-07-01T07:00:00.000Z"),
          endTime: new Date("2026-07-01T15:30:00.000Z"),
          breakMinutes: 0,
        },
      });

      // One full-day vacation (Urlaub) — a plain, non-§9 case.
      const vac = await app.inject({
        method: "POST",
        url: "/api/v1/leave/requests",
        headers: { authorization: `Bearer ${d.empToken}` },
        payload: { type: "VACATION", startDate: "2026-07-08", endDate: "2026-07-08" },
      });
      expect(vac.statusCode).toBe(201);
      await app.inject({
        method: "PATCH",
        url: `/api/v1/leave/requests/${JSON.parse(vac.body).id}/review`,
        headers: { authorization: `Bearer ${d.adminToken}` },
        payload: { status: "APPROVED" },
      });

      // One half-day sick LeaveRequest (D-06), created directly through Prisma — exercises
      // dec()'s half-day rendering (Test 6). Issue #210: the export now sources Krank
      // from LeaveRequest, not Absence, so this baseline fixture moves accordingly.
      // Half-day sickness is rejected at all three API write paths (EFZG § 3/§ 4,
      // leave.ts:402/1610/1784), so a direct-Prisma fixture is the legitimate way to
      // stand in for a legacy row that predates that guard.
      const sickType = await app.prisma.leaveType.create({
        data: {
          tenantId: d.tenant.id,
          ...leaveTypeFields("SICK"),
          color: "#EF4444",
        },
      });
      await app.prisma.leaveRequest.create({
        data: {
          employeeId: d.employee.id,
          leaveTypeId: sickType.id,
          startDate: new Date("2026-07-15T00:00:00.000Z"), // Wednesday
          endDate: new Date("2026-07-15T00:00:00.000Z"),
          halfDay: true,
          days: 0.5,
          status: "APPROVED",
        },
      });
    });

    afterAll(async () => {
      try {
        await cleanupTestData(app, d.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    });

    it("Test 4 (baseline): 12-field semicolon lines with the configured Lohnart numbers for worked hours + vacation + sick", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev/employee?employeeId=${d.employee.id}&year=2026&month=7`,
        headers: { authorization: `Bearer ${d.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toContain(".txt");

      const body = iconv.decode(res.rawPayload, "win1252");
      expect(body).toContain("[Allgemein]");
      expect(body).toContain("[Satzbeschreibung]");
      expect(body).toContain("[Bewegungsdaten]");
      // Sections appear in this exact order.
      expect(body.indexOf("[Allgemein]")).toBeLessThan(body.indexOf("[Satzbeschreibung]"));
      expect(body.indexOf("[Satzbeschreibung]")).toBeLessThan(body.indexOf("[Bewegungsdaten]"));
      expect(body).toContain("Abrechnungszeitraum=072026");

      const rows = body
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0);

      // Every data row has exactly 13 semicolon-separated fields: Satz-ID + 12 values.
      for (const r of rows) {
        expect(r.split(";").length).toBe(DATA_ROW_FIELDS);
      }

      const normalRow = rows.find((r) => r.split(";")[F_LOHNART] === "111");
      const urlaubRow = rows.find((r) => r.split(";")[F_LOHNART] === "222");
      expect(normalRow).toBeDefined();
      expect(urlaubRow).toBeDefined();
      expect(normalRow!.split(";")[F_STUNDEN]).toBe("8,50");
      // Krankheit Lohnart 333 carries the half-day sick Absence (0.5 tage).
      const krankRow = rows.find((r) => r.split(";")[F_LOHNART] === "333");
      expect(krankRow).toBeDefined();
      expect(krankRow!.split(";")[F_TAGE]).toBe("0,5");
    });

    it("Test 5: an employee with no absences at all produces only the Normalstunden line", async () => {
      const bare = await seedTestData(app, "datev-bare");
      try {
        await app.prisma.timeEntry.create({
          data: {
            employeeId: bare.employee.id,
            date: new Date("2026-07-01T00:00:00.000Z"),
            startTime: new Date("2026-07-01T07:00:00.000Z"),
            endTime: new Date("2026-07-01T15:00:00.000Z"),
            breakMinutes: 0,
          },
        });

        const res = await app.inject({
          method: "GET",
          url: `/api/v1/reports/datev/employee?employeeId=${bare.employee.id}&year=2026&month=7`,
          headers: { authorization: `Bearer ${bare.adminToken}` },
        });
        expect(res.statusCode).toBe(200);
        const body = iconv.decode(res.rawPayload, "win1252");
        const rows = body
          .split("[Bewegungsdaten]")[1]
          .split("\r\n")
          .filter((l) => l.trim().length > 0);

        expect(rows.length).toBe(1);
        expect(rows[0].split(";")[F_AUSFALL]).toBe(""); // no Ausfallkennzeichen
        expect(rows[0].split(";")[F_TAGE]).toBe(""); // no tage
      } finally {
        await cleanupTestData(app, bare.tenant.id);
      }
    });

    it("Test 6: dec() uses a comma decimal separator and renders a half day as 0,5", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev/employee?employeeId=${d.employee.id}&year=2026&month=7`,
        headers: { authorization: `Bearer ${d.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = iconv.decode(res.rawPayload, "win1252");
      // No US-style decimal point ever appears in a numeric field.
      const rows = body
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0);
      for (const r of rows) {
        const fields = r.split(";");
        const stunden = fields[F_STUNDEN];
        const tage = fields[F_TAGE];
        if (stunden) expect(stunden).not.toContain(".");
        if (tage) expect(tage).not.toContain(".");
      }
      const krankRow = rows.find((r) => r.split(";")[F_LOHNART] === "333");
      expect(krankRow!.split(";")[F_TAGE]).toBe("0,5");
    });

    // ── Issue #256, Befund 1 ─────────────────────────────────────────────────
    it("Test 7 (#256-01): every Bewegungsdaten row starts with the Satz-ID declared in [Satzbeschreibung]", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/reports/datev/employee?employeeId=${d.employee.id}&year=2026&month=7`,
        headers: { authorization: `Bearer ${d.adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = iconv.decode(res.rawPayload, "win1252");

      const satzLine = body
        .split("[Satzbeschreibung]")[1]
        .split("\r\n")
        .find((l) => l.trim().length > 0);
      expect(satzLine).toBeDefined();

      // The declaration is: <Satz-ID>;<Satzname>;<field name>… — everything after the
      // first two fields names ONE value of a data row of that record type.
      const satzFields = satzLine!.split(";");
      expect(satzFields[F_SATZ_ID]).toBe(String(DATEV_BWD_SATZ_ID));
      const declaredValueCount = satzFields.length - 2;

      const rows = body
        .split("[Bewegungsdaten]")[1]
        .split("\r\n")
        .filter((l) => l.trim().length > 0);
      // Guard against a vacuous pass: this fixture has worked hours, Urlaub and Krank,
      // so it MUST produce rows. An empty export would otherwise satisfy every
      // assertion in the loop below without checking anything (Issues #235/#240/#245).
      expect(rows.length).toBeGreaterThan(0);

      for (const r of rows) {
        const fields = r.split(";");
        // Before the fix the row began with the Personalnummer, so this was the
        // employeeNumber, never "20".
        expect(fields[F_SATZ_ID]).toBe(String(DATEV_BWD_SATZ_ID));
        // …and the row carried 12 fields, one short of Satz-ID + 12 declared values,
        // which is exactly why every value sat one column left of its own header.
        expect(fields.length).toBe(1 + declaredValueCount);
      }
    });
  });
});
