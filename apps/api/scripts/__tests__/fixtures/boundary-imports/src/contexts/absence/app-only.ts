// Regression-test fixture (Plan 03): imported ONLY by the composition-root stand-in (app.ts).
// If buildProjectedGraph ever ignores the exceptions document, this file gets a spurious
// `absence/index.ts -> app-only.ts` re-export edge that should never exist.
export const appOnlyThing = "app-only";
