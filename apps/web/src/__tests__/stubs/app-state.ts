// Minimal stand-in for SvelteKit's virtual `$app/state` module inside vitest (Issue #843).
//
// Same single-purpose idea as `app-navigation.ts` and `app-stores.ts`: vitest.config.ts declares
// no general `$app` alias, and `lib/table/url-state.ts` takes its default reader from `page.url`.
// The default page is a plain URL without a query; tests that care inject their own reader into
// `urlState()` or replace the module with `vi.mock("$app/state", ...)`. Do NOT add other exports
// here without a concrete need (ADR 0002, Entscheidung 2).
export const page = {
  url: new URL("http://localhost/"),
};
