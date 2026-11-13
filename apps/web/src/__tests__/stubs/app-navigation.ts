// Minimal stand-in for SvelteKit's virtual `$app/navigation` module inside vitest (Issue #588).
//
// Like `app-environment.ts`, this is a single-purpose shim: vitest.config.ts declares no general
// `$app` alias, so a page that imports `goto` could not be mounted at all. The one concrete need is
// the mounted dashboard test (dashboard-team-saldo-pending-588.test.ts), which proves the card
// "Salden" never blocks the team block. Tests that care about navigation replace this module with
// `vi.mock("$app/navigation", ...)`; the default does nothing. Do NOT add other exports here
// without a concrete need (ADR 0002, Entscheidung 2).
//
// Issue #609: the dashboard also reads the reminder arrival (`afterNavigate`) and strips the
// `?clock=1` parameter (`replaceState`); both are inert here, so a mounted dashboard test never
// sees an arrival and the reminder code stays idle.
export function goto(_href: string | URL): Promise<void> {
  return Promise.resolve();
}

export function afterNavigate(_callback: unknown): void {}

export function replaceState(_url: string | URL, _state: unknown): void {}
