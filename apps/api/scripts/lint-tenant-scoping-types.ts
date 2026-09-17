/**
 * Phase 204 Plan 01 — shared contract for the `lint:tenant-scoping` gate (GitHub Issue #204).
 *
 * This gate prevents a NEW route (or, since Phase 100B Plan 04, a facade function a route calls)
 * from reading a client-supplied identifier into a tenant-scoped Prisma model without constraining
 * the result to the caller's own tenant. As of Phase 100B Plan 08 it walks these eleven
 * directories, production code only:
 *
 *   - `apps/api/src/contexts/platform/api/`
 *   - `apps/api/src/contexts/platform/facade/` (Phase 100B Plan 04 — the first of five facade
 *     directories this phase introduces; see "The facade rule" below)
 *   - `apps/api/src/contexts/scheduling/facade/` (Phase 100B Plan 05 — Schichtplanung's
 *     conversion facade, `Shift`/`EmployeeAvailability`)
 *   - `apps/api/src/contexts/time-tracking/api/`
 *   - `apps/api/src/contexts/time-tracking/facade/` (Phase 100B Plan 08 — Zeiterfassung's
 *     conversion facade, `TimeEntry`/`Break`)
 *   - `apps/api/src/contexts/absence/api/`
 *   - `apps/api/src/contexts/scheduling/api/`
 *   - `apps/api/src/contexts/working-time-account/api/`
 *   - `apps/api/src/contexts/working-time-account/facade/` (Phase 100B Plan 06 — Arbeitszeitkonto's
 *     conversion facade, `OvertimeAccount`/`OvertimeTransaction`/`SaldoSnapshot`)
 *   - `apps/api/src/composition/` (Phase 99b Plan 02 — the composition layer moved out of
 *     `routes/`; it still reads client-supplied identifiers into cross-context Prisma queries and
 *     stays in scope, see `docs/context-cut-map.md`)
 *   - `apps/api/src/services/`
 *
 * The former monolithic route directory is GONE — every route that used to live there now lives
 * under exactly one of the five `contexts/*\/api` directories above (#99, "keine Restkategorie").
 * This is the exact scenario #229's `MissingScopedDirError` (`lint-tenant-scoping-candidates.ts`)
 * exists for: before that guard, a stale entry naming that removed directory would have made
 * `listScopedFiles` walk zero files and report "0 in-scope call(s) ... OK" with exit 0 — a
 * clean-looking result that in fact checked nothing at all. With the guard, the same stale entry
 * throws instead.
 *
 * `SCOPED_DIRS` below is the single place those paths are stated (D-11). Each context's flat
 * (non-`api/`) files and each context's `plugins/` subdirectory are deliberately out of scope:
 * a Prisma call there never carries a client-supplied identifier from a request, which is the
 * precondition this gate checks for (D-12) — unchanged by where those files physically live.
 *
 * `__tests__` subdirectories under any scoped directory are excluded EXPLICITLY, not by accident
 * of globbing (D-15) — see `EXCLUDED_DIR_SEGMENT`. Test fixtures construct their own literal
 * identifiers and have no client-supplied value by definition, so a correctly applied D-12 filter
 * would exclude them anyway; the exclusion is made explicit here so it cannot silently drift into
 * scope.
 *
 * ── The facade rule (100B Plan 04, D-10) ──────────────────────────────────────────────────────
 * Phase 100b (issue #100) puts a facade layer between a route and Prisma: each context's
 * implementation modules live at `apps/api/src/contexts/<x>/facade/*.ts`. `isFacadeModulePath`
 * below recognises that shape — ONE predicate, stated once, so no second definition of "is this a
 * facade module" can drift out of sync with this one (mirrors `lint-facade-signatures.ts`'s own
 * single-shape recognition of the same directories).
 *
 * A facade module is deliberately walked FROM INSIDE scope, not excluded the way `plugins/` is:
 * this is the opposite precondition from `plugins/`'s. A facade Prisma call carries EXACTLY a
 * client-supplied identifier from a request — that is the entire reason a facade exists, a route
 * calls it with a value that came from `req`. Excluding facades the way `plugins/` is excluded
 * would silently remove the gate's ability to see the very calls this phase moves behind them
 * (100B-RESEARCH.md §4.2: adding the directory to `SCOPED_DIRS` alone raises `in-scope` but leaves
 * `candidates` at zero forever, because a facade function has no `req` — worse than #229, which at
 * least had a null guard). G2/G3 in `lint-tenant-scoping-request-bindings.ts` are what make a
 * facade module's own judgement possible once it is in scope; `SCOPED_DIRS` itself only decides
 * whether the gate walks the file at all. Each conversion plan adds its own context's facade
 * directory to `SCOPED_DIRS` in the SAME commit that creates the directory (`MissingScopedDirError`
 * guards a listed-but-missing entry, #229) — `apps/api/src/contexts/platform/facade` is the first
 * (plan 04, `EmployeeScope`; no Prisma call in it, so the gate's numbers do not move); scheduling
 * (05), working-time-account (06), time-tracking (08) and absence (10) follow, one per wave.
 * Placing the facade inside the gate's scope is a net COVERAGE GAIN, not just damage control: 12
 * relevant-method calls that sit today outside every `SCOPED_DIRS` entry (`platform/anonymize.ts`,
 * `platform/plugins/data-retention.ts`, `time-tracking/arbzg.ts`,
 * `working-time-account/vocational-school-saldo.ts`,
 * `working-time-account/plugins/auto-close-month.ts`) become visible for the first time once they
 * move into a facade. Plan 05 (Schichtplanung) is the first conversion wave to add its own facade
 * directory alongside `contexts/platform/facade`, following exactly that one-per-wave ordering.
 *
 * This file contains ONLY types and frozen constants — no logic, no imports from the other
 * `lint-tenant-scoping-*` modules — so plans 02 (candidate selection) and 03 (verdict) can be
 * written against it in parallel.
 */

// ── Scope (D-11) ────────────────────────────────────────────────────────────────────────────

/**
 * D-11: the ONLY directories this gate walks. Stated once, here, as an explicit list — matching
 * this walker's existing literal-list design; no glob support. Phase 99b Plan 07 shape: seven
 * entries; the former monolithic route directory was removed from this list because it no longer
 * exists. Phase 100B Plan 04 added the eighth: `contexts/platform/facade` (`EmployeeScope`, no
 * Prisma call — see the facade-rule note above), the first of the five facade directories this
 * phase introduces. Plan 05 adds the ninth: `contexts/scheduling/facade` (`Shift`/
 * `EmployeeAvailability` — S1-S4), in the SAME commit that creates the directory
 * (`MissingScopedDirError`, #229). Plan 06 adds the tenth: `contexts/working-time-account/facade`
 * (`OvertimeAccount`/`OvertimeTransaction` — W8-W15). Plan 08 adds the eleventh:
 * `contexts/time-tracking/facade` (`TimeEntry`/`Break` — T1-T12/T2b/T2c). `absence`
 * (10) follows, one per conversion wave. No further platform entry is expected — platform
 * (Unterbau) needs no CONVERSION facade of its own for this phase's D-01 waves, because every
 * other context may already read it directly per ADR 0001; `contexts/platform/facade` exists only
 * for the one shared-type module, a different purpose than the other four (redirecting an
 * existing cross-context Prisma access), not a precedent for platform gaining a conversion facade
 * too.
 */
export const SCOPED_DIRS = [
  "apps/api/src/contexts/platform/api",
  "apps/api/src/contexts/platform/facade",
  "apps/api/src/contexts/time-tracking/api",
  "apps/api/src/contexts/time-tracking/facade",
  "apps/api/src/contexts/absence/api",
  "apps/api/src/contexts/absence/facade",
  "apps/api/src/contexts/scheduling/api",
  "apps/api/src/contexts/scheduling/facade",
  "apps/api/src/contexts/working-time-account/api",
  "apps/api/src/contexts/working-time-account/facade",
  "apps/api/src/composition",
  "apps/api/src/services",
] as const;

/**
 * 100B Plan 04, D-10/G1: does `repoRelativePath` sit under a context's facade directory
 * (`apps/api/src/contexts/<x>/facade/`)? ONE predicate, stated once — no reader of
 * `lint-tenant-scoping-candidates.ts` or `lint-tenant-scoping-request-bindings.ts` may rebuild
 * this shape inline. `[a-z][a-z-]*` allows a hyphenated context name (`working-time-account`,
 * `time-tracking`) — the same gap `context-area-map.test.ts`'s rahmen guard was blind to until
 * Phase 100B Plan 03 fixed it (GitHub #240); this predicate is written against that lesson from
 * the start, not repaired into it later.
 */
export function isFacadeModulePath(repoRelativePath: string): boolean {
  return /^apps\/api\/src\/contexts\/[a-z][a-z-]*\/facade\//.test(repoRelativePath);
}

/**
 * D-15: `__tests__` is excluded EXPLICITLY, not by accident of globbing. Test fixtures build
 * their own literal identifiers and have no client-supplied value by definition (verified: zero
 * `req.params` occurrences under any scoped directory's `__tests__` on main @ 708ffbfa, back
 * when the only scoped directory with such a subtree was the former monolithic route directory),
 * so the D-12 filter would drop them anyway — the exclusion is made explicit so it cannot
 * silently flip.
 */
export const EXCLUDED_DIR_SEGMENT = "__tests__";

// ── Relevant Prisma calls ───────────────────────────────────────────────────────────────────

/** The methods the ticket names. A `findMany` with nothing from the request is not this threat. */
export const RELEVANT_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "update",
  "delete",
  "deleteMany",
  "updateMany",
] as const;
export type RelevantMethod = (typeof RELEVANT_METHODS)[number];

// ── Principal (req.user) fields ─────────────────────────────────────────────────────────────

/**
 * Fields of `req.user` that constrain to the caller's own data. `tenantId` is the rule
 * CLAUDE.md § Multi-Tenancy Convention states. `employeeId` and `sub` are accepted as well
 * because they are STRICTLY TIGHTER than a tenant constraint, not looser: an Employee belongs to
 * exactly one Tenant and a User to exactly one Employee, so scoping to them cannot widen the
 * result set across a tenant boundary. Measured examples on main @ 708ffbfa (in the files that
 * were then `employees.ts` and `notifications.ts` under the former monolithic route directory,
 * now `apps/api/src/contexts/platform/api/{employees,notifications}.ts`):
 * `device.employeeId !== employeeId` -> 403, and `where: { id, userId: req.user.sub }`.
 */
export const PRINCIPAL_FIELDS = ["tenantId", "employeeId", "sub"] as const;
export type PrincipalField = (typeof PRINCIPAL_FIELDS)[number];

// ── Model classification (D-05, D-19) ───────────────────────────────────────────────────────

/** How a model reaches a `tenantId`, derived from DMMF (D-05/D-19). No residual category. */
export type ModelTenancy =
  | { kind: "own" }
  | { kind: "relation"; path: readonly string[] } // e.g. ["employee"], ["timeEntry","employee"]
  | { kind: "none" };

/** Key = the Prisma delegate name as written in code (camelCase): "timeEntry", not "TimeEntry". */
export type ModelGraph = ReadonlyMap<string, ModelTenancy>;

// ── One in-scope Prisma call ────────────────────────────────────────────────────────────────

/** One in-scope Prisma call, before any verdict. */
export type PrismaCall = {
  file: string; // repo-relative, forward slashes
  line: number; // 1-based
  model: string; // delegate name, e.g. "timeEntry"
  method: RelevantMethod;
  /** Stable exception-list key. See lint-tenant-scoping-exceptions.ts. */
  callId: string; // `${file}:${model}.${method}:${line}`
};

// ── Request-binding resolution ──────────────────────────────────────────────────────────────

/** Local names in ONE function scope that originate in the request. */
export type RequestBindings = {
  /** Names bound from req.params / req.query / req.body (D-12 client-supplied identifiers). */
  clientSupplied: ReadonlySet<string>;
  /** Names aliasing the whole principal: `const user = req.user` -> "user". */
  principalObjects: ReadonlySet<string>;
  /** localName -> which principal field it holds: `const tenantId = req.user.tenantId`. */
  principalFields: ReadonlyMap<string, PrincipalField>;
};

// ── Provenance and verdict (D-12, D-13, D-14) ───────────────────────────────────────────────

/** D-14: is this call even a candidate? */
export type Provenance =
  | { clientSupplied: true; via: readonly string[] }
  | { clientSupplied: false; reason: string };

/**
 * D-13's three ways, with their sub-forms named so the report says HOW a call passed.
 * (1) `where` constrains on tenantId       -> "inline-tenant-id"
 * (1') `where` constrains on another principal field -> "inline-principal-field"
 * (2) `where` carries a constraining relation filter -> "inline-relation-filter"
 * (3) fetch-then-compare in the same scope -> "fetch-then-compare" | "guard-fetch"
 */
export type ScopedVia =
  | "inline-tenant-id"
  | "inline-principal-field"
  | "inline-relation-filter"
  | "fetch-then-compare"
  | "guard-fetch";

export type Verdict =
  | { scoped: true; via: ScopedVia; detail: string }
  | { scoped: false; detail: string };
