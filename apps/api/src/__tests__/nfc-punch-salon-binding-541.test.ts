/**
 * Issue #541 (Phase 541-01, D-01/D-05) — an NFC terminal key bound to a salon.
 *
 * Proves, against a real database and through the real route `POST /time-entries/nfc-punch`:
 *
 * - a punch at a key bound to an ACTIVE salon starts the day's entry in that salon although the
 *   employee's weekly pattern (HOME assignment) names another salon;
 * - control: a punch at an UNBOUND key of the same tenant keeps the pattern salon, so the first
 *   case is not vacuous (the pattern is effective in this fixture).
 *
 * The clock resolver is not touched by #541; the binding reaches it only as `event.salonId`.
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { addDaysStr, mondayOfWeekStr, TEST_TZ } from "./test-dates";

/** Tenant-local instant for `HH:MM` on `dayStr`. */
function instant(dayStr: string, hhmm: string): Date {
  return fromZonedTime(`${dayStr}T${hhmm}:00`, TEST_TZ);
}

type PunchBody = {
  action?: string;
  resolution: { kind: string; entry?: { id: string; salonId: string } };
};

const NFC_CARD_ID = `NFC-541-${randomUUID()}`;

describe("Issue #541 — NFC punch at a terminal bound to a salon (D-05)", () => {
  let app: FastifyInstance;
  let seed: Awaited<ReturnType<typeof seedTestData>>;
  let salonPattern: { id: string };
  let salonTerminal: { id: string };
  let boundKey: string;
  let unboundKey: string;

  // One distinct past weekday per case so no case shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -24 * 7);
  const dayOf = (offset: number): string => addDaysStr(baseMonday, offset);

  async function createKey(salonId: string | null, name: string): Promise<string> {
    const raw = `clk_${randomBytes(32).toString("hex")}`;
    await app.prisma.terminalApiKey.create({
      data: {
        tenantId: seed.tenant.id,
        name,
        keyHash: createHash("sha256").update(raw).digest("hex"),
        keyPrefix: raw.slice(0, 12) + "...",
        ...(salonId ? { salonId } : {}),
      },
    });
    return raw;
  }

  async function nfcPunch(rawKey: string, dayStr: string, hhmm: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { nfcCardId: NFC_CARD_ID },
      });
    } finally {
      vi.useRealTimers();
    }
  }

  beforeAll(async () => {
    app = await getTestApp();
    seed = await seedTestData(app, "nfc541");
    salonPattern = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon P (Muster)" });
    salonTerminal = await createTestSalon(app.prisma, seed.tenant.id, {
      name: "Salon T (Terminal)",
    });

    // The weekly pattern names salon P on every weekday.
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

    boundKey = await createKey(salonTerminal.id, "541 bound terminal");
    unboundKey = await createKey(null, "541 unbound terminal");
  });

  afterAll(async () => {
    try {
      // Keys reference salons with ON DELETE RESTRICT: they go before the salons.
      await app.prisma.terminalApiKey.deleteMany({ where: { tenantId: seed.tenant.id } });
      await cleanupTestData(app, seed.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("a bound terminal starts the day's entry in its salon although the pattern names another", async () => {
    const day = dayOf(1); // Tuesday
    const res = await nfcPunch(boundKey, day, "09:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("IN");
    expect(body.resolution.entry?.salonId).toBe(salonTerminal.id);

    const stored = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: new Date(`${day}T00:00:00Z`), deletedAt: null },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].salonId).toBe(salonTerminal.id);
  });

  it("control: an unbound terminal keeps the pattern salon", async () => {
    const day = dayOf(2); // Wednesday
    const res = await nfcPunch(unboundKey, day, "09:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("IN");
    expect(body.resolution.entry?.salonId).toBe(salonPattern.id);
  });
});
