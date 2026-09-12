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
} from "../month-view-state";

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
