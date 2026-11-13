// Issue #609 (D-09, D-14, AC-4): the pure decision behind /dashboard?clock=1.
import { describe, expect, it } from "vitest";

import {
  clockReminderAction,
  clockReminderDialog,
  stripClockParam,
  type ClockReminderInput,
} from "../clock-reminder";

const BASE: ClockReminderInput = {
  param: "1",
  loading: false,
  isExempt: false,
  dayKind: "idle",
  clockInBlocked: false,
};

describe("clockReminderAction", () => {
  it.each([null, "0", "in", "", "true"])("param %j never does anything", (param) => {
    expect(clockReminderAction({ ...BASE, param })).toBe("none");
  });

  it("a param that is not 1 is none even while loading", () => {
    expect(clockReminderAction({ ...BASE, param: null, loading: true })).toBe("none");
  });

  it("waits while the page is loading", () => {
    expect(clockReminderAction({ ...BASE, loading: true })).toBe("wait");
  });

  it("a § 18-exempt person gets nothing", () => {
    expect(clockReminderAction({ ...BASE, isExempt: true })).toBe("none");
  });

  it("a finished day gets nothing (never the opposite stamp)", () => {
    expect(clockReminderAction({ ...BASE, dayKind: "finished" })).toBe("none");
  });

  it("a running day asks to clock out", () => {
    expect(clockReminderAction({ ...BASE, dayKind: "running" })).toBe("confirm-out");
  });

  it("an idle day with a pending salon choice brings the card into view", () => {
    expect(clockReminderAction({ ...BASE, clockInBlocked: true })).toBe("focus-card");
  });

  it("an idle day asks to clock in", () => {
    expect(clockReminderAction(BASE)).toBe("confirm-in");
  });

  it("exempt wins over a running day, loading wins over exempt", () => {
    expect(clockReminderAction({ ...BASE, isExempt: true, dayKind: "running" })).toBe("none");
    expect(clockReminderAction({ ...BASE, isExempt: true, loading: true })).toBe("wait");
  });
});

describe("clockReminderDialog", () => {
  const now = new Date("2026-11-10T08:16:00Z");

  it("words the clock-in confirmation with the time in the given zone", () => {
    expect(clockReminderDialog("confirm-in", now, "Europe/Berlin")).toEqual({
      title: "Jetzt einstempeln?",
      description: "Du stempelst jetzt um 09:16 ein.",
      confirmLabel: "Einstempeln",
    });
  });

  it("words the clock-out confirmation", () => {
    expect(clockReminderDialog("confirm-out", now, "Europe/Berlin")).toEqual({
      title: "Jetzt ausstempeln?",
      description: "Du stempelst jetzt um 09:16 aus.",
      confirmLabel: "Ausstempeln",
    });
  });

  it("formats the time in the zone it is given", () => {
    expect(clockReminderDialog("confirm-in", now, "UTC").description).toContain("08:16");
  });

  it("pads a morning hour to two digits", () => {
    const early = new Date("2026-11-10T05:05:00Z");
    expect(clockReminderDialog("confirm-in", early, "UTC").description).toContain("05:05");
  });
});

describe("stripClockParam", () => {
  it("removes clock and keeps other parameters and the hash", () => {
    expect(stripClockParam(new URL("https://x/dashboard?clock=1&a=b#h"))).toBe("/dashboard?a=b#h");
  });

  it("leaves a bare path when clock was the only parameter", () => {
    expect(stripClockParam(new URL("https://x/dashboard?clock=1"))).toBe("/dashboard");
  });

  it("is unchanged without the parameter", () => {
    expect(stripClockParam(new URL("https://x/dashboard?a=b%20c#h"))).toBe("/dashboard?a=b%20c#h");
    expect(stripClockParam(new URL("https://x/dashboard"))).toBe("/dashboard");
  });
});
