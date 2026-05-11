import { describe, it, expect } from "vitest";
import { PresenceStateManager, ABSENT_THRESHOLD } from "../state.js";
import type { FritzDevice } from "../tr064.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const TEST_MAC = "aa:bb:cc:dd:ee:ff";
const TEST_DEVICE: FritzDevice = {
  mac: TEST_MAC,
  hostname: "test-device",
  active: true,
  ip: "192.168.1.42",
};

/** Advance a date by a given number of milliseconds. */
function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** Advance a date by a given number of minutes. */
function addMin(d: Date, minutes: number): Date {
  return addMs(d, minutes * 60_000);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PresenceStateManager — REQ-14: Debounce", () => {
  it("REQ-14: fewer than ABSENT_THRESHOLD absent polls do not emit disconnected", () => {
    const mgr = new PresenceStateManager();
    const T0 = new Date("2026-01-01T08:00:00Z");

    // Connect the device first
    mgr.processHostList([TEST_DEVICE], T0);

    // Poll ABSENT_THRESHOLD - 1 times with the MAC absent
    for (let i = 1; i <= ABSENT_THRESHOLD - 1; i++) {
      const events = mgr.processHostList([], addMin(T0, i));
      const disconnectedEvents = events.filter((e) => e.state === "disconnected");
      expect(disconnectedEvents).toHaveLength(0);
    }
  });

  it("REQ-14: exactly ABSENT_THRESHOLD absent polls emits one disconnected", () => {
    const mgr = new PresenceStateManager();
    const T0 = new Date("2026-01-01T08:00:00Z");

    // Connect the device
    mgr.processHostList([TEST_DEVICE], T0);

    // Poll ABSENT_THRESHOLD - 1 times — should not emit disconnected
    for (let i = 1; i <= ABSENT_THRESHOLD - 1; i++) {
      mgr.processHostList([], addMin(T0, i));
    }

    // The ABSENT_THRESHOLD-th absent poll must emit exactly one disconnected
    const finalEvents = mgr.processHostList([], addMin(T0, ABSENT_THRESHOLD));
    const disconnectedEvents = finalEvents.filter((e) => e.state === "disconnected");
    expect(disconnectedEvents).toHaveLength(1);
    expect(disconnectedEvents[0].macAddress).toBe(TEST_MAC);
    expect(disconnectedEvents[0].state).toBe("disconnected");
  });

  it("REQ-14: debounce counter resets when MAC reappears before threshold", () => {
    const mgr = new PresenceStateManager();
    const T0 = new Date("2026-01-01T08:00:00Z");

    // Connect the device at T0
    mgr.processHostList([TEST_DEVICE], T0);

    // 3 absent polls (below ABSENT_THRESHOLD = 6)
    for (let i = 1; i <= 3; i++) {
      mgr.processHostList([], addMin(T0, i));
    }

    // MAC reappears — counter must reset to 0
    mgr.processHostList([TEST_DEVICE], addMin(T0, 4));

    // Now ABSENT_THRESHOLD more absent polls — disconnected should fire only on the Nth
    // (not earlier, because the counter was reset to 0 on reconnect)
    for (let i = 1; i <= ABSENT_THRESHOLD - 1; i++) {
      const events = mgr.processHostList([], addMin(T0, 4 + i));
      const disconnectedEvents = events.filter((e) => e.state === "disconnected");
      expect(disconnectedEvents).toHaveLength(0);
    }

    // The Nth absent poll after reset should emit disconnected
    const finalEvents = mgr.processHostList([], addMin(T0, 4 + ABSENT_THRESHOLD));
    const disconnectedEvents = finalEvents.filter((e) => e.state === "disconnected");
    expect(disconnectedEvents).toHaveLength(1);
  });
});

describe("PresenceStateManager — REQ-15: Gap synthetic disconnect", () => {
  it("REQ-15: gap >= 30 min emits synthetic disconnected before connected", () => {
    const mgr = new PresenceStateManager();
    const T0 = new Date("2026-01-01T08:00:00Z");

    // Connect at T0
    mgr.processHostList([TEST_DEVICE], T0);

    // ABSENT_THRESHOLD absent polls to transition to disconnected state
    for (let i = 1; i <= ABSENT_THRESHOLD; i++) {
      mgr.processHostList([], addMin(T0, i));
    }
    // MAC is now in "disconnected" state; lastSeen is T0 (last time device was active)
    const lastSeen = T0;

    // Reconnect at T0 + 31 min (>= GAP_THRESHOLD_MS)
    const reconnectTime = addMin(T0, 31);
    const events = mgr.processHostList([TEST_DEVICE], reconnectTime);

    // Must have exactly 2 events: synthetic disconnect then connected
    expect(events).toHaveLength(2);
    expect(events[0].state).toBe("disconnected");
    expect(events[1].state).toBe("connected");
    expect(events[1].timestamp).toEqual(reconnectTime);

    // The synthetic disconnect timestamp should be lastSeen (T0 — last active poll)
    expect(events[0].timestamp).toEqual(lastSeen);
  });

  it("REQ-15: gap < 30 min does NOT emit synthetic disconnect", () => {
    const mgr = new PresenceStateManager();
    const T0 = new Date("2026-01-01T08:00:00Z");

    // Connect at T0
    mgr.processHostList([TEST_DEVICE], T0);

    // ABSENT_THRESHOLD absent polls to reach disconnected state
    for (let i = 1; i <= ABSENT_THRESHOLD; i++) {
      mgr.processHostList([], addMin(T0, i));
    }

    // Reconnect at T0 + 29 min (< GAP_THRESHOLD_MS)
    const reconnectTime = addMin(T0, 29);
    const events = mgr.processHostList([TEST_DEVICE], reconnectTime);

    // Must contain zero disconnected events (short reconnect = silent)
    const disconnectedEvents = events.filter((e) => e.state === "disconnected");
    expect(disconnectedEvents).toHaveLength(0);
  });
});
