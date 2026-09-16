/**
 * Phase 204 Plan 01 — shared contract for the `lint:tenant-scoping` gate (GitHub Issue #204).
 *
 * This gate prevents a NEW route from reading a client-supplied identifier into a tenant-scoped
 * Prisma model without constraining the result to the caller's own tenant. As of Phase 99b Plan 07
 * (the last of the six context-cut moves), it walks these seven directories, production code only:
 *
 *   - `apps/api/src/contexts/unterbau/api/`
 *   - `apps/api/src/contexts/zeiterfassung/api/`
 *   - `apps/api/src/contexts/abwesenheiten/api/`
 *   - `apps/api/src/contexts/schichtplanung/api/`
 *   - `apps/api/src/contexts/arbeitszeitkonto/api/`
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
 * This file contains ONLY types and frozen constants — no logic, no imports from the other
 * `lint-tenant-scoping-*` modules — so plans 02 (candidate selection) and 03 (verdict) can be
 * written against it in parallel.
 */

// ── Scope (D-11) ────────────────────────────────────────────────────────────────────────────

/**
 * D-11: the ONLY directories this gate walks. Stated once, here, as an explicit list — matching
 * this walker's existing literal-list design; no glob support. Final shape (Phase 99b Plan 07):
 * seven entries; the former monolithic route directory was removed from this list because it no
 * longer exists.
 */
export const SCOPED_DIRS = [
  "apps/api/src/contexts/unterbau/api",
  "apps/api/src/contexts/zeiterfassung/api",
  "apps/api/src/contexts/abwesenheiten/api",
  "apps/api/src/contexts/schichtplanung/api",
  "apps/api/src/contexts/arbeitszeitkonto/api",
  "apps/api/src/composition",
  "apps/api/src/services",
] as const;

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
 * now `apps/api/src/contexts/unterbau/api/{employees,notifications}.ts`):
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
