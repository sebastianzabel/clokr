import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'lila' | 'hell' | 'dunkel';

export const themes: { id: Theme; label: string; color: string }[] = [
  { id: 'lila',   label: 'Lila',   color: '#80377B' },
  { id: 'hell',   label: 'Hell',   color: '#475569' },
  { id: 'dunkel', label: 'Dunkel', color: '#1E293B' },
];

const stored = browser ? (localStorage.getItem('theme') as string | null) : null;
const initial: Theme = (stored && themes.find(t => t.id === stored)) ? stored as Theme : 'lila';

export const theme = writable<Theme>(initial);

theme.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('theme', value);
  document.documentElement.setAttribute('data-theme', value);
});
