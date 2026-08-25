// Quick 260824-ef6 — pure-function coverage for the team-leave Storno rules/copy.
// Same convention as
// apps/web/src/lib/components/vocational-school/__tests__/retroactive.test.ts: plain
// function tests, no component mount, because storno.ts is a pure, dependency-free
// module by design.

import { describe, it, expect } from "vitest";
import {
  resolveStornoAction,
  stornoDialogCopy,
  stornoSuccessToast,
  type LeaveStatus,
} from "../storno";

const ALL_STATUSES: LeaveStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "CANCELLATION_REQUESTED",
];

describe("resolveStornoAction", () => {
  // Full status × isOwn matrix (10 cases). Driven from a literal array of all
  // statuses × [true, false] so a newly added LeaveStatus cannot silently default to
  // "no button" without a failing test.
  const expected: Record<
    LeaveStatus,
    { own: ReturnType<typeof resolveStornoAction>; foreign: ReturnType<typeof resolveStornoAction> }
  > = {
    APPROVED: { own: "request-cancellation", foreign: "request-cancellation" },
    PENDING: { own: "withdraw", foreign: null },
    CANCELLATION_REQUESTED: { own: null, foreign: null },
    CANCELLED: { own: null, foreign: null },
    REJECTED: { own: null, foreign: null },
  };

  for (const status of ALL_STATUSES) {
    it(`(${status}, isOwn=true) -> ${expected[status].own}`, () => {
      expect(resolveStornoAction(status, true)).toBe(expected[status].own);
    });
    it(`(${status}, isOwn=false) -> ${expected[status].foreign}`, () => {
      expect(resolveStornoAction(status, false)).toBe(expected[status].foreign);
    });
  }
});

describe("stornoDialogCopy", () => {
  it("withdraw: exact copy", () => {
    const copy = stornoDialogCopy("withdraw");
    expect(copy.buttonLabel).toBe("Zurückziehen");
    expect(copy.title).toBe("Antrag zurückziehen?");
    expect(copy.confirmLabel).toBe("Zurückziehen");
    expect(copy.description).toMatch(/sofort und endgültig storniert/);
  });

  it("request-cancellation: exact copy", () => {
    const copy = stornoDialogCopy("request-cancellation");
    expect(copy.buttonLabel).toBe("Stornieren");
    expect(copy.title).toBe("Stornierung beantragen?");
    expect(copy.confirmLabel).toBe("Stornierung beantragen");
    // Both domain facts: a DIFFERENT Führungskraft must approve, and the leave stays
    // active in the meantime (calendar + blocks Zeiterfassung).
    expect(copy.description).toMatch(/anderen Führungskraft/);
    expect(copy.description).toMatch(/bleibt der Antrag aktiv/);
    expect(copy.description).toMatch(/Kalender/);
    expect(copy.description).toMatch(/Zeiterfassung/);
  });

  it("request-cancellation copy never claims a completed cancellation", () => {
    // Domain-truth guard (CLAUDE.md "Leave Cancellation Flow"): APPROVED transitions
    // to CANCELLATION_REQUESTED, not CANCELLED — the leave remains ACTIVE until a
    // different manager approves. The copy must not imply it's already done.
    const copy = stornoDialogCopy("request-cancellation");
    expect(copy.description).not.toMatch(/storniert/);
    expect(copy.description).not.toMatch(/gelöscht/);
  });
});

describe("stornoSuccessToast", () => {
  it("withdraw", () => {
    expect(stornoSuccessToast("withdraw")).toBe("Antrag zurückgezogen");
  });
  it("request-cancellation", () => {
    expect(stornoSuccessToast("request-cancellation")).toBe("Stornierung beantragt");
  });
});
