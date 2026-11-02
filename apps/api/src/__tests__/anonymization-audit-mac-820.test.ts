/**
 * Issue #820 (DSGVO Art. 17): the anonymization replaces device MAC addresses inside the person's
 * AuditLog values - by key and shape, for every row tied to the person or their devices - and
 * keeps the rows; other persons' rows are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import {
  isMacKey,
  redactMacsInAuditValue,
  auditValueHoldsMac,
} from "../contexts/platform/audit-mac-redaction";
import { SUPPORT_AUDIT_REDACTED } from "../contexts/platform/support-audit-redaction";

const MAC_LIVE = "aa:bb:cc:dd:20:01";
const MAC_GONE = "aa:bb:cc:dd:20:02";
const MAC_UNKNOWN_LATER = "aa:bb:cc:dd:20:03";
const MAC_OTHER = "aa:bb:cc:dd:20:99";

describe("MAC redaction rule (unit)", () => {
  it("recognises mac keys by token, not by substring", () => {
    for (const k of ["mac", "oldMac", "wifi_mac", "macAddress", "macs", "MAC"]) {
      expect(isMacKey(k)).toBe(true);
    }
    for (const k of ["machineId", "macro", "label", "timestamp"]) expect(isMacKey(k)).toBe(false);
  });

  it("redacts by key and by shape, keeps UUIDs, numbers and structure", () => {
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const value = {
      mac: "aa:bb:cc:dd:ee:ff",
      macs: ["AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff"],
      note: "MAC aa:bb:cc:dd:ee:ff beobachtet um 08:00",
      id: uuid,
      minutes: 30,
      nested: { oldMac: "112233445566", keep: "WORK" },
    };
    expect(redactMacsInAuditValue(value)).toEqual({
      mac: SUPPORT_AUDIT_REDACTED,
      macs: [SUPPORT_AUDIT_REDACTED, SUPPORT_AUDIT_REDACTED],
      note: `MAC ${SUPPORT_AUDIT_REDACTED} beobachtet um 08:00`,
      id: uuid,
      minutes: 30,
      nested: { oldMac: SUPPORT_AUDIT_REDACTED, keep: "WORK" },
    });
    expect(auditValueHoldsMac({ id: uuid, t: "08:00:00" })).toBe(false);
  });
});

describe("anonymization redacts MAC addresses in the AuditLog (#820)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let target: { employeeId: string; userId: string };
  let other: { employeeId: string; userId: string };
  const ids: Record<string, string> = {};

  async function makePerson(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
        wifiMacs: [],
      },
    });
    return { employeeId: employee.id, userId: user.id };
  }

  const audit = async (
    key: string,
    row: Parameters<typeof app.prisma.auditLog.create>[0]["data"],
  ) => {
    ids[key] = (await app.prisma.auditLog.create({ data: row })).id;
  };
  const read = (key: string) => app.prisma.auditLog.findUniqueOrThrow({ where: { id: ids[key] } });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-820");
    target = await makePerson("target820");
    other = await makePerson("other820");

    const live = await app.prisma.presenceDevice.create({
      data: {
        tenantId: data.tenant.id,
        employeeId: target.employeeId,
        mac: MAC_LIVE,
        label: "Handy Anna",
      },
    });
    const goneId = crypto.randomUUID(); // a device removed earlier: only audit rows remain
    const entry = await app.prisma.timeEntry.create({
      data: {
        employeeId: target.employeeId,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        salonId: data.salonId,
      },
    });
    const otherEntry = await app.prisma.timeEntry.create({
      data: {
        employeeId: other.employeeId,
        date: new Date("2025-06-15"),
        startTime: new Date("2025-06-15T08:00:00Z"),
        endTime: new Date("2025-06-15T16:00:00Z"),
        salonId: data.salonId,
      },
    });

    // (a) authored by the person, no employeeId
    await audit("self-create", {
      userId: target.userId,
      action: "CREATE",
      entity: "PresenceDevice",
      entityId: live.id,
      newValue: { mac: MAC_LIVE, label: "Handy Anna" },
    });
    // (b) admin assignment naming the employee
    await audit("assign", {
      userId: data.adminUser.id,
      action: "ASSIGN_DEVICE",
      entity: "PresenceDevice",
      entityId: goneId,
      newValue: { mac: MAC_GONE, employeeId: target.employeeId, optInAutoEnabled: true },
    });
    // (d) later row of the removed device: no employeeId, no author, system write
    await audit("gone-delete", {
      action: "DELETE",
      entity: "PresenceDevice",
      entityId: goneId,
      oldValue: { mac: MAC_GONE, label: "Altes Handy", pairedVia: "QR" },
      newValue: { reason: "CONSENT_WITHDRAWN" },
    });
    // (c) presence event about the person
    await audit("opt-out", {
      action: "WIFI_OPT_OUT",
      entity: "PresenceEvent",
      entityId: target.employeeId,
      newValue: { mac: MAC_LIVE, eventType: "connected" },
      purgeable: true,
    });
    // (e) presence confirmation on the person's time entry, MAC also in the note
    await audit("confirmed", {
      action: "WIFI_PRESENCE_CONFIRMED",
      entity: "TimeEntry",
      entityId: entry.id,
      newValue: { mac: MAC_LIVE, note: `MAC ${MAC_LIVE} beobachtet`, adapter: "fritzbox" },
    });
    // (f) unknown-MAC event of a MAC that belongs to the person
    await audit("unknown", {
      action: "WIFI_UNKNOWN_MAC",
      entity: "PresenceEvent",
      newValue: { mac: MAC_LIVE, eventType: "connected", adapter: "fritzbox" },
      purgeable: true,
    });
    // other person: untouched
    await audit("other-create", {
      userId: other.userId,
      action: "CREATE",
      entity: "PresenceDevice",
      entityId: crypto.randomUUID(),
      newValue: { mac: MAC_OTHER, label: "Handy Bert" },
    });
    await audit("other-confirmed", {
      action: "WIFI_PRESENCE_CONFIRMED",
      entity: "TimeEntry",
      entityId: otherEntry.id,
      newValue: { mac: MAC_OTHER },
    });
    await audit("other-unknown", {
      action: "WIFI_UNKNOWN_MAC",
      entity: "PresenceEvent",
      newValue: { mac: MAC_UNKNOWN_LATER },
      purgeable: true,
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-audit-mac-820 cleanup failed:", err);
    }
  });

  it("negative control: before the anonymization the addresses are stored", async () => {
    expect(JSON.stringify((await read("confirmed")).newValue)).toContain(MAC_LIVE);
    expect(JSON.stringify((await read("gone-delete")).oldValue)).toContain(MAC_GONE);
  });

  it("replaces the addresses in every row of the person, keeps the rows and the rest", async () => {
    const before = await app.prisma.auditLog.count();
    const result = await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: target.employeeId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );
    expect(result.macAuditRedaction.rowsWithMac).toBe(6);
    expect(await app.prisma.auditLog.count()).toBe(before);

    const R = SUPPORT_AUDIT_REDACTED;
    expect((await read("self-create")).newValue).toEqual({ mac: R, label: R });
    expect((await read("assign")).newValue).toEqual({
      mac: R,
      employeeId: target.employeeId,
      optInAutoEnabled: true,
    });
    expect((await read("gone-delete")).oldValue).toEqual({ mac: R, label: R, pairedVia: "QR" });
    expect((await read("gone-delete")).newValue).toEqual({ reason: "CONSENT_WITHDRAWN" });
    expect((await read("opt-out")).newValue).toEqual({ mac: R, eventType: "connected" });
    expect((await read("unknown")).newValue).toMatchObject({ mac: R });
    const confirmed = await read("confirmed");
    expect(confirmed.newValue).toEqual({
      mac: R,
      note: `MAC ${R} beobachtet`,
      adapter: "fritzbox",
    });
    expect(confirmed.action).toBe("WIFI_PRESENCE_CONFIRMED");
    expect(confirmed.entityId).toBeTruthy();
  });

  it("leaves the rows of other persons untouched", async () => {
    expect((await read("other-create")).newValue).toEqual({ mac: MAC_OTHER, label: "Handy Bert" });
    expect((await read("other-confirmed")).newValue).toEqual({ mac: MAC_OTHER });
    expect((await read("other-unknown")).newValue).toEqual({ mac: MAC_UNKNOWN_LATER });
  });

  it("is idempotent: a second run finds nothing", async () => {
    const again = await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: target.employeeId,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );
    expect(again.macAuditRedaction.rowsWithMac).toBe(0);
  });
});
