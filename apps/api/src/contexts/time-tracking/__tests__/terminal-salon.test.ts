/**
 * Issue #541 — pure unit proof of the two punch-side functions of `terminal-salon.ts`
 * (fake db, fake log, fake resolve; no database).
 */
import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@clokr/db";
import { resolveTerminalPunch, terminalPunchSalon } from "../terminal-salon";
import type { ClockEvent, ClockResolution } from "../../../services/clock/types";

const TENANT = "tenant-1";
const KEY_ID = "key-1";
const SALON = "salon-1";

function fakeDb(found: { id: string; isActive: boolean } | null) {
  const findFirst = vi.fn().mockResolvedValue(found);
  const db = { salon: { findFirst } } as unknown as Prisma.TransactionClient;
  return { db, findFirst };
}

function fakeLog() {
  return { warn: vi.fn() };
}

function baseEvent(extra: Partial<ClockEvent> = {}): ClockEvent {
  return {
    employeeId: "emp-1",
    tenantId: TENANT,
    source: "NFC",
    intent: "AUTO",
    timestamp: new Date("2026-10-05T08:00:00.000Z"),
    date: new Date("2026-10-05T00:00:00.000Z"),
    dateStr: "2026-10-05",
    actor: { type: "TERMINAL", terminalApiKeyId: KEY_ID },
    interactive: false,
    ...extra,
  };
}

const inactive: ClockResolution = { kind: "CONFLICT", reason: "SALON_INACTIVE" };
const ok = { kind: "DEBOUNCE_NOOP" } as ClockResolution;

describe("terminalPunchSalon", () => {
  it("an unbound key contributes no salonId key, reads nothing and does not warn", async () => {
    const { db, findFirst } = fakeDb(null);
    const log = fakeLog();
    const result = await terminalPunchSalon(db, log, {
      id: KEY_ID,
      tenantId: TENANT,
      salonId: null,
    });
    expect("salonId" in result).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a key bound to an active salon returns { salonId } via a tenant-scoped read", async () => {
    const { db, findFirst } = fakeDb({ id: SALON, isActive: true });
    const log = fakeLog();
    const result = await terminalPunchSalon(db, log, {
      id: KEY_ID,
      tenantId: TENANT,
      salonId: SALON,
    });
    expect(result).toEqual({ salonId: SALON });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: SALON, tenantId: TENANT });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("a bound but deactivated salon returns {} with one TERMINAL_SALON_INACTIVE warn", async () => {
    const { db } = fakeDb({ id: SALON, isActive: false });
    const log = fakeLog();
    const result = await terminalPunchSalon(db, log, {
      id: KEY_ID,
      tenantId: TENANT,
      salonId: SALON,
    });
    expect(result).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      terminalApiKeyId: KEY_ID,
      salonId: SALON,
      reason: "TERMINAL_SALON_INACTIVE",
    });
  });

  it("a bound salon that is not found returns {} with one TERMINAL_SALON_NOT_FOUND warn", async () => {
    const { db } = fakeDb(null);
    const log = fakeLog();
    const result = await terminalPunchSalon(db, log, {
      id: KEY_ID,
      tenantId: TENANT,
      salonId: SALON,
    });
    expect(result).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      terminalApiKeyId: KEY_ID,
      salonId: SALON,
      reason: "TERMINAL_SALON_NOT_FOUND",
    });
  });
});

describe("resolveTerminalPunch", () => {
  it("an event without a salon is resolved once with the same event, even on SALON_INACTIVE", async () => {
    const event = baseEvent();
    const resolve = vi.fn().mockResolvedValueOnce(inactive);
    const log = fakeLog();
    const result = await resolveTerminalPunch(event, resolve, log, KEY_ID);
    expect(result).toBe(inactive);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toBe(event);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("SALON_INACTIVE for the terminal salon retries once without the salon key", async () => {
    const event = baseEvent({ salonId: SALON });
    const resolve = vi.fn().mockResolvedValueOnce(inactive).mockResolvedValueOnce(ok);
    const log = fakeLog();
    const result = await resolveTerminalPunch(event, resolve, log, KEY_ID);
    expect(result).toBe(ok);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0][0]).toBe(event);
    const second = resolve.mock.calls[1][0] as ClockEvent;
    expect("salonId" in second).toBe(false);
    const { salonId: _dropped, ...expected } = event;
    expect(second).toEqual(expected);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatchObject({
      terminalApiKeyId: KEY_ID,
      salonId: SALON,
      reason: "SALON_INACTIVE",
    });
  });

  it.each([
    "SALON_NOT_FOUND",
    "MONTH_LOCKED",
    "ENTRY_OVERLAP",
    "LEAVE_APPROVED",
    "RETRO_PENDING",
  ] as const)("a %s conflict is returned unchanged without a retry", async (reason) => {
    const event = baseEvent({ salonId: SALON });
    const first: ClockResolution = { kind: "CONFLICT", reason };
    const resolve = vi.fn().mockResolvedValueOnce(first);
    const log = fakeLog();
    const result = await resolveTerminalPunch(event, resolve, log, KEY_ID);
    expect(result).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("never calls resolve more than twice, whatever the second result is", async () => {
    const event = baseEvent({ salonId: SALON });
    const resolve = vi.fn().mockResolvedValue(inactive);
    const log = fakeLog();
    const result = await resolveTerminalPunch(event, resolve, log, KEY_ID);
    expect(result).toBe(inactive);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
