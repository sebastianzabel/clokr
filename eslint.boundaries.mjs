// Phase 101B Plan 02 (AC-2/AC-3/AC-6, D-01..D-03/D-07/D-12) — the boundary rule's block
// definitions. Exported so that `eslint.config.js` (the real config that actually runs) and
// `scripts/__tests__/boundary-rule.test.mjs` (the red proof) consume ONE definition. A test that
// rebuilds the patterns itself proves nothing about the rule that actually lints this repo.
//
// ── The five contexts of ADR 0001 ───────────────────────────────────────────────────────────────
// A literal array, never a character class: `time-tracking` and `working-time-account` both carry
// a hyphen, and a `[a-z]+`-style pattern silently drops both — CONTEXT.md's `<specifics>` names
// this exact mistake as having happened four times in one night in this repo. Mirrors
// `apps/api/scripts/measure-context-boundary-imports.ts`'s own `BOUNDARY_CONTEXTS` (kept as a
// separate literal here, not a shared import, because that script lives under `apps/api/scripts/`
// where `eslint` itself is not resolvable — see RESEARCH.md interface 7 — so this file cannot
// import from it without breaking the root/apps-api module-resolution split).
export const BOUNDARY_CONTEXTS = [
  "platform",
  "time-tracking",
  "absence",
  "scheduling",
  "working-time-account",
];

// D-03: the message names the rule's reason AND the legal way in. A boundary that does not say how
// to cross it legally produces eslint-disable comments, not compliance. German on purpose — this
// is a user-facing string (surfaced in the editor / lint output), not a code comment
// (CLAUDE.md § Language: code and comments are English, user-facing strings are German).
export const boundaryMessage = (context) =>
  `contexts/${context} ist ein fremder Kontext — importiere aus contexts/${context}/index.ts (ADR 0001).`;

// The glob is `**/<name>/**`. It deliberately does NOT insert the literal directory segment that
// physically houses these five names mid-pattern. RESEARCH.md finding 6 (load-bearing,
// non-negotiable #5): most cross-context specifiers in this tree carry NO such literal segment —
// a file inside that segment for `scheduling` writes `from "../../absence"`, never a form that
// repeats the segment name before `absence`. The longer, more-obviously-correct-looking glob would
// compile, pass an `app.ts`-shaped test case (whose specifiers DO repeat that segment), and
// silently miss the majority of real violations. `scripts/__tests__/boundary-rule.test.mjs` pins
// this shape with an explicit anti-tidy assertion — narrowing it back goes red, which is the point.
export const deepPattern = (context) => ({
  group: [`**/${context}/**`, `!**/${context}/index`],
  message: boundaryMessage(context),
});

// Owner decision #246: `__tests__` directories and `*.test.ts` files stay outside this rule for
// the whole phase (a test may legitimately fix a foreign context's internal shape — accepted risk,
// CONTEXT.md `<deferred>`). Every per-area block below carries this via `ignores`.
export const BOUNDARY_IGNORES = ["**/__tests__/**", "**/*.test.ts"];

function patternsExcept(context) {
  return BOUNDARY_CONTEXTS.filter((c) => c !== context).map(deepPattern);
}

// One block per AREA. Each block carries its COMPLETE pattern set, because flat config REPLACES a
// rule's options for a matching file rather than merging them (RESEARCH.md interface 5,
// live-probed against this repo's installed ESLint 10.8.0): a later block matching the same file
// wholly discards an earlier block's `no-restricted-imports` option for that file, so a per-area
// block written as a delta (only the "new" patterns) would silently let that area's files fall
// back to whatever an earlier, less specific block set — or nothing at all.
//
// `severity` is threaded through as a single argument (`"warn"` for this plan, D-12; `"error"`
// from plan 09 onward) so the whole-repo flip is a one-line change at the call site, never a
// second copy of the pattern data.
export function boundaryConfigs(severity) {
  return [
    // 1. The base: every file under apps/api/src is checked against all five contexts by
    // default. `composition/`, `middleware/`, `utils/`, `index.ts`, `config.ts`, and any file
    // outside the five `contexts/*` trees and outside `services/clock`/`services/phorest` (which
    // get their own, more specific blocks below and therefore override this one for their own
    // files — see the REPLACES note above) own no context of their own, so nothing is excepted
    // from their perspective.
    {
      files: ["apps/api/src/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: BOUNDARY_CONTEXTS.map(deepPattern) }],
      },
    },
    // 2. platform (Unterbau) — AC-3: the shared substrate may not reach into any of the four
    // Fach-Kontexte's internals either.
    {
      files: ["apps/api/src/contexts/platform/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: patternsExcept("platform") }],
      },
    },
    // 3. absence (Abwesenheiten)
    {
      files: ["apps/api/src/contexts/absence/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: patternsExcept("absence") }],
      },
    },
    // 4. working-time-account (Arbeitszeitkonto)
    {
      files: ["apps/api/src/contexts/working-time-account/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: patternsExcept("working-time-account") }],
      },
    },
    // 5. time-tracking (Zeiterfassung) + services/clock — ADR 0001 Eintrag F: Zeiterfassung is
    // TWO physical trees, one context. Without `services/clock/**` in this block's `files`,
    // `services/clock/resolver.ts:15`'s `../../contexts/time-tracking/invalid-reason` would fall
    // through to block 1's full five-pattern set (which DOES include `time-tracking`) and be
    // reported as a false positive — it is an OWN-context import that merely spells the context
    // name in its path, not a boundary crossing.
    {
      files: ["apps/api/src/contexts/time-tracking/**/*.ts", "apps/api/src/services/clock/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: patternsExcept("time-tracking") }],
      },
    },
    // 6. scheduling (Schichtplanung) + services/phorest — same ADR Eintrag F reasoning, mirrored:
    // `services/phorest/sync-shifts.ts:41`'s `../../contexts/scheduling/time-arithmetic` is an
    // own-context import, not a violation.
    {
      files: ["apps/api/src/contexts/scheduling/**/*.ts", "apps/api/src/services/phorest/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      rules: {
        "no-restricted-imports": [severity, { patterns: patternsExcept("scheduling") }],
      },
    },
    // 7. The ONE named composition-root exception (Owner decision 2026-09-17, Form C /
    // CONTEXT.md D-01). app.ts registers every route module of every context; subjecting it to
    // the rule would force ~70 re-exports including every route registrar and would make import
    // cycles a real question rather than a measured one. It is named here as a single exception,
    // not opened as a bucket — its 45 deep imports are counted by equality in
    // apps/api/scripts/context-boundary-import-exceptions.json (`expectedCount: 45`), so a 46th
    // is a finding, not an absorption. Exact path, not a glob — `apps/api/src/app.ts` and nothing
    // else, so a future `app.test.ts` (already excluded by `**/*.test.ts` above) or a sibling
    // `app-something.ts` is never silently swept in.
    {
      files: ["apps/api/src/app.ts"],
      rules: { "no-restricted-imports": "off" },
    },
    // 8. Plan 05 (Task 3, AC-5) — a stale exception, mechanically. `reportUnusedDisableDirectives`
    // already defaults to "warn" in this flat config and no lint invocation passes
    // --max-warnings, so today it would never fail a gate: a disable comment whose import was
    // later fixed (or moved) is a stale exception with a reason nobody can falsify, and it would
    // sit there silently. Raised to "error", SCOPED to apps/api/src: unscoped it breaks apps/web
    // on a pre-existing unused `no-var` disable in src/lib/components/layout/Topbar.svelte:40,
    // which is Issue #112's tree, not this phase's (RESEARCH.md "Pitfall 3", measured live —
    // apps/web's own eslint output is byte-identical before and after this block, Plan 05's own
    // <verify>). This complements the register-parity check in
    // measure-context-boundary-imports.ts; it does not replace it — parity catches an
    // UNREGISTERED exception, this catches a STALE one.
    {
      files: ["apps/api/src/**/*.ts"],
      ignores: BOUNDARY_IGNORES,
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
  ];
}
