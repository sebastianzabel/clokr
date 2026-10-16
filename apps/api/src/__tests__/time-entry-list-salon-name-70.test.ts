/**
 * Issue #70 (Phase 70b-06, D-07) — `GET /time-entries` rows carry the display field `salonName`.
 *
 * With several entries per day in different salons the dashboard must name the salon of each row.
 * The row already carries `salonId` (the control value); `salonName` is a display string only —
 * no nested salon object and no additional id, so the recorded neutrality bodies stay byte-identical.
 * A deactivated salon's name is still shown: the entry's history names it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

type Row = Record<string, unknown> & { id: string; salonId: string; salonName: string };

describe("Issue #70 — GET /time-entries rows name their salon", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string; name: string };
  let salonB: { id: string; name: string };
  const day = addDaysStr(mondayOfWeekStr(), -9 * 7 + 3);
  const instant = (hhmm: string) => fromZonedTime(`${day}T${hhmm}:00`, TEST_TZ);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "sn70");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Alster" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon Elbe" });
    for (const [salon, from, to] of [
      [salonA, "07:00", "11:00"],
      [salonB, "11:30", "15:00"],
    ] as const) {
      await app.prisma.timeEntry.create({
        data: {
          employeeId: seed.employee.id,
          date: new Date(`${day}T00:00:00Z`),
          startTime: instant(from),
          endTime: instant(to),
          source: "MOBILE",
          breakMinutes: 0,
          salonId: salon.id,
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  async function list(): Promise<Row[]> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/time-entries?from=${day}&to=${day}`,
      headers: { authorization: `Bearer ${seed.empToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return JSON.parse(res.body) as Row[];
  }

  it("each row carries the name of its own salon next to its salonId", async () => {
    const rows = await list();
    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.salonId, r.salonName]));
    expect(byId.get(salonA.id)).toBe(salonA.name);
    expect(byId.get(salonB.id)).toBe(salonB.name);
  });

  it("the name stays after the salon is deactivated", async () => {
    await app.prisma.salon.update({ where: { id: salonB.id }, data: { isActive: false } });
    const rows = await list();
    expect(rows.find((r) => r.salonId === salonB.id)?.salonName).toBe(salonB.name);
  });

  // Amendment 2026-10-16 (Issue #92, Phase 92b-03, AC-92-7): the rows additionally carry the display
  // field `travelToSalonName` (null on every ordinary row, `travelToSalonId` is a column and already
  // part of `Object.keys(column)` since 92b-01). Case count unchanged.
  it("the row key set is the previous one plus salonName and travelToSalonName only, and no nested salon object appears", async () => {
    const rows = await list();
    expect(rows.length).toBeGreaterThan(0);
    // The previous wire shape: every column of the row plus the three includes and the two derived
    // display minutes.
    const column = await app.prisma.timeEntry.findFirstOrThrow({
      where: { id: rows[0]!.id },
    });
    const previous = [
      ...Object.keys(column),
      "employee",
      "breaks",
      "activityShares",
      "presenceMinutes",
      "workingMinutes",
    ].sort();
    for (const row of rows) {
      expect(row).not.toHaveProperty("salon");
      expect(row).not.toHaveProperty("travelToSalon");
      expect(typeof row.salonName).toBe("string");
      expect(row.travelToSalonName).toBeNull();
      expect(Object.keys(row).sort()).toEqual(
        [...previous, "salonName", "travelToSalonName"].sort(),
      );
    }
  });
});
