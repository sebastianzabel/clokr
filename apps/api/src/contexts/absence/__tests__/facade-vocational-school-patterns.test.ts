/**
 * Phase 100B Plan 11 (Wave 5) — focused integration test for the Abwesenheiten
 * `EmployeeVocationalSchoolPattern` (A20/A21a/A21b) and `Section9Credit` (A22 + the two DSGVO
 * compliance functions) facades.
 *
 * Named after the pattern facade per this plan's `files_modified` — covers both new facade files
 * in one place, matching Plan 10's `facade-entitlements.test.ts` (which likewise tested both
 * `leave-types.ts` and `entitlements.ts` in one file).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../../__tests__/setup";
import {
  getActiveBsPattern,
  listActiveBsPatternsForWeek,
  listActiveBsPatternsWithFederalStateOverride,
  getConfirmedSection9Credits,
  getSection9DocumentPaths,
  anonymizeSection9CreditsForEmployee,
} from "../index";
import type { FastifyInstance } from "fastify";

// ── Date helpers (dynamic — never a hardcoded absolute date, per this project's own
//    documented history of date-hardcoded tests turning into time bombs) ────────────────────────

function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

// 103-BEFUND.md § "Zweiter Befund" — the measured real-world tie: same validFrom, createdAt 41
// days apart. Reused verbatim as the fixture shape (see vocational-school-pattern-historisation.test.ts).
const TIE_CREATEDAT_GAP_MS = 41 * 24 * 60 * 60 * 1000;

interface CreatePatternOpts {
  validFrom: Date;
  validUntil?: Date | null;
  createdAt?: Date;
  isActive?: boolean;
  federalStateOverride?: "NIEDERSACHSEN" | "BAYERN" | null;
  bsSlotFirstLongDayMinutes?: number | null;
}

async function createPattern(app: FastifyInstance, employeeId: string, opts: CreatePatternOpts) {
  return app.prisma.employeeVocationalSchoolPattern.create({
    data: {
      employeeId,
      daysOfWeek: [1],
      blockWeeks: [],
      validFrom: opts.validFrom,
      validUntil: opts.validUntil ?? null,
      isActive: opts.isActive ?? true,
      createdAt: opts.createdAt ?? new Date(),
      federalStateOverride: opts.federalStateOverride ?? null,
      bsSlotFirstLongDayMinutes: opts.bsSlotFirstLongDayMinutes ?? null,
    },
  });
}

describe("Abwesenheiten facade — EmployeeVocationalSchoolPattern / Section9Credit (Phase 100B Plan 11)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let otherData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-patterns-facade");
    otherData = await seedTestData(app, "vs-patterns-facade-other");
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: otherData.employee.id } });
      await cleanupTestData(app, data.tenant.id);
      await cleanupTestData(app, otherData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: { in: [data.employee.id, otherData.employee.id] } },
    });
  });

  // ── A20 — getActiveBsPattern ─────────────────────────────────────────────────────────────────

  describe("getActiveBsPattern (A20)", () => {
    it("returns null when the employee has no active pattern", async () => {
      const found = await getActiveBsPattern(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        todayUtc(),
      );
      expect(found).toBeNull();
    });

    it("resolves the pattern whose validFrom/validUntil window covers `at`", async () => {
      const oldFrom = addDaysUtc(todayUtc(), -100);
      const oldUntil = addDaysUtc(todayUtc(), -50);
      const newFrom = addDaysUtc(todayUtc(), -49);
      await createPattern(app, data.employee.id, {
        validFrom: oldFrom,
        validUntil: oldUntil,
        bsSlotFirstLongDayMinutes: 111,
      });
      await createPattern(app, data.employee.id, {
        validFrom: newFrom,
        validUntil: null,
        bsSlotFirstLongDayMinutes: 222,
      });

      const duringOld = await getActiveBsPattern(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        addDaysUtc(todayUtc(), -75),
      );
      expect(duringOld?.bsSlotFirstLongDayMinutes).toBe(111);

      const duringNew = await getActiveBsPattern(
        app.prisma,
        data.employee.id,
        data.tenant.id,
        todayUtc(),
      );
      expect(duringNew?.bsSlotFirstLongDayMinutes).toBe(222);
    });

    it("does not resolve a pattern belonging to a DIFFERENT tenant's employee", async () => {
      await createPattern(app, otherData.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -10),
      });
      const found = await getActiveBsPattern(
        app.prisma,
        otherData.employee.id,
        data.tenant.id, // WRONG tenant for this employee
        todayUtc(),
      );
      expect(found).toBeNull();
    });

    it("resolves a tied validFrom to the SAME winner (later createdAt) across 10 consecutive calls — Phase 103's determinism rule made an assertion, not a convention", async () => {
      const validFrom = addDaysUtc(todayUtc(), -70);
      const older = await createPattern(app, data.employee.id, {
        validFrom,
        createdAt: new Date(validFrom.getTime()),
        bsSlotFirstLongDayMinutes: 300,
      });
      const newer = await createPattern(app, data.employee.id, {
        validFrom,
        createdAt: new Date(validFrom.getTime() + TIE_CREATEDAT_GAP_MS),
        bsSlotFirstLongDayMinutes: 500,
      });

      const results: (number | null | undefined)[] = [];
      for (let i = 0; i < 10; i++) {
        const winner = await getActiveBsPattern(
          app.prisma,
          data.employee.id,
          data.tenant.id,
          validFrom,
        );
        results.push(winner?.bsSlotFirstLongDayMinutes);
      }

      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(500); // later-createdAt row wins, matching newer.id
      expect(newer.bsSlotFirstLongDayMinutes).toBe(500);
      expect(older.bsSlotFirstLongDayMinutes).toBe(300); // sanity: the two rows really differ
    });
  });

  // ── A21a — listActiveBsPatternsForWeek ───────────────────────────────────────────────────────

  describe("listActiveBsPatternsForWeek (A21a)", () => {
    it("returns only patterns whose validity window overlaps [from, to], for this tenant", async () => {
      const from = addDaysUtc(todayUtc(), -7);
      const to = todayUtc();
      await createPattern(app, data.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -3),
        validUntil: null,
        federalStateOverride: "BAYERN",
      });
      const outsideWindow = await createPattern(app, data.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -100),
        validUntil: addDaysUtc(todayUtc(), -50),
      });
      await createPattern(app, otherData.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -3),
      });

      const rows = await listActiveBsPatternsForWeek(app.prisma, data.tenant.id, from, to);

      expect(rows.some((r) => r.employeeId === data.employee.id)).toBe(true);
      expect(rows.some((r) => r.employeeId === otherData.employee.id)).toBe(false);
      // The out-of-window pattern must not appear even though it belongs to the same employee —
      // assert via count rather than id (this model has no natural id field on the projection).
      expect(rows.filter((r) => r.employeeId === data.employee.id)).toHaveLength(1);
      expect(outsideWindow.employeeId).toBe(data.employee.id); // sanity, same employee
    });
  });

  // ── A21b — listActiveBsPatternsWithFederalStateOverride ──────────────────────────────────────

  describe("listActiveBsPatternsWithFederalStateOverride (A21b)", () => {
    it("returns only active patterns with a non-null federalStateOverride, ignoring the date window entirely — the genuine divergence from A21a", async () => {
      await createPattern(app, data.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -3),
        federalStateOverride: "BAYERN",
      });
      // Deliberately FAR outside any week window — A21b must still see it (unlike A21a).
      await createPattern(app, data.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -900),
        validUntil: addDaysUtc(todayUtc(), -800),
        federalStateOverride: "NIEDERSACHSEN",
      });
      // No override at all — must be excluded.
      await createPattern(app, data.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -3),
        federalStateOverride: null,
      });
      await createPattern(app, otherData.employee.id, {
        validFrom: addDaysUtc(todayUtc(), -3),
        federalStateOverride: "BAYERN",
      });

      const rows = await listActiveBsPatternsWithFederalStateOverride(app.prisma, data.tenant.id);

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.federalStateOverride).sort()).toEqual(["BAYERN", "NIEDERSACHSEN"]);
    });
  });

  // ── Section9Credit fixtures ───────────────────────────────────────────────────────────────────

  async function createSection9Pair(
    ownerData: Awaited<ReturnType<typeof seedTestData>>,
    opts: {
      status: "AU_PENDING" | "CONFIRMED" | "REJECTED";
      overlapStart: Date;
      overlapEnd: Date;
      creditedStart?: Date | null;
      creditedEnd?: Date | null;
      documentPath?: string | null;
      reason?: string | null;
      offsetDays: number; // keeps every LeaveRequest pair's dates distinct across calls
    },
  ) {
    const sickType = await app.prisma.leaveType.upsert({
      where: { tenantId_code: { tenantId: ownerData.tenant.id, code: "SICK" } },
      update: {},
      create: {
        tenantId: ownerData.tenant.id,
        code: "SICK",
        name: "Krankmeldung",
        isPaid: true,
        requiresApproval: false,
      },
    });

    const base = addDaysUtc(todayUtc(), -200 + opts.offsetDays);
    const vacationRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: ownerData.employee.id,
        leaveTypeId: ownerData.vacationType.id,
        startDate: base,
        endDate: addDaysUtc(base, 4),
        days: 5,
        status: "APPROVED",
      },
    });
    const sickRequest = await app.prisma.leaveRequest.create({
      data: {
        employeeId: ownerData.employee.id,
        leaveTypeId: sickType.id,
        startDate: addDaysUtc(base, 1),
        endDate: addDaysUtc(base, 2),
        days: 2,
        status: "APPROVED",
      },
    });

    return app.prisma.section9Credit.create({
      data: {
        employeeId: ownerData.employee.id,
        sickRequestId: sickRequest.id,
        vacationRequestId: vacationRequest.id,
        overlapStart: opts.overlapStart,
        overlapEnd: opts.overlapEnd,
        status: opts.status,
        creditedStart: opts.creditedStart ?? null,
        creditedEnd: opts.creditedEnd ?? null,
        documentPath: opts.documentPath ?? null,
        reason: opts.reason ?? null,
      },
    });
  }

  // ── A22 — getConfirmedSection9Credits ────────────────────────────────────────────────────────

  describe("getConfirmedSection9Credits (A22)", () => {
    it("returns only CONFIRMED credits for this tenant whose credited range overlaps [from, to]", async () => {
      const from = addDaysUtc(todayUtc(), -210);
      const to = addDaysUtc(todayUtc(), -190);
      const confirmed = await createSection9Pair(data, {
        status: "CONFIRMED",
        overlapStart: addDaysUtc(todayUtc(), -199),
        overlapEnd: addDaysUtc(todayUtc(), -198),
        creditedStart: addDaysUtc(todayUtc(), -199),
        creditedEnd: addDaysUtc(todayUtc(), -198),
        offsetDays: 1,
      });
      await createSection9Pair(data, {
        status: "AU_PENDING",
        overlapStart: addDaysUtc(todayUtc(), -199),
        overlapEnd: addDaysUtc(todayUtc(), -198),
        offsetDays: 10,
      });
      await createSection9Pair(otherData, {
        status: "CONFIRMED",
        overlapStart: addDaysUtc(todayUtc(), -199),
        overlapEnd: addDaysUtc(todayUtc(), -198),
        creditedStart: addDaysUtc(todayUtc(), -199),
        creditedEnd: addDaysUtc(todayUtc(), -198),
        offsetDays: 20,
      });

      const rows = await getConfirmedSection9Credits(app.prisma, data.tenant.id, from, to);

      expect(rows).toHaveLength(1);
      expect(rows[0].employeeId).toBe(data.employee.id);
      expect(confirmed.status).toBe("CONFIRMED"); // sanity
    });
  });

  // ── getSection9DocumentPaths ──────────────────────────────────────────────────────────────────

  describe("getSection9DocumentPaths", () => {
    it("returns document paths for the employee regardless of status, excluding rows with no document", async () => {
      await createSection9Pair(data, {
        status: "AU_PENDING",
        overlapStart: addDaysUtc(todayUtc(), -50),
        overlapEnd: addDaysUtc(todayUtc(), -49),
        documentPath: "s9/pending.pdf",
        offsetDays: 30,
      });
      await createSection9Pair(data, {
        status: "REJECTED",
        overlapStart: addDaysUtc(todayUtc(), -50),
        overlapEnd: addDaysUtc(todayUtc(), -49),
        documentPath: "s9/rejected.pdf",
        offsetDays: 40,
      });
      await createSection9Pair(data, {
        status: "CONFIRMED",
        overlapStart: addDaysUtc(todayUtc(), -50),
        overlapEnd: addDaysUtc(todayUtc(), -49),
        documentPath: null, // eAU, no document — must be excluded
        offsetDays: 50,
      });

      const rows = await getSection9DocumentPaths(app.prisma, data.employee.id);

      expect(rows.map((r) => r.documentPath).sort()).toEqual(["s9/pending.pdf", "s9/rejected.pdf"]);
    });
  });

  // ── anonymizeSection9CreditsForEmployee ───────────────────────────────────────────────────────

  describe("anonymizeSection9CreditsForEmployee", () => {
    it("nulls documentPath and reason, preserves the row and every other field, and touches only the given employee", async () => {
      const target = await createSection9Pair(data, {
        status: "CONFIRMED",
        overlapStart: addDaysUtc(todayUtc(), -60),
        overlapEnd: addDaysUtc(todayUtc(), -59),
        creditedStart: addDaysUtc(todayUtc(), -60),
        creditedEnd: addDaysUtc(todayUtc(), -59),
        documentPath: "s9/anon-target.pdf",
        reason: "Attest liegt vor",
        offsetDays: 60,
      });
      const untouched = await createSection9Pair(otherData, {
        status: "CONFIRMED",
        overlapStart: addDaysUtc(todayUtc(), -60),
        overlapEnd: addDaysUtc(todayUtc(), -59),
        documentPath: "s9/other-tenant.pdf",
        reason: "Anderer Mandant",
        offsetDays: 70,
      });

      await app.prisma.$transaction(async (tx) => {
        await anonymizeSection9CreditsForEmployee(tx, data.employee.id);
      });

      const after = await app.prisma.section9Credit.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.documentPath).toBeNull();
      expect(after.reason).toBeNull();
      // Everything else survives (Revisionssicherheit — the row IS the Korrektureintrag).
      expect(after.status).toBe("CONFIRMED");
      expect(after.overlapStart).toEqual(target.overlapStart);
      expect(after.creditedStart).toEqual(target.creditedStart);

      const otherAfter = await app.prisma.section9Credit.findUniqueOrThrow({
        where: { id: untouched.id },
      });
      expect(otherAfter.documentPath).toBe("s9/other-tenant.pdf");
      expect(otherAfter.reason).toBe("Anderer Mandant");
    });
  });
});
