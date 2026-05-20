import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { prefsHydrated } from '$stores/prefs-state';
import { savePreferences } from '$api/preferences';

/**
 * v1.5 density — applied via `data-density` attribute on <html>.
 * Compact reduces --pad-card to 16px and --row-h to 36px (see tokens.css).
 * Default: comfortable.
 */
export type Density = 'comfortable' | 'compact';

const VALID: readonly Density[] = ['comfortable', 'compact'] as const;

function readInitial(): Density {
  if (!browser) return 'comfortable';
  const raw = localStorage.getItem('density');
  if (raw && (VALID as readonly string[]).includes(raw)) return raw as Density;
  return 'comfortable';
}

export const density = writable<Density>(readInitial());

density.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('density', value);
  document.documentElement.setAttribute('data-density', value);
  // After hydration from the server, persist user toggles back to /me/preferences.
  if (get(prefsHydrated)) {
    savePreferences({ density: value }).catch(() => {});
  }
});
