import { describe, it, expect } from "vitest";
import { resolvePresenceState } from "../utils/presence";

// Helpers
const future = true;
const past = false;
const workday = true;
const noWorkday = false;
const hasShift = true;
const noShift = false;

const validOpen = { endTime: null, isInvalid: false };
const validClosed = { endTime: new Date("2026-04-10T16:00:00Z"), isInvalid: false };
const invalidOpen = { endTime: null, isInvalid: true };
const invalidClosed = { endTime: new Date("2026-04-10T16:00:00Z"), isInvalid: true };
const approvedLeave = { status: "APPROVED" as const, leaveTypeName: "Urlaub" };
const cancellationRequestedLeave = {
  status: "CANCELLATION_REQUESTED" as const,
  leaveTypeName: "Urlaub",
};
const sickAbsence = { type: "SICK" };

describe("resolvePresenceState", () => {
  it("returns clocked_in for a valid open entry", () => {
    const result = resolvePresenceState({
      entries: [validOpen],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "clocked_in", reason: null });
  });

  it("returns present for a valid completed entry", () => {
    const result = resolvePresenceState({
      entries: [validClosed],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "present", reason: null });
  });

  it("ignores isInvalid:true open entry — shows missing for past workday", () => {
    const result = resolvePresenceState({
      entries: [invalidOpen],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "missing", reason: null });
  });

  it("ignores isInvalid:true closed entry — shows missing for past workday", () => {
    const result = resolvePresenceState({
      entries: [invalidClosed],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "missing", reason: null });
  });

  it("isInvalid entry + CANCELLATION_REQUESTED leave → absent (not present)", () => {
    // D-08 + D-09: invalid entry filtered, leave drives status
    const result = resolvePresenceState({
      entries: [invalidOpen],
      leave: cancellationRequestedLeave,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "absent", reason: "Urlaubsstornierung beantragt" });
  });

  it("CANCELLATION_REQUESTED leave → absent with German reason (D-09)", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: cancellationRequestedLeave,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "absent", reason: "Urlaubsstornierung beantragt" });
  });

  it("APPROVED leave → absent with leave type name", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: approvedLeave,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "absent", reason: "Urlaub" });
  });

  it("valid present entry beats APPROVED leave (presence priority)", () => {
    const result = resolvePresenceState({
      entries: [validClosed],
      leave: approvedLeave,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "present", reason: null });
  });

  it("absence → absent with German label", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: null,
      absence: sickAbsence,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "absent", reason: "Krankmeldung" });
  });

  it("future workday with no entries → scheduled", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: future,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "scheduled", reason: null });
  });

  it("future shift (non-workday) with no entries → scheduled", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: null,
      absence: null,
      isWorkday: noWorkday,
      isFuture: future,
      hasShift: hasShift,
    });
    expect(result).toEqual({ status: "scheduled", reason: null });
  });

  it("past workday with no entries → missing", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: null,
      absence: null,
      isWorkday: workday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "missing", reason: null });
  });

  it("past non-workday, no shift, no entries → none", () => {
    const result = resolvePresenceState({
      entries: [],
      leave: null,
      absence: null,
      isWorkday: noWorkday,
      isFuture: past,
      hasShift: noShift,
    });
    expect(result).toEqual({ status: "none", reason: null });
  });
});
