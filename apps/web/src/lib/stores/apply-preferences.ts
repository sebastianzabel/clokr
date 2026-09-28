import { get } from "svelte/store";
import { prefsHydrated } from "$stores/prefs-state";
import { skin, type Skin } from "$stores/skin";
import { mode, type Mode } from "$stores/mode";
import { theme, type Theme } from "$stores/theme";
import { savePreferences } from "$api/preferences";

/**
 * Apply a multi-key preference selection (e.g. a Modern preset on /admin/themes, which sets
 * skin + mode + theme together) as ONE PUT /me/preferences instead of one PUT per store.
 *
 * Why this exists: each of skin.ts / mode.ts / theme.ts subscribes to its own store and fires a
 * partial `savePreferences({key})` whenever `prefsHydrated` is open, so selecting a preset that
 * touches N stores used to fire N concurrent partial PUTs within milliseconds of each other —
 * exactly the trigger of the lost-update race fixed server-side in me.ts (Issue #392, atomic
 * jsonb merge). Routing multi-key selections through here removes the trigger at the source; the
 * server-side fix also makes any remaining concurrent PUT (e.g. from an entirely different tab)
 * safe, but one PUT here is still strictly fewer requests than three.
 *
 * Gate contract: reuses the existing `prefsHydrated` gate exactly as
 * `hydratePreferencesFromServer()` in auth.ts does — no new flag. It reads the gate once, closes
 * it so the per-store subscribers below do not each fire their own PUT, sets the given stores (in
 * skin -> mode -> theme order, matching selectModern() today), restores the gate to what it was,
 * and only then — if the gate was open — persists everything in one PUT. localStorage and the DOM
 * attribute are unaffected: the subscribers still run unconditionally, only the auto-PUT is
 * suppressed while the gate is closed.
 */
export function applyPreferences(prefs: { skin?: Skin; mode?: Mode; theme?: Theme }): void {
  const wasHydrated = get(prefsHydrated);
  prefsHydrated.set(false);
  try {
    if (prefs.skin !== undefined) skin.set(prefs.skin);
    if (prefs.mode !== undefined) mode.set(prefs.mode);
    if (prefs.theme !== undefined) theme.set(prefs.theme);
  } finally {
    prefsHydrated.set(wasHydrated);
  }

  if (wasHydrated) {
    savePreferences(prefs).catch(() => {});
  }
}
