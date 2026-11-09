import { writable, get } from "svelte/store";
import { browser } from "$app/environment";
import { prefsHydrated } from "$stores/prefs-state";
import { savePreferences } from "$api/preferences";

/**
 * Themes (Issue #842) - applied via the `data-theme` attribute on <html>. Every theme exists in a
 * light and a dark mode (`data-mode`, see mode.ts); the token blocks live in tokens.css.
 * Pflaume is the default. The list carries no colour: a preview draws from the real tokens.
 */
export type Theme = "pflaume" | "salz" | "petrol";

export const themes: { id: Theme; label: string }[] = [
  { id: "pflaume", label: "Pflaume" },
  { id: "salz", label: "Salz" },
  { id: "petrol", label: "Petrol" },
];

// Legacy mapping (#842 D-842-17), the web twin of the API's `normalizeUiTheme`. Silent; a stored
// or served value of a retired theme id becomes one of the three current ids:
//   lila, hell -> pflaume | nacht, schiefer, dunkel -> salz | wald -> petrol | unknown -> pflaume
// Mode coordination (one-time, only if no `mode` key exists):
//   hell   -> also seed localStorage.mode = 'light'
//   dunkel -> also seed localStorage.mode = 'dark'
const LEGACY_THEME_MAP: Record<string, Theme> = {
  lila: "pflaume",
  hell: "pflaume",
  nacht: "salz",
  schiefer: "salz",
  dunkel: "salz",
  wald: "petrol",
};
const LEGACY_MODE_SEED: Record<string, "light" | "dark"> = {
  hell: "light",
  dunkel: "dark",
};

/** The one allow-list in front of `data-theme` and localStorage (T-842-06). */
export function normalizeTheme(raw: unknown): Theme {
  if (typeof raw !== "string") return "pflaume";
  const known = themes.find((t) => t.id === raw);
  if (known) return known.id;
  if (Object.prototype.hasOwnProperty.call(LEGACY_THEME_MAP, raw)) return LEGACY_THEME_MAP[raw];
  return "pflaume";
}

function readInitial(): Theme {
  if (!browser) return "pflaume";
  // #842 D-842-16: skin and density are gone - drop the keys they left on the device.
  localStorage.removeItem("skin");
  localStorage.removeItem("density");
  const raw = localStorage.getItem("theme");
  if (!raw) return "pflaume";
  const normalized = normalizeTheme(raw);
  if (normalized !== raw) {
    localStorage.setItem("theme", normalized); // overwrite the legacy value immediately
    // One-time mode seed for hell/dunkel legacy users - only if no mode key set yet.
    // This is the ONLY case where theme.ts touches another store's localStorage key.
    const seed = LEGACY_MODE_SEED[raw];
    if (seed && localStorage.getItem("mode") === null) {
      localStorage.setItem("mode", seed);
    }
  }
  return normalized;
}

export const theme = writable<Theme>(readInitial());

theme.subscribe((value) => {
  if (!browser) return;
  const safe = normalizeTheme(value);
  localStorage.setItem("theme", safe);
  document.documentElement.setAttribute("data-theme", safe);
  // After hydration from the server, persist user toggles back to /me/preferences.
  // Silent fail keeps the UI responsive offline (localStorage already updated above).
  if (get(prefsHydrated)) {
    savePreferences({ theme: safe }).catch(() => {});
  }
});
