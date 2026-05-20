import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { prefsHydrated } from '$stores/prefs-state';
import { savePreferences } from '$api/preferences';

/**
 * v999.2 skin — applied via `data-skin` attribute on <html>.
 *
 * - `editorial` (default): the v1.5 design system (Jost / Cormorant / Jet Mono,
 *   solid surfaces, no `data-skin` attribute is set so existing selectors
 *   keep working untouched).
 * - `modern`: glassmorphism display layer (Inter Tight, neon brand,
 *   translucent surfaces). Activated by adding `data-skin="modern"` to
 *   <html>; tokens.css + app.css contain the entire override surface.
 *
 * This store mirrors the density/theme/mode pattern: localStorage as the
 * offline fallback, server-persisted via /me/preferences once the
 * `prefsHydrated` gate is open.
 */
export type Skin = 'editorial' | 'modern';

const VALID: readonly Skin[] = ['editorial', 'modern'] as const;

function readInitial(): Skin {
  if (!browser) return 'editorial';
  const raw = localStorage.getItem('skin');
  if (raw && (VALID as readonly string[]).includes(raw)) return raw as Skin;
  return 'editorial';
}

export const skin = writable<Skin>(readInitial());

skin.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('skin', value);
  // Editorial = default — drop the attribute entirely so component selectors
  // that key off `[data-skin="modern"]` cleanly stop matching. This is the
  // cheapest way to guarantee the editorial layout is byte-for-byte unchanged.
  if (value === 'editorial') {
    document.documentElement.removeAttribute('data-skin');
  } else {
    document.documentElement.setAttribute('data-skin', value);
  }
  // After hydration from the server, persist user toggles back to /me/preferences.
  if (get(prefsHydrated)) {
    savePreferences({ skin: value }).catch(() => {});
  }
});
