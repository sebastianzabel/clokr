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
 * Phase 541-02 extends it with the full matrix: AC-1 / D-06 (new entry in the bound salon on a
 * finished day of another salon, re-open when the latest entry is already there, OUT of an open
 * entry that keeps its salon, the four unchanged refusals with nothing written, a body salonId is
 * ignored), AC-2 (an unbound key behaves exactly as before on a two-salon day) and AC-3 / D-05 (a
 * key bound to a since-deactivated salon still records the punch by today's rule).
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
  let salonOther: { id: string };
  let boundKey: string;
  let boundToOtherKey: string;
  let unboundKey: string;

  // One distinct past weekday per case so no case shares a day with another.
  const baseMonday = addDaysStr(mondayOfWeekStr(), -24 * 7);
  const dayOf = (offset: number): string => addDaysStr(baseMonday, offset);

  const dateOf = (dayStr: string) => new Date(`${dayStr}T00:00:00Z`);

  /** A closed (or, with `to` null, open) entry `from`-`to` of `dayStr` booked to `salonId`. */
  function seedEntry(
    dayStr: string,
    salonId: string,
    from: string,
    to: string | null,
    opts: { locked?: boolean; source?: "MOBILE" | "NFC" } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: dateOf(dayStr),
        startTime: instant(dayStr, from),
        endTime: to === null ? null : instant(dayStr, to),
        // An AUTO punch closes only an entry of its own source (state machine); a cross-source
        // tap would be a presence CONFIRM, not an OUT.
        source: opts.source ?? "MOBILE",
        isLocked: opts.locked ?? false,
        breakMinutes: 0,
        salonId,
      },
    });
  }

  const liveRows = (dayStr: string) =>
    app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr), deletedAt: null },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });

  /** Every row of the day (soft-deleted included) as one comparable string. */
  async function daySnapshot(dayStr: string): Promise<string> {
    const rows = await app.prisma.timeEntry.findMany({
      where: { employeeId: seed.employee.id, date: dateOf(dayStr) },
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
    });
    const breaks = await app.prisma.break.count({
      where: { timeEntryId: { in: rows.map((r) => r.id) } },
    });
    return JSON.stringify({ rows, breaks });
  }

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

  async function nfcPunch(
    rawKey: string,
    dayStr: string,
    hhmm: string,
    extraPayload: Record<string, unknown> = {},
  ) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant(dayStr, hhmm));
    try {
      return await app.inject({
        method: "POST",
        url: "/api/v1/time-entries/nfc-punch",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { nfcCardId: NFC_CARD_ID, ...extraPayload },
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

    salonOther = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon B (Anderer)" });

    boundKey = await createKey(salonTerminal.id, "541 bound terminal");
    boundToOtherKey = await createKey(salonOther.id, "541 terminal bound to B");
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

  // ── AC-1 / D-06: what a bound key does on days that already carry entries ──────────────────

  it("AC-1 (1): a finished day whose latest entry is in another salon starts a NEW entry in the bound salon", async () => {
    const day = dayOf(3);
    const b = await seedEntry(day, salonOther.id, "08:00", "12:00");
    const res = await nfcPunch(boundKey, day, "13:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("IN");
    expect(body.resolution.entry?.salonId).toBe(salonTerminal.id);

    const rows = await liveRows(day);
    expect(rows).toHaveLength(2);
    const untouched = rows.find((r) => r.id === b.id)!;
    expect(untouched.endTime?.toISOString()).toBe(instant(day, "12:00").toISOString());
    expect(untouched.salonId).toBe(salonOther.id);
    expect(await app.prisma.break.count({ where: { timeEntryId: b.id } })).toBe(0);
    const created = rows.find((r) => r.id !== b.id)!;
    expect(created.salonId).toBe(salonTerminal.id);
    expect(created.endTime).toBeNull();
  });

  it("AC-1 (2): a finished day whose latest entry is already in the bound salon re-opens it", async () => {
    const day = dayOf(4);
    const t = await seedEntry(day, salonTerminal.id, "08:00", "12:00");
    const res = await nfcPunch(boundKey, day, "13:00");
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as PunchBody).action).toBe("IN");

    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(t.id);
    expect(rows[0].endTime).toBeNull();
    expect(rows[0].salonId).toBe(salonTerminal.id);
  });

  it("AC-1 (3): an open entry in another salon is closed (OUT) and keeps its salon", async () => {
    const day = dayOf(5);
    const b = await seedEntry(day, salonOther.id, "08:00", null, { source: "NFC" });
    const res = await nfcPunch(boundKey, day, "12:00");
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as PunchBody;
    expect(body.action).toBe("OUT");
    expect(body.resolution.entry?.id).toBe(b.id);

    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].endTime).not.toBeNull();
    expect(rows[0].salonId).toBe(salonOther.id);
  });

  it("AC-1 (5): a salonId in the request body is ignored under a bound key", async () => {
    const day = dayOf(6);
    const res = await nfcPunch(boundKey, day, "09:00", { salonId: salonOther.id });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as PunchBody).resolution.entry?.salonId).toBe(salonTerminal.id);
    const rows = await liveRows(day);
    expect(rows).toHaveLength(1);
    expect(rows[0].salonId).toBe(salonTerminal.id);
  });

  // ── D-06: the four refusals answer under a bound salon exactly as before, and write nothing ──

  type RefusalBody = {
    error: string;
    code?: string;
    action?: string;
    resolution: { reason: string };
  };

  it("AC-1 / D-06 (4a): LEAVE_APPROVED under a bound salon is refused, nothing written", async () => {
    const day = dayOf(7);
    await app.prisma.leaveRequest.create({
      data: {
        employeeId: seed.employee.id,
        leaveTypeId: seed.vacationType.id,
        startDate: dateOf(day),
        endDate: dateOf(day),
        days: 1,
        status: "APPROVED",
      },
    });
    const before = await daySnapshot(day);
    const res = await nfcPunch(boundKey, day, "09:00");
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as RefusalBody;
    expect(body.error).toBe("§ 8 BUrlG: Heute ist Urlaub genehmigt. Bitte zuerst stornieren.");
    expect(body.action).toBe("BLOCKED");
    expect(body.resolution.reason).toBe("LEAVE_APPROVED");
    expect(await daySnapshot(day)).toBe(before);
    expect(await liveRows(day)).toHaveLength(0);
  });

  it("AC-1 / D-06 (4b): MONTH_LOCKED under a bound salon is refused, the locked entry is untouched", async () => {
    const day = dayOf(8);
    await seedEntry(day, salonOther.id, "08:00", "12:00", { locked: true });
    const before = await daySnapshot(day);
    const res = await nfcPunch(boundKey, day, "13:00");
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as RefusalBody;
    expect(body.error).toBe("Eintrag ist gesperrt und kann nicht bearbeitet werden");
    expect(body.resolution.reason).toBe("MONTH_LOCKED");
    expect(await daySnapshot(day)).toBe(before);
    expect(await liveRows(day)).toHaveLength(1);
  });

  it("AC-1 / D-06 (4c): ENTRY_OVERLAP under a bound salon is refused, nothing written", async () => {
    const day = dayOf(9);
    await seedEntry(day, salonOther.id, "14:00", "16:00");
    const before = await daySnapshot(day);
    const res = await nfcPunch(boundKey, day, "10:00");
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as RefusalBody;
    expect(body.code).toBe("ENTRY_OVERLAP");
    expect(body.resolution.reason).toBe("ENTRY_OVERLAP");
    expect(await daySnapshot(day)).toBe(before);
    expect(await liveRows(day)).toHaveLength(1);
  });

  it("AC-1 / D-06 (4d): RETRO_PENDING under a bound salon is refused, the Nachtrag stays PENDING", async () => {
    // Issue #657: the coupled row below is seeded WITHOUT the pending marker (`invalidReasonCode`
    // null, a pre-code row shape), which is exactly what the resolver's RETRO_PENDING backstop
    // covers; a row carrying the marker is no clock candidate (retro-pending-clock-657.test.ts).
    const day = dayOf(10);
    const request = await app.prisma.retroEntryRequest.create({
      data: {
        employeeId: seed.employee.id,
        targetDate: dateOf(day),
        reason: "541 fixture: pending Zeitnachtrag",
        startTime: "08:00",
        endTime: "12:00",
        breakMinutes: 0,
        status: "PENDING",
      },
    });
    await app.prisma.timeEntry.create({
      data: {
        employeeId: seed.employee.id,
        date: dateOf(day),
        startTime: instant(day, "08:00"),
        endTime: instant(day, "12:00"),
        breakMinutes: 0,
        source: "MANUAL",
        createdBy: seed.employee.id,
        isInvalid: true,
        invalidReason: "Nachtrag – Genehmigung ausstehend",
        retroRequestId: request.id,
        salonId: salonOther.id,
      },
    });
    const before = await daySnapshot(day);
    const res = await nfcPunch(boundKey, day, "13:00");
    expect(res.statusCode, res.body).toBe(409);
    const body = JSON.parse(res.body) as RefusalBody;
    expect(body.error).toBe("Für diesen Tag liegt ein offener Zeitnachtrag zur Genehmigung vor.");
    expect(body.action).toBe("BLOCKED");
    expect(body.resolution.reason).toBe("RETRO_PENDING");
    expect(await daySnapshot(day)).toBe(before);
    const reloaded = await app.prisma.retroEntryRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(reloaded.status).toBe("PENDING");
  });

  // ── AC-2: an unbound key behaves exactly as before #541 ─────────────────────────────────────

  it("AC-2 (6a): an unbound key on a two-salon day re-opens the latest entry, then closes it", async () => {
    const day = dayOf(11);
    await seedEntry(day, salonPattern.id, "08:00", "12:00");
    const b = await seedEntry(day, salonOther.id, "12:30", "16:00", { source: "NFC" });

    const inRes = await nfcPunch(unboundKey, day, "17:00");
    expect(inRes.statusCode, inRes.body).toBe(200);
    expect((JSON.parse(inRes.body) as PunchBody).action).toBe("IN");
    const reopened = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(reopened.endTime).toBeNull();
    expect(reopened.salonId).toBe(salonOther.id);
    expect(await liveRows(day)).toHaveLength(2);

    const outRes = await nfcPunch(unboundKey, day, "18:00");
    expect(outRes.statusCode, outRes.body).toBe(200);
    const outBody = JSON.parse(outRes.body) as PunchBody;
    expect(outBody.action).toBe("OUT");
    expect(outBody.resolution.entry?.id).toBe(b.id);
    const closed = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(closed.endTime).not.toBeNull();
    expect(closed.salonId).toBe(salonOther.id);
    expect(await liveRows(day)).toHaveLength(2);
  });

  it("AC-2 (6b): a key bound to the latest entry's salon answers identically (re-open, not a new entry)", async () => {
    const day = dayOf(12);
    await seedEntry(day, salonPattern.id, "08:00", "12:00");
    const b = await seedEntry(day, salonOther.id, "12:30", "16:00");

    const res = await nfcPunch(boundToOtherKey, day, "17:00");
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as PunchBody).action).toBe("IN");
    const reopened = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(reopened.endTime).toBeNull();
    expect(reopened.salonId).toBe(salonOther.id);
    expect(await liveRows(day)).toHaveLength(2);
  });

  // ── AC-3 / D-05: a binding to a deactivated salon never costs a punch ───────────────────────

  it("AC-3 (7): deactivating a bound salon is allowed, keeps the binding, and the punch follows today's rule", async () => {
    const salonX = await createTestSalon(app.prisma, seed.tenant.id, { name: "Salon X (spaeter)" });
    const keyX = await createKey(salonX.id, "541 terminal bound to X");

    const deact = await app.inject({
      method: "POST",
      url: `/api/v1/salons/${salonX.id}/deactivate`,
      headers: { authorization: `Bearer ${seed.adminToken}` },
    });
    expect(deact.statusCode, deact.body).toBe(200);
    const keyRow = await app.prisma.terminalApiKey.findFirstOrThrow({
      where: { tenantId: seed.tenant.id, name: "541 terminal bound to X" },
    });
    expect(keyRow.salonId).toBe(salonX.id);

    // A fresh day: the weekly pattern decides (salon P), the dead binding is ignored.
    const fresh = dayOf(13);
    const freshRes = await nfcPunch(keyX, fresh, "09:00");
    expect(freshRes.statusCode, freshRes.body).toBe(200);
    const freshBody = JSON.parse(freshRes.body) as PunchBody;
    expect(freshBody.action).toBe("IN");
    expect(freshBody.resolution.entry?.salonId).toBe(salonPattern.id);

    // A finished day whose latest entry is in B: re-opened, not a 409.
    const finished = dayOf(14);
    const b = await seedEntry(finished, salonOther.id, "08:00", "12:00");
    const finishedRes = await nfcPunch(keyX, finished, "13:00");
    expect(finishedRes.statusCode, finishedRes.body).toBe(200);
    expect((JSON.parse(finishedRes.body) as PunchBody).action).toBe("IN");
    const reopened = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(reopened.endTime).toBeNull();
    expect(reopened.salonId).toBe(salonOther.id);
    expect(await liveRows(finished)).toHaveLength(1);
  });
});
