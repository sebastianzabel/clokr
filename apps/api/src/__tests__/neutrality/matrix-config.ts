/**
 * Phase 75b (Issue #75, D-20, D-21, AC-75-9, AC-75-10) — the checked-in configuration of the
 * permission neutrality matrix.
 *
 * Three lists together must cover exactly the route set `deriveMatrixRoutes()` parses from source
 * (the matrix test checks both directions):
 *   - `ROUTE_SPECS`       — every route the matrix exercises, with how to build its requests;
 *   - `EXCLUDED_ROUTES`   — derived routes the matrix deliberately does not exercise, each with a
 *                           written reason;
 *   - `OUTSIDE_DERIVATION` — routes declared in `app.ts` itself, which the source parser cannot see;
 *                           the test proves each one is registered (`app.hasRoute`), so this list
 *                           cannot go stale either.
 *
 * A spec names, per path parameter, the FIXTURE KIND that substitutes it. Person-bound kinds are
 * resolved against the variant's person (`own.<kind>` or `foreign.<kind>`), tenant-level kinds
 * against the actor's tenant (`tenant.<kind>`). Query and body values may reference any fixture
 * label with a `$<label>` placeholder (e.g. `$foreign.employee`).
 */

/** The actors, in the fixed D-20 order (least privileged first), fallback actors (D-21) last. */
export type ActorKind =
  | "EMPLOYEE"
  | "APIKEY_PLAIN"
  | "MANAGER"
  | "APIKEY_ADMIN"
  | "ADMIN"
  | "FALLBACK_EMPLOYEE"
  | "FALLBACK_MANAGER"
  | "FALLBACK_ADMIN";

export const ACTOR_ORDER: readonly ActorKind[] = [
  "EMPLOYEE",
  "APIKEY_PLAIN",
  "MANAGER",
  "APIKEY_ADMIN",
  "ADMIN",
  "FALLBACK_EMPLOYEE",
  "FALLBACK_MANAGER",
  "FALLBACK_ADMIN",
];

/** Actors authenticated with a `clk_` API key. They have no employee of their own. */
export const API_KEY_ACTORS: ReadonlySet<ActorKind> = new Set(["APIKEY_PLAIN", "APIKEY_ADMIN"]);

/** Actors built AFTER the migration SQL ran: they hold no stored role assignment (D-21). */
export const FALLBACK_ACTORS: ReadonlySet<ActorKind> = new Set([
  "FALLBACK_EMPLOYEE",
  "FALLBACK_MANAGER",
  "FALLBACK_ADMIN",
]);

/** Whose entity a cell addresses: the actor's own person, a foreign person of the same tenant, a
 * tenant-level entity, or nothing (no path parameter). */
export type Variant = "own" | "foreign" | "tenant" | "none";

/** `read` cells run first, `mutate` cells after them, `self-destructive` cells last (Pitfall 4). */
export type CellPhase = "read" | "mutate" | "self-destructive";

/** The phases this plan runs. Plan 75b-03 widens it to the mutating phases. */
export const PHASES_ENABLED: ReadonlySet<CellPhase> = new Set<CellPhase>(["read"]);

/** Named per-route projections, recorded next to the id multiset (Pitfall 1: masking changes must
 * show as a cell difference, not hide behind equal ids). */
export type ProjectionName = "leaveTypeMask" | "pendingApprovalsCount";

/** One request shape of a route. `name` is part of the cell key and must be unique per route. */
export interface VariantSpec {
  name: string;
  target: Variant;
  query?: Record<string, string>;
  body?: unknown;
}

export interface RouteSpec {
  phase: CellPhase;
  /** Path parameter name → fixture kind. */
  params?: Record<string, string>;
  /** Request shapes. Defaults: `own` + `foreign` when a person-bound kind is a parameter, `tenant`
   * when only tenant-level kinds are, `none` without parameters. */
  variants?: VariantSpec[];
  projections?: ProjectionName[];
  /**
   * Set on GET routes whose handler decides by role itself (75b-RESEARCH Q2). `true`: the
   * EMPLOYEE and ADMIN cells of the `foreign` variant must differ — proof the ownership branch is
   * reached. A string: the written reason why the two cells may coincide.
   */
  handlerCheck?: true | string;
}

/** Fixture kinds that exist once per tenant (resolved as `tenant.<kind>`). Every other kind is
 * person-bound and exists for the own and the foreign person (`own.<kind>`, `foreign.<kind>`). */
export const TENANT_LEVEL_KINDS: ReadonlySet<string> = new Set<string>([]);

export interface RouteReason {
  route: string;
  reason: string;
}

/** Derived routes the matrix does not exercise. Filled in Task 2. */
export const EXCLUDED_ROUTES: readonly RouteReason[] = [];

/** Routes declared in `app.ts` itself — invisible to the source parser, proven registered. */
export const OUTSIDE_DERIVATION: readonly RouteReason[] = [
  {
    route: "POST /api/v1/logs/client",
    reason:
      "Declared inline in app.ts (client error logging, requireAuth only, no role decision); " +
      "5 requests per minute route limit.",
  },
  {
    route: "GET /health",
    reason: "Declared inline in app.ts; unauthenticated database ping for the orchestrator.",
  },
  {
    route: "GET /api/v1/health",
    reason: "Declared inline in app.ts; unauthenticated alias of GET /health.",
  },
  {
    route: "GET /api/v1/version",
    reason: "Declared inline in app.ts; unauthenticated, returns only the baked version string.",
  },
];

export const ROUTE_SPECS: Readonly<Record<string, RouteSpec>> = {
  "GET /api/v1/employees": { phase: "read" },
  "GET /api/v1/employees/:id": {
    phase: "read",
    params: { id: "employee" },
    handlerCheck: true,
  },
};
