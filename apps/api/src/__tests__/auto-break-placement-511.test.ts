// Issue #511 (AK-4, D-17, D-19, D-20) — the automatic break is placed in TENANT time at a position
// that satisfies § 4 Satz 2/3 ArbZG, and minors receive at least the § 11 JArbSchG amount.
//
// Fixed instants only (no Date.now()) for the manual-entry cases; the clock-out cases need a live
// "now" because the resolver stamps the end itself. Run under TZ=UTC (the container zone) and
// TZ=Europe/Berlin: the result must not depend on the server zone.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("auto-break placement (#511)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  async function clearEntries() {
    await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: data.employee.id } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  }

  async function setConfig(defaultBreakStart: string | null) {
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        autoBreakEnabled: true,
        defaultBreakStart,
        timezone: "Europe/Berlin",
        retroEntryWindowDays: 3650,
      },
    });
  }

  async function postEntry(date: string, startZ: string, endZ: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        employeeId: data.employee.id,
        date,
        startTime: startZ,
        endTime: endZ,
        breakMinutes: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: body.entry.id },
      orderBy: { startTime: "asc" },
    });
    const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: body.entry.id } });
    return { body, breaks, stored };
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "abp511");
  });

  afterAll(async () => {
    try {
      await clearEntries();
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await clearEntries();
  });

  describe("manual POST: configured start is read in tenant time (D-17), nearest conformant (D-19)", () => {
    beforeEach(async () => {
      await setConfig("12:00");
    });

    it("summer: 08:00-17:00 Berlin gets its break at 12:00 Berlin = 10:00Z", async () => {
      const { breaks, stored } = await postEntry(
        "2025-07-16",
        "2025-07-16T06:00:00.000Z",
        "2025-07-16T15:00:00.000Z",
      );
      expect(breaks).toHaveLength(1);
      expect(breaks[0].startTime.toISOString()).toBe("2025-07-16T10:00:00.000Z");
      // Exactly 9 h of presence is not "above 9 h": the 6 h tier (30 min) applies.
      expect(breaks[0].endTime.toISOString()).toBe("2025-07-16T10:30:00.000Z");
      expect(stored.breakMinutes).toBe(30);
      expect(stored.breakStatus).toBe("AUTO");
    });

    it("winter: 08:00-17:00 Berlin gets its break at 12:00 Berlin = 11:00Z", async () => {
      const { breaks } = await postEntry(
        "2025-01-15",
        "2025-01-15T07:00:00.000Z",
        "2025-01-15T16:00:00.000Z",
      );
      expect(breaks).toHaveLength(1);
      expect(breaks[0].startTime.toISOString()).toBe("2025-01-15T11:00:00.000Z");
    });

    it("12 h entry starting 05:00 moves the 12:00 break to 11:00 (every block <= 6 h)", async () => {
      const { breaks } = await postEntry(
        "2025-07-16",
        "2025-07-16T03:00:00.000Z",
        "2025-07-16T15:00:00.000Z",
      );
      expect(breaks).toHaveLength(1);
      // 05:00 Berlin start: 11:00 Berlin = 09:00Z is the latest start that keeps the first block at 6 h.
      expect(breaks[0].startTime.toISOString()).toBe("2025-07-16T09:00:00.000Z");
      expect(breaks[0].startTime.getTime() - new Date("2025-07-16T03:00:00.000Z").getTime()).toBe(
        6 * 3_600_000,
      );
    });
  });

  describe("manual POST without a configured start", () => {
    beforeEach(async () => {
      await setConfig(null);
    });

    it("7 h entry keeps today's centred break (11:15-11:45 Berlin)", async () => {
      const { breaks, stored } = await postEntry(
        "2025-07-16",
        "2025-07-16T06:00:00.000Z",
        "2025-07-16T13:00:00.000Z",
      );
      expect(breaks).toHaveLength(1);
      expect(breaks[0].startTime.toISOString()).toBe("2025-07-16T09:15:00.000Z");
      expect(breaks[0].endTime.toISOString()).toBe("2025-07-16T09:45:00.000Z");
      expect(stored.breakMinutes).toBe(30);
    });
  });

  afterEach(async () => {
    await clearEntries();
  });
});
