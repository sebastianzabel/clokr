import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { authStore } from './auth';

/**
 * v1.5 persona — logical view-mode for the authenticated shell.
 *
 * Unlike `theme`, `mode`, or `density`, persona does NOT apply a `data-*`
 * attribute on <html>. It is a logical-only state consumed by the Sidebar
 * (for nav section visibility) and Topbar (for the persona segmented
 * control) via reactive store subscription.
 *
 * Initial value rules (in order):
 *   1. SSR (`!browser`) → 'employee'
 *   2. localStorage `persona` if it matches a VALID value
 *   3. Derived from `authStore.user.role`:
 *        ADMIN    → 'admin'
 *        MANAGER  → 'manager'
 *        EMPLOYEE → 'employee'
 *        (missing user) → 'employee'
 *
 * Security note: persona is a CLIENT-SIDE display gate only. Every
 * admin/manager API endpoint enforces server-side role checks via the
 * `requireRole(...)` middleware (see apps/api/src/middleware/auth.ts).
 * Switching persona in the UI does NOT grant elevated permissions — a
 * non-admin user clicking an Admin link results in a server 403.
 */
export type Persona = 'employee' | 'manager' | 'admin';

const VALID: readonly Persona[] = ['employee', 'manager', 'admin'] as const;

function readInitial(): Persona {
  if (!browser) return 'employee';
  const raw = localStorage.getItem('persona');
  if (raw && (VALID as readonly string[]).includes(raw)) return raw as Persona;
  const role = get(authStore).user?.role;
  if (role === 'ADMIN') return 'admin';
  if (role === 'MANAGER') return 'manager';
  return 'employee';
}

/**
 * Returns the set of personas a user with the given role is permitted to
 * switch into. Consumed by the Topbar persona segmented control to
 * disable forbidden options.
 */
export function allowedPersonas(
  role: 'ADMIN' | 'MANAGER' | 'EMPLOYEE' | undefined | null,
): Persona[] {
  if (role === 'ADMIN') return ['employee', 'manager', 'admin'];
  if (role === 'MANAGER') return ['employee', 'manager'];
  return ['employee'];
}

export const persona = writable<Persona>(readInitial());

persona.subscribe((value) => {
  if (!browser) return;
  localStorage.setItem('persona', value);
  // Note: persona does NOT set a data-* attribute on <html> (unlike theme/mode/density).
  // It is a logical state consumed by Sidebar/Topbar via reactive subscription only.
});
