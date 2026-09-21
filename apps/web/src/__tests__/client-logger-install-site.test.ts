// Issue #149, second hole in the same chain — source-level pin for the INSTALL SITE of the
// global error handlers, not for their behaviour (that is logger.test.ts).
//
// `clientLogger.install()` used to run in `(app)/+layout.svelte`'s onMount only. Everything in
// the `(auth)` group — login, OTP, invitation, forgot-password, reset-password — therefore had
// no `window.onerror` / `unhandledrejection` handler at all: an uncaught error on the login page
// reached nobody. Moving the call into the ROOT layout is what makes the chain cover every page.
//
// Why a source read, not a mount: routes are not mountable in this workspace (no `$app` alias in
// apps/web/vitest.config.ts) — same precedent as layout-boundaries.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

function routesDir(): string {
  try {
    return fileURLToPath(new URL("../routes", import.meta.url));
  } catch {
    return resolve(process.cwd(), "src/routes");
  }
}

const ROOT_LAYOUT = readRouteFile("../routes/+layout.svelte", "src/routes/+layout.svelte");
const APP_LAYOUT = readRouteFile(
  "../routes/(app)/+layout.svelte",
  "src/routes/(app)/+layout.svelte",
);

describe("clientLogger.install() sits in the root layout (Issue #149)", () => {
  it("the root layout imports the logger and calls install()", () => {
    expect(ROOT_LAYOUT).toContain('from "$lib/utils/logger"');
    expect(ROOT_LAYOUT.match(/clientLogger\.install\(\)/g)).toHaveLength(1);
  });

  it("the (app) layout no longer installs it — a nested duplicate would be dead weight", () => {
    expect(APP_LAYOUT).not.toContain("clientLogger.install()");
  });

  it("the (auth) group exists and is covered by the root layout, having no layout of its own", () => {
    // Anti-vacuity: name the pages this guard is actually about. If the group is ever renamed or
    // emptied, this fails loudly instead of silently guarding nothing.
    const authPages = readdirSync(resolve(routesDir(), "(auth)"));
    expect(authPages.length).toBeGreaterThan(0);
    expect(authPages).toContain("login");
    expect(authPages).not.toContain("+layout.svelte");
  });
});
