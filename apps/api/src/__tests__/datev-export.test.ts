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
import type { FastifyInstance } from "fastify";

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

      const urlaubRow = rows.find((r) => r.includes(";U;") && r.split(";")[4] === "300");
      const krankRow = rows.find((r) => r.includes(";K;") && r.split(";")[4] === "200");
      expect(urlaubRow).toBeDefined();
      expect(krankRow).toBeDefined();

      // Field 7 (index 6) is `tage`.
      const urlaubTage = Number(urlaubRow!.split(";")[6].replace(",", "."));
      const krankTage = Number(krankRow!.split(";")[6].replace(",", "."));
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

      // One half-day sick Absence (D-06) — exercises dec()'s half-day rendering (Test 6).
      await app.prisma.absence.create({
        data: {
          employeeId: d.employee.id,
          type: "SICK",
          startDate: new Date("2026-07-15T00:00:00.000Z"),
          endDate: new Date("2026-07-15T00:00:00.000Z"),
          halfDay: true,
          days: 0.5,
          createdBy: d.adminUser.id,
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

      // Every data row has exactly 12 semicolon-separated fields.
      for (const r of rows) {
        expect(r.split(";").length).toBe(12);
      }

      const normalRow = rows.find((r) => r.split(";")[4] === "111");
      const urlaubRow = rows.find((r) => r.split(";")[4] === "222");
      expect(normalRow).toBeDefined();
      expect(urlaubRow).toBeDefined();
      // Field 6 (index 5) is `stunden`; the Normalstunden line carries 8.5h worked.
      expect(normalRow!.split(";")[5]).toBe("8,50");
      // Krankheit Lohnart 333 carries the half-day sick Absence (0.5 tage).
      const krankRow = rows.find((r) => r.split(";")[4] === "333");
      expect(krankRow).toBeDefined();
      expect(krankRow!.split(";")[6]).toBe("0,5");
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
        expect(rows[0].split(";")[3]).toBe(""); // no Ausfallkennzeichen
        expect(rows[0].split(";")[6]).toBe(""); // no tage
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
        const [, , , , , stunden, tage] = r.split(";");
        if (stunden) expect(stunden).not.toContain(".");
        if (tage) expect(tage).not.toContain(".");
      }
      const krankRow = rows.find((r) => r.split(";")[4] === "333");
      expect(krankRow!.split(";")[6]).toBe("0,5");
    });
  });
});
