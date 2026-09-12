/**
 * month-view-state.ts
 *
 * Phase 116 (GitHub issue #119) — the ONE derivation that answers "what does the month list
 * render right now", in FOUR values instead of a boolean.
 *
 * WHY THIS MODULE EXISTS: "we have no data" and "there is no data" were rendered identically.
 * `apps/web/src/routes/(app)/time-entries/+page.svelte:2029` gated its empty state on
 * `allEntries.length === 0` with no `loading` check at all, so the very first painted frame of
 * a fully-populated month asserted "Keine Zeiteinträge in diesem Monat" as fact. The calendar
 * branch of the SAME page (`:1728`) already did it correctly with `{#if loading} …skeleton…
 * {:else}`. Same page, same data, two different honesty standards.
 *
 * LINE NUMBERS: issue #119 cites `:1964` (list empty state), `:1682` (correct calendar
 * skeleton), `:148` (`let loading`), `:289` (`ownEmployeeId`), `:325` (the swallowing catch)
 * and `:1409-1419` (`monthMetrics`). Those have DRIFTED — phases 112–115 edited the same file.
 * The current lines are `:2029`, `:1728`, `:153`, `:321`, `:377` and `:1445-1454`. The CODE is
 * byte-identical; only the numbers moved. Do not conclude from a mismatch that the issue was
 * already fixed.
 *
 * PRECEDENCE — `loading` → `no-employee` → `empty` → `rows`, and the order is load-bearing:
 *   - `loading` first because the whole complaint is "do not assert anything while you are
 *     still finding out".
 *   - `no-employee` before `empty` because with `employeeId === null` the schedule, overtime
 *     and absence fetches are replaced by `Promise.resolve(null)` at `+page.svelte:377-431` —
 *     they were never even attempted. Calling that "dieser Monat ist leer" is the same lie in
 *     a different costume.
 *
 * FETCHRESULT — `.catch(() => null)` collapses "the endpoint says there is nothing" and "the
 * endpoint fell over" onto one value. `monthMetrics`'s `if (!schedule)` short circuit
 * (`+page.svelte:1445`) then turns an HTTP 500 into `sollToDateMin: 0`, which
 * `SollIstBar.svelte:64-65` prints as **"noch keine Sollzeit in diesem Monat"** — a backend
 * outage presented to an employee as a statement about her contract. Three statuses
 * (`ok` / `failed` / `skipped`) make that collapse impossible to write: `skipped` is the
 * never-attempted case, `failed` is the fell-over case, and they can no longer be confused.
 *
 * UMFANGSGRENZE: `apps/web/src/lib/components/saldo/MonatSaldoCard.svelte` and
 * `apps/web/src/lib/components/ui/SollIstBar.svelte` MUST NOT be changed by this phase. Issue
 * #119 is explicit: "SollIstBar und MonatSaldoCard sind nicht schuld … Korrigiert werden die
 * Aufrufer." `MonatSaldoCard` already owns a loading branch AND an error branch ("Werte
 * konnten nicht geladen werden." + "Erneut laden") — nothing ever routed into the latter.
 * This module is the caller-side answer that finally does.
 *
 * The module is pure and imports nothing, deliberately: `apps/web/vitest.config.ts` declares
 * no `$app/*` alias, so no route page in this repo can be mounted under vitest. A pure sibling
 * module is the only shape in which the acceptance criterion "Ein Test deckt 'lädt noch → kein
 * Leerzustand' ab" can exist at all.
 */

/** Outcome of one fetch whose failure the user must be told about. */
export type FetchResult<T> =
  | { status: "ok"; value: T }
  | { status: "skipped" }
  | { status: "failed" };

/** The fetch was never attempted (e.g. no employee link) — NOT a backend failure. */
export const SKIPPED: FetchResult<never> = { status: "skipped" };

/** The fetch was attempted and rejected. */
export const FAILED: FetchResult<never> = { status: "failed" };

export function ok<T>(value: T): FetchResult<T> {
  return { status: "ok", value };
}

/**
 * Wrap a fetch so its failure becomes a distinguishable value instead of `null`.
 *
 * This deliberately does NOT log or toast — the caller decides how a failure is surfaced.
 * Swallowing it into a toast AND returning `null` is exactly what the old
 * `.catch(() => null)` did, and it is why a 500 could reach the user as "kein Soll".
 * It also discards the rejection object entirely: no message, stack, URL or response body
 * can reach the DOM through this module (T-116-01).
 */
export function settled<T>(p: Promise<T>): Promise<FetchResult<T>> {
  return p.then((value) => ok(value)).catch(() => FAILED as FetchResult<T>);
}

/**
 * The payload, or a fallback when there is none.
 *
 * Note the `status` check rather than a truthiness check on `value`:
 * `{ status: "ok", value: null }` must return `null`, not the fallback — otherwise a
 * legitimately empty schedule would be indistinguishable from an unfetched one, which is the
 * very confusion this module exists to remove.
 */
export function valueOr<T, F>(result: FetchResult<T>, fallback: F): T | F {
  return result.status === "ok" ? result.value : fallback;
}

/** True when at least one of the given fetches FAILED. `skipped` does not count. */
export function anyFailed(...results: FetchResult<unknown>[]): boolean {
  return results.some((r) => r.status === "failed");
}

export type MonthListState = "loading" | "no-employee" | "empty" | "rows";

export function resolveMonthListState(input: {
  loading: boolean;
  hasEmployeeLink: boolean;
  rowCount: number;
}): MonthListState {
  // Acceptance criterion #1: "Solange geladen wird, erscheint kein Leerzustand." This arm is
  // the whole guarantee — no row count, and no missing employee link, may overtake it.
  if (input.loading) return "loading";
  // Without an employee link the month-scoped fetches were never attempted, so "leer" is
  // unearned. Stale rows from a previous state do not make it earned either.
  if (!input.hasEmployeeLink) return "no-employee";
  return input.rowCount === 0 ? "empty" : "rows";
}

export type SaldoCardState = "loading" | "error" | "ready";

export function resolveSaldoCardState(input: {
  loading: boolean;
  hasEmployeeLink: boolean;
  fetchFailed: boolean;
  pageError: boolean;
}): SaldoCardState {
  // Mirrors MonatSaldoCard.svelte:80 checking `loading` BEFORE `error`, so the card's own
  // precedence and this function's can never disagree.
  if (input.loading) return "loading";
  // `MonatSaldoCard` offers exactly three renderings and may not gain a fourth (Umfangsgrenze).
  // Of the three, `error` is the only one that asserts nothing about the month. The PAGE, not
  // the card, carries the sentence that names the real cause ("Kein Mitarbeiterprofil
  // verknüpft"). Do not "improve" this by adding a `noEmployee` prop to the card.
  if (!input.hasEmployeeLink) return "error";
  if (input.fetchFailed || input.pageError) return "error";
  // "ready" is the state that renders SollIstBar's "noch keine Sollzeit in diesem Monat" when
  // sollToDateMin is 0 — which is why a failed fetch must never reach it.
  return "ready";
}
