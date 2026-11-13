// Issue #835 — planner refusals are decided by `data.code`, never by the German text.
import { describe, it, expect } from "vitest";
import {
  isDeadlinePassed,
  isPlanAlreadyOpen,
  isPlanClosed,
  isWishOverlap,
  isWishTakenOver,
  planErrorCode,
  planErrorMessage,
} from "../errors";

function apiError(status: number, data: unknown, message = "Fehler"): Error {
  return Object.assign(new Error(message), { status, data });
}

describe("planErrorCode", () => {
  it("returns data.code of an ApiError-shaped object", () => {
    expect(planErrorCode(apiError(409, { error: "x", code: "LEAVE_PLAN_CLOSED" }))).toBe(
      "LEAVE_PLAN_CLOSED",
    );
  });

  it("is null for anything else", () => {
    expect(planErrorCode(new Error("plain"))).toBeNull();
    expect(planErrorCode("LEAVE_PLAN_CLOSED")).toBeNull();
    expect(planErrorCode(null)).toBeNull();
    expect(planErrorCode(apiError(409, { error: "no code" }))).toBeNull();
    expect(planErrorCode(apiError(409, undefined))).toBeNull();
    expect(planErrorCode(Object.assign(new Error("x"), { data: { code: "A" } }))).toBeNull();
  });
});

describe("the is… helpers", () => {
  const cases: Array<[string, (e: unknown) => boolean]> = [
    ["LEAVE_PLAN_CLOSED", isPlanClosed],
    ["LEAVE_PLAN_DEADLINE_PASSED", isDeadlinePassed],
    ["LEAVE_PLAN_WISH_OVERLAP", isWishOverlap],
    ["LEAVE_PLAN_WISH_TAKEN_OVER", isWishTakenOver],
    ["LEAVE_PLAN_ALREADY_OPEN", isPlanAlreadyOpen],
  ];

  it.each(cases)("%s answers by code", (code, predicate) => {
    expect(predicate(apiError(409, { error: "x", code }))).toBe(true);
    expect(predicate(apiError(409, { error: "x", code: "OTHER" }))).toBe(false);
    expect(predicate(new Error(code))).toBe(false);
  });

  it("a matching German text with another code is false", () => {
    const err = apiError(409, {
      error: "Die Urlaubsplanung ist abgeschlossen und kann nicht mehr geändert werden.",
      code: "LEAVE_PLAN_WISH_OVERLAP",
    });
    expect(isPlanClosed(err)).toBe(false);
  });
});

describe("planErrorMessage", () => {
  it("shows the server's German message, else the error message, else the fallback", () => {
    expect(planErrorMessage(apiError(409, { error: "Überschneidung" }))).toBe("Überschneidung");
    expect(planErrorMessage(apiError(500, {}, "Fehler 500"))).toBe("Fehler 500");
    expect(planErrorMessage("boom")).toBe("Das hat nicht geklappt.");
  });
});
