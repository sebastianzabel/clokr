// Issue #836 (plan 07) — the exception-step helpers. `$api/client` is mocked with a real-shaped
// ApiError (it pulls `$stores/auth`, which pulls SvelteKit's `$app/environment`), as in RolesTab.test.ts.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return { ApiError, api: {} };
});

import { describe, it, expect, vi } from "vitest";
import { ApiError } from "$api/client";
import {
  exceedancesOf,
  isLeaveLimitExceptionRequired,
  validateExceptionReason,
  LEAVE_LIMIT_EXCEPTION_REQUIRED,
} from "../exception";

describe("isLeaveLimitExceptionRequired", () => {
  it("is true for the 409 with the limit-exception code", () => {
    const err = new ApiError(409, "x", { code: LEAVE_LIMIT_EXCEPTION_REQUIRED, exceedances: [] });
    expect(isLeaveLimitExceptionRequired(err)).toBe(true);
  });

  it("is false for the four-eyes code, a 409 without code, a 403 and a plain Error", () => {
    expect(
      isLeaveLimitExceptionRequired(
        new ApiError(409, "x", { code: "FOUR_EYES_CONFIRMATION_REQUIRED" }),
      ),
    ).toBe(false);
    expect(isLeaveLimitExceptionRequired(new ApiError(409, "x", { error: "y" }))).toBe(false);
    expect(isLeaveLimitExceptionRequired(new ApiError(409, "x"))).toBe(false);
    expect(
      isLeaveLimitExceptionRequired(
        new ApiError(403, "x", { code: LEAVE_LIMIT_EXCEPTION_REQUIRED }),
      ),
    ).toBe(false);
    expect(isLeaveLimitExceptionRequired(new Error("x"))).toBe(false);
  });
});

describe("exceedancesOf", () => {
  it("returns the exceedances of the 409 body", () => {
    const w = { ruleId: "r1" };
    const err = new ApiError(409, "x", { code: LEAVE_LIMIT_EXCEPTION_REQUIRED, exceedances: [w] });
    expect(exceedancesOf(err)).toEqual([w]);
  });

  it("returns an empty list for an unexpected body or error", () => {
    expect(exceedancesOf(new ApiError(409, "x", { code: LEAVE_LIMIT_EXCEPTION_REQUIRED }))).toEqual(
      [],
    );
    expect(exceedancesOf(new Error("x"))).toEqual([]);
  });
});

describe("validateExceptionReason", () => {
  it("refuses 9 and 501 characters, accepts 10 and 500 (trimmed)", () => {
    expect(validateExceptionReason("a".repeat(9))).toContain("10 bis 500");
    expect(validateExceptionReason("a".repeat(501))).toContain("10 bis 500");
    expect(validateExceptionReason("a".repeat(10))).toBeNull();
    expect(validateExceptionReason("a".repeat(500))).toBeNull();
    expect(validateExceptionReason(`   ${"a".repeat(9)}   `)).toContain("10 bis 500");
  });
});
