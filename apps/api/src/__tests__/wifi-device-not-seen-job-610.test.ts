/**
 * Issue #610 (Phase 610-04, Task 3, D-10 refined, P-610-18/19) - the daily WLAN re-couple hint
 * (Feature 11 of the attendance checker) against the database.
 *
 * Every world is a fresh tenant, and every date derives from an injected `now` (the real clock at the
 * start of the test), never from a literal. The qualifying days are the three tenant-local days
 * before today; the phone was last seen ten days ago.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { fromZonedTime } from "date-fns-tz";
import {
  cleanupTestData,
  getTestApp,
  seedTestData,
  soleNotification,
  soleNotificationOrNull,
} from "./setup";
import { daysAgoStrInTz } from "./test-dates";
import {
  confirmCode,
  createPresenceSourceWithKey,
  issueCode,
  randomTestMac,
} from "./presence-pairing-fixtures-610";

const TZ = "Europe/Berlin";
const TYPE = "WIFI_DEVICE_NOT_SEEN";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type EntrySource = "MANUAL" | "WIFI" | "NFC" | "MOBILE" | null;

interface WorldOptions {
  /** Source of the closed WORK entry per day-before-today (1 = yesterday); null = no entry. */
  entries?: Partial<Record<1 | 2 | 3, EntrySource>>;
  /** Days before today on which the person has a shift. */
  shiftDaysAgo?: number[];
  pairedVia?: "QR" | "MANUAL";
  consent?: boolean;
  userActive?: boolean;
  /** Hours before now of the source's last event; null = never used. */
  sourceUsedHoursAgo?: number | null;
  lastSeenDaysAgo?: number | null;
  addedDaysAgo?: number;
}

describe("Issue #610 - the daily WLAN re-couple hint (Feature 11)", () => {
  let app: FastifyInstance;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await app.settlePushDispatch();
    for (const id of tenantIds) await cleanupTestData(app, id);
  });

  const local = (day: string, hhmm: string) => fromZonedTime(`${day}T${hhmm}:00`, TZ);

  async function buildWorld(now: Date, o: WorldOptions = {}) {
    const data = await seedTestData(app, `wns610${(seq += 1)}`);
    tenantIds.push(data.tenant.id);
    const prisma = app.prisma;
    const entries = { 1: "MANUAL", 2: "MANUAL", 3: "MANUAL", ...(o.entries ?? {}) } as Record<
      1 | 2 | 3,
      EntrySource
    >;

    await prisma.employee.update({
      where: { id: data.employee.id },
      data: { wifiPresenceEnabled: o.consent ?? true },
    });
    if (o.userActive === false) {
      await prisma.user.update({ where: { id: data.empUser.id }, data: { isActive: false } });
    }

    const { rawKey, sourceId } = await createPresenceSourceWithKey(app, data.tenant.id);
    const usedHoursAgo = o.sourceUsedHoursAgo === undefined ? 1 : o.sourceUsedHoursAgo;
    await prisma.presenceSource.update({
      where: { id: sourceId },
      data: {
        lastUsedAt: usedHoursAgo === null ? null : new Date(now.getTime() - usedHoursAgo * HOUR),
      },
    });

    const lastSeenDaysAgo = o.lastSeenDaysAgo === undefined ? 10 : o.lastSeenDaysAgo;
    const device = await prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        mac: randomTestMac(),
        pairedVia: o.pairedVia ?? "QR",
        addedAt: new Date(now.getTime() - (o.addedDaysAgo ?? 10) * DAY),
        lastSeenAt:
          lastSeenDaysAgo === null ? null : new Date(now.getTime() - lastSeenDaysAgo * DAY),
      },
    });

    for (const ago of o.shiftDaysAgo ?? [1, 2, 3]) {
      await prisma.shift.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(`${daysAgoStrInTz(now, ago, TZ)}T00:00:00.000Z`),
          startTime: "09:00",
          endTime: "13:00",
          label: "Testschicht",
        },
      });
    }
    for (const ago of [1, 2, 3] as const) {
      const source = entries[ago];
      if (source === null) continue;
      const day = daysAgoStrInTz(now, ago, TZ);
      await prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(`${day}T00:00:00.000Z`),
          startTime: local(day, "09:00"),
          endTime: local(day, "13:00"),
          type: "WORK",
          source,
        },
      });
    }
    return { data, device, rawKey, sourceId };
  }

  const noticesOf = (userIds: string[]) =>
    app.prisma.notification.findMany({ where: { type: TYPE, userId: { in: userIds } } });

  it("tells the person once, with the neutral in-app text, and nobody else", async () => {
    const now = new Date();
    const w = await buildWorld(now);

    await app.tryWifiDeviceNotSeen(now);

    const n = await soleNotification(app.prisma, {
      where: { userId: w.data.empUser.id, type: TYPE },
    });
    expect(n.title).toBe("Handy neu koppeln");
    expect(n.link).toBe("/settings");
    expect(n.relatedType).toBe("PresenceDevice");
    expect(n.relatedId).toBe(w.device.id);
    expect(n.message).toContain("nicht erkannt");
    expect(n.dismissedAt).toBeNull();
    // Managers are never recipients: the only notice of the whole tenant is the person's own.
    expect(await noticesOf([w.data.adminUser.id])).toHaveLength(0);
  });

  it("does not notify a second time for the same device (dedupe)", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    await app.tryWifiDeviceNotSeen(now);
    await app.tryWifiDeviceNotSeen(now);
    expect(await noticesOf([w.data.empUser.id])).toHaveLength(1);
  });

  it("dismisses the open notice when the phone is seen again, without a new notice", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    await app.tryWifiDeviceNotSeen(now);
    // The notice is two hours old, then the adapter reports the phone.
    await app.prisma.notification.updateMany({
      where: { userId: w.data.empUser.id, type: TYPE },
      data: { createdAt: new Date(now.getTime() - 2 * HOUR) },
    });
    const device = await app.prisma.presenceDevice.findUniqueOrThrow({
      where: { id: w.device.id },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/presence/events",
      headers: { authorization: `Bearer ${w.rawKey}` },
      payload: { mac: device.mac, eventType: "connected", timestamp: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(200);

    await app.tryWifiDeviceNotSeen(new Date());

    const rows = await noticesOf([w.data.empUser.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].dismissedAt).not.toBeNull();
  });

  it("re-arms after a sighting: seen again, then missing again, tells the person again", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    await app.tryWifiDeviceNotSeen(now);
    // An old notice, then a sighting that still lies before the window: the episode is a new one.
    await app.prisma.notification.updateMany({
      where: { userId: w.data.empUser.id, type: TYPE },
      data: {
        createdAt: new Date(now.getTime() - 9 * DAY),
        dismissedAt: new Date(now.getTime() - 8 * DAY),
      },
    });
    await app.prisma.presenceDevice.update({
      where: { id: w.device.id },
      data: { lastSeenAt: new Date(now.getTime() - 5 * DAY) },
    });
    await app.tryWifiDeviceNotSeen(now);
    expect(await noticesOf([w.data.empUser.id])).toHaveLength(2);
  });

  describe("no notice", () => {
    async function expectNoNotice(
      options: WorldOptions,
      before?: (w: Awaited<ReturnType<typeof buildWorld>>) => Promise<void>,
    ) {
      const now = new Date();
      const w = await buildWorld(now, options);
      if (before) await before(w);
      await app.tryWifiDeviceNotSeen(now);
      expect(
        await soleNotificationOrNull(app.prisma, {
          where: { userId: w.data.empUser.id, type: TYPE },
        }),
      ).toBeNull();
      expect(await noticesOf([w.data.empUser.id, w.data.adminUser.id])).toHaveLength(0);
    }

    it("with only two qualifying days", async () => {
      await expectNoNotice({ entries: { 3: null } });
    });

    it("when one of the three days was clocked by WLAN only", async () => {
      await expectNoNotice({ entries: { 2: "WIFI" } });
    });

    it("when a shift day has no entry at all", async () => {
      await expectNoNotice({ shiftDaysAgo: [1, 2] });
    });

    it("for a MANUAL device", async () => {
      await expectNoNotice({ pairedVia: "MANUAL" });
    });

    it("for a person without WLAN consent", async () => {
      await expectNoNotice({ consent: false });
    });

    it("for an inactive user", async () => {
      await expectNoNotice({ userActive: false });
    });

    it("when the adapter produced no event in the window (outage guard)", async () => {
      await expectNoNotice({ sourceUsedHoursAgo: 5 * 24 });
      await expectNoNotice({ sourceUsedHoursAgo: null });
    });

    it("when the phone was seen inside the window", async () => {
      await expectNoNotice({ lastSeenDaysAgo: 1 });
    });

    it("when the phone was coupled inside the window and never seen", async () => {
      await expectNoNotice({ addedDaysAgo: 1, lastSeenDaysAgo: null });
    });

    it("IN-04: for an exited person (the exit day lies before today)", async () => {
      await expectNoNotice({}, async (w) => {
        await app.prisma.employee.update({
          where: { id: w.data.employee.id },
          data: { exitDate: new Date(Date.now() - 2 * DAY) },
        });
      });
    });

    it("IN-04: for an anonymized person", async () => {
      await expectNoNotice({}, async (w) => {
        await app.prisma.employee.update({
          where: { id: w.data.employee.id },
          data: { firstName: "Gelöscht", lastName: `GELÖSCHT-${w.data.employee.id.slice(0, 8)}` },
        });
      });
    });

    it("IN-04: when the manually clocked days are invalid entries", async () => {
      await expectNoNotice({}, async (w) => {
        await app.prisma.timeEntry.updateMany({
          where: { employeeId: w.data.employee.id },
          data: { isInvalid: true },
        });
      });
    });

    it("for a deactivated tenant", async () => {
      await expectNoNotice({}, async (w) => {
        await app.prisma.tenant.update({
          where: { id: w.data.tenant.id },
          data: { deactivatedAt: new Date() },
        });
        app.invalidateTenantState(w.data.tenant.id);
      });
    });
  });

  it("a re-couple dismisses the open notice of the replaced device", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    await app.tryWifiDeviceNotSeen(now);
    const open = await soleNotification(app.prisma, {
      where: { userId: w.data.empUser.id, type: TYPE },
    });
    expect(open.dismissedAt).toBeNull();

    const newMac = randomTestMac();
    const issued = await issueCode(app, w.rawKey, newMac, "Neues Handy");
    expect(issued.statusCode).toBe(201);
    const code = (JSON.parse(issued.body) as { code: string }).code;
    const confirmed = await confirmCode(app, w.data.empToken, code);
    expect(confirmed.statusCode).toBe(201);

    const after = await soleNotification(app.prisma, {
      where: { userId: w.data.empUser.id, type: TYPE },
    });
    expect(after.id).toBe(open.id);
    expect(after.dismissedAt).not.toBeNull();
    // The replaced device is gone, the new one is coupled and has no notice of its own.
    expect(await app.prisma.presenceDevice.findUnique({ where: { id: w.device.id } })).toBeNull();
  });

  it("IN-04: a person whose exit day is still ahead keeps getting the hint", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    await app.prisma.employee.update({
      where: { id: w.data.employee.id },
      data: { exitDate: new Date(now.getTime() + 10 * DAY) },
    });
    await app.tryWifiDeviceNotSeen(now);
    await soleNotification(app.prisma, { where: { userId: w.data.empUser.id, type: TYPE } });
  });

  it("IN-04: one failing notification does not stop the other devices of the tenant", async () => {
    const now = new Date();
    const w = await buildWorld(now);
    // A second eligible person in the same tenant: the admin employee, same shift and entry days.
    const other = w.data.adminEmployee;
    await app.prisma.employee.update({
      where: { id: other.id },
      data: { wifiPresenceEnabled: true },
    });
    await app.prisma.presenceDevice.create({
      data: {
        tenantId: w.data.tenant.id,
        employeeId: other.id,
        mac: randomTestMac(),
        pairedVia: "QR",
        addedAt: new Date(now.getTime() - 10 * DAY),
        lastSeenAt: new Date(now.getTime() - 10 * DAY),
      },
    });
    for (const ago of [1, 2, 3]) {
      const day = daysAgoStrInTz(now, ago, TZ);
      await app.prisma.shift.create({
        data: {
          employeeId: other.id,
          salonId: w.data.salonId,
          date: new Date(`${day}T00:00:00.000Z`),
          startTime: "09:00",
          endTime: "13:00",
          label: "Testschicht",
        },
      });
      await app.prisma.timeEntry.create({
        data: {
          employeeId: other.id,
          salonId: w.data.salonId,
          date: new Date(`${day}T00:00:00.000Z`),
          startTime: local(day, "09:00"),
          endTime: local(day, "13:00"),
          type: "WORK",
          source: "MANUAL",
        },
      });
    }

    const realNotify = app.notify.bind(app);
    let calls = 0;
    const spy = vi.spyOn(app, "notify").mockImplementation(async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("notify exploded");
      return realNotify(input);
    });
    try {
      await app.tryWifiDeviceNotSeen(now);
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(2);
    const delivered = await noticesOf([w.data.empUser.id, w.data.adminUser.id]);
    expect(delivered).toHaveLength(1);
  });
});
