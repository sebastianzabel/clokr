// Phase 63 Plan 02 — JArbSchG §9 helper tests.
//
// Covers BERSCH-07 (AZUBI < 18 hard block over 225 min; AZUBI ≥ 18 soft-warn;
// non-AZUBI passes through; locked-month bypass per D-13 — locked-month is the
// route's responsibility so we only assert the helper behaves correctly on the
// happy paths and at the boundaries).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { ageAtDate, checkJArbSchG } from "../utils/jarbschg";

// ── Test helpers ─────────────────────────────────────────────────────────────

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function seedBsAbsence(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  opts: { deleted?: boolean } = {},
) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "jarbschg-test",
      deletedAt: opts.deleted ? new Date() : null,
    },
  });
}

// ── ageAtDate (pure) ─────────────────────────────────────────────────────────

describe("ageAtDate (pure helper, no DB)", () => {
  it("birthday is yesterday — returns full age (had birthday this year)", () => {
    const birth = utcDate("2008-06-15");
    const at = utcDate("2026-06-16"); // birthday was yesterday
    expect(ageAtDate(birth, at)).toBe(18);
  });

  it("birthday is tomorrow — returns age - 1 (not yet had birthday)", () => {
    const birth = utcDate("2008-06-15");
    const at = utcDate("2026-06-14"); // birthday is tomorrow
    expect(ageAtDate(birth, at)).toBe(17);
  });

  it("birthday is EXACTLY on at-date — returns full age (whole year complete)", () => {
    const birth = utcDate("2008-06-15");
    const at = utcDate("2026-06-15");
    expect(ageAtDate(birth, at)).toBe(18);
  });

  it("UTC-only — no DST drift", () => {
    // German DST switch days (last Sun of Mar/Oct). Pure UTC components → no drift.
    const birth = utcDate("2008-03-30");
    const at = utcDate("2026-03-30");
    expect(ageAtDate(birth, at)).toBe(18);
  });
});

// ── checkJArbSchG (integration with DB) ──────────────────────────────────────

describe("checkJArbSchG (Phase 63 Plan 02 - BERSCH-07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Reference date: 2026-06-17 (Wednesday). Used as the "work date" in tests.
  const WORK_DATE = utcDate("2026-06-17");

  // Birthdates positioned relative to WORK_DATE:
  //   AGE_17 — turns 17 in 2025; on 2026-06-17 is age 17.
  //   AGE_18_TODAY — turns 18 EXACTLY on 2026-06-17.
  //   AGE_19 — turns 19 in 2026; on 2026-06-17 is 19.
  const BIRTH_AGE_17 = utcDate("2008-12-15");
  const BIRTH_AGE_18_TODAY = utcDate("2008-06-17");
  const BIRTH_AGE_19 = utcDate("2007-01-15");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-jarb");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Each test starts with a clean slate: AZUBI classification + no birthDate +
  // no Absences on the employee.
  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: null },
    });
  });

  // ── Fail-open precondition paths ─────────────────────────────────────────

  it("returns { blocked: false } when employee not found", async () => {
    const res = await checkJArbSchG(app.prisma, {
      employeeId: "00000000-0000-0000-0000-000000000000",
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
    expect(res.softWarn).toBeUndefined();
  });

  it("returns { blocked: false } when classification !== AZUBI", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "VOLLZEIT", birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
    expect(res.softWarn).toBeUndefined();
  });

  it("returns { blocked: false } when no VOCATIONAL_SCHOOL Absence on that date (AZUBI < 18)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // No absence seeded.
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
  });

  it("returns { blocked: false } when BS Absence is soft-deleted (AZUBI < 18)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE, { deleted: true });
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
  });

  it("returns { blocked: false } when AZUBI < 18 BUT plannedNetWorkMin <= 225", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 225,
    });
    expect(res.blocked).toBe(false);
    expect(res.softWarn).toBeUndefined();
  });

  it("returns { blocked: false } when birthDate is null (fail-open, AZUBI on BS day)", async () => {
    // No birthDate set. Even with AZUBI + BS day + 480 min planned, fail-open.
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
  });

  // ── HARD BLOCK paths (AZUBI < 18, BS day, > 225 min) ─────────────────────

  it("returns BLOCKED with EXACT D-11 message when AZUBI < 18 + BS day + > 225 min", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 226, // 1 min over threshold
    });
    expect(res.blocked).toBe(true);
    // VERBATIM D-11 — exact string match (deep equality). If this test fails after a
    // copy-edit, also update .planning/phases/63-.../CONTEXT.md D-11.
    expect(res.message).toBe(
      "Reguläre Arbeit am Berufsschultag mit mehr als 5 Unterrichtsstunden (225 Min) ist für jugendliche Auszubildende (unter 18) nach JArbSchG §9 Abs. 1 Nr. 2 untersagt. Bitte den Eintrag entsprechend kürzen oder einen anderen Mitarbeiter einplanen.",
    );
    // The stable D-11 substring containing the statute reference.
    expect(res.message).toContain("JArbSchG §9 Abs. 1 Nr. 2 untersagt");
    expect(res.softWarn).toBeUndefined();
  });

  it("returns BLOCKED at high net-work min (e.g. 480) for AZUBI < 18 + BS day", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(true);
    expect(res.message).not.toBeNull();
  });

  // ── SOFT WARN paths (AZUBI ≥ 18, BS day, > 225 min) ─────────────────────

  it("returns SOFT WARN when AZUBI exactly 18 today on BS day with > 225 min (boundary)", async () => {
    // 18th birthday EXACTLY on WORK_DATE → age 18 → NOT a minor → soft-warn, not block.
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_18_TODAY },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
    expect(res.softWarn).toBeDefined();
    expect(res.softWarn!.code).toBe("MAX_DAILY_EXCEEDED");
    expect(res.softWarn!.severity).toBe("warning");
    expect(res.softWarn!.message).toContain("JArbSchG-Empfehlung");
  });

  it("returns SOFT WARN for AZUBI age 19 on BS day with > 225 min", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_19 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    expect(res.blocked).toBe(false);
    expect(res.softWarn).toBeDefined();
    expect(res.softWarn!.message).toContain("JArbSchG-Empfehlung");
  });

  it("AZUBI ≥ 18 with planned ≤ 225 returns no warn (silent allow)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_19 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 200,
    });
    expect(res.blocked).toBe(false);
    expect(res.softWarn).toBeUndefined();
  });

  // ── Information disclosure mitigation (T-63-05) ──────────────────────────

  it("result shape does NOT contain birthDate (T-63-05 mitigation)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    await seedBsAbsence(app, data.employee.id, WORK_DATE);
    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WORK_DATE,
      plannedNetWorkMin: 480,
    });
    // Defensive: result shape is `{ blocked, message, softWarn? }` only — no PII.
    expect(Object.keys(res).sort()).toEqual(["blocked", "message"].sort());
    expect(JSON.stringify(res)).not.toContain("birthDate");
    expect(JSON.stringify(res)).not.toContain("2008-12-15");
  });
});
