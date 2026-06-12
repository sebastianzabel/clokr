// Phase 78 Plan 04 — DATEV LODAS byte-equivalence snapshot (TEST-V19-01)
//
// ── CONTEXT D-09 ("DATEV byte-equivalence in separater file") ──
//
// This file pins the DATEV LODAS payroll export bytes for a deterministic
// Azubi+BS scenario. Any future code change that perturbs the on-the-wire
// DATEV output (CRLF framing, CP1252 encoding, field ordering, decimal-comma
// formatting, Lohnartennummern, Bewegungsdaten rows) surfaces as a snapshot
// diff in PR review.
//
// This mitigates PITFALLS L-1 (silent DATEV regression) — the export is a
// payroll-relevant byte stream that customers' tax advisors import directly
// into LODAS, so a one-byte drift can corrupt a whole company's Lohnabrechnung
// without anyone noticing until the next audit.
//
// ── SCENARIO ──
//
// Single deterministic Azubi:
//   - FIXED_SCHEDULE, 40h/week, Mo-Fr 8h
//   - hire 2024-01-01
//   - 2 Berufsschule (BS) days in May 2026: 2026-05-04 (Mo) and 2026-05-11 (Mo)
//   - 8 TimeEntries on Tue-Fri of weeks 2+3 (May 5/6/7/8 and May 12/13/14/15),
//     each 8h 07:00→15:00 UTC (no break) — fully deterministic minutes
//
// ── NORMALIZATION ──
//
// The DATEV output for this scenario is fully deterministic (no embedded
// "generated at" timestamp or run-ID — only the Abrechnungszeitraum=MMYYYY
// derived from the query params, plus Kalendertag = last day of month).
// We still scrub any ISO timestamp to FIXED_TIMESTAMP_2026_06_01 as a
// defensive measure for forward-compat in case future versions add a header.
//
// No PII — initials only (memory feedback_no_pii_in_github).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "./setup";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { AbsenceType } from "@clokr/db";

// Pin "now" defensively — DATEV export does not embed Date.now(), but if a
// future change does, this keeps the snapshot stable.
const FIXED_TIMESTAMP_2026_06_01 = "2026-06-01T08:00:00.000Z";

// ISO timestamp scrubber — replaces any 2020-2099 ISO-8601 timestamp with a
// fixed placeholder so accidental Date.now() leaks become visible as a stable
// snapshot diff rather than a flaky moving target.
const ISO_TIMESTAMP_RE = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;

function normalize(s: string): string {
  return s.replace(ISO_TIMESTAMP_RE, "FIXED_TIMESTAMP_2026_06_01");
}

describe("DATEV LODAS byte-equivalence snapshot (Phase 78 Plan 04) — TEST-V19-01", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminToken: string;

  beforeAll(async () => {
    app = await getTestApp();

    const prisma = app.prisma;
    const s = "datev-snap";

    const tenant = await prisma.tenant.create({
      data: {
        name: `DS ${s}`,
        slug: `ds-${s}-${Date.now().toString(36)}`,
        federalState: "NIEDERSACHSEN",
      },
    });
    tenantId = tenant.id;

    await prisma.tenantConfig.create({
      data: {
        tenantId: tenant.id,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        vocationalSchoolMinutesPerDay: 480,
        vocationalSchoolBlockMinutesPerWeek: 2400,
        // Pin the DATEV Lohnartennummern to defaults so snapshot is stable
        datevNormalstundenNr: 100,
        datevUrlaubNr: 300,
        datevKrankNr: 200,
        datevSonderurlaubNr: 302,
      },
    });

    // Admin user + token
    const adminUser = await prisma.user.create({
      data: {
        email: `admin-${s}-${Date.now().toString(36)}@example.test`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "ADMIN",
        isActive: true,
      },
    });
    await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: adminUser.id,
        employeeNumber: `ADM-${s}`,
        firstName: "A.",
        lastName: "D.",
        hireDate: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
    adminToken = app.jwt.sign({
      sub: adminUser.id,
      role: "ADMIN",
      tenantId: tenant.id,
    });

    // Azubi employee with deterministic identity for snapshot stability.
    // Initials only — NO PII (memory feedback_no_pii_in_github).
    const empUser = await prisma.user.create({
      data: {
        email: `azubi-${s}-${Date.now().toString(36)}@example.test`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const emp = await prisma.employee.create({
      data: {
        tenantId: tenant.id,
        userId: empUser.id,
        // Fixed employeeNumber so snapshot is stable across runs
        employeeNumber: "AZ-001",
        firstName: "A.",
        lastName: "Z.",
        hireDate: new Date("2024-01-01T00:00:00.000Z"),
      },
    });

    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2024-01-01T00:00:00.000Z"),
      },
    });

    // ── 2 Berufsschule (BS) days: Monday week 2 (2026-05-04) and Monday week 3 (2026-05-11) ──
    for (const iso of ["2026-05-04T00:00:00.000Z", "2026-05-11T00:00:00.000Z"]) {
      await prisma.absence.create({
        data: {
          employeeId: emp.id,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          startDate: new Date(iso),
          endDate: new Date(iso),
          days: 1,
          createdBy: adminUser.id,
        },
      });
    }

    // ── 8 TimeEntries on Tue-Fri of weeks 2+3 ──
    // Each 8h, 07:00 → 15:00 UTC, no break → 480 worked minutes/day → 64 worked hours total
    const workDays = [
      "2026-05-05", // Tue W2
      "2026-05-06", // Wed W2
      "2026-05-07", // Thu W2
      "2026-05-08", // Fri W2
      "2026-05-12", // Tue W3
      "2026-05-13", // Wed W3
      "2026-05-14", // Thu W3
      "2026-05-15", // Fri W3
    ];
    for (const d of workDays) {
      await prisma.timeEntry.create({
        data: {
          employeeId: emp.id,
          date: new Date(`${d}T00:00:00.000Z`),
          startTime: new Date(`${d}T07:00:00.000Z`),
          endTime: new Date(`${d}T15:00:00.000Z`),
          breakMinutes: 0,
        },
      });
    }
  });

  afterAll(async () => {
    if (tenantId) {
      try {
        await cleanupTestData(app, tenantId);
      } catch (err) {
        console.error("DATEV snapshot test cleanup failed:", err);
      }
    }
    await closeTestApp();
  });

  it("DATEV LODAS export bytes match snapshot for Azubi+BS May 2026 scenario", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reports/datev?year=2026&month=5",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode, `DATEV export failed (status ${res.statusCode}): ${res.body}`).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");

    // Raw bytes — the on-the-wire payload customers' tax advisors will import.
    const rawBytes = res.rawPayload;
    // Decode CP1252 for human-readable snapshot
    const decoded = iconv.decode(rawBytes, "win1252");
    const normalized = normalize(decoded);

    // SHA-256 of the raw bytes gives us a true byte-equivalence anchor:
    // any single-byte drift in the CP1252 output changes this digest.
    const sha256 = createHash("sha256").update(rawBytes).digest("hex");

    expect({
      contentType: res.headers["content-type"],
      contentDisposition: res.headers["content-disposition"],
      byteLength: rawBytes.length,
      sha256,
      decoded: normalized,
    }).toMatchSnapshot();
  });
});
