/**
 * Phase 378 (Issue #378) — web-side permission checks, the counterpart to `docs/permissions.md`
 * and `apps/api/src/contexts/platform/request-permissions.ts`'s `hasPermission()`.
 *
 * The web decides Team-Bereich visibility (nav, route guards, dashboard cards) by the caller's
 * PERMISSIONS, not by the legacy compat `role` — a role assignment scoped to a Salon or to
 * Personen (Systemrollen-Templates Salonmanager, Ausbilder, #76) never widens `role` (it stays
 * "EMPLOYEE", #357), but its permissions are real and the API already authorizes by them (#75,
 * #91b). `$authStore.user.permissions` (populated at login, see `auth.ts`'s `issueTokens()`) is
 * the client's copy of exactly that list — see `apps/web/src/lib/stores/auth.ts`.
 *
 * A permission key here is a plain string, not the API's literal-union `PermissionKey` type: the
 * web has no `@clokr/db`/catalog import available (`apps/web/Dockerfile`'s `test ! -e
 * /app/packages/db` gate, same reasoning `team-calendar-visibility.ts` documents for its own
 * vocabulary duplication) and would drift from it independently anyway. Keys used here are
 * written out in full and checked against `docs/permissions.md` by review, not by the compiler.
 */

/** The minimal shape every check here needs — matches `AuthUser` from `$stores/auth`. */
export interface PermissionHolder {
  permissions?: string[];
}

/** Does `user` hold `key`? A user with no `permissions` list (not logged in, or a pre-Phase-378
 *  cached session) holds nothing — fail-closed, never fail-open. */
export function hasPermission(user: PermissionHolder | null | undefined, key: string): boolean {
  return user?.permissions?.includes(key) ?? false;
}

/** Does `user` hold ANY of `keys`? Mirrors the API's `requireAnyPermission`. */
export function hasAnyPermission(
  user: PermissionHolder | null | undefined,
  keys: readonly string[],
): boolean {
  return keys.some((key) => hasPermission(user, key));
}
