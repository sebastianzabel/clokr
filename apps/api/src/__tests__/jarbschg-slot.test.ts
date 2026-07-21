// Phase 76.31-07 — slot-aware JArbSchG §9 tests (D-08 FULL scope).
//
// The §9 long-day hard-block is now SLOT-AWARE, re-expressed against BS `Absence`
// rows (no WorkEvent — D-10). These tests assert the classification behavior:
//   - A FIRST_LONG_DAY (ordinal 1 in a >= 2-day school week) still hard-blocks a
//     minor AZUBI with the verbatim D-11 message.
//   - A SHORT_DAY (ordinal 3+) with credited minutes <= 225 does NOT block a minor.
//   - An adult AZUBI on a FIRST_LONG_DAY gets the D-12 soft-warn (not a block).
//   - A single isolated BS day (no >= 2-day slot context) falls back to the LEGACY
//     flat-225 path (preserves the pre-76.31 seedBsAbsence behavior).
//
// A genuine multi-day slot context requires >= 2 distinct BS days in the ISO week
// so the per-day ordinal (FIRST vs SECOND vs SHORT) is meaningful.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { checkJArbSchG } from "../utils/jarbschg";

// ── Test helpers ─────────────────────────────────────────────────────────────

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function seedBsAbsence(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  unterrichtsMinutes?: number,
) {
  return app.prisma.absence.create({
    data: {
      employeeId,
      type: "VOCATIONAL_SCHOOL",
      source: "PATTERN",
      startDate: date,
      endDate: date,
      days: 1.0,
      createdBy: "jarbschg-slot-test",
      deletedAt: null,
      // Phase 76.38 — per-day Unterrichtszeit for duration-based slot classification.
      ...(unterrichtsMinutes != null ? { unterrichtsMinutes } : {}),
    },
  });
}

// D-11 verbatim hard-block message — kept in sync with utils/jarbschg.ts. The test
// asserts EXACT equality so a copy-edit cannot drift silently.
const HARD_BLOCK_MESSAGE =
  "Reguläre Arbeit am Berufsschultag mit mehr als 5 Unterrichtsstunden (225 Min) ist für jugendliche Auszubildende (unter 18) nach JArbSchG §9 Abs. 1 Nr. 2 untersagt. Bitte den Eintrag entsprechend kürzen oder einen anderen Mitarbeiter einplanen.";

// ── checkJArbSchG slot-aware (Phase 76.31-07) ────────────────────────────────

describe("checkJArbSchG slot-aware §9 (Phase 76.31-07)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // ISO week 2026-W25: Mon 2026-06-15, Tue 2026-06-16, Wed 2026-06-17.
  const MON = utcDate("2026-06-15");
  const TUE = utcDate("2026-06-16");
  const WED = utcDate("2026-06-17");

  // Minor: on 2026-06-15 is age 17. Adult: age 19.
  const BIRTH_AGE_17 = utcDate("2008-12-15");
  const BIRTH_AGE_19 = utcDate("2007-01-15");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs-jarb-slot");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: {
        classification: "AZUBI",
        birthDate: null,
        bsSlotFirstLongDayMinutes: null,
        bsSlotSecondLongDayMinutes: null,
        bsSlotShortDayMinutes: null,
        bsSlotBlockWeekMinutes: null,
      },
    });
  });

  it("FIRST_LONG_DAY (ordinal 1, >= 2-day week) hard-blocks a minor AZUBI with the verbatim D-11 message", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // Two distinct BS days in the ISO week → RESOLVER. Target = Monday (ordinal 1).
    await seedBsAbsence(app, data.employee.id, MON);
    await seedBsAbsence(app, data.employee.id, TUE);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: MON,
      plannedNetWorkMin: 300, // > 0
    });

    expect(res.blocked).toBe(true);
    expect(res.message).toBe(HARD_BLOCK_MESSAGE);
    expect(res.softWarn).toBeUndefined();
  });

  it("SHORT_DAY (ordinal 3, <= 225 credited) does NOT block a minor AZUBI", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      // Configure the SHORT_DAY slot at 180 min (< 5 UStd, <= 225) so it is NOT a long day.
      data: { birthDate: BIRTH_AGE_17, bsSlotShortDayMinutes: 180 },
    });
    // Three distinct BS days → RESOLVER. Target = Wednesday (ordinal 3 → SHORT_DAY).
    await seedBsAbsence(app, data.employee.id, MON);
    await seedBsAbsence(app, data.employee.id, TUE);
    await seedBsAbsence(app, data.employee.id, WED);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WED,
      plannedNetWorkMin: 480, // high, but the SHORT_DAY slot means §9 is inactive
    });

    // Despite being a minor with a BS day and > 225 planned work, the SHORT_DAY
    // classification (180 min credited <= 225) means §9 does NOT fire.
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
  });

  it("FIRST_LONG_DAY for an adult AZUBI (>= 18) yields the D-12 soft-warn, not a block", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_19 },
    });
    await seedBsAbsence(app, data.employee.id, MON);
    await seedBsAbsence(app, data.employee.id, TUE);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: MON,
      plannedNetWorkMin: 300,
    });

    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
    expect(res.softWarn).toBeDefined();
    expect(res.softWarn!.code).toBe("MAX_DAILY_EXCEEDED");
    expect(res.softWarn!.severity).toBe("warning");
    expect(res.softWarn!.message).toContain("JArbSchG-Empfehlung");
  });

  it("LEGACY preservation: a single isolated BS day with plannedNetWorkMin <= 225 is not blocked (flat path)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // Only ONE BS day in the ISO week → no >= 2-day slot context → LEGACY flat-225.
    await seedBsAbsence(app, data.employee.id, WED);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WED,
      plannedNetWorkMin: 225, // at the flat threshold → not blocked
    });

    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
  });

  it("LEGACY preservation: a single isolated BS day with plannedNetWorkMin > 225 still hard-blocks a minor (flat path)", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // One BS day → LEGACY. Above the flat 225 threshold → block (pre-76.31 behavior).
    await seedBsAbsence(app, data.employee.id, WED);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: WED,
      plannedNetWorkMin: 480,
    });

    expect(res.blocked).toBe(true);
    expect(res.message).toBe(HARD_BLOCK_MESSAGE);
  });

  // ── Phase 76.38 — duration-based §9 classification (SALDO-05 / D-11) ─────────
  //
  // RED-first: a Monday that is ISO-week ordinal 1 but a genuine Kurztag (180 min
  // Unterrichtszeit ≤ 225) must NOT hard-block a minor AZUBI. Under the OLD ordinal
  // code Monday resolves to FIRST_LONG_DAY (ordinal 1) → isLongDay → hard-block. With
  // duration-based classification Monday is SHORT_DAY (180 ≤ 225) → §9 inactive.
  //
  // Thursday carries a Langtag (300 min > 225) so there are >= 2 BS days in the week
  // (RESOLVER mode, not LEGACY) — the ordinal-vs-duration divergence is exercised.
  it("Phase 76.38: ordinal-1 Kurztag (180 min Unterrichtszeit) does NOT block a minor AZUBI", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // Mon = ordinal 1 Kurztag (180 ≤ 225); Thu = Langtag (300) → >= 2-day RESOLVER week.
    await seedBsAbsence(app, data.employee.id, MON, 180);
    await seedBsAbsence(app, data.employee.id, TUE, 300);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: MON,
      plannedNetWorkMin: 480, // high, but a genuine Kurztag → §9 must stay inactive
    });

    // Duration-correct: Monday is a SHORT_DAY → not blocked. (RED under ordinal code,
    // which classifies ordinal-1 Monday as FIRST_LONG_DAY and hard-blocks.)
    expect(res.blocked).toBe(false);
    expect(res.message).toBeNull();
  });

  it("Phase 76.38: ordinal-2 Langtag (300 min Unterrichtszeit) DOES block a minor AZUBI", async () => {
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { birthDate: BIRTH_AGE_17 },
    });
    // Mon = Kurztag(180); Tue = Langtag(300). Target Tue is a real Langtag → hard-block.
    await seedBsAbsence(app, data.employee.id, MON, 180);
    await seedBsAbsence(app, data.employee.id, TUE, 300);

    const res = await checkJArbSchG(app.prisma, {
      employeeId: data.employee.id,
      date: TUE,
      plannedNetWorkMin: 300,
    });

    expect(res.blocked).toBe(true);
    expect(res.message).toBe(HARD_BLOCK_MESSAGE);
  });
});
