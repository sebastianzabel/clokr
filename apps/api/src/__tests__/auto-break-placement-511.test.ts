// Issue #511 (AK-4, D-17, D-19, D-20) — the automatic break is placed in TENANT time at a position
// that satisfies § 4 Satz 2/3 ArbZG, and minors receive at least the § 11 JArbSchG amount.
//
// Fixed instants only (no Date.now()) for the manual-entry cases; the clock-out cases need a live
// "now" because the resolver stamps the end itself. Run under TZ=UTC (the container zone) and
// TZ=Europe/Berlin: the result must not depend on the server zone.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";
import { todayInTz } from "../contexts/working-time-account";

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

  // ── D-20: clock-out and NFC clock-out of a minor ───────────────────────────────────────────
  describe("clock-out sites: employee under 18 (D-20) and adults unchanged", () => {
    const NFC_CARD_ID = "NFC-ABP511-CARD";
    let terminalApiKey: string;
    let originalBirthDate: Date | null = null;

    function minutesFromStart(entry: { startTime: Date | null }, d: Date): number {
      return (d.getTime() - entry.startTime!.getTime()) / 60_000;
    }

    async function setBirthDate(years: number | null) {
      const today = todayInTz("Europe/Berlin");
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: {
          birthDate:
            years === null
              ? null
              : new Date(
                  Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()),
                ),
        },
      });
    }

    async function openEntry(hoursAgo: number, source: "MANUAL" | "NFC" = "MANUAL") {
      return app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          date: todayInTz("Europe/Berlin"),
          startTime: new Date(Date.now() - hoursAgo * 3_600_000),
          source,
          salonId: data.salonId,
        },
      });
    }

    beforeAll(async () => {
      originalBirthDate = (
        await app.prisma.employee.findUniqueOrThrow({ where: { id: data.employee.id } })
      ).birthDate;
      await app.prisma.employee.updateMany({
        where: { nfcCardId: NFC_CARD_ID },
        data: { nfcCardId: null },
      });
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { nfcCardId: NFC_CARD_ID },
      });
      terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
      await app.prisma.terminalApiKey.create({
        data: {
          tenantId: data.tenant.id,
          name: "abp511 terminal",
          keyHash: createHash("sha256").update(terminalApiKey).digest("hex"),
          keyPrefix: terminalApiKey.substring(0, 12) + "...",
        },
      });
    });

    beforeEach(async () => {
      await setConfig(null);
    });

    afterAll(async () => {
      await app.prisma.employee.update({
        where: { id: data.employee.id },
        data: { birthDate: originalBirthDate },
      });
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: data.tenant.id } });
    });

    it("clock-out of a 17-year-old after 5 h: one 30-min AUTO break, 1 h clear of both edges", async () => {
      await setBirthDate(17);
      const entry = await openEntry(5);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      expect(breaks).toHaveLength(1);
      expect(stored.breakMinutes).toBe(30);
      expect(stored.breakStatus).toBe("AUTO");
      expect(minutesFromStart(stored, breaks[0].startTime)).toBeGreaterThanOrEqual(60);
      expect(
        minutesFromStart(stored, stored.endTime!) - minutesFromStart(stored, breaks[0].endTime),
      ).toBeGreaterThanOrEqual(60);
    });

    it("clock-out of a minor after 7 h gets 60 minutes, split so no block exceeds 4.5 h", async () => {
      await setBirthDate(16);
      const entry = await openEntry(7);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const breaks = await app.prisma.break.findMany({
        where: { timeEntryId: entry.id },
        orderBy: { startTime: "asc" },
      });
      // The configured tenant amount for 7 h is 30 min; a minor gets the § 11 minimum of 60.
      expect(stored.breakMinutes).toBe(60);
      const total = breaks.reduce(
        (sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()),
        0,
      );
      expect(total / 60_000).toBe(60);
      // Every stretch of work between the segments (and to both edges) is at most 4.5 h.
      const edges = [
        stored.startTime!.getTime(),
        ...breaks.flatMap((b) => [b.startTime.getTime(), b.endTime.getTime()]),
        stored.endTime!.getTime(),
      ];
      for (let i = 0; i < edges.length; i += 2) {
        expect(edges[i + 1] - edges[i]).toBeLessThanOrEqual(270 * 60_000);
      }
    });

    it("NFC clock-out of a minor after 5 h writes the 30-min break through the same helper", async () => {
      await setBirthDate(17);
      // The toggle only closes an entry opened by the same source (state machine).
      const entry = await openEntry(5, "NFC");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).action).toBe("OUT");
      const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      expect(breaks).toHaveLength(1);
      expect(stored.breakMinutes).toBe(30);
      expect(stored.breakStatus).toBe("AUTO");
      expect(minutesFromStart(stored, breaks[0].startTime)).toBeGreaterThanOrEqual(60);
    });

    it("an adult after 5 h gets no automatic break (unchanged)", async () => {
      await setBirthDate(30);
      const entry = await openEntry(5);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      expect(breaks).toHaveLength(0);
    });

    it("an adult after 7 h keeps the configured amount and the centred break", async () => {
      await setBirthDate(30);
      const entry = await openEntry(7);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entry.id}/clock-out`,
        headers: { authorization: `Bearer ${data.empToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const stored = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entry.id } });
      expect(breaks).toHaveLength(1);
      expect(stored.breakMinutes).toBe(30);
      const offset = minutesFromStart(stored, breaks[0].startTime);
      const presence = minutesFromStart(stored, stored.endTime!);
      expect(offset).toBeCloseTo((presence - 30) / 2, 3);
    });
  });

  afterEach(async () => {
    await clearEntries();
  });
});
