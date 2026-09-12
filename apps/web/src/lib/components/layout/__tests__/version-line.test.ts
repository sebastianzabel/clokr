// Phase 110 (Issue #36), Wave-0 pin — the version line in Sidebar.svelte and
// MobileMoreSheet.svelte has ZERO test coverage today (N-11). Plan 07 turns this same
// line into the What's-New entry point (a clickable button with an unread marker,
// D-09/AK-09). This file pins the CURRENT rendering BEFORE that change so a regression
// in the wrong direction — the version line disappearing, a second nav element sneaking
// in, the aria-label being dropped — turns a test red instead of landing silently.
//
// Sidebar.svelte is read as SOURCE, not mounted: it imports `$app/navigation`, and
// apps/web/vitest.config.ts declares no `$app` alias (see that file's own comment on
// why routing/`$app/*` is kept out of the component-test config). Source-read is not
// laziness here — it is the only option, following the established idiom in
// apps/web/src/__tests__/layout-boundaries.test.ts.
//
// MobileMoreSheet.svelte has no `$app` import, so it CAN be mounted — a later task in
// this same file adds a mounted pin for it in both the populated and the empty-store
// state, on top of the same source-read assertions Sidebar.svelte gets here.
//
// Deliberately NOT pinned: "no <button> wraps the version line". Plan 07 legitimately
// wraps it in one. A pin that must be deleted to make the next plan pass is not a pin
// (T-110-11) — only the occurrence counts of the durable invariants below are asserted.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/svelte";

// MobileMoreSheet itself has no `$app/*` import, but mounting it pulls in
// $stores/version -> $api/client -> $stores/auth -> $app/environment transitively, and
// apps/web/vitest.config.ts declares no `$app` alias (see that file's own comment on
// why route/`$app/*` resolution is deliberately kept out of the component-test config).
// Mocking "$app/environment" directly does not help — Vite's import-analysis plugin
// fails to resolve the bare specifier before Vitest's mock registry gets a chance to
// intercept it. Mocking "$stores/auth" instead (a real, alias-resolvable path) replaces
// the whole module before its own `$app/environment` import is ever transformed, which
// unblocks mounting without touching vitest.config.ts or any production file — nothing
// in this test cares about auth state.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

import { renderWithTheme } from "$tests/test-utils";
import { versionStore } from "$stores/version";
import MobileMoreSheet from "../MobileMoreSheet.svelte";

function readComponentFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const SIDEBAR = readComponentFile("../Sidebar.svelte", "src/lib/components/layout/Sidebar.svelte");
const MOBILE_MORE_SHEET = readComponentFile(
  "../MobileMoreSheet.svelte",
  "src/lib/components/layout/MobileMoreSheet.svelte",
);

function occurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe("version line — Wave 0 pin (Phase 110, D-09/AK-09)", () => {
  it("Sidebar: exactly one aria-labelled version container", () => {
    expect(occurrences(SIDEBAR, 'aria-label="Anwendungsversion"')).toBe(1);
  });

  it("Sidebar: exactly one v{$versionStore} interpolation", () => {
    expect(occurrences(SIDEBAR, "v{$versionStore}")).toBe(1);
  });

  // AK-09: the entry point must stay the existing version line — a second <nav here
  // means a new navigation element was introduced, which AK-09 forbids.
  it("Sidebar: exactly one <nav element (AK-09 — no new navigation element)", () => {
    expect(occurrences(SIDEBAR, "<nav")).toBe(1);
  });

  it("Sidebar: version line is fail-silent — guarded by {#if $versionStore}", () => {
    expect(SIDEBAR).toContain("{#if $versionStore}");
  });

  it('Sidebar: version text carries translate="no"', () => {
    expect(SIDEBAR).toContain('translate="no"');
  });

  it("Sidebar: imports versionStore + loadVersion from $stores/version and calls loadVersion() in onMount", () => {
    expect(SIDEBAR).toContain('import { versionStore, loadVersion } from "$stores/version"');
    expect(SIDEBAR).toMatch(/onMount\(\(\) => \{\s*loadVersion\(\);/);
  });

  it("MobileMoreSheet: exactly one aria-labelled version container", () => {
    expect(occurrences(MOBILE_MORE_SHEET, 'aria-label="Anwendungsversion"')).toBe(1);
  });

  it("MobileMoreSheet: exactly one v{$versionStore} interpolation", () => {
    expect(occurrences(MOBILE_MORE_SHEET, "v{$versionStore}")).toBe(1);
  });

  // AK-09: same claim as Sidebar above — the mobile entry point must also stay the
  // existing version line, not a newly added navigation element.
  it("MobileMoreSheet: exactly one <nav element (AK-09 — no new navigation element)", () => {
    expect(occurrences(MOBILE_MORE_SHEET, "<nav")).toBe(1);
  });

  it("MobileMoreSheet: version line is fail-silent — guarded by {#if $versionStore}", () => {
    expect(MOBILE_MORE_SHEET).toContain("{#if $versionStore}");
  });

  it('MobileMoreSheet: version text carries translate="no"', () => {
    expect(MOBILE_MORE_SHEET).toContain('translate="no"');
  });

  it("MobileMoreSheet: imports versionStore + loadVersion from $stores/version and calls loadVersion() in onMount", () => {
    expect(MOBILE_MORE_SHEET).toContain(
      'import { versionStore, loadVersion } from "$stores/version"',
    );
    expect(MOBILE_MORE_SHEET).toMatch(/onMount\(\(\) => \{\s*loadVersion\(\);/);
  });
});

describe("MobileMoreSheet version line — mounted pin", () => {
  afterEach(() => {
    // versionStore is a module-level singleton (apps/web/src/lib/stores/version.ts) —
    // without this reset the value set here would leak into every later test file in
    // the same worker (T-110-12).
    versionStore.set("");
  });

  const baseProps = { open: true, items: [], currentPath: "/dashboard" };

  it("renders v1.9.18 when versionStore is populated", () => {
    versionStore.set("1.9.18");
    const { container } = renderWithTheme(MobileMoreSheet, baseProps);

    expect(screen.getByText("v1.9.18")).toBeTruthy();
    expect(container.querySelector('[aria-label="Anwendungsversion"]')).not.toBeNull();
  });

  it("renders no version container when versionStore is empty (fail-silent, AK-06)", () => {
    versionStore.set("");
    const { container } = renderWithTheme(MobileMoreSheet, baseProps);

    expect(container.querySelector('[aria-label="Anwendungsversion"]')).toBeNull();
  });
});
