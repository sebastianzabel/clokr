// Minimal stand-in for SvelteKit's virtual `$app/navigation` module inside vitest (Issue #588).
//
// Like `app-environment.ts`, this is a single-purpose shim: vitest.config.ts declares no general
// `$app` alias, so a page that imports `goto` could not be mounted at all. The one concrete need is
// the mounted dashboard test (dashboard-team-saldo-pending-588.test.ts), which proves the card
// "Salden" never blocks the team block. Tests that care about navigation replace this module with
// `vi.mock("$app/navigation", ...)`; the default does nothing. Do NOT add other exports here
// without a concrete need (ADR 0002, Entscheidung 2).
export function goto(_href: string | URL): Promise<void> {
  return Promise.resolve();
}
