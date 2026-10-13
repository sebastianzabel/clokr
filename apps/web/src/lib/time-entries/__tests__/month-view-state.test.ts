import { describe, it, expect } from "vitest";
import {
  ok,
  settled,
  valueOr,
  anyFailed,
  resolveMonthListState,
  resolveSaldoCardState,
  SKIPPED,
  FAILED,
  DENIED,
  settledAllowDenied,
  isDenied,
  istOnlyMonthMetrics,
} from "../month-view-state";

// The real ApiError (`$api/client`) cannot be imported here: it pulls the auth store, which reads
// localStorage at import time. The classifier is deliberately structural (an Error carrying a
// numeric `status`), so a mirror of ApiError's shape is the faithful stand-in.
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Phase 116 (GitHub issue #119). The FIRST describe block below IS acceptance criterion #6:
// no test anywhere in this repo asserted that a still-loading month list withholds its empty
// state, which is why `{#if allEntries.length === 0}` with no `loading` guard could ship — and
// stay shipped through phases 112–115, all of which edited that very same file.

describe("resolveMonthListState — never claims 'empty' while loading (acceptance criterion #6)", () => {
  it("loading with zero rows is 'loading', not 'empty'", () => {
    expect(resolveMonthListState({ loading: true, hasEmployeeLink: true, rowCount: 0 })).toBe(
      "loading",
    );
  });

  it("loading never yields 'empty' for ANY row count", () => {
    for (const rowCount of [0, 1, 7, 31]) {
      expect(resolveMonthListState({ loading: true, hasEmployeeLink: true, rowCount })).not.toBe(
        "empty",
      );
    }
  });

  it("loading beats a missing employee link too", () => {
    expect(resolveMonthListState({ loading: true, hasEmployeeLink: false, rowCount: 0 })).toBe(
      "loading",
    );
  });

  it("the regression shield: loading and loaded-empty are not the same answer", () => {
    expect(resolveMonthListState({ loading: true, hasEmployeeLink: true, rowCount: 0 })).not.toBe(
      resolveMonthListState({ loading: false, hasEmployeeLink: true, rowCount: 0 }),
    );
  });
});

describe("resolveMonthListState — the other three answers", () => {
  it("loaded, linked and genuinely without rows is 'empty'", () => {
    expect(resolveMonthListState({ loading: false, hasEmployeeLink: true, rowCount: 0 })).toBe(
      "empty",
    );
  });

  it("loaded with rows is 'rows'", () => {
    expect(resolveMonthListState({ loading: false, hasEmployeeLink: true, rowCount: 1 })).toBe(
      "rows",
    );
  });

  it("no employee link is its own answer, not 'empty'", () => {
    expect(resolveMonthListState({ loading: false, hasEmployeeLink: false, rowCount: 0 })).toBe(
      "no-employee",
    );
  });

  it("stale rows without an employee link are still 'no-employee'", () => {
    expect(resolveMonthListState({ loading: false, hasEmployeeLink: false, rowCount: 3 })).toBe(
      "no-employee",
    );
  });
});

describe("resolveSaldoCardState — routes into MonatSaldoCard's existing error branch", () => {
  it("loading wins over everything, mirroring MonatSaldoCard.svelte:80 checking loading first", () => {
    expect(
      resolveSaldoCardState({
        loading: true,
        hasEmployeeLink: false,
        fetchFailed: true,
        pageError: true,
      }),
    ).toBe("loading");
  });

  it("a failed schedule/overtime fetch is an error, not 'ready'", () => {
    expect(
      resolveSaldoCardState({
        loading: false,
        hasEmployeeLink: true,
        fetchFailed: true,
        pageError: false,
      }),
    ).toBe("error");
  });

  it("a page-level load error is an error", () => {
    expect(
      resolveSaldoCardState({
        loading: false,
        hasEmployeeLink: true,
        fetchFailed: false,
        pageError: true,
      }),
    ).toBe("error");
  });

  it("no employee link is an error, because the card has no fourth rendering", () => {
    expect(
      resolveSaldoCardState({
        loading: false,
        hasEmployeeLink: false,
        fetchFailed: false,
        pageError: false,
      }),
    ).toBe("error");
  });

  it("everything fine is 'ready'", () => {
    expect(
      resolveSaldoCardState({
        loading: false,
        hasEmployeeLink: true,
        fetchFailed: false,
        pageError: false,
      }),
    ).toBe("ready");
  });

  it("a failed fetch NEVER yields 'ready' — 'ready' is the state that renders 'noch keine Sollzeit in diesem Monat'", () => {
    // "ready" lets monthMetrics' `if (!schedule)` short circuit through to sollToDateMin: 0,
    // which SollIstBar.svelte:64-65 prints as that sentence. A 500 must not reach it.
    expect(
      resolveSaldoCardState({
        loading: false,
        hasEmployeeLink: true,
        fetchFailed: true,
        pageError: false,
      }),
    ).not.toBe("ready");
  });
});

describe("FetchResult — a failure and an absent value are different things", () => {
  it("settled resolves an ok payload", async () => {
    expect(await settled(Promise.resolve(42))).toEqual({ status: "ok", value: 42 });
  });

  it("settled treats a legitimately null payload as ok, NOT as a failure", async () => {
    const r = await settled(Promise.resolve(null));
    expect(r).toEqual({ status: "ok", value: null });
    expect(r.status).not.toBe("failed");
  });

  it("settled turns a rejection into 'failed'", async () => {
    expect(await settled(Promise.reject(new Error("boom")))).toEqual({ status: "failed" });
  });

  it("settled does not rethrow", async () => {
    // No try/catch here on purpose — if settled() rethrew, this test would fail outright.
    const r = await settled(Promise.reject(new Error("boom")));
    expect(r.status).toBe("failed");
  });

  it("the collapse the old code made is now impossible", async () => {
    // `+page.svelte:377`'s `.catch(() => null)` gave both of these the identical value `null`.
    expect(await settled(Promise.resolve(null))).not.toEqual(
      await settled(Promise.reject(new Error("boom"))),
    );
  });
});

describe("valueOr / anyFailed", () => {
  it("valueOr returns the ok payload", () => {
    expect(valueOr(ok(42), null)).toBe(42);
  });

  it("an ok-null must NOT fall back", () => {
    expect(valueOr(ok(null), "fallback")).toBe(null);
  });

  it("valueOr falls back on failed", () => {
    expect(valueOr(FAILED, null)).toBe(null);
  });

  it("valueOr falls back on skipped", () => {
    expect(valueOr(SKIPPED, null)).toBe(null);
  });

  it("valueOr returns the given fallback value on failed", () => {
    expect(valueOr(FAILED, "fallback")).toBe("fallback");
  });

  it("anyFailed of nothing is false", () => {
    expect(anyFailed()).toBe(false);
  });

  it("skipped is not failed — that is the whole point of the third status", () => {
    expect(anyFailed(SKIPPED, ok(1))).toBe(false);
  });

  it("anyFailed spots a failure next to a skip", () => {
    expect(anyFailed(SKIPPED, FAILED)).toBe(true);
  });

  it("anyFailed spots a failure among several ok results", () => {
    expect(anyFailed(ok(1), ok(2), FAILED)).toBe(true);
  });
});

// Issue #85 (Phase 76b note): a role that may legitimately be refused a read must see the card
// disappear, not an error card. The helper is opt-in; `settled()` keeps treating every rejection
// as a failure.
describe("settledAllowDenied — a refusal is neither a failure nor a value", () => {
  it("resolves an ok payload", async () => {
    expect(await settledAllowDenied(Promise.resolve(7))).toEqual({ status: "ok", value: 7 });
  });

  it("an ApiError 403 is 'denied'", async () => {
    const r = await settledAllowDenied(Promise.reject(new ApiError(403, "Forbidden")));
    expect(r).toEqual({ status: "denied" });
  });

  it("an ApiError 404 (the identical answer for an out-of-scope person) is 'denied'", async () => {
    const r = await settledAllowDenied(Promise.reject(new ApiError(404, "Nicht gefunden")));
    expect(r).toEqual({ status: "denied" });
  });

  it("an ApiError 500 stays 'failed'", async () => {
    const r = await settledAllowDenied(Promise.reject(new ApiError(500, "boom")));
    expect(r).toEqual({ status: "failed" });
  });

  it("an ApiError 401 stays 'failed'", async () => {
    const r = await settledAllowDenied(Promise.reject(new ApiError(401, "Unauthorized")));
    expect(r).toEqual({ status: "failed" });
  });

  it("a non-ApiError rejection (network error) stays 'failed'", async () => {
    const r = await settledAllowDenied(Promise.reject(new TypeError("Failed to fetch")));
    expect(r).toEqual({ status: "failed" });
  });

  it("a plain object that merely carries status 403 is not an ApiError and stays 'failed'", async () => {
    const r = await settledAllowDenied(Promise.reject({ status: 403 }));
    expect(r).toEqual({ status: "failed" });
  });

  it("settled() is unchanged: a 403 rejection is still 'failed'", async () => {
    expect(await settled(Promise.reject(new ApiError(403, "Forbidden")))).toEqual({
      status: "failed",
    });
  });
});

describe("denied next to anyFailed / valueOr / isDenied", () => {
  it("anyFailed does not count a denial", () => {
    expect(anyFailed(DENIED, ok(1))).toBe(false);
  });

  it("anyFailed still spots a failure next to a denial", () => {
    expect(anyFailed(DENIED, FAILED)).toBe(true);
  });

  it("valueOr falls back on denied", () => {
    expect(valueOr(DENIED, null)).toBe(null);
    expect(valueOr(DENIED, "fallback")).toBe("fallback");
  });

  it("isDenied is true for a denial and false for ok, failed and skipped", () => {
    expect(isDenied(DENIED)).toBe(true);
    expect(isDenied(ok(1))).toBe(false);
    expect(isDenied(FAILED)).toBe(false);
    expect(isDenied(SKIPPED)).toBe(false);
  });

  it("isDenied is true when any of several results is denied, and false for none", () => {
    expect(isDenied(ok(1), DENIED)).toBe(true);
    expect(isDenied()).toBe(false);
  });
});

describe("istOnlyMonthMetrics — the refused-read month card", () => {
  it("shows the Ist and the day count, and implies no Soll and no saldo", () => {
    expect(istOnlyMonthMetrics({ istMin: 1230, workdaysSoFar: 3 })).toEqual({
      sollToDateMin: 0,
      istMin: 1230,
      saldoMin: null,
      sollLabel: "Soll",
      closed: false,
      workdaysSoFar: 3,
      noSollTarget: true,
    });
  });
});
