/**
 * Issue #70 (Phase 70b-04, I-15) — unconfirmed-break days with several entries per day.
 *
 * An employee may hold several entries per day, so two of them can both carry the automatic break
 * (`breakStatus = AUTO`). `findUnconfirmedBreakDays` answers "which DAYS still need a confirmation"
 * and therefore lists each day once (it feeds the manual month-close 409, the auto-close deferral,
 * the deferred-close reporter and the dashboard); `findUnconfirmedBreakEntries` answers "which
 * ENTRIES" for the nudge and still lists every entry. The pure funnel `unconfirmedDaysFromEntries`
 * already de-duplicated; this pins that the DB-aware variant agrees with it.
 *
 * Mutation proof (recorded in the 70b-04 SUMMARY, restored by `cp`): returning `entries.map(e =>
 * e.date)` again turns the first case red.
 *
 * No person names in fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { TEST_TZ } from "./test-dates";
import {
  findUnconfirmedBreakDays,
  findUnconfirmedBreakEntries,
  unconfirmedDaysFromEntries,
} from "../contexts/time-tracking/find-unconfirmed-break-days";

describe("Issue #70 — unconfirmed-break days are listed once", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: { id: string };
  const monthFirstDay = new Date("2026-05-01T00:00:00Z");
  const monthLastDay = new Date("2026-05-31T00:00:00Z");

  const opts = () => ({
    employeeId: seed.employee.id,
    monthFirstDay,
    monthLastDay,
    tz: TEST_TZ,
    scheduleType: "FIXED_WEEKLY",
    enforceBreakConfirmation: true,
  });

  async function autoEntry(day: string, from: string, to: string, salonId: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: new Date(`${day}T${from}:00Z`),
        endTime: new Date(`${day}T${to}:00Z`),
        breakMinutes: 30,
        breakStatus: "AUTO",
        type: "WORK",
        source: "MANUAL",
        salonId,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "ucb70");
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch {
      // best-effort cleanup
    }
  });

  it("two AUTO entries of one day: the day once, both entries in the per-entry variant", async () => {
    const first = await autoEntry("2026-05-12", "05:00", "11:30", seed.salonId);
    const second = await autoEntry("2026-05-12", "12:00", "18:30", salonB.id);
    const other = await autoEntry("2026-05-11", "05:00", "11:30", seed.salonId);

    const days = await findUnconfirmedBreakDays(app.prisma, opts());
    expect(days).toEqual(["2026-05-11", "2026-05-12"]);

    const entries = await findUnconfirmedBreakEntries(app.prisma, opts());
    expect(entries.map((e) => e.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [first.id, second.id, other.id].sort((a, b) => a.localeCompare(b)),
    );
    expect(entries.filter((e) => e.date === "2026-05-12")).toHaveLength(2);

    // The pure funnel (status listing) and the DB-aware variant agree.
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, deletedAt: null },
      select: { date: true, breakStatus: true, isLocked: true },
    });
    expect(unconfirmedDaysFromEntries(rows, TEST_TZ, "FIXED_WEEKLY", true)).toEqual(days);
  });

  it("the master gate and the flexible schedules still answer nothing", async () => {
    expect(
      await findUnconfirmedBreakDays(app.prisma, { ...opts(), enforceBreakConfirmation: false }),
    ).toEqual([]);
    expect(
      await findUnconfirmedBreakDays(app.prisma, { ...opts(), scheduleType: "MONTHLY_HOURS" }),
    ).toEqual([]);
  });
});
