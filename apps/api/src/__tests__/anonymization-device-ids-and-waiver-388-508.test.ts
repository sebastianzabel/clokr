/**
 * Issue #388 + #508 (DSGVO Art. 17): the anonymization also clears the WLAN device identifiers
 * (Employee.wifiMacs, PresenceDevice rows) and the free-text TimeEntry.breakWaivedReason, and
 * leaves the retention-relevant rows in place.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto, { createHash, randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";

const MAC_LEGACY = "aa:bb:cc:dd:ee:01";
const MAC_DEVICE = "aa:bb:cc:dd:ee:02";
const WAIVER_TEXT = "Heute durchgearbeitet, weil Kind krank";
// Generated per run, like device-keys-deactivated-88: a literal key trips the secret scan.
const PRESENCE_KEY = `clk_388_508_${randomBytes(8).toString("hex")}`;

describe("anonymization clears device identifiers and the waiver reason (#388, #508)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let employeeId: string;
  let otherEmployeeId: string;
  let entryId: string;

  async function makeEmployee(label: string, extra: Record<string, unknown> = {}) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-388-508");

    const target = await makeEmployee("target", {
      wifiMacs: [MAC_LEGACY],
      wifiPresenceEnabled: true,
      wifiOptInAt: new Date("2025-01-01T00:00:00Z"),
    });
    employeeId = target.id;
    const other = await makeEmployee("other", {
      wifiMacs: ["aa:bb:cc:dd:ee:99"],
      wifiPresenceEnabled: true,
    });
    otherEmployeeId = other.id;

    await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId, mac: MAC_DEVICE, label: "iPhone von Max" },
    });
    await app.prisma.presenceDevice.create({
      data: { tenantId: data.tenant.id, employeeId: otherEmployeeId, mac: "aa:bb:cc:dd:ee:98" },
    });
    await app.prisma.presenceSource.create({
      data: {
        tenantId: data.tenant.id,
        name: "anon-388-508",
        keyHash: createHash("sha256").update(PRESENCE_KEY).digest("hex"),
        keyPrefix: PRESENCE_KEY.slice(0, 8),
      },
    });

    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        breakStatus: "WAIVED",
        breakWaivedReason: WAIVER_TEXT,
        salonId: data.salonId,
      },
    });
    entryId = entry.id;
    // A soft-deleted row carries the text too and must be reached.
    await app.prisma.timeEntry.create({
      data: {
        employeeId,
        date: new Date("2025-06-16"),
        startTime: new Date("2025-06-16T08:00:00Z"),
        endTime: new Date("2025-06-16T09:00:00Z"),
        breakWaivedReason: WAIVER_TEXT,
        deletedAt: new Date("2025-06-17T00:00:00Z"),
        salonId: data.salonId,
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: otherEmployeeId,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        breakWaivedReason: "fremder Text",
        salonId: data.salonId,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-388-508 cleanup failed:", err);
    }
  });

  it("negative control: before the anonymization the identifiers and the text are present", async () => {
    const emp = await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(emp.wifiMacs).toEqual([MAC_LEGACY]);
    expect(await app.prisma.presenceDevice.count({ where: { employeeId } })).toBe(1);
    const e = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(e.breakWaivedReason).toBe(WAIVER_TEXT);
  });

  it("clears wifiMacs, opt-in, PresenceDevice rows and breakWaivedReason; entries stay; others untouched", async () => {
    const entriesBefore = await app.prisma.timeEntry.count({ where: { employeeId } });
    const result = await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );

    // Counts only are reported for the audit, never the addresses.
    expect(result.clearedDeviceIdentifiers).toEqual({ wifiMacs: 1, presenceDevices: 1 });

    const emp = await app.prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(emp.wifiMacs).toEqual([]);
    expect(emp.wifiPresenceEnabled).toBe(false);
    expect(emp.wifiOptInAt).toBeNull();
    expect(await app.prisma.presenceDevice.count({ where: { employeeId } })).toBe(0);

    const waived = await app.prisma.timeEntry.count({
      where: { employeeId, breakWaivedReason: { not: null } },
    });
    expect(waived).toBe(0);
    // Retention: rows (incl. the soft-deleted one) remain, breakStatus untouched.
    expect(await app.prisma.timeEntry.count({ where: { employeeId } })).toBe(entriesBefore);
    const e = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(e.breakStatus).toBe("WAIVED");

    const other = await app.prisma.employee.findUniqueOrThrow({ where: { id: otherEmployeeId } });
    expect(other.wifiMacs).toEqual(["aa:bb:cc:dd:ee:99"]);
    expect(await app.prisma.presenceDevice.count({ where: { employeeId: otherEmployeeId } })).toBe(
      1,
    );
    expect(
      await app.prisma.timeEntry.count({
        where: { employeeId: otherEmployeeId, breakWaivedReason: "fremder Text" },
      }),
    ).toBe(1);
  });

  it("a WLAN presence event with the old MAC no longer stamps anything", async () => {
    const entriesBefore = await app.prisma.timeEntry.count({ where: { employeeId } });
    for (const mac of [MAC_LEGACY, MAC_DEVICE]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/presence/events",
        headers: { authorization: `Bearer ${PRESENCE_KEY}` },
        payload: { mac, eventType: "connected", timestamp: new Date().toISOString() },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await app.prisma.timeEntry.count({ where: { employeeId } })).toBe(entriesBefore);
    // Both addresses are now unknown MACs: purgeable presence-only audit rows, no entry.
    expect(
      await app.prisma.auditLog.count({
        where: { action: "WIFI_UNKNOWN_MAC", newValue: { path: ["mac"], equals: MAC_LEGACY } },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});
