import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { prefsHydrated } from '$stores/prefs-state';
import { savePreferences } from '$api/preferences';

/**
 * v1.5 themes — applied via `data-theme` attribute on <html>.
 * Pflaume is the default (visual no-op migration from legacy `lila`).
 * Hex values per docs/design/tokens.css.
 */
export type Theme = 'pflaume' | 'nacht' | 'wald';

export const themes: { id: Theme; label: string; color: string; gradient: [string, string] }[] = [
  { id: 'pflaume', label: 'Pflaume', color: '#80377B', gradient: ['#5C2858', '#A85CA3'] },
  { id: 'nacht',   label: 'Nacht',   color: '#3D4DAD', gradient: ['#232E78', '#6B7BD8'] },
  { id: 'wald',    label: 'Wald',    color: '#2D6A4F', gradient: ['#1B4332', '#52B788'] },
];

// Legacy migration map (silent — runs once on first load post-v1.5 deploy).
// Per D-06: lila → pflaume, hell → pflaume, dunkel → nacht. Unknown → pflaume.
// Mode coordination (one-time, only if no `mode` key exists):
//   hell   → also seed localStorage.mode = 'light' (preserves visual light experience)
//   dunkel → also seed localStorage.mode = 'dark'  (preserves visual dark experience)
//   lila   → no mode side-effect (v1.2 lila was always light, but we don't seed because
//            absence of a mode key already defaults to 'light' in mode.ts)
const LEGACY_THEME_MAP: Record<string, Theme> = {
  lila: 'pflaume',
  hell: 'pflaume',
  dunkel: 'nacht',
};
const LEGACY_MODE_SEED: Record<string, 'light' | 'dark'> = {
  hell: 'light',
  dunkel: 'dark',
};

function readInitial(): Theme {
  if (!browser) return 'pflaume';
  const raw = localStorage.getItem('theme');
  if (!raw) return 'pflaume';
  // Migrate legacy values
  if (raw in LEGACY_THEME_MAP) {
    const migrated = LEGACY_THEME_MAP[raw];
    localStorage.setItem('theme', migrated); // overwrite legacy value immediately
    // One-time mode seed for hell/dunkel legacy users — only if no mode key set yet.
    // This is the ONLY case where theme.ts touches another store's localStorage key.
    const seed = LEGACY_MODE_SEED[raw];
    if (seed && localStorage.getItem('mode') === null) {
      localStorage.setItem('mode', seed);
    }
    return migrated;
  }
  // Validate current value
  if (themes.some(t => t.id === raw)) return raw as Theme;
  return 'pflaume';
}

export const theme = writable<Theme>(readInitial());

theme.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('theme', value);
  document.documentElement.setAttribute('data-theme', value);
  // After hydration from the server, persist user toggles back to /me/preferences.
  // Silent fail keeps the UI responsive offline (localStorage already updated above).
  if (get(prefsHydrated)) {
    savePreferences({ theme: value }).catch(() => {});
  }
});
