/**
 * Phase 68b (issue #68), D-08/D-09 — NFC and WIFI clock paths take the salon of the day exactly
 * like MOBILE already does (68b-01's tracer, `time-entry-salon.test.ts`); a `salonId` sent in ANY
 * clock request body is silently ignored (Zod strips unknown keys); NFC and WIFI answer their
 * existing NO_ACTIVE_SALON/200 contracts correctly with no row written; clock-out (STOP), a break
 * append, a same-day re-clock-in (REOPEN) and consolidation never re-home an existing entry, even
 * after the assignment that produced its salon is deleted afterward; an instant before the
 * tenant-local hire day falls back to the tenant default salon.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";
import { consolidateSameDayEntries } from "../services/clock/consolidate";

/** Tenant-local instant for `HH:MM` on `dayStr` — mirrors `time-entry-salon.test.ts`'s idiom. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

async function setupNfcTerminal(
  app: FastifyInstance,
  tenantId: string,
  employeeId: string,
  cardId: string,
): Promise<string> {
  await app.prisma.employee.update({ where: { id: employeeId }, data: { nfcCardId: cardId } });
  const terminalApiKey = `clk_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(terminalApiKey).digest("hex");
  await app.prisma.terminalApiKey.create({
    data: {
      tenantId,
      name: "68b-03 Salon-Clock Terminal",
      keyHash,
      keyPrefix: terminalApiKey.slice(0, 12) + "...",
    },
  });
  return terminalApiKey;
}

async function setupWifiSource(
  app: FastifyInstance,
  tenantId: string,
  mac: string,
  employeeId: string,
): Promise<string> {
  await app.prisma.tenantConfig.update({
    where: { tenantId },
    data: { wifiPresenceWindowMinutes: 720 },
  });
  await app.prisma.employee.update({
    where: { id: employeeId },
    data: { wifiMacs: [mac], wifiPresenceEnabled: true },
  });
  const rawKey = `clk_68b03_${randomBytes(8).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  await app.prisma.presenceSource.create({
    data: {
      tenantId,
      name: "68b-03 Salon-Clock Presence Source",
      keyHash,
      keyPrefix: rawKey.slice(0, 8),
      revokedAt: null,
    },
  });
  return rawKey;
}

/** All-day shift on `salonId` covering `dayStr` — so a WIFI entry's salon provably does not come
 * from the shift (the shift here deliberately sits on a DIFFERENT salon than the assignment). */
async function seedAllDayShift(
  app: FastifyInstance,
  employeeId: string,
  salonId: string,
  dayStr: string,
): Promise<void> {
  await app.prisma.shift.create({
    data: {
      employeeId,
      salonId,
      date: new Date(`${dayStr}T00:00:00Z`),
      startTime: "00:00",
      endTime: "23:59",
      label: "68b-03 WIFI fixture shift",
    },
  });
}

describe("Phase 68b — NFC and WIFI take the salon of the day; a request-body salonId is ignored (D-08/D-09)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  let salonC: { id: string };
  let terminalApiKey: string;
  let wifiRawKey: string;
  const NFC_CARD = `68b03-day-nfc-${Date.now().toString(36)}`;
  const WIFI_MAC_RAW = "AA:BB:CC:DD:EE:01";
  const WIFI_MAC_NORMALIZED = "aa:bb:cc:dd:ee:01";

  // Distinct calendar WEEKS for NFC / WIFI / MOBILE so each source's test days never collide with
  // another source's test day for the same employee (the partial unique index allows at most one
  // non-deleted TimeEntry per employee per day) — no per-test cleanup needed.
  // 0=Monday .. 6=Sunday day-of-week naming below matches EmployeeSalonAssignment.weekdays.
  const nfcMonday = addDaysStr(mondayOfWeekStr(), -35); // Monday
  const nfcThursday = addDaysStr(nfcMonday, 3); // Thursday
  const nfcTuesday = addDaysStr(nfcMonday, 1); // Tuesday
  const wifiMonday = addDaysStr(mondayOfWeekStr(), -28); // Monday
  const wifiThursday = addDaysStr(wifiMonday, 3); // Thursday
  const wifiFriday = addDaysStr(wifiMonday, 4); // Friday
  const mobileMonday = addDaysStr(mondayOfWeekStr(), -21); // Monday
  const mobileWednesday = addDaysStr(mobileMonday, 2); // Wednesday

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tesc-day"); // seed.salonId = the tenant's default salon (D)
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    salonC = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon C (never assigned)",
    });

    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });

    terminalApiKey = await setupNfcTerminal(app, seed.tenant.id, seed.employee.id, NFC_CARD);
    wifiRawKey = await setupWifiSource(app, seed.tenant.id, WIFI_MAC_NORMALIZED, seed.employee.id);

    // WIFI's shift sits on the TENANT DEFAULT (D), never on A/B — proves the WIFI entry's salon
    // comes from resolveEntrySalon, not from the shift.
    for (const day of [wifiMonday, wifiThursday, wifiFriday]) {
      await seedAllDayShift(app, seed.employee.id, seed.salonId, day);
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("NFC punch on a past Thursday lands on the DEPLOYMENT salon (B)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(nfcThursday, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { resolution: { entry: { salonId: string } } };
      expect(body.resolution.entry.salonId).toBe(salonB.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("NFC punch on a past Monday lands on the HOME salon (A)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(nfcMonday, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { resolution: { entry: { salonId: string } } };
      expect(body.resolution.entry.salonId).toBe(salonA.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WIFI connected event at the Thursday shift start lands on the DEPLOYMENT salon (B)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = instant(wifiThursday, "09:00");
    vi.setSystemTime(at);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${wifiRawKey}` },
        payload: { mac: WIFI_MAC_RAW, eventType: "connected", timestamp: at.toISOString() },
      });
      expect(res.statusCode).toBe(200);
      const rows = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: seed.employee.id,
          date: new Date(`${wifiThursday}T00:00:00Z`),
          source: "WIFI",
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].salonId).toBe(salonB.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WIFI connected event at the Monday shift start lands on the HOME salon (A)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = instant(wifiMonday, "09:00");
    vi.setSystemTime(at);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${wifiRawKey}` },
        payload: { mac: WIFI_MAC_RAW, eventType: "connected", timestamp: at.toISOString() },
      });
      expect(res.statusCode).toBe(200);
      const rows = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: seed.employee.id,
          date: new Date(`${wifiMonday}T00:00:00Z`),
          source: "WIFI",
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].salonId).toBe(salonA.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a salonId sent in the NFC punch body is ignored (Tuesday -> HOME A, never Salon C)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(nfcTuesday, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD, salonId: salonC.id },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { resolution: { entry: { salonId: string } } };
      expect(body.resolution.entry.salonId).toBe(salonA.id);
      expect(body.resolution.entry.salonId).not.toBe(salonC.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a salonId sent in the MOBILE clock-in body is ignored (Wednesday -> HOME A, never Salon C)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(mobileWednesday, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE", salonId: salonC.id },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { resolution: { entry: { salonId: string } } };
      expect(body.resolution.entry.salonId).toBe(salonA.id);
      expect(body.resolution.entry.salonId).not.toBe(salonC.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a salonId sent in the WIFI presence body is ignored (Friday -> HOME A, never Salon C)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = instant(wifiFriday, "09:00");
    vi.setSystemTime(at);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${wifiRawKey}` },
        payload: {
          mac: WIFI_MAC_RAW,
          eventType: "connected",
          timestamp: at.toISOString(),
          salonId: salonC.id,
        },
      });
      expect(res.statusCode).toBe(200);
      const rows = await app.prisma.timeEntry.findMany({
        where: {
          employeeId: seed.employee.id,
          date: new Date(`${wifiFriday}T00:00:00Z`),
          source: "WIFI",
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].salonId).toBe(salonA.id);
      expect(rows[0].salonId).not.toBe(salonC.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Phase 68b — NFC and WIFI without an active salon (D-08 NO_ACTIVE_SALON contract)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let terminalApiKey: string;
  let wifiRawKey: string;
  const NFC_CARD = `68b03-none-nfc-${Date.now().toString(36)}`;
  const WIFI_MAC_RAW = "AA:BB:CC:DD:EE:02";
  const WIFI_MAC_NORMALIZED = "aa:bb:cc:dd:ee:02";
  const day = addDaysStr(mondayOfWeekStr(), -42); // Monday

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tesc-none");
    await app.prisma.salon.updateMany({
      where: { tenantId: seed.tenant.id },
      data: { isActive: false, deactivatedAt: new Date() },
    });
    terminalApiKey = await setupNfcTerminal(app, seed.tenant.id, seed.employee.id, NFC_CARD);
    wifiRawKey = await setupWifiSource(app, seed.tenant.id, WIFI_MAC_NORMALIZED, seed.employee.id);
    await seedAllDayShift(app, seed.employee.id, seed.salonId, day);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("NFC punch answers 409 NO_ACTIVE_SALON and writes no row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(day, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${terminalApiKey}` },
        payload: { nfcCardId: NFC_CARD },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: "Kein aktiver Salon vorhanden.",
        code: "NO_ACTIVE_SALON",
        resolution: { kind: "CONFLICT", reason: "NO_ACTIVE_SALON" },
      });
      const rows = await app.prisma.timeEntry.findMany({
        where: { employeeId: seed.employee.id },
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("WIFI connected event answers 200 { ok: true } and writes no row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = instant(day, "09:00");
    vi.setSystemTime(at);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${wifiRawKey}` },
        payload: { mac: WIFI_MAC_RAW, eventType: "connected", timestamp: at.toISOString() },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      const rows = await app.prisma.timeEntry.findMany({
        where: { employeeId: seed.employee.id },
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Phase 68b — salon stability across STOP/break/REOPEN, even after the assignment is deleted (D-09)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const monday = addDaysStr(mondayOfWeekStr(), -49);
  const thursday = addDaysStr(monday, 3); // Thursday

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tesc-stab");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (HOME)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon B (Thursday DEPLOYMENT)",
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonB.id,
        kind: "DEPLOYMENT",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [3], // Thursday
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("clock-in, deleting the DEPLOYMENT assignment, a break, clock-out, re-clock-in (REOPEN) and a second clock-out never move the entry off the DEPLOYMENT salon it started with", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(instant(thursday, "09:00"));
      const inRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(inRes.statusCode).toBe(200);
      const inBody = JSON.parse(inRes.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(inBody.resolution.kind).toBe("CLOCKED_IN");
      expect(inBody.resolution.entry.salonId).toBe(salonB.id);
      const entryId = inBody.resolution.entry.id;

      // Remove the assignment that produced this salon — salonForDay would now say A for Thursday.
      await app.prisma.employeeSalonAssignment.deleteMany({
        where: { employeeId: seed.employee.id, kind: "DEPLOYMENT" },
      });

      vi.setSystemTime(instant(thursday, "12:30"));
      const breakRes = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/breaks`,
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {
          startTime: instant(thursday, "12:00").toISOString(),
          endTime: instant(thursday, "12:30").toISOString(),
        },
      });
      expect(breakRes.statusCode).toBe(200);
      let entry = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(entry.salonId).toBe(salonB.id);

      vi.setSystemTime(instant(thursday, "16:00"));
      const outRes = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/clock-out`,
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {},
      });
      expect(outRes.statusCode).toBe(200);
      entry = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(entry.salonId).toBe(salonB.id);

      vi.setSystemTime(instant(thursday, "16:30"));
      const reopenRes = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(reopenRes.statusCode).toBe(200);
      const reopenBody = JSON.parse(reopenRes.body) as {
        resolution: { kind: string; entry: { id: string; salonId: string } };
      };
      expect(reopenBody.resolution.kind).toBe("CLOCKED_IN");
      expect(reopenBody.resolution.entry.id).toBe(entryId); // REOPEN reuses the same row
      expect(reopenBody.resolution.entry.salonId).toBe(salonB.id);

      vi.setSystemTime(instant(thursday, "17:00"));
      const outRes2 = await app.inject({
        method: "POST",
        url: `/api/v1/time-entries/${entryId}/clock-out`,
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: {},
      });
      expect(outRes2.statusCode).toBe(200);
      entry = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
      expect(entry.salonId).toBe(salonB.id);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Phase 68b — consolidation never changes an existing entry's salon (D-09)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  let salonB: { id: string };
  const day = addDaysStr(mondayOfWeekStr(), -56);
  const otherDay = addDaysStr(day, 1);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tesc-consol");
    salonA = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon A (predecessor)" });
    salonB = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B (second row)" });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("merging a real predecessor (A) with a real second row (B) leaves both rows on their original salon", async () => {
    const predecessor = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        salonId: salonA.id,
        date: new Date(`${day}T00:00:00Z`),
        startTime: instant(day, "08:00"),
        endTime: instant(day, "12:00"),
      },
    });
    // A REAL second row, but on ANOTHER date (the partial unique index forbids two live rows on
    // one day) — passed to consolidateSameDayEntries with an overridden date/startTime/endTime so
    // the soft-delete `update` inside it finds a real id (68b-03-PLAN.md context technique).
    const secondRow = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        salonId: salonB.id,
        date: new Date(`${otherDay}T00:00:00Z`),
        startTime: instant(otherDay, "08:00"),
        endTime: instant(otherDay, "17:00"),
      },
    });

    const result = await app.prisma.$transaction((tx) =>
      consolidateSameDayEntries(
        tx,
        seed.tenant.id,
        {
          ...secondRow,
          date: new Date(`${day}T00:00:00Z`),
          startTime: instant(day, "13:00"),
          endTime: instant(day, "17:00"),
        } as never,
        4,
        app.log,
      ),
    );

    expect(result.merged).toBe(true);

    const predecessorAfter = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: predecessor.id },
    });
    expect(predecessorAfter.salonId).toBe(salonA.id);
    expect(predecessorAfter.endTime?.getTime()).toBe(instant(day, "17:00").getTime());

    const secondRowAfter = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: secondRow.id },
    });
    expect(secondRowAfter.salonId).toBe(salonB.id);
    expect(secondRowAfter.deletedAt).not.toBeNull();
  });
});

describe("Phase 68b — a day before the tenant-local hire day falls back to the default salon (D-08)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: { id: string };
  const pinnedDay = addDaysStr(mondayOfWeekStr(), -63);
  const hireDay = addDaysStr(pinnedDay, 10);

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "tesc-hire"); // seed.salonId = the tenant's default salon (D)
    salonA = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon A (HOME from hire day)",
    });
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { hireDate: new Date(`${hireDay}T00:00:00Z`) },
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonA.id,
        kind: "HOME",
        validFrom: new Date(`${hireDay}T00:00:00Z`),
        validUntil: null,
        weekdays: [],
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("MOBILE clock-in on a day before the employee's hire day lands on the tenant default salon (D), not A", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(pinnedDay, "09:00"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/clock-in",
        headers: { authorization: `Bearer ${seed.empToken}` },
        payload: { source: "MOBILE" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { resolution: { entry: { salonId: string } } };
      expect(body.resolution.entry.salonId).toBe(seed.salonId);
      expect(body.resolution.entry.salonId).not.toBe(salonA.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
