import type { FritzDevice } from "./tr064.js";

// ── Constants (exported for testability) ──────────────────────────────────────
/** Number of consecutive absent polls before emitting a disconnected event (REQ-14) */
export const ABSENT_THRESHOLD = 6;

/** Milliseconds of absence that triggers a synthetic disconnect before reconnect (REQ-15) */
export const GAP_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ── Internal types ─────────────────────────────────────────────────────────────
interface MacState {
  lastState: "connected" | "disconnected";
  /** Last time the MAC was observed as active */
  lastSeen: Date;
  /** Number of consecutive polls where this MAC was absent (resets on reconnect) */
  absentCount: number;
}

// ── Public types ──────────────────────────────────────────────────────────────
export interface PresenceEvent {
  macAddress: string;
  state: "connected" | "disconnected";
  timestamp: Date;
}

// ── State machine ─────────────────────────────────────────────────────────────
export class PresenceStateManager {
  private readonly map: Map<string, MacState> = new Map();

  /**
   * Process a fresh host list snapshot from the FritzBox.
   * Returns PresenceEvents that must be posted to the clokr-api immediately.
   *
   * REQ-14: Debounce — a MAC must be absent for ABSENT_THRESHOLD consecutive
   * polls before a disconnected event is emitted.
   *
   * REQ-15: Gap detection — if a MAC reappears after >= GAP_THRESHOLD_MS ms
   * of absence, emit a synthetic disconnected event (at lastSeen time) before
   * the connected event.
   */
  processHostList(hosts: FritzDevice[], now: Date): PresenceEvent[] {
    const activeMacs = new Set(hosts.filter((h) => h.active).map((h) => h.mac));
    const events: PresenceEvent[] = [];

    // ── Handle active MACs ────────────────────────────────────────────────────
    for (const mac of activeMacs) {
      const existing = this.map.get(mac);

      if (!existing) {
        // First time we see this MAC — emit connected immediately
        this.map.set(mac, { lastState: "connected", lastSeen: now, absentCount: 0 });
        events.push({ macAddress: mac, state: "connected", timestamp: now });
        continue;
      }

      if (existing.lastState === "disconnected") {
        // MAC was previously disconnected (debounce threshold already fired)
        const gapMs = now.getTime() - existing.lastSeen.getTime();

        if (gapMs >= GAP_THRESHOLD_MS) {
          // Long gap: emit synthetic disconnect at lastSeen time, then connected now
          events.push({ macAddress: mac, state: "disconnected", timestamp: existing.lastSeen });
          events.push({ macAddress: mac, state: "connected", timestamp: now });
        }
        // Short gap (<30 min): reconnect silently — no event emitted to avoid
        // spurious clock-in retries for brief outages
      }
      // Whether it was "connected" or "disconnected", update state on active poll
      this.map.set(mac, { lastState: "connected", lastSeen: now, absentCount: 0 });
    }

    // ── Handle absent MACs (debounce logic) ───────────────────────────────────
    for (const [mac, existing] of this.map) {
      if (activeMacs.has(mac)) continue; // already handled above

      if (existing.lastState === "disconnected") {
        // Already in disconnected state — nothing to do
        continue;
      }

      const newAbsentCount = existing.absentCount + 1;

      if (newAbsentCount >= ABSENT_THRESHOLD) {
        // Debounce threshold reached — emit disconnected
        events.push({ macAddress: mac, state: "disconnected", timestamp: now });
        this.map.set(mac, {
          lastState: "disconnected",
          lastSeen: existing.lastSeen,
          absentCount: newAbsentCount,
        });
      } else {
        // Still within grace window — increment counter, do not emit
        this.map.set(mac, { ...existing, absentCount: newAbsentCount });
      }
    }

    return events;
  }

  /** Returns the full internal MAC state map (used by GET /devices snapshot). */
  getAll(): Map<string, MacState> {
    return this.map;
  }
}
