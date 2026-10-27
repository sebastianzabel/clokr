// Issue #799 — the automatic break is applied by EVERY clock trigger that closes an entry
// (web, NFC terminal, WIFI presence), through the one shared post-STOP step. The same working day
// must therefore yield the same break and the same working minutes whichever trigger closed it.
import { createHash, randomBytes } from "crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { todayInTz } from "../contexts/working-time-account";

const NFC_CARD_ID = "NFC-799-CARD";
const WIFI_MAC = "aa:bb:cc:00:07:99";
const RAW_KEY = `clk_a799_${randomBytes(8).toString("hex")}`;
const WIFI_DATE = new Date("2026-01-15T00:00:00Z"); // Thursday; shift 09:00-17:00 Berlin = 08:00-16:00Z

describe("auto-break on every clock trigger (#799)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let terminalKey: string;

  async function clear() {
    await app.prisma.break.deleteMany({ where: { timeEntry: { employeeId: data.employee.id } } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  }

  async function closedFacts(entryId: string) {
    const e = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    const breaks = await app.prisma.break.findMany({
      where: { timeEntryId: entryId },
      orderBy: { startTime: "asc" },
    });
    const presenceMin = Math.round((e.endTime!.getTime() - e.startTime.getTime()) / 60_000);
    return {
      breakMinutes: e.breakMinutes,
      breakStatus: e.breakStatus,
      breakRows: breaks.length,
      breakRowMinutes: breaks.reduce(
        (s, b) => s + Math.round((b.endTime.getTime() - b.startTime.getTime()) / 60_000),
        0,
      ),
      workingMinutes: presenceMin - (e.breakMinutes ?? 0),
    };
  }

  async function openToday(source: "MANUAL" | "NFC", hoursAgo: number) {
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

  async function wifiEvent(eventType: "connected" | "disconnected", timestamp: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${RAW_KEY}` },
      payload: { mac: WIFI_MAC, eventType, timestamp, adapter: "fritzbox" },
    });
  }

  async function openWifi(startIso: string) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date: WIFI_DATE,
        startTime: new Date(startIso),
        source: "WIFI",
        salonId: data.salonId,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "ab799");
    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: {
        autoBreakEnabled: true,
        defaultBreakStart: null,
        timezone: "Europe/Berlin",
        wifiPresenceWindowMinutes: 15,
      },
    });
    await app.prisma.employee.updateMany({
      where: { nfcCardId: NFC_CARD_ID },
      data: { nfcCardId: null },
    });
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { nfcCardId: NFC_CARD_ID, wifiMacs: [WIFI_MAC], wifiPresenceEnabled: true },
    });
    terminalKey = `clk_${randomBytes(32).toString("hex")}`;
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: data.tenant.id,
        name: "ab799 terminal",
        keyHash: createHash("sha256").update(terminalKey).digest("hex"),
        keyPrefix: terminalKey.substring(0, 12) + "...",
      },
    });
    await app.prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "ab799 FritzBox",
        keyHash: createHash("sha256").update(RAW_KEY).digest("hex"),
        keyPrefix: RAW_KEY.slice(0, 8),
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId: data.employee.id,
        salonId: data.salonId,
        date: WIFI_DATE,
        startTime: "09:00",
        endTime: "17:00",
        label: "ab799",
      },
    });
  });

  afterAll(async () => {
    try {
      await clear();
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: data.tenant.id } });
      await app.prisma.presenceSource.deleteMany({ where: { tenantId: data.tenant.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("ab799 cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(clear);

  it("an 8 h day closed via web, NFC and WIFI gets the same break and the same working minutes", async () => {
    // web
    const web = await openToday("MANUAL", 8);
    const webRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${web.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(webRes.statusCode).toBe(200);
    const webFacts = await closedFacts(web.id);
    await clear();

    // NFC
    const nfc = await openToday("NFC", 8);
    const nfcRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/nfc-punch",
      headers: { authorization: `Bearer ${terminalKey}` },
      payload: { nfcCardId: NFC_CARD_ID },
    });
    expect(nfcRes.statusCode).toBe(200);
    expect(JSON.parse(nfcRes.body).action).toBe("OUT");
    const nfcFacts = await closedFacts(nfc.id);
    await clear();

    // WIFI
    const wifi = await openWifi("2026-01-15T08:00:00.000Z");
    const wifiRes = await wifiEvent("disconnected", "2026-01-15T16:00:00.000Z");
    expect(wifiRes.statusCode).toBe(200);
    const wifiFacts = await closedFacts(wifi.id);

    expect(webFacts).toEqual({
      breakMinutes: 30,
      breakStatus: "AUTO",
      breakRows: 1,
      breakRowMinutes: 30,
      workingMinutes: 450,
    });
    expect(nfcFacts).toEqual(webFacts);
    expect(wifiFacts).toEqual(webFacts);
  });

  it("a WIFI entry with an existing break (reopened with a gap break) gets no automatic break", async () => {
    const wifi = await openWifi("2026-01-15T07:00:00.000Z");
    await app.prisma.break.create({
      data: {
        timeEntryId: wifi.id,
        startTime: new Date("2026-01-15T10:00:00.000Z"),
        endTime: new Date("2026-01-15T10:20:00.000Z"),
      },
    });
    const res = await wifiEvent("disconnected", "2026-01-15T16:00:00.000Z");
    expect(res.statusCode).toBe(200);
    const facts = await closedFacts(wifi.id);
    expect(facts.breakRows).toBe(1);
    expect(facts.breakStatus).not.toBe("AUTO");
  });

  it("a WIFI day of 5 h and a tenant with the feature off get no automatic break", async () => {
    const short = await openWifi("2026-01-15T11:00:00.000Z");
    expect((await wifiEvent("disconnected", "2026-01-15T16:00:00.000Z")).statusCode).toBe(200);
    expect((await closedFacts(short.id)).breakRows).toBe(0);
    await clear();

    await app.prisma.tenantConfig.update({
      where: { tenantId: data.tenant.id },
      data: { autoBreakEnabled: false },
    });
    try {
      const long = await openWifi("2026-01-15T08:00:00.000Z");
      expect((await wifiEvent("disconnected", "2026-01-15T16:00:00.000Z")).statusCode).toBe(200);
      expect((await closedFacts(long.id)).breakRows).toBe(0);
    } finally {
      await app.prisma.tenantConfig.update({
        where: { tenantId: data.tenant.id },
        data: { autoBreakEnabled: true },
      });
    }
  });

  // ── A recorded gap replaces the automatic break of the earlier stop (#799 extension) ──────────
  async function seedClosedAutoEntry(
    source: "MANUAL" | "NFC" | "WIFI",
    startIso: string,
    endIso: string,
    date: Date,
  ) {
    const start = new Date(startIso);
    const end = new Date(endIso);
    const e = await app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date,
        startTime: start,
        endTime: end,
        source,
        salonId: data.salonId,
        breakMinutes: 30,
        breakStatus: "AUTO",
      },
    });
    await app.prisma.break.create({
      data: {
        timeEntryId: e.id,
        startTime: new Date(start.getTime() + 3 * 3_600_000),
        endTime: new Date(start.getTime() + 3 * 3_600_000 + 30 * 60_000),
        isAuto: true,
      },
    });
    return e;
  }

  async function expectGapOnly(entryId: string, gapMinutes: number) {
    const e = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    const breaks = await app.prisma.break.findMany({ where: { timeEntryId: entryId } });
    expect(breaks).toHaveLength(1);
    expect(Math.round((breaks[0].endTime.getTime() - breaks[0].startTime.getTime()) / 60_000)).toBe(
      gapMinutes,
    );
    expect(e.breakMinutes).toBe(gapMinutes);
    expect(e.breakStatus).toBe("CONFIRMED");
    const audits = await app.prisma.auditLog.findMany({
      where: {
        entity: "Break",
        action: "DELETE",
        newValue: { path: ["reason"], equals: "Automatische Pause durch erfasste Pause ersetzt" },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  }

  it("web: re-clock-in after 20 min removes the auto break, the next stop adds no second one", async () => {
    const now = Date.now();
    const e = await seedClosedAutoEntry(
      "MANUAL",
      new Date(now - 7 * 3_600_000).toISOString(),
      new Date(now - 20 * 60_000).toISOString(),
      todayInTz("Europe/Berlin"),
    );
    const inRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MANUAL" },
    });
    expect(inRes.statusCode).toBe(200);
    await expectGapOnly(e.id, 20);
    const outRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${e.id}/clock-out`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {},
    });
    expect(outRes.statusCode).toBe(200);
    const breaks = await app.prisma.break.findMany({ where: { timeEntryId: e.id } });
    expect(breaks).toHaveLength(1);
  });

  it("NFC: re-punch after 20 min removes the auto break, the next stop adds no second one", async () => {
    const now = Date.now();
    const e = await seedClosedAutoEntry(
      "NFC",
      new Date(now - 7 * 3_600_000).toISOString(),
      new Date(now - 20 * 60_000).toISOString(),
      todayInTz("Europe/Berlin"),
    );
    const punch = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });
    const inRes = await punch();
    expect(inRes.statusCode).toBe(200);
    expect(JSON.parse(inRes.body).action).toBe("IN");
    await expectGapOnly(e.id, 20);
    // A second punch inside the debounce window is a no-op; age the reopen out of it.
    await app.prisma.timeEntry.update({
      where: { id: e.id },
      data: { startTime: new Date(now - 8 * 3_600_000) },
    });
    const outRes = await punch();
    expect(outRes.statusCode).toBe(200);
    const breaks = await app.prisma.break.findMany({ where: { timeEntryId: e.id } });
    expect(breaks).toHaveLength(1);
  });

  it("WIFI: the presence disconnect after a re-open adds no second break (the adapter never re-opens itself)", async () => {
    // A WIFI connected event on a day that has a WIFI row only confirms presence; the re-open
    // comes from another trigger. The WIFI disconnect then stops the re-opened entry.
    const e = await seedClosedAutoEntry(
      "WIFI",
      "2026-01-15T08:00:00.000Z",
      "2026-01-15T15:40:00.000Z",
      WIFI_DATE,
    );
    const { removeAutoBreaksOfEntry } = await import("../services/clock/auto-break-replace");
    await app.prisma.$transaction(async (tx) => {
      const removed = await removeAutoBreaksOfEntry(tx, e);
      expect(removed).toHaveLength(1);
      await tx.break.create({
        data: {
          timeEntryId: e.id,
          startTime: new Date("2026-01-15T15:40:00.000Z"),
          endTime: new Date("2026-01-15T15:55:00.000Z"),
        },
      });
      await tx.timeEntry.update({
        where: { id: e.id },
        data: { endTime: null, breakMinutes: 15, breakStatus: "CONFIRMED" },
      });
    });
    expect((await wifiEvent("disconnected", "2026-01-15T16:05:00.000Z")).statusCode).toBe(200);
    const done = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: e.id } });
    expect(done.endTime).not.toBeNull();
    expect(await app.prisma.break.count({ where: { timeEntryId: e.id } })).toBe(1);
  });

  it("a manually confirmed break is never removed on reopen", async () => {
    const now = Date.now();
    const e = await seedClosedAutoEntry(
      "MANUAL",
      new Date(now - 7 * 3_600_000).toISOString(),
      new Date(now - 20 * 60_000).toISOString(),
      todayInTz("Europe/Berlin"),
    );
    await app.prisma.break.updateMany({ where: { timeEntryId: e.id }, data: { isAuto: false } });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MANUAL" },
    });
    expect(res.statusCode).toBe(200);
    expect(await app.prisma.break.count({ where: { timeEntryId: e.id } })).toBe(2);
  });

  it("a pre-fix shaped entry (status AUTO, Break rows without the isAuto marker) loses nothing on reopen", async () => {
    const now = Date.now();
    const e = await seedClosedAutoEntry(
      "MANUAL",
      new Date(now - 7 * 3_600_000).toISOString(),
      new Date(now - 20 * 60_000).toISOString(),
      todayInTz("Europe/Berlin"),
    );
    // History: the auto break and an earlier recorded gap break, both written before the marker.
    await app.prisma.break.updateMany({ where: { timeEntryId: e.id }, data: { isAuto: false } });
    await app.prisma.break.create({
      data: {
        timeEntryId: e.id,
        startTime: new Date(now - 5 * 3_600_000),
        endTime: new Date(now - 5 * 3_600_000 + 10 * 60_000),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { source: "MANUAL" },
    });
    expect(res.statusCode).toBe(200);
    // the two old rows plus the new gap break
    expect(await app.prisma.break.count({ where: { timeEntryId: e.id } })).toBe(3);
    const row = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.breakStatus).toBe("AUTO");
  });
});
