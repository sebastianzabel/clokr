/**
 * latest-request.ts
 *
 * Issue #660 (WR-03): a request token for a page loader that can be started again before the
 * previous run has finished (the team time-entry page when the manager switches person quickly).
 * Only the response of the LATEST `begin()` may be applied; an older one that resolves later is
 * dropped, so the screen never shows the data of a person who is no longer selected.
 *
 * Pure module: no Svelte, no API call.
 */

export interface LatestRequestGuard {
  /** Starts a run and invalidates every earlier one. Returns this run's token. */
  begin(): number;
  /** Whether `token` still belongs to the latest run. */
  isCurrent(token: number): boolean;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0;
  return {
    begin: () => ++latest,
    isCurrent: (token) => token === latest,
  };
}
