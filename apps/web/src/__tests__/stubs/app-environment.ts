// Minimal stand-in for SvelteKit's virtual `$app/environment` module inside vitest.
//
// apps/web/vitest.config.ts deliberately declares no `$app` alias (see that file's own
// comment) to avoid pulling in SvelteKit's full server/router pipeline for component tests.
// This file is the ONE narrow exception: several stores (auth.ts, theme.ts, mode.ts,
// density.ts, skin.ts) import only `browser` from `$app/environment`, and a real (unmocked)
// module-boot test needs that resolved to something. `browser: true` matches the vitest
// config's own `resolve.conditions: ["browser"]` choice — this suite already treats jsdom as
// the browser build target.
//
// Do NOT add other $app/* exports or paths here without a concrete need (ADR 0002,
// Entscheidung 2 — no generalization on spec) — this stays a single-purpose shim, not a
// SvelteKit test harness.
export const browser = true;
export const dev = true;
export const building = false;
export const version = "test";
