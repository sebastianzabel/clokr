import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { checkArbZG } from "../../utils/arbzg";

describe("ArbZG Compliance Checks", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "az");
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  // Helper: create a time entry directly in DB for ArbZG checks
  async function createEntry(
    date: string,
    startHour: number,
    endHour: number,
    breakMin = 0,
    startMinute = 0,
    endMinute = 0,
  ) {
    const startTime = new Date(
      `${date}T${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00.000Z`,
    );
    const endTime = new Date(
      `${date}T${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}:00.000Z`,
    );
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: new Date(date),
        startTime,
        endTime,
        breakMinutes: breakMin,
        source: "MANUAL",
      },
    });
  }

  // Helper: clean up time entries for a specific date
  async function cleanDate(date: string) {
    await app.prisma.break.deleteMany({
      where: {
        timeEntry: {
          employeeId: data.employee.id,
          date: new Date(date),
        },
      },
    });
    await app.prisma.timeEntry.deleteMany({
      where: { employeeId: data.employee.id, date: new Date(date) },
    });
  }

  describe("Daily working time limits", () => {
    it("8h work day produces NO MAX_DAILY_EXCEEDED warning", async () => {
      const date = "2025-01-06"; // Monday
      await cleanDate(date);
      await createEntry(date, 8, 16, 0); // 8h net

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
      expect(maxDaily).toBeUndefined();
    });

    it("10.5h work day produces MAX_DAILY_EXCEEDED error", async () => {
      const date = "2025-01-07"; // Tuesday
      await cleanDate(date);
      // 6:00 - 17:00 = 11h total, 30min break = 10.5h net > 10h
      await createEntry(date, 6, 17, 30);

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
      expect(maxDaily).toBeDefined();
      expect(maxDaily!.severity).toBe("error");
    });
  });

  describe("Break requirements (section 4)", () => {
    it("6.5h with 0 break produces BREAK_TOO_SHORT warning", async () => {
      const date = "2025-01-08"; // Wednesday
      await cleanDate(date);
      // 8:00 - 14:30 = 6.5h, 0 break
      await createEntry(date, 8, 14, 0, 0, 30);

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(breakWarn).toBeDefined();
      expect(breakWarn!.severity).toBe("warning");
    });

    it("9.5h with 30min break produces BREAK_TOO_SHORT error (need 45min)", async () => {
      const date = "2025-01-09"; // Thursday
      await cleanDate(date);
      // 7:00 - 17:00 = 10h, 30min break = 9.5h net > 9h
      await createEntry(date, 7, 17, 30);

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(breakWarn).toBeDefined();
      expect(breakWarn!.severity).toBe("error");
    });

    it("9.5h with 45min break produces NO break warning", async () => {
      const date = "2025-01-10"; // Friday
      await cleanDate(date);
      // 7:00 - 17:15 = 10.25h, 45min break = 9.5h net
      await createEntry(date, 7, 17, 45, 0, 15);

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(breakWarn).toBeUndefined();
    });
  });

  describe("Gap-as-break logic", () => {
    it("gap > 2h between entries is NOT counted as break", async () => {
      const date = "2025-01-13"; // Monday
      await cleanDate(date);
      // Slot 1: 06:00 - 09:30 = 3.5h
      await createEntry(date, 6, 9, 0, 0, 30);
      // Gap: 09:30 - 12:00 = 2.5h (> 2h, NOT counted as break)
      // Slot 2: 12:00 - 15:30 = 3.5h
      await createEntry(date, 12, 15, 0, 0, 30);
      // Total net = 7h, break from gap = 0 (gap > 2h not counted)
      // > 6h and < 30min break → BREAK_TOO_SHORT warning expected

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(breakWarn).toBeDefined();
    });

    it("gap < 2h between entries IS counted as break", async () => {
      const date = "2025-01-14"; // Tuesday
      await cleanDate(date);
      // Slot 1: 08:00 - 12:00 = 4h
      await createEntry(date, 8, 12, 0);
      // Gap: 12:00 - 12:45 = 45min (< 2h, counted as break)
      // Slot 2: 12:45 - 16:45 = 4h
      await createEntry(date, 12, 16, 0, 45, 45);
      // Total net = 8h, gap break = 45min → no break warning expected

      const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
      const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
      expect(breakWarn).toBeUndefined();
    });
  });
});
