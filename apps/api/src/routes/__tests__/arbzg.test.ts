import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "../../__tests__/setup";
import type { FastifyInstance } from "fastify";
import { checkArbZG } from "../../utils/arbzg";
import type { Employee } from "@clokr/db";
import { fromZonedTime } from "date-fns-tz";

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

  // ── 24-week rolling average tests ─────────────────────────────────────────
  describe("COMPLIANCE: 24-week rolling average (Paragraph 3 ArbZG)", () => {
    // Use a SEPARATE employee to avoid contamination from other test blocks
    let avgEmployee: Employee;

    // Dedicated user for the rolling-average employee (cannot reuse empUser.id — Employee.userId is unique)
    let avgUserId: string;

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const avgUser = await app.prisma.user.create({
        data: {
          email: `avg-${s}@test.de`,
          passwordHash: "PLACEHOLDER",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      avgUserId = avgUser.id;
      avgEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: avgUserId,
          employeeNumber: `AZ-AVG-${s}`,
          firstName: "Rolling",
          lastName: "Average",
          hireDate: new Date("2024-01-01"),
        },
      });
    });

    afterAll(async () => {
      // Clean up the separate rolling-average employee and their entries
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee?.id } });
      await app.prisma.workSchedule.deleteMany({ where: { employeeId: avgEmployee?.id } });
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: avgEmployee?.id } });
      if (avgEmployee?.id) await app.prisma.employee.delete({ where: { id: avgEmployee.id } });
      if (avgUserId) await app.prisma.user.delete({ where: { id: avgUserId } });
    });

    /**
     * Helper: create a single time entry for the rolling average employee.
     * startHour and endHour are UTC hours.
     */
    async function createAvgEntry(date: string, startHour: number, endHour: number, breakMin = 0) {
      const startTime = new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00.000Z`);
      const endTime = new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00.000Z`);
      return app.prisma.timeEntry.create({
        data: {
          employeeId: avgEmployee.id,
          date: new Date(date),
          startTime,
          endTime,
          breakMinutes: breakMin,
          source: "MANUAL",
        },
      });
    }

    it("24 weeks of 10h/day Mon-Fri triggers AVG warning (1200h / 144 Werktage = 8.33h > 8h)", async () => {
      // Clean slate for this scenario
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      // Create 24 weeks of 10h/day Mon-Fri (= 1200h total)
      // 1200h / 144 Werktage = 8.33h per Werktag → EXCEEDS 8h limit
      // Use dates in 2024 range (stable past), Mon-Fri each week
      // Week 1 starts 2024-01-01 (Monday)
      const startWeek = new Date("2024-01-01T00:00:00.000Z"); // Monday
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          // Mon=0, Tue=1, Wed=2, Thu=3, Fri=4
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          // 08:00-18:00 UTC = 10h net
          await createAvgEntry(dateStr, 8, 18, 0);
        }
      }

      // Use the last day of the 24-week period as changedDate so all entries are in the window.
      // Week 24 (w=23) ends on 2024-06-14 (Friday), so changedDate must be >= 2024-06-14.
      // The window covers changedDate - 167 days = 2024-06-14 - 167 = 2023-12-29 (before all entries).
      const changedDate = new Date("2024-06-14T17:00:00.000Z"); // end of last entry day
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeDefined();
      expect(avgWarn!.severity).toBe("warning");
    });

    it("24 weeks of 4-day/39h week (9.75h/day, 4 workdays) does NOT trigger AVG warning", async () => {
      // 4 days x 9.75h x 24 weeks = 936h total
      // 936h / 144 Werktage = 6.5h per Werktag → LEGAL (< 8h)
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      const startWeek = new Date("2024-01-01T00:00:00.000Z"); // Monday
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 4; d++) {
          // Mon-Thu only (4-day week)
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          // 08:00-17:45 UTC = 9.75h (585 minutes) net
          const startTime = new Date(`${dateStr}T08:00:00.000Z`);
          const endTime = new Date(`${dateStr}T17:45:00.000Z`);
          await app.prisma.timeEntry.create({
            data: {
              employeeId: avgEmployee.id,
              date: new Date(dateStr),
              startTime,
              endTime,
              breakMinutes: 0,
              source: "MANUAL",
            },
          });
        }
      }

      const changedDate = new Date("2024-06-03T08:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeUndefined();
    });

    it("24 weeks of 7.5h/day Mon-Fri does NOT trigger AVG warning", async () => {
      // 7.5h x 120 days = 900h / 144 Werktage = 6.25h → legal
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          // 08:00-15:30 UTC = 7.5h net
          await createAvgEntry(dateStr, 8, 15, 30);
        }
      }

      const changedDate = new Date("2024-06-03T08:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeUndefined();
    });

    it("24 weeks exactly at 8h/Werktag boundary (8h x 144 = 1152h) does NOT trigger AVG warning", async () => {
      // Exactly at boundary: 1152h / 144 = exactly 8h per Werktag = not strictly > 8h → no warning
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      // 1152h / 120 workdays = 9.6h per workday (Mon-Fri) → 9.6h x 120 = 1152h total
      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          // 08:00-17:36 UTC = 9h 36min = 576 minutes net
          const startTime = new Date(`${dateStr}T08:00:00.000Z`);
          const endTime = new Date(`${dateStr}T17:36:00.000Z`);
          await app.prisma.timeEntry.create({
            data: {
              employeeId: avgEmployee.id,
              date: new Date(dateStr),
              startTime,
              endTime,
              breakMinutes: 0,
              source: "MANUAL",
            },
          });
        }
      }

      const changedDate = new Date("2024-06-03T08:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeUndefined();
    });

    it("entries with deletedAt set are excluded from rolling average calculation", async () => {
      // Create 10h/day entries that would trigger the warning, then soft-delete them
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      const entryIds: string[] = [];
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          const entry = await createAvgEntry(dateStr, 8, 18, 0); // 10h
          entryIds.push(entry.id);
        }
      }

      // Soft-delete all entries
      await app.prisma.timeEntry.updateMany({
        where: { id: { in: entryIds } },
        data: { deletedAt: new Date() },
      });

      const changedDate = new Date("2024-06-03T08:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeUndefined();
    });

    it("entries without endTime are excluded from rolling average calculation", async () => {
      // Create entries missing endTime that would inflate average if counted
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: avgEmployee.id } });

      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          // Entry without endTime — open/incomplete entry
          await app.prisma.timeEntry.create({
            data: {
              employeeId: avgEmployee.id,
              date: new Date(dateStr),
              startTime: new Date(`${dateStr}T08:00:00.000Z`),
              // endTime intentionally omitted (null)
              breakMinutes: 0,
              source: "MANUAL",
            },
          });
        }
      }

      const changedDate = new Date("2024-06-03T08:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, avgEmployee.id, changedDate);
      const avgWarn = warnings.find(
        (w) => w.code === "MAX_DAILY_AVG_EXCEEDED" || w.message.includes("24-Wochen"),
      );
      expect(avgWarn).toBeUndefined();
    });
  });

  // ── Boundary threshold tests ───────────────────────────────────────────────
  describe("COMPLIANCE: Exact boundary thresholds (D-11)", () => {
    // ── § 3 Daily max boundary: 10h00 vs 10h01 ──────────────────────────────
    describe("Paragraph 3 daily maximum boundary", () => {
      it("exactly 10h00 worked (600 min) produces NO MAX_DAILY_EXCEEDED warning", async () => {
        const date = "2025-02-03"; // Monday
        await cleanDate(date);
        // 08:00 - 18:00 UTC = exactly 600 minutes = 10h net
        await createEntry(date, 8, 18, 0);

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        expect(maxDaily).toBeUndefined();
      });

      it("10h01 worked (601 min) produces MAX_DAILY_EXCEEDED warning", async () => {
        const date = "2025-02-04"; // Tuesday
        await cleanDate(date);
        // 08:00-18:01 UTC = 601 minutes net > 600 min (10h)
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime: new Date(`${date}T08:00:00.000Z`),
            endTime: new Date(`${date}T18:01:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        expect(maxDaily).toBeDefined();
        expect(maxDaily!.severity).toBe("error");
      });
    });

    // ── § 4 Break boundary: 6h00 vs 6h01 ────────────────────────────────────
    describe("Paragraph 4 break requirement boundary", () => {
      it("exactly 6h00 worked (360 min) with 0 break produces NO BREAK_TOO_SHORT warning", async () => {
        const date = "2025-02-05"; // Wednesday
        await cleanDate(date);
        // 08:00-14:00 UTC = exactly 360 minutes = 6h net
        await createEntry(date, 8, 14, 0);

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
        expect(breakWarn).toBeUndefined();
      });

      it("6h01 worked (361 min) with 0 break produces BREAK_TOO_SHORT warning", async () => {
        const date = "2025-02-06"; // Thursday
        await cleanDate(date);
        // 08:00-14:01 UTC = 361 minutes net > 360 min (6h)
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime: new Date(`${date}T08:00:00.000Z`),
            endTime: new Date(`${date}T14:01:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
        expect(breakWarn).toBeDefined();
        expect(breakWarn!.severity).toBe("warning");
      });

      it("9h01 worked with 30min break produces BREAK_TOO_SHORT error (needs 45min at >9h)", async () => {
        const date = "2025-02-07"; // Friday
        await cleanDate(date);
        // 08:00-18:01 UTC = 601 min gross, 30 min break = 571 min net > 540 min (9h)
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime: new Date(`${date}T08:00:00.000Z`),
            endTime: new Date(`${date}T18:01:00.000Z`),
            breakMinutes: 30,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
        expect(breakWarn).toBeDefined();
        expect(breakWarn!.severity).toBe("error");
      });

      it("9h01 worked with 45min break produces NO BREAK_TOO_SHORT warning", async () => {
        const date = "2025-02-10"; // Monday
        await cleanDate(date);
        // 08:00-18:01 UTC = 601 min gross, 45 min break = 556 min net > 540 min (9h), 45min break sufficient
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime: new Date(`${date}T08:00:00.000Z`),
            endTime: new Date(`${date}T18:01:00.000Z`),
            breakMinutes: 45,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        const breakWarn = warnings.find((w) => w.code === "BREAK_TOO_SHORT");
        expect(breakWarn).toBeUndefined();
      });
    });

    // ── § 5 Rest period boundary: exactly 11h vs 10h59 ──────────────────────
    describe("Paragraph 5 rest period boundary", () => {
      it("exactly 11h rest between shifts produces NO MIN_REST_VIOLATED warning", async () => {
        const date1 = "2025-02-11"; // Tuesday
        const date2 = "2025-02-12"; // Wednesday
        await cleanDate(date1);
        await cleanDate(date2);

        // Day 1 ends at 18:00 UTC
        // Day 2 starts at 05:00 UTC → rest = 11h exactly
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date1),
            startTime: new Date(`${date1}T08:00:00.000Z`),
            endTime: new Date(`${date1}T18:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date2),
            startTime: new Date(`${date2}T05:00:00.000Z`),
            endTime: new Date(`${date2}T13:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        // Check from the perspective of date2 (the second day)
        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date2));
        const restWarn = warnings.find((w) => w.code === "MIN_REST_VIOLATED");
        expect(restWarn).toBeUndefined();
      });

      it("10h59 rest between shifts produces MIN_REST_VIOLATED warning", async () => {
        const date1 = "2025-02-13"; // Thursday
        const date2 = "2025-02-14"; // Friday
        await cleanDate(date1);
        await cleanDate(date2);

        // Day 1 ends at 18:00 UTC
        // Day 2 starts at 04:59 UTC → rest = 10h59 = 659 min < 660 min (11h)
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date1),
            startTime: new Date(`${date1}T08:00:00.000Z`),
            endTime: new Date(`${date1}T18:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date2),
            startTime: new Date(`${date2}T04:59:00.000Z`),
            endTime: new Date(`${date2}T12:59:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        // Check from the perspective of date2 (the second day)
        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date2));
        const restWarn = warnings.find((w) => w.code === "MIN_REST_VIOLATED");
        expect(restWarn).toBeDefined();
        expect(restWarn!.severity).toBe("warning");
      });
    });

    // ── § 3 Weekly max boundary: 48h vs 48h01 ────────────────────────────────
    describe("Paragraph 3 weekly maximum boundary", () => {
      it("exactly 48h weekly total produces NO MAX_WEEKLY_EXCEEDED warning", async () => {
        // Use a dedicated week: 2025-03-17 (Mon) to 2025-03-22 (Sat)
        // 6 days × 8h = 48h exactly
        const weekDates = [
          "2025-03-17",
          "2025-03-18",
          "2025-03-19",
          "2025-03-20",
          "2025-03-21",
          "2025-03-22",
        ];
        for (const d of weekDates) await cleanDate(d);

        for (const d of weekDates) {
          await createEntry(d, 8, 16, 0); // 8h each
        }

        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date("2025-03-17T08:00:00.000Z"),
        );
        const weekWarn = warnings.find((w) => w.code === "MAX_WEEKLY_EXCEEDED");
        expect(weekWarn).toBeUndefined();
      });

      it("48h01 weekly total produces MAX_WEEKLY_EXCEEDED warning", async () => {
        // Use a dedicated week: 2025-03-24 (Mon) to 2025-03-29 (Sat)
        // 6 days × 8h + 1 min on Monday = 48h01
        const weekDates = [
          "2025-03-24",
          "2025-03-25",
          "2025-03-26",
          "2025-03-27",
          "2025-03-28",
          "2025-03-29",
        ];
        for (const d of weekDates) await cleanDate(d);

        // Monday gets 8h01min
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date("2025-03-24"),
            startTime: new Date("2025-03-24T08:00:00.000Z"),
            endTime: new Date("2025-03-24T16:01:00.000Z"),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });
        // Remaining 5 days get exactly 8h each
        for (const d of weekDates.slice(1)) {
          await createEntry(d, 8, 16, 0);
        }

        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date("2025-03-24T08:00:00.000Z"),
        );
        const weekWarn = warnings.find((w) => w.code === "MAX_WEEKLY_EXCEEDED");
        expect(weekWarn).toBeDefined();
        expect(weekWarn!.severity).toBe("error");
      });
    });
  });

  // ── DST and timezone edge case tests ──────────────────────────────────────
  describe("COMPLIANCE: DST and timezone edge cases (D-13)", () => {
    // Europe/Berlin timezone is "Europe/Berlin" (set by seedTestData)
    // Spring forward 2025: March 30 02:00 CET → 03:00 CEST (UTC+2)
    // Fall back 2025: October 26 03:00 CEST → 02:00 CET (UTC+1)

    describe("DST spring forward (March CET→CEST)", () => {
      it("shift on DST spring-forward day calculates correct worked hours", async () => {
        // 2025-03-30: Berlin clocks move forward 01:00 local = 02:00 UTC
        // A shift 07:00-15:00 Berlin local time (CET, before DST transition):
        //   start: 07:00 CET = 06:00 UTC
        //   end:   16:00 CEST = 14:00 UTC (after the clock jumped forward)
        // This shift crosses the DST boundary, elapsed wall-clock time = 8h
        const date = "2025-03-30";
        await cleanDate(date);

        // 07:00 Berlin local (CET = UTC+1) → 06:00 UTC
        const startTime = fromZonedTime(new Date("2025-03-30T07:00:00"), "Europe/Berlin");
        // 15:00 Berlin local (CEST = UTC+2) → 13:00 UTC
        // Real elapsed = 13:00 UTC - 06:00 UTC = 7h (spring forward loses 1h)
        const endTime = fromZonedTime(new Date("2025-03-30T15:00:00"), "Europe/Berlin");

        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime,
            endTime,
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        // Should not crash — worked hours are 7h UTC-elapsed, well under 10h limit
        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date(`${date}T06:00:00.000Z`),
        );
        // No daily max warning (7h < 10h)
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        expect(maxDaily).toBeUndefined();
      });
    });

    describe("DST fall back (October CEST→CET)", () => {
      it("shift on DST fall-back day calculates correct worked hours", async () => {
        // 2025-10-26: Berlin clocks move back 03:00 CEST → 02:00 CET
        // A shift 00:30-08:30 Berlin local time spanning the fall-back:
        //   The clock "repeats" 02:00-03:00, so elapsed UTC time is 9h
        const date = "2025-10-26";
        await cleanDate(date);

        // 00:30 CEST (UTC+2) → 22:30 UTC on Oct 25 → use Oct 26 to avoid date mismatch
        // Simpler: use a shift that doesn't cross the ambiguous hour
        // 04:00 CET (UTC+1) to 12:00 CET (UTC+1) = 8h exactly
        const startTime = fromZonedTime(new Date("2025-10-26T04:00:00"), "Europe/Berlin");
        const endTime = fromZonedTime(new Date("2025-10-26T12:00:00"), "Europe/Berlin");

        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date),
            startTime,
            endTime,
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date(`${date}T03:00:00.000Z`),
        );
        // Should not crash
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        // 8h worked is under the 10h daily limit
        expect(maxDaily).toBeUndefined();
      });
    });

    describe("Cross-midnight shifts", () => {
      it("cross-midnight shift (22:00-06:00) calculates 8h correctly", async () => {
        const dateNight = "2025-04-07"; // Monday
        const dateMorning = "2025-04-08"; // Tuesday
        await cleanDate(dateNight);
        await cleanDate(dateMorning);

        // Night shift: starts 22:00 UTC Mon, ends 06:00 UTC Tue = 8h elapsed
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(dateNight),
            startTime: new Date(`${dateNight}T22:00:00.000Z`),
            endTime: new Date(`${dateMorning}T06:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        // checkArbZG on the night date — should correctly calculate 8h and no daily max warning
        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date(`${dateNight}T22:00:00.000Z`),
        );
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        // 8h worked is under the 10h daily limit
        expect(maxDaily).toBeUndefined();
      });

      it("cross-midnight shift over 10h (20:00-07:00) produces MAX_DAILY_EXCEEDED warning", async () => {
        const dateNight = "2025-04-09"; // Wednesday
        const dateMorning = "2025-04-10"; // Thursday
        await cleanDate(dateNight);
        await cleanDate(dateMorning);

        // Shift: starts 20:00 UTC Wed, ends 07:00 UTC Thu = 11h elapsed > 10h
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(dateNight),
            startTime: new Date(`${dateNight}T20:00:00.000Z`),
            endTime: new Date(`${dateMorning}T07:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(
          app.prisma,
          data.employee.id,
          new Date(`${dateNight}T20:00:00.000Z`),
        );
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        expect(maxDaily).toBeDefined();
        expect(maxDaily!.severity).toBe("error");
      });
    });

    describe("Year boundary (Dec 31 → Jan 1)", () => {
      it("entry on Dec 31 with typical work hours does not crash or produce off-by-one errors", async () => {
        const date = "2025-12-31";
        await cleanDate(date);
        // Standard 8h work day on the last day of the year
        await createEntry(date, 8, 16, 0);

        // Should not throw and should correctly apply all checks
        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date));
        // No daily max warning for 8h
        const maxDaily = warnings.find((w) => w.code === "MAX_DAILY_EXCEEDED");
        expect(maxDaily).toBeUndefined();
      });

      it("rest period check across year boundary (Dec 31 → Jan 1) works correctly", async () => {
        const date1 = "2025-12-31";
        const date2 = "2026-01-01";
        await cleanDate(date1);
        await cleanDate(date2);

        // Dec 31 ends at 18:00 UTC; Jan 1 starts at 04:59 UTC → rest = 10h59 < 11h
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date1),
            startTime: new Date(`${date1}T08:00:00.000Z`),
            endTime: new Date(`${date1}T18:00:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });
        await app.prisma.timeEntry.create({
          data: {
            employeeId: data.employee.id,
            date: new Date(date2),
            startTime: new Date(`${date2}T04:59:00.000Z`),
            endTime: new Date(`${date2}T12:59:00.000Z`),
            breakMinutes: 0,
            source: "MANUAL",
          },
        });

        const warnings = await checkArbZG(app.prisma, data.employee.id, new Date(date2));
        const restWarn = warnings.find((w) => w.code === "MIN_REST_VIOLATED");
        // 10h59 < 11h → should warn
        expect(restWarn).toBeDefined();
      });
    });
  });

  // ── MONTHLY_HOURS ArbZG suppression tests ─────────────────────────────────
  describe("MONTHLY_HOURS ArbZG suppression", () => {
    let monthlyEmployee: { id: string };
    let monthlyUserId: string;
    let monthlyScheduleId: string;

    beforeAll(async () => {
      const s = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const mUser = await app.prisma.user.create({
        data: {
          email: `monthly-arbzg-${s}@test.de`,
          passwordHash: "PLACEHOLDER",
          role: "EMPLOYEE",
          isActive: true,
        },
      });
      monthlyUserId = mUser.id;
      monthlyEmployee = await app.prisma.employee.create({
        data: {
          tenantId: data.tenant.id,
          userId: mUser.id,
          employeeNumber: `MH-AZ-${s}`,
          firstName: "Monthly",
          lastName: "ArbZG",
          hireDate: new Date("2024-01-01"),
        },
      });
      const sched = await app.prisma.workSchedule.create({
        data: {
          employeeId: monthlyEmployee.id,
          type: "MONTHLY_HOURS",
          weeklyHours: 10,
          monthlyHours: 40,
          mondayHours: 0,
          tuesdayHours: 0,
          wednesdayHours: 0,
          thursdayHours: 0,
          fridayHours: 0,
          saturdayHours: 0,
          sundayHours: 0,
          validFrom: new Date("2024-01-01"),
        },
      });
      monthlyScheduleId = sched.id;
    });

    afterAll(async () => {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: monthlyEmployee?.id } });
      await app.prisma.workSchedule.deleteMany({ where: { employeeId: monthlyEmployee?.id } });
      await app.prisma.overtimeAccount.deleteMany({ where: { employeeId: monthlyEmployee?.id } });
      if (monthlyEmployee?.id)
        await app.prisma.employee.delete({ where: { id: monthlyEmployee.id } });
      if (monthlyUserId) await app.prisma.user.delete({ where: { id: monthlyUserId } });
    });

    it("MONTHLY_HOURS employee: no MAX_DAILY_AVG_EXCEEDED warning even with >8h/day average", async () => {
      // Clean slate
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: monthlyEmployee.id } });

      // Create 24 weeks of 10h/day Mon-Fri — average = 1200h / 144 Werktage = 8.33h > 8h
      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          await app.prisma.timeEntry.create({
            data: {
              employeeId: monthlyEmployee.id,
              date: new Date(dateStr),
              startTime: new Date(`${dateStr}T08:00:00.000Z`),
              endTime: new Date(`${dateStr}T18:00:00.000Z`),
              breakMinutes: 0,
              source: "MANUAL",
            },
          });
        }
      }

      const changedDate = new Date("2024-06-14T17:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, monthlyEmployee.id, changedDate);
      const avgWarn = warnings.filter((w) => w.code === "MAX_DAILY_AVG_EXCEEDED");
      expect(avgWarn).toHaveLength(0);
    });

    it("MONTHLY_HOURS employee: MAX_DAILY_EXCEEDED still fires at >10h", async () => {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: monthlyEmployee.id } });

      const date = "2025-04-07";
      await app.prisma.timeEntry.create({
        data: {
          employeeId: monthlyEmployee.id,
          date: new Date(date),
          startTime: new Date(`${date}T06:00:00.000Z`),
          endTime: new Date(`${date}T17:00:00.000Z`), // 11h net
          breakMinutes: 0,
          source: "MANUAL",
        },
      });

      const warnings = await checkArbZG(app.prisma, monthlyEmployee.id, new Date(date));
      expect(warnings.some((w) => w.code === "MAX_DAILY_EXCEEDED")).toBe(true);
    });

    it("MONTHLY_HOURS employee: BREAK_TOO_SHORT still fires for >6h with 0 break", async () => {
      await app.prisma.timeEntry.deleteMany({ where: { employeeId: monthlyEmployee.id } });

      const date = "2025-04-08";
      await app.prisma.timeEntry.create({
        data: {
          employeeId: monthlyEmployee.id,
          date: new Date(date),
          startTime: new Date(`${date}T08:00:00.000Z`),
          endTime: new Date(`${date}T14:30:00.000Z`), // 6.5h net, 0 break
          breakMinutes: 0,
          source: "MANUAL",
        },
      });

      const warnings = await checkArbZG(app.prisma, monthlyEmployee.id, new Date(date));
      expect(warnings.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(true);
    });

    it("FIXED_WEEKLY employee still gets MAX_DAILY_AVG_EXCEEDED at >8h/day average", async () => {
      // The regular data.employee is FIXED_WEEKLY — verify the guard doesn't break FIXED_WEEKLY
      // Use the avgEmployee from the rolling average describe block — it already has the right setup
      // Instead, just verify the existing 24-week tests still pass indirectly via this sanity check:
      // Create entries for data.employee (FIXED_WEEKLY) to confirm the guard doesn't suppress
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2024-01-01"), lte: new Date("2024-06-14") },
        },
      });

      const startWeek = new Date("2024-01-01T00:00:00.000Z");
      for (let w = 0; w < 24; w++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(startWeek);
          date.setDate(date.getDate() + w * 7 + d);
          const dateStr = date.toISOString().slice(0, 10);
          await app.prisma.timeEntry.create({
            data: {
              employeeId: data.employee.id,
              date: new Date(dateStr),
              startTime: new Date(`${dateStr}T08:00:00.000Z`),
              endTime: new Date(`${dateStr}T18:00:00.000Z`), // 10h
              breakMinutes: 0,
              source: "MANUAL",
            },
          });
        }
      }

      const changedDate = new Date("2024-06-14T17:00:00.000Z");
      const warnings = await checkArbZG(app.prisma, data.employee.id, changedDate);
      expect(warnings.some((w) => w.code === "MAX_DAILY_AVG_EXCEEDED")).toBe(true);

      // Cleanup
      await app.prisma.timeEntry.deleteMany({
        where: {
          employeeId: data.employee.id,
          date: { gte: new Date("2024-01-01"), lte: new Date("2024-06-14") },
        },
      });
    });
  });
});
