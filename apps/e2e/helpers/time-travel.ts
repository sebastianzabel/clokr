/**
 * Time-travel helper for date-sensitive E2E flows (Plan 74-03, D-05).
 *
 * Wraps Playwright's `page.route()` to inject the `X-Test-Now` HTTP header on
 * every `/api/v1/*` request. The header is honoured server-side by the
 * `apps/api/src/routes/test-bootstrap.ts` onRequest hook, which is itself
 * gated by the `ALLOW_TEST_BOOTSTRAP` env var. Result: tests pin what the API
 * believes "now" is, without touching the client-side `Date.now()` (which
 * doesn't matter — carry-over computation runs server-side).
 *
 * Why a request-level header instead of `page.clock.setFixedTime()`:
 * - `page.clock` only fakes the browser's clock — server-side `new Date()`
 *   is untouched, which is precisely the layer we need to control for
 *   carry-over (BUrlG § 7, EuGH C-684/16) decisions.
 * - Cookies / localStorage are out — the server has no way to discriminate
 *   "this request is from a test" vs "this request is from a real user
 *   trying to forge the date" without a clear, env-gated channel.
 * - HTTP header is per-request, which means parallel workers cannot pollute
 *   each other's "now" (T-74-03-03 mitigation).
 *
 * Usage:
 *
 * ```ts
 * import { withTestNow, clearTestNow } from "../helpers/time-travel";
 *
 * test("year-end rollover", async ({ page, tenant }) => {
 *   await withTestNow(page, "2026-12-31T23:59:00Z");
 *   await page.goto(`/leave?employeeId=${empId}`);
 *   // …assertions against the urlaub balance at Dec 31, 2026…
 *
 *   // Travel to Jan 1, 2027 — clear FIRST, then re-apply.
 *   await clearTestNow(page);
 *   await withTestNow(page, "2027-01-01T00:01:00Z");
 *   await page.goto(`/leave?employeeId=${empId}`);
 * });
 * ```
 *
 * Stacking note: Playwright `page.route()` handlers are LIFO; calling
 * `withTestNow` twice without `clearTestNow` in between would chain two
 * interceptors that both rewrite headers. The second call would win, but the
 * first stays registered and adds overhead. Always `clearTestNow` between
 * different pinned dates inside the same test.
 *
 * Safety net: if `ALLOW_TEST_BOOTSTRAP=false` on the target API, the header
 * is silently ignored — the test will then race against the real wall clock
 * and likely fail with confusing assertion errors. The fixture annotation
 * in `apps/e2e/fixtures/tenant.ts` (which fails on bootstrap-tenant 404)
 * surfaces the misconfiguration before any time-travel happens.
 */
import type { Page } from "@playwright/test";

/** Regex used to fail-fast on obviously malformed ISO timestamps. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Glob matched against every API request — kept as a const so spec authors
 * can reference it for `page.unroute(API_GLOB)` parity if they ever extend
 * this helper. */
export const API_GLOB = "**/api/v1/**";

/**
 * Pin the server-side "now" to `isoDate` for the rest of this page session.
 *
 * Throws synchronously (before any route is registered) if the input doesn't
 * parse as a date — catching typos at the assertion site rather than
 * surfacing them as "wrong year" inside a far-removed expect().
 */
export async function withTestNow(page: Page, isoDate: string): Promise<void> {
  if (!ISO_DATE_RE.test(isoDate)) {
    throw new Error(
      `withTestNow: ${JSON.stringify(isoDate)} is not a valid ISO-8601 date. ` +
        `Expected formats: "2026-12-31" or "2026-12-31T23:59:00Z".`,
    );
  }
  const probe = new Date(isoDate);
  if (Number.isNaN(probe.getTime())) {
    throw new Error(`withTestNow: ${JSON.stringify(isoDate)} parses to Invalid Date.`);
  }

  await page.route(API_GLOB, async (route, request) => {
    const headers = { ...request.headers(), "x-test-now": isoDate };
    await route.continue({ headers });
  });
}

/**
 * Remove the time-travel interceptor for this page session.
 *
 * Call this before switching to a new pinned date — see the stacking note in
 * the module header. Safe to call when no `withTestNow` is active; Playwright
 * silently no-ops on unmatched `unroute` per its docs.
 */
export async function clearTestNow(page: Page): Promise<void> {
  await page.unroute(API_GLOB);
}
