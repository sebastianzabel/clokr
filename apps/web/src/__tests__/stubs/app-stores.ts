// Minimal stand-in for SvelteKit's virtual `$app/stores` module inside vitest (Issue #609).
//
// Same single-purpose idea as `app-navigation.ts`: vitest.config.ts declares no general `$app`
// alias, and the dashboard page now reads `$page.url` for the reminder parameter `?clock=1`, so a
// mounted dashboard test could not resolve the import. The default page is the plain dashboard URL
// without a parameter; tests that care replace the module with `vi.mock("$app/stores", ...)`. Do NOT
// add other exports here without a concrete need (ADR 0002, Entscheidung 2).
import { readable } from "svelte/store";

export const page = readable({
  url: new URL("http://localhost/dashboard"),
  state: {},
});
