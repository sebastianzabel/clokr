/**
 * Issue #609 (IN-03) - a successful clock-in answers the person's open REMINDER_SHIFT_START notices,
 * a successful clock-out the open REMINDER_SHIFT_END notices, the way CLOCK_OUT_REMINDER is
 * dismissed on a clock-out. The rows are kept (soft-dismissed); a refused clock dismisses nothing;
 * another person's notices and the other occasion's notices stay.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { todayInTz } from "../contexts/working-time-account";

const START = "REMINDER_SHIFT_START";
const END = "REMINDER_SHIFT_END";

let app: FastifyInstance;
let seed: Awaited<ReturnType<typeof seedTestData>>;

async function notice(userId: string, type: string, dismissedAt: Date | null = null) {
  const row = await app.prisma.notification.create({
    data: {
      userId,
      type,
      title: type,
      message: "Erinnerung",
      link: "/dashboard?clock=1",
      relatedType: "Shift",
      relatedId: `shift-${type}-${userId}-${Math.random()}`,
      dismissedAt,
    },
  });
  return row.id;
}

async function dismissedAtOf(id: string): Promise<Date | null> {
  return (await app.prisma.notification.findUniqueOrThrow({ where: { id } })).dismissedAt;
}

const auth = () => ({ authorization: `Bearer ${seed.empToken}` });

beforeAll(async () => {
  app = await getTestApp();
  seed = await seedTestData(app, "dis609");

  // a second tenant with an NFC terminal and a WLAN presence source for the device paths
  device = await seedTestData(app, "dis609d");
  await app.prisma.tenantConfig.update({
    where: { tenantId: device.tenant.id },
    data: { timezone: "Europe/Berlin", wifiPresenceWindowMinutes: 15 },
  });
  await app.prisma.employee.updateMany({
    where: { nfcCardId: NFC_CARD_ID },
    data: { nfcCardId: null },
  });
  await app.prisma.employee.update({
    where: { id: device.employee.id },
    data: { nfcCardId: NFC_CARD_ID, wifiMacs: [WIFI_MAC], wifiPresenceEnabled: true },
  });
  terminalKey = `clk_${randomBytes(32).toString("hex")}`;
  await app.prisma.terminalApiKey.create({
    data: {
      tenantId: device.tenant.id,
      name: "dis609 terminal",
      keyHash: createHash("sha256").update(terminalKey).digest("hex"),
      keyPrefix: terminalKey.substring(0, 12) + "...",
    },
  });
  await app.prisma.presenceSource.create({
    data: {
      tenantId: device.tenant.id,
      name: "dis609 FritzBox",
      keyHash: createHash("sha256").update(RAW_KEY).digest("hex"),
      keyPrefix: RAW_KEY.slice(0, 8),
    },
  });
  await app.prisma.shift.create({
    data: {
      employeeId: device.employee.id,
      salonId: device.salonId,
      date: WIFI_DAY,
      startTime: "09:00",
      endTime: "17:00",
      label: "dis609",
    },
  });
});

const NFC_CARD_ID = "NFC-609-CARD";
const WIFI_MAC = "aa:bb:cc:00:06:09";
const RAW_KEY = `clk_a609_${randomBytes(8).toString("hex")}`;
const WIFI_DAY = new Date("2026-01-15T00:00:00Z"); // shift 09:00-17:00 Berlin = 08:00-16:00Z
let terminalKey: string;
let device: Awaited<ReturnType<typeof seedTestData>>;

afterAll(async () => {
  await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: device.tenant.id } });
  await app.prisma.presenceSource.deleteMany({ where: { tenantId: device.tenant.id } });
  await cleanupTestData(app, device.tenant.id);
  await cleanupTestData(app, seed.tenant.id);
  await closeTestApp();
});

describe("clock events answer the open shift reminders (IN-03)", () => {
  it("clock-in dismisses the START notices, clock-out the END notices, and nothing else", async () => {
    const me = seed.empUser.id;
    const others = seed.adminUser.id;
    const alreadyDismissed = new Date("2026-01-01T10:00:00Z");

    const myStart = await notice(me, START);
    const myStartDone = await notice(me, START, alreadyDismissed);
    const myEnd = await notice(me, END);
    const otherStart = await notice(others, START);
    const otherEnd = await notice(others, END);

    const inRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: auth(),
      payload: { source: "MOBILE" },
    });
    expect(inRes.statusCode).toBe(200);
    const entryId = (JSON.parse(inRes.body) as { resolution: { entry: { id: string } } }).resolution
      .entry.id;

    expect(await dismissedAtOf(myStart)).not.toBeNull();
    expect(await dismissedAtOf(myStartDone)).toEqual(alreadyDismissed); // not touched again
    expect(await dismissedAtOf(myEnd)).toBeNull(); // the other occasion stays
    expect(await dismissedAtOf(otherStart)).toBeNull(); // another person stays
    expect(await dismissedAtOf(otherEnd)).toBeNull();

    // a refused clock-in (already clocked in) dismisses nothing
    const lateStart = await notice(me, START);
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: auth(),
      payload: { source: "MOBILE" },
    });
    expect(again.statusCode).toBe(409);
    expect(await dismissedAtOf(lateStart)).toBeNull();

    // the clock-out dismisses the END notices of the person
    const outRes = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entryId}/clock-out`,
      headers: auth(),
      payload: {},
    });
    expect(outRes.statusCode).toBe(200);
    expect(await dismissedAtOf(myEnd)).not.toBeNull();
    expect(await dismissedAtOf(otherEnd)).toBeNull();
    // the START notice created after the first clock-in is not touched by a clock-out
    expect(await dismissedAtOf(lateStart)).toBeNull();

    // the rows are kept: nothing was deleted
    expect(
      await app.prisma.notification.count({ where: { id: { in: [myStart, myEnd, otherEnd] } } }),
    ).toBe(3);
  });

  it("a second clock-out on the closed entry (409) dismisses nothing", async () => {
    const me = seed.empUser.id;
    const inRes = await app.inject({
      method: "POST",
      url: "/api/v1/time-entries/clock-in",
      headers: auth(),
      payload: { source: "MOBILE" },
    });
    expect(inRes.statusCode).toBe(200);
    const entryId = (JSON.parse(inRes.body) as { resolution: { entry: { id: string } } }).resolution
      .entry.id;
    const out = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entryId}/clock-out`,
      headers: auth(),
      payload: {},
    });
    expect(out.statusCode).toBe(200);

    const lateEnd = await notice(me, END);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/time-entries/${entryId}/clock-out`,
      headers: auth(),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(await dismissedAtOf(lateEnd)).toBeNull();
  });
});

describe("the device clock paths answer the open shift reminders too (IN-03)", () => {
  it("an NFC punch out dismisses the END notices, the next punch in the START notices", async () => {
    const me = device.empUser.id;
    await app.prisma.timeEntry.create({
      data: {
        employeeId: device.employee.id,
        date: todayInTz("Europe/Berlin"),
        startTime: new Date(Date.now() - 8 * 3_600_000),
        source: "NFC",
        salonId: device.salonId,
      },
    });
    const end = await notice(me, END);
    const start = await notice(me, START);
    const punch = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });

    const out = await punch();
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).action).toBe("OUT");
    expect(await dismissedAtOf(end)).not.toBeNull();
    expect(await dismissedAtOf(start)).toBeNull();

    const back = await punch();
    expect(back.statusCode).toBe(200);
    expect(JSON.parse(back.body).action).toBe("IN");
    expect(await dismissedAtOf(start)).not.toBeNull();
  });

  it("a WLAN connect dismisses the START notices, a disconnect the END notices", async () => {
    const me = device.empUser.id;
    const event = (eventType: "connected" | "disconnected", timestamp: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${RAW_KEY}` },
        payload: { mac: WIFI_MAC, eventType, timestamp, adapter: "fritzbox" },
      });
    const start = await notice(me, START);
    const end = await notice(me, END);

    expect((await event("connected", "2026-01-15T08:00:00.000Z")).statusCode).toBe(200);
    // anti-vacuity: the connect really opened a WLAN entry (a gated event would dismiss nothing)
    expect(
      await app.prisma.timeEntry.count({
        where: { employeeId: device.employee.id, source: "WIFI", date: WIFI_DAY, deletedAt: null },
      }),
    ).toBe(1);
    expect(await dismissedAtOf(start)).not.toBeNull();
    expect(await dismissedAtOf(end)).toBeNull();

    expect((await event("disconnected", "2026-01-15T16:00:00.000Z")).statusCode).toBe(200);
    expect(await dismissedAtOf(end)).not.toBeNull();
  });
});
