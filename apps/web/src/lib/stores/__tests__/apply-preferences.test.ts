// Issue #392 (quick task 260928-uli), Task 2 — unit tests for applyPreferences().
//
// $stores/skin, $stores/mode and $stores/theme cannot be imported for real here: they import
// `$app/environment`, which apps/web/vitest.config.ts does not alias (see the comment in
// apps/web/src/lib/components/layout/__tests__/version-line.test.ts lines 29-40 for the full
// reasoning). Each is instead mocked with an async factory that dynamically imports svelte/store,
// the REAL $stores/prefs-state, and the mocked $api/preferences, and reproduces the production
// subscribe pattern minus the localStorage/DOM writes (which are not under test here and would
// require a browser-flag mock too).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const { saveSpy } = vi.hoisted(() => ({
  saveSpy: vi.fn(() => Promise.resolve({})),
}));

vi.mock("$api/preferences", () => ({
  savePreferences: saveSpy,
}));

vi.mock("$stores/skin", async () => {
  const { writable, get } = await import("svelte/store");
  const { prefsHydrated } = await import("$stores/prefs-state");
  const { savePreferences } = await import("$api/preferences");
  const skin = writable<"editorial" | "modern">("editorial");
  skin.subscribe((value) => {
    if (get(prefsHydrated)) {
      savePreferences({ skin: value }).catch(() => {});
    }
  });
  return { skin };
});

vi.mock("$stores/mode", async () => {
  const { writable, get } = await import("svelte/store");
  const { prefsHydrated } = await import("$stores/prefs-state");
  const { savePreferences } = await import("$api/preferences");
  const mode = writable<"light" | "dark">("light");
  mode.subscribe((value) => {
    if (get(prefsHydrated)) {
      savePreferences({ mode: value }).catch(() => {});
    }
  });
  return { mode };
});

vi.mock("$stores/theme", async () => {
  const { writable, get } = await import("svelte/store");
  const { prefsHydrated } = await import("$stores/prefs-state");
  const { savePreferences } = await import("$api/preferences");
  const theme = writable<"pflaume" | "nacht" | "wald">("pflaume");
  theme.subscribe((value) => {
    if (get(prefsHydrated)) {
      savePreferences({ theme: value }).catch(() => {});
    }
  });
  return { theme };
});

import { prefsHydrated } from "$stores/prefs-state";
import { skin } from "$stores/skin";
import { mode } from "$stores/mode";
import { theme } from "$stores/theme";
import { applyPreferences } from "../apply-preferences";

describe("applyPreferences", () => {
  beforeEach(() => {
    // Reset with the gate closed so these resets themselves never call savePreferences.
    prefsHydrated.set(false);
    skin.set("editorial");
    mode.set("light");
    theme.set("pflaume");
    saveSpy.mockClear();
  });

  it("control (anti-vacuity): with the gate open, setting the three mocked stores directly calls savePreferences 3 times", () => {
    prefsHydrated.set(true);

    skin.set("modern");
    mode.set("dark");
    theme.set("wald");

    expect(saveSpy).toHaveBeenCalledTimes(3);
  });

  it("applyPreferences({skin, mode, theme}) with the gate open calls savePreferences exactly once with all three keys", () => {
    prefsHydrated.set(true);
    saveSpy.mockClear();

    applyPreferences({ skin: "modern", mode: "dark", theme: "pflaume" });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({ skin: "modern", mode: "dark", theme: "pflaume" });
    expect(get(skin)).toBe("modern");
    expect(get(mode)).toBe("dark");
    expect(get(theme)).toBe("pflaume");
    expect(get(prefsHydrated)).toBe(true);
  });

  it("applyPreferences({skin, theme}) with the gate open calls savePreferences exactly once with exactly those two keys, mode untouched", () => {
    prefsHydrated.set(true);
    saveSpy.mockClear();

    applyPreferences({ skin: "editorial", theme: "wald" });

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({ skin: "editorial", theme: "wald" });
    expect(get(skin)).toBe("editorial");
    expect(get(theme)).toBe("wald");
    expect(get(mode)).toBe("light"); // untouched
  });

  it("with the gate closed, applyPreferences updates the stores, calls savePreferences zero times, and prefsHydrated stays false", () => {
    // Gate is already false from beforeEach (simulates pre-hydration / post-logout).
    applyPreferences({ skin: "modern", mode: "dark", theme: "wald" });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(get(skin)).toBe("modern");
    expect(get(mode)).toBe("dark");
    expect(get(theme)).toBe("wald");
    expect(get(prefsHydrated)).toBe(false);
  });
});
