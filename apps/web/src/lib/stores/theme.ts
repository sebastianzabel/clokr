import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'pflaume' | 'nacht' | 'wald' | 'schiefer' | 'pro';

export const themes: { id: Theme; label: string; color: string }[] = [
  { id: 'pflaume',  label: 'Pflaume',  color: '#80377B' },
  { id: 'nacht',   label: 'Nacht',    color: '#7C6AF7' },
  { id: 'wald',    label: 'Wald',     color: '#2D6A4F' },
  { id: 'schiefer',label: 'Schiefer', color: '#1E3A5F' },
  { id: 'pro',     label: 'Pro',      color: '#4f46e5' },
];

const stored = browser ? (localStorage.getItem('theme') as Theme | null) : null;
const initial: Theme = (stored && themes.find(t => t.id === stored)) ? stored as Theme : 'pflaume';

export const theme = writable<Theme>(initial);

theme.subscribe(value => {
  if (!browser) return;
  localStorage.setItem('theme', value);
  document.documentElement.setAttribute('data-theme', value);
});
