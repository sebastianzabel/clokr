/**
 * Phase 100B Plan 12 (Wave 5, closing model) — focused integration test for the Abwesenheiten
 * `Absence` facade (A4/A5/A6 plus the three compliance functions).
 *
 * The centrepiece is the A4/A5 membership test below: it is what actually keeps the D-09 split
 * from being silently merged, not this file's prose or the facade module's own docblock. It was
 * seen RED twice (once per temporarily removed A5 filter — `type: { not: "VOCATIONAL_SCHOOL" }`
 * and separately `source: { not: "PATTERN" }`) before being committed green; both transcripts are
 * quoted verbatim in this plan's own SUMMARY.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  getAbsencesOverlapping,
  getRosterSollAbsencesOverlapping,
  getVocationalSchoolDays,
  hasVocationalSchoolDay,
  getAbsenceDocumentPaths,
  anonymizeAbsencesForEmployee,
  hardDeleteAbsencesForEmployee,
  archiveAbsencesBefore,
} from "../index";
import type { FastifyInstance } from "fastify";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

describe("Abwesenheiten facade — Absence (Phase 100B Plan 12)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "absences-facade");
    otherData = await seedTestData(app, "absences-facade-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── A4/A5 — the D-09 membership test (the actual guard, not the docblock) ─────────────────────

  describe("getAbsencesOverlapping (A4) vs getRosterSollAbsencesOverlapping (A5) — D-09", () => {
    // Window: 2027-03-01..2027-03-07. Far enough in the future to never collide with a real
    // fixture; deliberately NOT `new Date()`-relative so the fixture reads the same on any day.
    const windowFrom = utcDate(2027, 3, 1);
    const windowTo = utcDate(2027, 3, 7);

    let ordinaryId: string;
    let bsId: string;
    let patternId: string;
    let softDeletedId: string;

    beforeAll(async () => {
      const ordinary = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 3, 2),
          endDate: utcDate(2027, 3, 2),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      ordinaryId = ordinary.id;

      const bs = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          startDate: utcDate(2027, 3, 3),
          endDate: utcDate(2027, 3, 3),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      bsId = bs.id;

      const pattern = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          source: "PATTERN",
          startDate: utcDate(2027, 3, 4),
          endDate: utcDate(2027, 3, 4),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      patternId = pattern.id;

      const softDeleted = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 3, 5),
          endDate: utcDate(2027, 3, 5),
          days: 1,
          createdBy: "SYSTEM",
          deletedAt: new Date(),
        },
      });
      softDeletedId = softDeleted.id;
    });

    afterAll(async () => {
      await app.prisma.absence.deleteMany({
        where: { id: { in: [ordinaryId, bsId, patternId, softDeletedId] } },
      });
    });

    it("A4 (getAbsencesOverlapping) returns the ordinary, BS and PATTERN rows, excluding the soft-deleted one — exact set", async () => {
      const rows = await getAbsencesOverlapping(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        windowFrom,
        windowTo,
      );
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([ordinaryId, bsId, patternId].sort());
    });

    it("A5 (getRosterSollAbsencesOverlapping) returns ONLY the ordinary row — exact set", async () => {
      const rows = await getRosterSollAbsencesOverlapping(
        app.prisma,
        data.tenant.id,
        windowFrom,
        windowTo,
      );
      const ordinaryRow = rows.find((r) => r.employeeId === data.employee.id);
      expect(ordinaryRow).toBeDefined();
      // The exact-set assertion: exactly one row for this employee in the window (not 2 or 3).
      const rowsForEmployee = rows.filter((r) => r.employeeId === data.employee.id);
      expect(rowsForEmployee).toHaveLength(1);
      expect(
        rowsForEmployee[0].startDate.toISOString().slice(0, 10) ===
          utcDate(2027, 3, 2).toISOString().slice(0, 10),
      ).toBe(true);
    });

    it("A5 does NOT return the VOCATIONAL_SCHOOL row — removing the type filter would make this fail (seen RED, see this plan's SUMMARY)", async () => {
      const rows = await getRosterSollAbsencesOverlapping(
        app.prisma,
        data.tenant.id,
        windowFrom,
        windowTo,
      );
      // Cross-check against A4, which DOES include the BS row for the same employee/window —
      // proving the two functions genuinely diverge on the same underlying data, not just in name.
      const a4Rows = await getAbsencesOverlapping(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        windowFrom,
        windowTo,
      );
      expect(a4Rows.some((r) => r.id === bsId)).toBe(true);
      expect(
        rows.some(
          (r) =>
            r.employeeId === data.employee.id &&
            r.startDate.getTime() === utcDate(2027, 3, 3).getTime(),
        ),
      ).toBe(false);
    });

    it("A5 does NOT return the PATTERN-source row — removing the source filter would make this fail (seen RED, see this plan's SUMMARY)", async () => {
      const rows = await getRosterSollAbsencesOverlapping(
        app.prisma,
        data.tenant.id,
        windowFrom,
        windowTo,
      );
      const a4Rows = await getAbsencesOverlapping(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        windowFrom,
        windowTo,
      );
      expect(a4Rows.some((r) => r.id === patternId)).toBe(true);
      expect(
        rows.some(
          (r) =>
            r.employeeId === data.employee.id &&
            r.startDate.getTime() === utcDate(2027, 3, 4).getTime(),
        ),
      ).toBe(false);
    });

    it("A4 does not see another tenant's absence in the same window (tenant scope)", async () => {
      const other = await app.prisma.absence.create({
        data: {
          employeeId: otherData.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 3, 2),
          endDate: utcDate(2027, 3, 2),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      try {
        const tenantWide = await getAbsencesOverlapping(
          app.prisma,
          { kind: "tenant", tenantId: data.tenant.id },
          windowFrom,
          windowTo,
        );
        expect(tenantWide.some((r) => r.id === other.id)).toBe(false);
      } finally {
        await app.prisma.absence.delete({ where: { id: other.id } });
      }
    });
  });

  // ── A6 — VOCATIONAL_SCHOOL-only reads ───────────────────────────────────────────────────────

  describe("getVocationalSchoolDays / hasVocationalSchoolDay (A6)", () => {
    const from = utcDate(2027, 4, 5); // a Monday
    const to = utcDate(2027, 4, 11); // the following Sunday
    let bsId: string;
    let ordinaryId: string;

    beforeAll(async () => {
      const bs = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "VOCATIONAL_SCHOOL",
          startDate: utcDate(2027, 4, 6),
          endDate: utcDate(2027, 4, 6),
          days: 1,
          createdBy: "SYSTEM",
          unterrichtsMinutes: 300,
        },
      });
      bsId = bs.id;

      const ordinary = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 4, 7),
          endDate: utcDate(2027, 4, 7),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      ordinaryId = ordinary.id;
    });

    afterAll(async () => {
      await app.prisma.absence.deleteMany({ where: { id: { in: [bsId, ordinaryId] } } });
    });

    it("returns only the VOCATIONAL_SCHOOL row in the window", async () => {
      const rows = await getVocationalSchoolDays(
        app.prisma,
        { kind: "employee", employeeId: data.employee.id, tenantId: data.tenant.id },
        from,
        to,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].employeeId).toBe(data.employee.id);
      expect(rows[0].unterrichtsMinutes).toBe(300);
    });

    it("hasVocationalSchoolDay is true on the BS day and false on the ordinary-absence day", async () => {
      expect(
        await hasVocationalSchoolDay(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          utcDate(2027, 4, 6),
        ),
      ).toBe(true);
      expect(
        await hasVocationalSchoolDay(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          utcDate(2027, 4, 7),
        ),
      ).toBe(false);
    });

    it("getVocationalSchoolDays supports the bulk employees scope (sync-shifts.ts's shape)", async () => {
      const rows = await getVocationalSchoolDays(
        app.prisma,
        {
          kind: "employees",
          employeeIds: [data.employee.id, otherData.employee.id],
          tenantId: data.tenant.id,
        },
        from,
        to,
      );
      expect(rows.map((r) => r.employeeId)).toEqual([data.employee.id]);
    });
  });

  // ── Compliance slices (D-08) ─────────────────────────────────────────────────────────────────

  describe("getAbsenceDocumentPaths — reaches soft-deleted rows (CONTEXT.md's named case)", () => {
    let visibleId: string;
    let softDeletedId: string;

    beforeAll(async () => {
      const visible = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 5, 1),
          endDate: utcDate(2027, 5, 1),
          days: 1,
          createdBy: "SYSTEM",
          documentPath: "au-certs/visible.pdf",
        },
      });
      visibleId = visible.id;

      const softDeleted = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 5, 2),
          endDate: utcDate(2027, 5, 2),
          days: 1,
          createdBy: "SYSTEM",
          documentPath: "au-certs/soft-deleted.pdf",
          deletedAt: new Date(),
        },
      });
      softDeletedId = softDeleted.id;
    });

    afterAll(async () => {
      await app.prisma.absence.deleteMany({ where: { id: { in: [visibleId, softDeletedId] } } });
    });

    it("returns the document path of BOTH the visible and the soft-deleted row — the concrete Art. 17 requirement", async () => {
      const paths = (await getAbsenceDocumentPaths(app.prisma, data.employee.id)).map(
        (r) => r.documentPath,
      );
      expect(paths).toContain("au-certs/visible.pdf");
      expect(paths).toContain("au-certs/soft-deleted.pdf");
    });
  });

  describe("anonymizeAbsencesForEmployee — reaches soft-deleted rows too", () => {
    it("nulls note and documentPath on a soft-deleted row", async () => {
      const row = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2027, 5, 10),
          endDate: utcDate(2027, 5, 10),
          days: 1,
          createdBy: "SYSTEM",
          note: "vertraulich",
          documentPath: "au-certs/anon-me.pdf",
          deletedAt: new Date(),
        },
      });
      try {
        await app.prisma.$transaction(async (tx) => {
          await anonymizeAbsencesForEmployee(tx, data.employee.id);
        });
        const after = await app.prisma.absence.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.note).toBeNull();
        expect(after.documentPath).toBeNull();
        expect(after.deletedAt).not.toBeNull(); // anonymisation does not touch deletedAt
      } finally {
        await app.prisma.absence.delete({ where: { id: row.id } });
      }
    });
  });

  describe("hardDeleteAbsencesForEmployee", () => {
    it("removes every Absence row for the employee, including soft-deleted ones", async () => {
      // Reuses otherData.employee (a full seeded employee incl. its own User/Tenant) rather than
      // hand-constructing a bare Employee row — `employee.user` is a required relation the bare
      // `employee.create` fixture above does not satisfy. otherData is not used by any other
      // describe block in this file, so a hard-delete against it here is safe.
      const employeeId = otherData.employee.id;
      await app.prisma.absence.create({
        data: {
          employeeId,
          type: "SICK",
          startDate: utcDate(2027, 6, 1),
          endDate: utcDate(2027, 6, 1),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      await app.prisma.absence.create({
        data: {
          employeeId,
          type: "SICK",
          startDate: utcDate(2027, 6, 2),
          endDate: utcDate(2027, 6, 2),
          days: 1,
          createdBy: "SYSTEM",
          deletedAt: new Date(),
        },
      });

      await app.prisma.$transaction(async (tx) => {
        await hardDeleteAbsencesForEmployee(tx, employeeId);
      });

      const remaining = await app.prisma.absence.findMany({ where: { employeeId } });
      expect(remaining).toHaveLength(0);
    });
  });

  describe("archiveAbsencesBefore — idempotent (D-08's IDEMPOTENCY guard, not a soft-delete filter)", () => {
    it("running it twice archives the same rows once, not twice", async () => {
      const row = await app.prisma.absence.create({
        data: {
          employeeId: data.employee.id,
          type: "SICK",
          startDate: utcDate(2020, 1, 1),
          endDate: utcDate(2020, 1, 1),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      try {
        const cutoff = utcDate(2020, 12, 31);
        const firstRun = await archiveAbsencesBefore(
          app.prisma,
          [data.employee.id],
          data.tenant.id,
          cutoff,
        );
        expect(firstRun).toBeGreaterThanOrEqual(1);

        const afterFirst = await app.prisma.absence.findUniqueOrThrow({ where: { id: row.id } });
        expect(afterFirst.deletedAt).not.toBeNull();

        // Second run must NOT re-count (and, by extension, re-log) the already-archived row —
        // that is what the `deletedAt: null` idempotency guard in the facade's own `where` buys.
        const secondRun = await archiveAbsencesBefore(
          app.prisma,
          [data.employee.id],
          data.tenant.id,
          cutoff,
        );
        expect(secondRun).toBe(0);
      } finally {
        await app.prisma.absence.delete({ where: { id: row.id } });
      }
    });

    it("does not archive another tenant's absence even with a matching cutoff", async () => {
      const row = await app.prisma.absence.create({
        data: {
          employeeId: otherData.employee.id,
          type: "SICK",
          startDate: utcDate(2020, 1, 1),
          endDate: utcDate(2020, 1, 1),
          days: 1,
          createdBy: "SYSTEM",
        },
      });
      try {
        const cutoff = utcDate(2020, 12, 31);
        await archiveAbsencesBefore(app.prisma, [otherData.employee.id], data.tenant.id, cutoff);
        const after = await app.prisma.absence.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.deletedAt).toBeNull();
      } finally {
        await app.prisma.absence.delete({ where: { id: row.id } });
      }
    });
  });
});
