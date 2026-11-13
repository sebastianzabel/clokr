/**
 * Issue #541 (Phase 541-02, D-09, T-541-07) — the deactivation race of a bound terminal salon.
 *
 * The `/nfc-punch` adapter checks the bound salon BEFORE the resolver's transaction, so a salon
 * deactivated in between would reach the resolver as an explicit salon and be refused with
 * CONFLICT/SALON_INACTIVE — a lost punch (§ 16 Abs. 2 ArbZG). `resolveTerminalPunch` retries once
 * without the salon. This file simulates a pre-check that still saw the salon active by replacing
 * only `terminalPunchSalon` with a stub that hands the stored binding through unchecked, while the
 * salon is INACTIVE in the database. Every other export of the module stays real.
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

vi.mock("../contexts/time-tracking/terminal-salon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../contexts/time-tracking/terminal-salon")>();
  return {
    ...actual,
    // A pre-check that still saw the salon active: the binding passes through unvalidated.
    terminalPunchSalon: async (
      _db: unknown,
      _log: unknown,
      apiKey: { salonId: string | null },
    ): Promise<{ salonId?: string }> =>
      apiKey.salonId === null ? {} : { salonId: apiKey.salonId },
  };
});

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type PunchBody = {
  action?: string;
  resolution: { kind: string; reason?: string; entry?: { id: string; salonId: string } };
};

const NFC_CARD_ID = `NFC-541R-${randomUUID()}`;

describe("Issue #541 — a salon deactivated between pre-check and resolver never costs the punch (D-09)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonPattern: { id: string };
  let salonDead: { id: string };
  let deadKey: string;

  const baseMonday = addDaysStr(mondayOfWeekStr(), -20 * 7);
  const dayOf = (offset: number): string => addDaysStr(baseMonday, offset);
  const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

  const liveRows = (dayStr: string) =>
    app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  async function nfcPunch(dayStr: string, hhmm: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${deadKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "nfc541race");
    salonPattern = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon P (Muster)" });
    salonDead = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon X (deaktiviert)",
      isActive: false,
    });
    await app.prisma.employeeSalonAssignment.create({
      data: {
        tenantId: seed.tenant.id,
        employeeId: seed.employee.id,
        salonId: salonPattern.id,
        kind: "HOME",
        validFrom: new Date("2020-01-01"),
        validUntil: null,
        weekdays: [],
      },
    });
    await app.prisma.employee.update({
      where: { id: seed.employee.id },
      data: { nfcCardId: NFC_CARD_ID },
    });
    deadKey = `clk_${randomBytes(32).toString("hex")}`;
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: seed.tenant.id,
        name: "541 race terminal",
        keyHash: createHash("sha256").update(deadKey).digest("hex"),
        keyPrefix: deadKey.slice(0, 12) + "...",
        salonId: salonDead.id,
      },
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("a fresh day: the resolver refuses the dead terminal salon, the retry records the punch in the pattern salon", async () => {
    const day = dayOf(1);
    const res = await nfcPunch(day, "09:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("IN");
    expect(body.resolution.entry?.salonId).toBe(salonPattern.id);
    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].salonId).toBe(salonPattern.id);
  });

  it("a finished day: the closed-entry branch refuses the dead salon first, the retry re-opens the entry", async () => {
    const day = dayOf(2);
    const closed = await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: dateOf(day),
        startTime: instant(day, "08:00"),
        endTime: instant(day, "12:00"),
        source: "MOBILE",
        breakMinutes: 0,
        salonId: salonPattern.id,
      },
    });
    const res = await nfcPunch(day, "13:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("IN");
    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(closed.id);
    expect(rows[0].endTime).toBeNull();
    expect(rows[0].salonId).toBe(salonPattern.id);
  });
});
