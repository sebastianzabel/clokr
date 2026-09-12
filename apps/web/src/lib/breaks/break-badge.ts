/**
 * break-badge.ts
 *
 * Phase 112 (GitHub issue #115) — the break-confirmation status badge mapping, lifted verbatim
 * out of routes/(app)/time-entries/+page.svelte so that the list view and the edit modal
 * provably share ONE mapping and so the UI-SPEC colour/copy contract from Phase 93 (BREAK-07)
 * is unit-testable. Route pages cannot be mounted in this repo's vitest setup
 * (apps/web/vitest.config.ts deliberately excludes the SvelteKit pipeline).
 *
 * Behaviour is unchanged, INCLUDING the fallback: anything that is not "CONFIRMED" or "WAIVED"
 * — undefined included — is treated as AUTO by the badge mapping.
 */

export type BreakStatus = "AUTO" | "CONFIRMED" | "WAIVED";

export function breakBadgeClass(status: BreakStatus | string | null | undefined): string {
  return status === "CONFIRMED"
    ? "badge-green"
    : status === "WAIVED"
      ? "badge-gray"
      : "badge-yellow"; // AUTO — action required
}

export function breakBadgeLabel(status: BreakStatus | string | null | undefined): string {
  return status === "CONFIRMED"
    ? "Pause bestätigt"
    : status === "WAIVED"
      ? "Durchgearbeitet"
      : "Pause unbestätigt"; // AUTO
}

/**
 * Actionable-unconfirmed test. Deliberately STRICTER than breakBadgeLabel's fallback: only an
 * explicit "AUTO" on a non-locked entry counts. A locked entry lives in a closed month and can
 * neither be confirmed nor waived (CLAUDE.md — immutability after lock), so surfacing it would
 * be a dead end.
 */
export function isUnconfirmedBreak(entry: {
  breakStatus?: string | null;
  isLocked?: boolean | null;
}): boolean {
  return entry.breakStatus === "AUTO" && entry.isLocked !== true;
}
