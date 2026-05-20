import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { prefsHydrated } from '$stores/prefs-state';
import { savePreferences } from '$api/preferences';

/**
 * v1.5 light/dark mode — applied via `data-mode` attribute on <html>.
 * Independent of theme (any theme × any mode is valid).
 * Default: light. Dark uses warm ivory (#F0ECE6) not pure white — see tokens.css [data-mode="dark"].
 *
 * Legacy migration coordination: theme.ts (Task 1 of this plan) seeds localStorage.mode
 * for legacy 'hell' (→ light) and 'dunkel' (→ dark) users on first v1.5 load, but ONLY
 * if no mode key exists. mode.ts therefore needs no special migration logic — it simply
 * reads localStorage.mode and applies the value (which may have been seeded by theme.ts).
 */
export type Mode = 'light' | 'dark';

const VALID: readonly Mode[] = ['light', 'dark'] as const;

function readInitial(): Mode {
  if (!browser) return 'light';
  const raw = localStorage.getItem('mode');
  if (raw && (VALID as readonly string[]).includes(raw)) return raw as Mode;
  return 'light';
}

export const mode = writable<Mode>(readInitial());

mode.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('mode', value);
  document.documentElement.setAttribute('data-mode', value);
  // After hydration from the server, persist user toggles back to /me/preferences.
  if (get(prefsHydrated)) {
    savePreferences({ mode: value }).catch(() => {});
  }
});
