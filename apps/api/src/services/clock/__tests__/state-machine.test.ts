import { describe, it, expect } from "vitest";
import { decide } from "../state-machine";
import type { ClockState } from "../types";

describe("services/clock/state-machine — decide()", () => {
  describe("intent = AUTO (NFC tap, WIFI connected)", () => {
    it("NO_OPEN_ENTRY + AUTO → START", () => {
      const state: ClockState = { kind: "NO_OPEN_ENTRY" };
      expect(decide(state, "AUTO", "NFC")).toEqual({ kind: "START" });
    });

    it("OPEN_ENTRY same source + AUTO → STOP (toggle close)", () => {
      const state: ClockState = { kind: "OPEN_ENTRY", entryId: "entry-1", source: "NFC" };
      expect(decide(state, "AUTO", "NFC")).toEqual({ kind: "STOP", entryId: "entry-1" });
    });

    it("OPEN_ENTRY cross source + AUTO → CONFIRM (WIFI re-detects NFC entry)", () => {
      const state: ClockState = { kind: "OPEN_ENTRY", entryId: "entry-1", source: "NFC" };
      expect(decide(state, "AUTO", "WIFI")).toEqual({ kind: "CONFIRM", entryId: "entry-1" });
    });
  });

  describe("intent = IN (explicit /clock-in)", () => {
    it("NO_OPEN_ENTRY + IN → START", () => {
      const state: ClockState = { kind: "NO_OPEN_ENTRY" };
      expect(decide(state, "IN", "MOBILE")).toEqual({ kind: "START" });
    });

    it("OPEN_ENTRY + IN → CONFLICT ALREADY_CLOCKED_IN", () => {
      const state: ClockState = { kind: "OPEN_ENTRY", entryId: "entry-1", source: "MOBILE" };
      expect(decide(state, "IN", "MOBILE")).toEqual({
        kind: "CONFLICT",
        reason: "ALREADY_CLOCKED_IN",
      });
    });
  });

  describe("intent = OUT (explicit /clock-out, WIFI disconnected)", () => {
    it("OPEN_ENTRY + OUT → STOP", () => {
      const state: ClockState = { kind: "OPEN_ENTRY", entryId: "entry-1", source: "MOBILE" };
      expect(decide(state, "OUT", "MOBILE")).toEqual({ kind: "STOP", entryId: "entry-1" });
    });

    it("NO_OPEN_ENTRY + OUT → CONFLICT NOT_CLOCKED_IN", () => {
      const state: ClockState = { kind: "NO_OPEN_ENTRY" };
      expect(decide(state, "OUT", "MOBILE")).toEqual({
        kind: "CONFLICT",
        reason: "NOT_CLOCKED_IN",
      });
    });
  });

  describe("source-agnostic — unknown future sources handled gracefully", () => {
    it("AUTO + NO_OPEN_ENTRY + 'SYNTHETIC' source → START (architectural enforcement)", () => {
      const state: ClockState = { kind: "NO_OPEN_ENTRY" };
      expect(decide(state, "AUTO", "SYNTHETIC")).toEqual({ kind: "START" });
    });
  });
});
