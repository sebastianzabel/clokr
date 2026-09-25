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
 *
 * Dates in queries are fixed relative to the pinned "now" of the matrix (2026-06-17, a Wednesday):
 * June 2026 is the current month, May 2026 holds the § 9 case.
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

/** The phases the matrix runs: all of them (plan 75b-03 widened it from `read`). */
export const PHASES_ENABLED: ReadonlySet<CellPhase> = new Set<CellPhase>([
  "read",
  "mutate",
  "self-destructive",
]);

/** Named per-route projections, recorded next to the id multiset (Pitfall 1: masking changes must
 * show as a cell difference, not hide behind equal ids). */
export type ProjectionName = "leaveTypeMask" | "pendingApprovalsCount" | "collisionTotal" | "body";

/**
 * The `limit` of the activity-feed cells, and the number of feed-pin audit rows every fixture
 * tenant holds. The ADMIN branch of `GET /activity` reads the newest `limit` audit rows of the
 * tenant PLUS every `userId: null` row of the whole database (`composition/activity.ts`) — rows
 * that other test files and earlier runs leave behind (cleanup nulls `AuditLog.userId`). With
 * `limit` own rows newer than anything else, `take: limit` never reaches a foreign row and the
 * cell is deterministic in a shared worker database.
 */
export const ACTIVITY_FEED_LIMIT = 20;

/** A multipart upload with one file part (field `file`), built by hand with a fixed boundary. */
export interface MultipartSpec {
  filename: string;
  contentType: string;
  /** Which fixed file content the part carries (see `cell-runner.ts`). */
  content: "png" | "pdf";
}

/** One request shape of a route. `name` is part of the cell key and must be unique per route. */
export interface VariantSpec {
  name: string;
  target: Variant;
  /** Path parameter name → fixture kind, overriding the route's `params` for this variant only
   * (e.g. a lock cell that needs a request in a special state). */
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  multipart?: MultipartSpec;
}

/** Actors whose cells of a route record the status code only, with the reason why. */
export interface StatusOnly {
  actors: readonly ActorKind[];
  reason: string;
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
   * EMPLOYEE and ADMIN cells of `checkVariant` (default `foreign`) must differ — full records,
   * projections included — which proves the request reaches the ownership branch instead of
   * failing earlier (e.g. a 400 before the check). A string: the written reason why the two cells
   * may coincide.
   */
  handlerCheck?: true | string;
  /** The variant the discriminating check compares (default `foreign`). */
  checkVariant?: string;
  /**
   * Record only the status code for these actors — the body is not a stable function of the
   * actor's own tenant. Only for pre-existing, filed defects; the reason names the issue.
   */
  statusOnly?: StatusOnly;
}

/** Fixture kinds that exist once per tenant (resolved as `tenant.<kind>`). Every other kind is
 * person-bound and exists for the own and the foreign person (`own.<kind>`, `foreign.<kind>`). */
export const TENANT_LEVEL_KINDS: ReadonlySet<string> = new Set<string>([
  "leaveType.VACATION",
  "leaveType.SICK",
  "specialLeaveRule",
  "holiday",
  "companyShutdown",
  "shiftTemplate",
  "coverageRule",
  "terminal",
  "apiKey.secondary",
  "presenceSource",
  "phorestMapping",
  "customRole.assigned",
  "customRole.free",
  "roleAssignment.customer",
  "salon",
  "salonInactive",
  "auditLog",
  "hardDeleteTarget.employee",
]);

export interface RouteReason {
  route: string;
  reason: string;
}

/** Derived routes the matrix does not exercise (75b-RESEARCH Q5). Login/refresh `user.role` and
 * the JWT `role` claim are recorded separately by plan 75b-04 (D-20, C-4). */
export const EXCLUDED_ROUTES: readonly RouteReason[] = [
  ...[
    "POST /api/v1/auth/login",
    "POST /api/v1/auth/verify-otp",
    "POST /api/v1/auth/resend-otp",
    "POST /api/v1/auth/refresh",
    "POST /api/v1/auth/logout",
    "POST /api/v1/auth/forgot-password",
    "POST /api/v1/auth/reset-password",
    "GET /api/v1/auth/password-policy",
  ].map((route) => ({
    route,
    reason:
      "Unauthenticated auth endpoint without a role decision; tight per-route rate limits " +
      "(3-5 per 5-15 min, auth.ts) would 429. Login/refresh role is recorded by plan 75b-04.",
  })),
  {
    route: "POST /api/v1/invitations/accept",
    reason:
      "Unauthenticated: the invitation token is the credential, no role decision; " +
      "10 per minute route limit.",
  },
  {
    route: "POST /api/v1/auth/change-password",
    reason:
      "Self-service with jwtVerify only, no role decision; 5 per 15 min route limit, and it " +
      "mutates the actor's own credentials.",
  },
  ...[
    "POST /api/v1/test/bootstrap-tenant",
    "POST /api/v1/test/bootstrap-terminal",
    "DELETE /api/v1/test/tenant/:id",
  ].map((route) => ({
    route,
    reason:
      "Test-only bootstrap route, registered only with ALLOW_TEST_BOOTSTRAP " +
      "(test-bootstrap.ts), no authentication and no role decision.",
  })),
  {
    route: "POST /api/v1/time-entries/nfc-punch",
    reason: "Device-authenticated (terminal API key), no user role; the NFC hot path is unchanged.",
  },
  {
    route: "POST /api/v1/presence/events",
    reason: "Device-authenticated (presence-source key and MAC), no user role involved.",
  },
  {
    route: "GET /api/v1/terminals/allowed-cards",
    reason: "Device-authenticated (terminal API key), no user role involved.",
  },
  {
    route: "GET /api/v1/release-notes",
    reason: "Public baked release notes (release-notes.ts), no authentication at all.",
  },
];

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

// ── Variant helpers ─────────────────────────────────────────────────────────────────────────────

/** A query-only route called once without a person, then for the own and the foreign person. */
function personQuery(
  param: string,
  base: Record<string, string> = {},
  opts: { withNone?: boolean } = {},
): VariantSpec[] {
  return [
    ...(opts.withNone === false ? [] : [{ name: "none", target: "none" as const, query: base }]),
    { name: "own", target: "own", query: { ...base, [param]: "$own.employee" } },
    { name: "foreign", target: "foreign", query: { ...base, [param]: "$foreign.employee" } },
  ];
}

/** The own and the foreign variant of a person-parameter route, both with the same query. */
function ownForeign(query: Record<string, string>): VariantSpec[] {
  return [
    { name: "own", target: "own", query },
    { name: "foreign", target: "foreign", query },
  ];
}

function none(query: Record<string, string>): VariantSpec[] {
  return [{ name: "none", target: "none", query }];
}

const JUNE = { year: "2026", month: "6" };
const MAY = { year: "2026", month: "5" };
const YEAR = { year: "2026" };
const JUNE_RANGE = { from: "2026-06-01", to: "2026-06-30" };

/**
 * Issue #345 (pre-existing, not fixed in #75): `GET` and `POST /holidays` resolve the caller's
 * federal state through `tenant.findFirst({ employees: { some: { userId: sub } } })`, which finds
 * nothing for an API key (`sub` is `apikey:<id>`), and then fall back to an UNFILTERED, UNORDERED
 * `tenant.findFirst()` — some other tenant of the database. What an API key gets back therefore
 * depends on which tenants exist and in which order the database returns them, not on the key's
 * own tenant, so only the status code of those cells is recorded. JWT actors keep the full record.
 */
const HOLIDAYS_API_KEY_FALLBACK =
  "Issue #345: for an API key the handler falls back to an unordered tenant.findFirst() over " +
  "all tenants, so the body names a foreign, database-order-dependent tenant — status only.";

const mutate = (params?: Record<string, string>): RouteSpec => ({ phase: "mutate", params });
const selfDestructive = (params: Record<string, string>): RouteSpec => ({
  phase: "self-destructive",
  params,
});

/** A mutating route whose every default variant (see `variantsOf`) sends the same body. */
function mutateWith(params: Record<string, string> | undefined, body: unknown): RouteSpec {
  const kinds = Object.values(params ?? {});
  let variants: VariantSpec[];
  if (kinds.length === 0) {
    variants = [{ name: "none", target: "none", body }];
  } else if (kinds.every((kind) => TENANT_LEVEL_KINDS.has(kind))) {
    variants = [{ name: "tenant", target: "tenant", body }];
  } else {
    variants = [
      { name: "own", target: "own", body },
      { name: "foreign", target: "foreign", body },
    ];
  }
  return { phase: "mutate", params, variants };
}

export const ROUTE_SPECS: Readonly<Record<string, RouteSpec>> = {
  // ── read ─────────────────────────────────────────────────────────────────────────────────────
  "GET /api/v1/activity": {
    phase: "read",
    variants: none({ limit: String(ACTIVITY_FEED_LIMIT) }),
    handlerCheck: true,
    checkVariant: "none",
  },
  "GET /api/v1/admin/presence-sources": { phase: "read" },
  "GET /api/v1/admin/presence-sources/:id/devices": {
    phase: "read",
    params: { id: "presenceSource" },
  },
  "GET /api/v1/admin/presence-sources/opted-in": { phase: "read" },
  "GET /api/v1/admin/school-holidays": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/api-keys": { phase: "read" },
  "GET /api/v1/api-keys/scopes": { phase: "read" },
  "GET /api/v1/audit-logs": { phase: "read" },
  "GET /api/v1/audit-logs/:id": { phase: "read", params: { id: "auditLog" } },
  "GET /api/v1/avatars/:employeeId": { phase: "read", params: { employeeId: "employee" } },
  "GET /api/v1/company-shutdowns": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/dashboard": { phase: "read" },
  "GET /api/v1/dashboard/my-week": { phase: "read" },
  "GET /api/v1/dashboard/open-items": {
    phase: "read",
    projections: ["pendingApprovalsCount"],
    handlerCheck: true,
    checkVariant: "none",
  },
  "GET /api/v1/dashboard/overtime-overview": { phase: "read" },
  "GET /api/v1/dashboard/overtime-trend": { phase: "read" },
  "GET /api/v1/dashboard/team-week": { phase: "read" },
  "GET /api/v1/dashboard/today-attendance": { phase: "read" },
  "GET /api/v1/employees": {
    phase: "read",
    variants: [
      { name: "none", target: "none" },
      { name: "includeAnonymized", target: "none", query: { includeAnonymized: "true" } },
    ],
    handlerCheck: true,
    checkVariant: "includeAnonymized",
  },
  "GET /api/v1/employees/:id": { phase: "read", params: { id: "employee" }, handlerCheck: true },
  "GET /api/v1/employees/:id/availability": {
    phase: "read",
    params: { id: "employee" },
    handlerCheck: true,
  },
  "GET /api/v1/employees/:id/salon-assignments": { phase: "read", params: { id: "employee" } },
  "GET /api/v1/employees/:id/shift-patterns": {
    phase: "read",
    params: { id: "employee" },
    handlerCheck: true,
  },
  "GET /api/v1/employees/:id/vocational-school-pattern": {
    phase: "read",
    params: { id: "employee" },
    handlerCheck: true,
  },
  "GET /api/v1/employees/me/wifi": { phase: "read" },
  "GET /api/v1/holidays": {
    phase: "read",
    variants: none(YEAR),
    statusOnly: { actors: ["APIKEY_PLAIN", "APIKEY_ADMIN"], reason: HOLIDAYS_API_KEY_FALLBACK },
  },
  "GET /api/v1/integrations/phorest/appointment-collisions": {
    phase: "read",
    variants: [
      {
        name: "own",
        target: "own",
        query: { employeeId: "$own.employee", from: "2026-06-15", to: "2026-06-21" },
      },
      {
        name: "foreign",
        target: "foreign",
        query: { employeeId: "$foreign.employee", from: "2026-06-15", to: "2026-06-21" },
      },
      { name: "shift-own", target: "own", query: { shiftId: "$own.shift" } },
      { name: "shift-foreign", target: "foreign", query: { shiftId: "$foreign.shift" } },
    ],
    projections: ["collisionTotal"],
    handlerCheck: true,
  },
  "GET /api/v1/integrations/phorest/config": { phase: "read" },
  "GET /api/v1/integrations/phorest/mappings": { phase: "read" },
  "GET /api/v1/integrations/phorest/staff": { phase: "read" },
  "GET /api/v1/integrations/phorest/sync-runs": { phase: "read" },
  "GET /api/v1/leave/calendar": {
    phase: "read",
    variants: [
      { name: "june", target: "none", query: JUNE },
      { name: "may", target: "none", query: MAY },
    ],
    projections: ["leaveTypeMask"],
    handlerCheck: true,
    checkVariant: "june",
  },
  "GET /api/v1/leave/entitlements/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
    variants: ownForeign(YEAR),
    handlerCheck: true,
  },
  "GET /api/v1/leave/hours-preview": {
    phase: "read",
    variants: none({ startDate: "2026-07-13", endDate: "2026-07-14" }),
  },
  "GET /api/v1/leave/ical/personal": { phase: "read" },
  "GET /api/v1/leave/ical/team": { phase: "read" },
  "GET /api/v1/leave/karenz-overrun": { phase: "read" },
  "GET /api/v1/leave/overlap": {
    phase: "read",
    variants: [
      { name: "june", target: "none", query: { startDate: "2026-06-22", endDate: "2026-06-23" } },
      { name: "may", target: "none", query: { startDate: "2026-05-11", endDate: "2026-05-15" } },
    ],
    projections: ["leaveTypeMask"],
    handlerCheck: true,
    checkVariant: "june",
  },
  "GET /api/v1/leave/overtime-balance": { phase: "read" },
  "GET /api/v1/leave/requests": {
    phase: "read",
    variants: personQuery("employeeId"),
    handlerCheck: true,
  },
  "GET /api/v1/leave/section9": {
    phase: "read",
    handlerCheck: true,
    checkVariant: "none",
  },
  "GET /api/v1/leave/section9/:id": {
    phase: "read",
    params: { id: "section9.credit" },
    handlerCheck: true,
  },
  "GET /api/v1/me/availability": { phase: "read" },
  "GET /api/v1/me/preferences": { phase: "read" },
  "GET /api/v1/me/release-notes-seen": { phase: "read" },
  "GET /api/v1/notifications": { phase: "read" },
  "GET /api/v1/overtime/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
    handlerCheck: true,
  },
  "GET /api/v1/overtime/close-month/deferred": { phase: "read" },
  "GET /api/v1/overtime/close-month/status": { phase: "read", variants: none(MAY) },
  "GET /api/v1/overtime/close-month/year-status": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/overtime/month-saldo/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
    variants: ownForeign(JUNE),
    handlerCheck: true,
  },
  "GET /api/v1/overtime/snapshots/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
    handlerCheck: true,
  },
  // Report exports: every export writes an EXPORT audit row with `userId: req.user.sub`, which
  // for an API key is `apikey:<id>` and violates the foreign key onto User — the API-key cells of
  // the export routes below answer 500. Issue #333, pre-existing, recorded as-is.
  "GET /api/v1/reports/carryover-at-risk": { phase: "read" },
  "GET /api/v1/reports/datev": { phase: "read", variants: none(MAY) },
  "GET /api/v1/reports/datev/employee": {
    phase: "read",
    variants: personQuery("employeeId", MAY, { withNone: false }),
  },
  "GET /api/v1/reports/leave-list/pdf": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/reports/leave-overview": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/reports/leave-overview/pdf": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/reports/monthly": {
    phase: "read",
    variants: personQuery("employeeId", JUNE, { withNone: false }),
  },
  "GET /api/v1/reports/monthly/pdf": {
    phase: "read",
    variants: personQuery("employeeId", JUNE, { withNone: false }),
    handlerCheck: true,
  },
  "GET /api/v1/reports/monthly/pdf/all": { phase: "read", variants: none(JUNE) },
  "GET /api/v1/reports/vacation/pdf": { phase: "read", variants: none(YEAR) },
  "GET /api/v1/retro-entry-requests": { phase: "read" },
  "GET /api/v1/role-assignments": { phase: "read" },
  "GET /api/v1/role-assignments/:id": { phase: "read", params: { id: "roleAssignment.customer" } },
  "GET /api/v1/roles": { phase: "read" },
  "GET /api/v1/roles/:id": { phase: "read", params: { id: "customRole.assigned" } },
  "GET /api/v1/salons": {
    phase: "read",
    variants: [
      { name: "none", target: "none" },
      { name: "includeInactive", target: "none", query: { includeInactive: "true" } },
    ],
  },
  "GET /api/v1/salons/:id": { phase: "read", params: { id: "salon" } },
  "GET /api/v1/section9-documents/:creditId": {
    phase: "read",
    params: { creditId: "section9.credit" },
    handlerCheck: true,
  },
  "GET /api/v1/settings/employees": { phase: "read" },
  "GET /api/v1/settings/leave-types": { phase: "read" },
  "GET /api/v1/settings/security": { phase: "read" },
  "GET /api/v1/settings/smtp": { phase: "read" },
  "GET /api/v1/settings/vacation/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
  },
  "GET /api/v1/settings/work": { phase: "read" },
  "GET /api/v1/settings/work/:employeeId": {
    phase: "read",
    params: { employeeId: "employee" },
    handlerCheck: true,
  },
  "GET /api/v1/settings/work/:employeeId/history": {
    phase: "read",
    params: { employeeId: "employee" },
  },
  "GET /api/v1/shift-patterns/tenant": { phase: "read" },
  "GET /api/v1/shifts/conflicts": {
    phase: "read",
    variants: none({ from: "2026-06-15", to: "2026-06-21" }),
  },
  "GET /api/v1/shifts/coverage-rules": { phase: "read" },
  "GET /api/v1/shifts/my-week": { phase: "read", variants: none({ date: "2026-06-15" }) },
  "GET /api/v1/shifts/range": {
    phase: "read",
    variants: personQuery("employeeId", JUNE_RANGE),
    // The rows carry no ids; the body shows WHOSE shifts came back (own and foreign shifts have
    // different times), which is how an EMPLOYEE's silent fallback to the own person shows.
    projections: ["body"],
    handlerCheck: true,
  },
  "GET /api/v1/shifts/templates": { phase: "read" },
  "GET /api/v1/shifts/week": { phase: "read", variants: none({ date: "2026-06-15" }) },
  "GET /api/v1/special-leave/rules": { phase: "read" },
  "GET /api/v1/special-leave/rules/:id": { phase: "read", params: { id: "specialLeaveRule" } },
  "GET /api/v1/terminals": { phase: "read" },
  "GET /api/v1/time-entries": {
    phase: "read",
    variants: personQuery("employeeId", JUNE_RANGE),
    handlerCheck: true,
  },
  "GET /api/v1/vocational-school/preview": { phase: "read" },
  "GET /api/v1/vocational-school/retroactive-preview": {
    phase: "read",
    variants: personQuery("employeeId", {}, { withNone: false }),
  },
  "GET /api/v1/vocational-school/upcoming": {
    phase: "read",
    variants: personQuery("employeeId", JUNE_RANGE),
    handlerCheck: true,
  },

  // ── mutate ──────────────────────────────────────────────────────────────────────────────────
  // Declaration order is execution order (per actor, after every read cell). Within a family,
  // creates and updates come first and deletes last, a child is deleted before its parent, and a
  // restore follows its delete — so every cell addresses the fixture state it was written for.
  // Guard-only routes (a route guard decides, the handler does not look at the role) keep a
  // minimal body: an allowed actor's 400 against a denied actor's 403 is a falsifiable cell.
  // Routes whose HANDLER decides by role (75b-RESEARCH Q2) get valid own/foreign bodies and
  // `handlerCheck`, so the request reaches that decision.
  //
  // API-key actors: many writes answer 500 because the route writes `req.user.sub`
  // (`apikey:<id>`) into `AuditLog.userId`, a foreign key onto User — Issue #333, pre-existing,
  // recorded as-is (a later fix changes those cells on purpose, not by accident).

  // presence sources (Unterbau / Zeiterfassung)
  "POST /api/v1/admin/presence-sources": mutate(),
  "PATCH /api/v1/admin/presence-sources/:id": mutate({ id: "presenceSource" }),
  "POST /api/v1/admin/presence-sources/:id/devices/:mac/assign": mutate({
    id: "presenceSource",
    mac: "presenceDevice.mac",
  }),
  "DELETE /api/v1/admin/presence-sources/:id/devices/:mac": mutate({
    id: "presenceSource",
    mac: "presenceDevice.mac",
  }),
  "DELETE /api/v1/admin/presence-sources/:id": mutate({ id: "presenceSource" }),

  // school holidays: the refresh reaches the stubbed OpenHolidays reply (external-stubs.ts)
  "POST /api/v1/admin/school-holidays/refresh": mutate(),

  // API keys: the DELETE target is the tenant's SECOND key, never the acting one (Pitfall 4)
  "POST /api/v1/api-keys": mutate(),
  "DELETE /api/v1/api-keys/:id": mutate({ id: "apiKey.secondary" }),

  // company shutdowns (Betriebsurlaub): the exception is created for the own person and then
  // deleted again; the foreign person's exception comes from the fixture
  "POST /api/v1/company-shutdowns": mutate(),
  "PATCH /api/v1/company-shutdowns/:id": mutate({ id: "companyShutdown" }),
  // Without a body the handler destructures `undefined` and answers 500 — a harness artefact, so
  // this guard-only route gets a valid body.
  "POST /api/v1/company-shutdowns/:id/exceptions": mutateWith(
    { id: "companyShutdown" },
    { employeeId: "$own.employee", reason: "Matrix Ausnahme" },
  ),
  "DELETE /api/v1/company-shutdowns/:id/exceptions/:employeeId": mutate({
    id: "companyShutdown",
    employeeId: "employee",
  }),
  "DELETE /api/v1/company-shutdowns/:id": mutate({ id: "companyShutdown" }),

  // employees (guard-only writes; the self-destructive ones are at the end of the file)
  "POST /api/v1/employees": mutate(),
  "PATCH /api/v1/employees/:id": mutate({ id: "employee" }),
  "PATCH /api/v1/employees/:id/reactivate": mutate({ id: "employee" }),
  "PATCH /api/v1/employees/:id/unlock": mutate({ id: "employee" }),
  "POST /api/v1/employees/:id/resend-invitation": mutate({ id: "employee" }),
  "PUT /api/v1/employees/:id/availability": {
    ...mutateWith(
      { id: "employee" },
      { entries: [{ dayOfWeek: 1, status: "AVAILABLE", validFrom: "2026-07-01" }] },
    ),
    // Handler check #24: body parsed first, then EMPLOYEE-and-not-own → 403.
    handlerCheck: true,
  },
  "PUT /api/v1/employees/:id/shift-patterns": mutate({ id: "employee" }),
  "PUT /api/v1/employees/:id/vocational-school-pattern": mutate({ id: "employee" }),

  // Salonzuordnung (67b): valid bodies, so an allowed actor really ends, creates and changes an
  // assignment. The fixture's open deployment to the second salon ends on 30 June, a new July
  // deployment to that salon follows it without overlap, and the default salon becomes the
  // Stammsalon from the hire date (no assignment to it exists, so nothing overlaps).
  "POST /api/v1/employees/:id/salon-assignments/:assignmentId/end": mutateWith(
    { id: "employee", assignmentId: "salonAssignment" },
    { validUntil: "2026-06-30" },
  ),
  "POST /api/v1/employees/:id/salon-assignments": mutateWith(
    { id: "employee" },
    {
      salonId: "$tenant.salon",
      validFrom: "2026-07-01",
      validUntil: "2026-07-31",
      weekdays: [1],
    },
  ),
  "POST /api/v1/employees/:id/salon-assignments/home": mutateWith(
    { id: "employee" },
    { salonId: "$tenant.salon.default", validFrom: "2024-01-01" },
  ),

  // own Wi-Fi presence (self-service; an API key has no employee)
  // API keys answer 500 here, and not because of #333: a key has no employee, and the handler
  // passes `id: undefined` to `employee.findUnique`, which Prisma rejects as a validation error.
  // Pre-existing, recorded as-is (its sibling POST answers 401 for the same situation).
  "PATCH /api/v1/employees/me/wifi": mutateWith(undefined, { wifiPresenceEnabled: true }),
  "POST /api/v1/employees/me/wifi/devices": mutateWith(undefined, {
    mac: "02:00:00:00:00:03",
    label: "Matrix Neu",
  }),
  "DELETE /api/v1/employees/me/wifi/devices/:id": mutate({ id: "wifiDevice" }),

  // holidays — a minimal body, so no API-key cell writes anything (Issue #345, see GET)
  "POST /api/v1/holidays": {
    ...mutate(),
    statusOnly: { actors: ["APIKEY_PLAIN", "APIKEY_ADMIN"], reason: HOLIDAYS_API_KEY_FALLBACK },
  },
  "DELETE /api/v1/holidays/:id": mutate({ id: "holiday" }),

  // CSV imports
  "POST /api/v1/imports/employees": mutate(),
  "POST /api/v1/imports/time-entries": mutate(),

  // Phorest: the test and the sync stop at "not configured" / the body check, and the stubbed
  // gateway answers anything that does get through
  "PUT /api/v1/integrations/phorest/config": mutate(),
  "POST /api/v1/integrations/phorest/mappings": mutate(),
  "POST /api/v1/integrations/phorest/test": mutate(),
  "POST /api/v1/integrations/phorest/sync-shifts": mutate(),
  "DELETE /api/v1/integrations/phorest/mappings/:phorestStaffId": mutate({
    phorestStaffId: "phorestMapping",
  }),
  // Salon coupling (65b, arrived with origin/main after the recording; D-24). The fixture holds no
  // coupling — one would change what the config, test, staff and sync cells above resolve. So the
  // three cells run back to back: create a coupling of the second salon, list it (a GET placed in
  // the mutate phase on purpose, so its record carries the coupling rather than an empty list),
  // delete it again. Nothing between them reads couplings, and after the delete the tenant is as
  // before. No route here calls Phorest.
  "POST /api/v1/integrations/phorest/couplings": mutateWith(undefined, {
    salonId: "$tenant.salon",
    externalBranchId: "matrix-branch",
  }),
  "GET /api/v1/integrations/phorest/couplings": mutate(),
  "DELETE /api/v1/integrations/phorest/couplings/:salonId": mutate({ salonId: "salon" }),

  // leave requests
  "POST /api/v1/leave/requests": {
    phase: "mutate",
    // Handler check #6: a foreign `employeeId` needs MANAGER/ADMIN (else the 403 refusing
    // requests on behalf of others); without one the request is the caller's own, which an API
    // key does not have (the 400 for a missing employee profile). Three free, non-overlapping
    // periods.
    variants: [
      {
        name: "self",
        target: "none",
        body: { type: "VACATION", startDate: "2026-07-20", endDate: "2026-07-21" },
      },
      {
        name: "own",
        target: "own",
        body: {
          type: "VACATION",
          startDate: "2026-07-27",
          endDate: "2026-07-28",
          employeeId: "$own.employee",
        },
      },
      {
        name: "foreign",
        target: "foreign",
        body: {
          type: "VACATION",
          startDate: "2026-08-03",
          endDate: "2026-08-04",
          employeeId: "$foreign.employee",
        },
      },
    ],
    handlerCheck: true,
  },
  // Owner-only edit of a PENDING request (no manager path); before the review approves it.
  "PATCH /api/v1/leave/requests/:id": mutateWith(
    { id: "leaveRequest.pending" },
    { startDate: "2026-07-06", endDate: "2026-07-07" },
  ),
  "PATCH /api/v1/leave/requests/:id/review": {
    phase: "mutate",
    params: { id: "leaveRequest.pending" },
    // AC-75-17 lock cells: `own` is the actor's own PENDING request → the 403 self-approval
    // refusal (leave.ts); `cancellation` is a foreign CANCELLATION_REQUESTED request whose
    // cancellation the ACTOR requested → the 403 refusing a cancellation approval by its
    // requester (4-eyes). `foreign` is the regular approval.
    variants: [
      { name: "own", target: "own", body: { status: "APPROVED" } },
      { name: "foreign", target: "foreign", body: { status: "APPROVED" } },
      {
        name: "cancellation",
        target: "foreign",
        params: { id: "leaveRequest.cancellationByActor" },
        body: { status: "APPROVED" },
      },
    ],
  },
  "PATCH /api/v1/leave/requests/:id/correct": mutate({ id: "leaveRequest.approved" }),
  "PATCH /api/v1/leave/requests/:id/attest": mutate({ id: "leaveRequest.sick" }),
  "DELETE /api/v1/leave/requests/:id": {
    ...mutateWith({ id: "leaveRequest.withdrawable" }, { reason: "Matrix Storno" }),
    // Handler check #9: owner or MANAGER/ADMIN, after the tenant 404.
    handlerCheck: true,
  },

  // § 9 BUrlG: the upload needs AU_PENDING, so it runs first; reject → reopen → confirm then walks
  // the case through every state an allowed actor can reach
  "POST /api/v1/section9-documents/:creditId": {
    phase: "mutate",
    params: { creditId: "section9.credit" },
    // Handler check #14 (multipart): self or MANAGER/ADMIN, else 403 "Keine Berechtigung".
    variants: [
      {
        name: "own",
        target: "own",
        multipart: { filename: "au.pdf", contentType: "application/pdf", content: "pdf" },
      },
      {
        name: "foreign",
        target: "foreign",
        multipart: { filename: "au.pdf", contentType: "application/pdf", content: "pdf" },
      },
    ],
    handlerCheck: true,
  },
  "POST /api/v1/leave/section9/:id/reject": mutateWith(
    { id: "section9.credit" },
    { reason: "Matrix Ablehnung" },
  ),
  "POST /api/v1/leave/section9/:id/reopen": mutateWith(
    { id: "section9.credit" },
    { reason: "Matrix Wiedereröffnung" },
  ),
  "POST /api/v1/leave/section9/:id/confirm": mutateWith(
    { id: "section9.credit" },
    {
      attestSource: "EAU",
      attestValidFrom: "2026-05-13",
      attestValidTo: "2026-05-13",
      reason: "Matrix AU liegt vor",
    },
  ),

  // notifications (own inbox only)
  "PATCH /api/v1/notifications/:id/read": mutate({ id: "notification" }),
  "PATCH /api/v1/notifications/read-all": mutate(),
  "DELETE /api/v1/notifications/:id": mutate({ id: "notification" }),
  "DELETE /api/v1/notifications/dismiss-all": mutate(),

  // Arbeitszeitkonto
  "POST /api/v1/overtime/close-month": mutate(),
  "POST /api/v1/overtime/close-year": mutate(),
  "POST /api/v1/overtime/opening-balance": mutate(),
  "POST /api/v1/overtime/payout": mutate(),
  "POST /api/v1/overtime/plans": mutate(),
  "POST /api/v1/overtime/unlock-month": mutate(),
  "POST /api/v1/reports/carryover-warn": mutate(),

  // retro entry requests (Zeitnachtrag)
  "POST /api/v1/retro-entry-requests": {
    phase: "mutate",
    // Handler check #28: a non-manager's `employeeId` silently falls back to the own person (no
    // 403 — the ids show it); an API key has no own person (400).
    variants: [
      {
        name: "self",
        target: "none",
        body: {
          targetDate: "2026-06-09",
          reason: "Matrix Nachtrag",
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 30,
        },
      },
      {
        name: "foreign",
        target: "foreign",
        body: {
          employeeId: "$foreign.employee",
          targetDate: "2026-06-08",
          reason: "Matrix Nachtrag",
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 30,
        },
      },
    ],
    handlerCheck: true,
  },
  "PATCH /api/v1/retro-entry-requests/:id/review": {
    // Handler check #29, after the self-approval lock (AC-75-17): `own` → the 403 self-approval
    // refusal for every actor with an employee; `foreign` → the second, role-based 403 for an
    // EMPLOYEE (managers and admins only) — two different error strings, both recorded.
    ...mutateWith({ id: "retroRequest.pending" }, { status: "APPROVED" }),
    handlerCheck: true,
  },
  "DELETE /api/v1/retro-entry-requests/:id": mutate({ id: "retroRequest.pending" }),

  // roles and role assignments (74/74b)
  "POST /api/v1/roles": mutate(),
  "PATCH /api/v1/roles/:id": mutate({ id: "customRole.free" }),
  "POST /api/v1/roles/:id/copy": mutate({ id: "customRole.assigned" }),
  "POST /api/v1/role-assignments": mutate(),
  "PATCH /api/v1/role-assignments/:id": mutate({ id: "roleAssignment.customer" }),
  "DELETE /api/v1/role-assignments/:id": mutate({ id: "roleAssignment.customer" }),
  "DELETE /api/v1/roles/:id": mutate({ id: "customRole.free" }),

  // salons (64b)
  "POST /api/v1/salons": mutate(),
  "PATCH /api/v1/salons/:id": mutate({ id: "salon" }),
  "POST /api/v1/salons/:id/activate": mutate({ id: "salonInactive" }),
  "POST /api/v1/salons/:id/deactivate": mutate({ id: "salon" }),

  // tenant settings
  "POST /api/v1/settings/smtp/test": mutate(),
  "PUT /api/v1/settings/leave-types/:id": mutate({ id: "leaveType.VACATION" }),
  "PUT /api/v1/settings/security": mutate(),
  "PUT /api/v1/settings/smtp": mutate(),
  "PUT /api/v1/settings/vacation/:employeeId": mutate({ employeeId: "employee" }),
  "PUT /api/v1/settings/work": mutate(),
  "PUT /api/v1/settings/work/:employeeId": mutate({ employeeId: "employee" }),

  // shifts (Schichtplanung): updates first, then the shift's delete and its restore, then the
  // coverage rule before the template it references
  "POST /api/v1/shifts": mutate(),
  "POST /api/v1/shifts/bulk": mutate(),
  "POST /api/v1/shifts/copy-week": mutate(),
  "POST /api/v1/shifts/generate-week": mutate(),
  "POST /api/v1/shifts/coverage-rules": mutate(),
  "POST /api/v1/shifts/templates": mutate(),
  "PUT /api/v1/shifts/:id": mutate({ id: "shift" }),
  "PUT /api/v1/shifts/coverage-rules/:id": mutate({ id: "coverageRule" }),
  "PUT /api/v1/shifts/templates/:id": mutate({ id: "shiftTemplate" }),
  "DELETE /api/v1/shifts/:id": mutate({ id: "shift" }),
  "POST /api/v1/shifts/:id/restore": mutate({ id: "shift" }),
  "DELETE /api/v1/shifts/coverage-rules/:id": mutate({ id: "coverageRule" }),
  "DELETE /api/v1/shifts/templates/:id": mutate({ id: "shiftTemplate" }),

  // special leave rules (Sonderurlaub)
  "POST /api/v1/special-leave/rules": mutate(),
  "PUT /api/v1/special-leave/rules/:id": mutate({ id: "specialLeaveRule" }),
  "DELETE /api/v1/special-leave/rules/:id": mutate({ id: "specialLeaveRule" }),

  // NFC terminals
  "POST /api/v1/terminals": mutate(),
  "DELETE /api/v1/terminals/:id": mutate({ id: "terminal" }),

  // time entries (Zeiterfassung): clock-in first (the fixture's entries of today are still
  // open), the manual create, then everything on the closed entry, and its delete last
  "POST /api/v1/time-entries/clock-in": {
    phase: "mutate",
    // Handler check #30: clocking in someone else needs a non-EMPLOYEE role (403 "Forbidden").
    // Both persons are already clocked in today, so an allowed request ends in the 409.
    variants: [
      { name: "self", target: "none", body: {} },
      { name: "foreign", target: "foreign", body: { employeeId: "$foreign.employee" } },
    ],
    handlerCheck: true,
  },
  "POST /api/v1/time-entries": {
    phase: "mutate",
    // Handler check #33: a non-manager's `employeeId` is silently replaced by the own person, a
    // manager's is honoured. Two different days, both inside the retro window and free of
    // fixture entries, so the EMPLOYEE's foreign request succeeds for itself instead of colliding
    // with its self entry — the ids show whose entry was created. An API key has no own person.
    variants: [
      {
        name: "self",
        target: "none",
        body: {
          date: "2026-06-11",
          startTime: "2026-06-11T06:00:00.000Z",
          endTime: "2026-06-11T14:00:00.000Z",
          breakMinutes: 30,
        },
      },
      {
        name: "foreign",
        target: "foreign",
        body: {
          employeeId: "$foreign.employee",
          date: "2026-06-12",
          startTime: "2026-06-12T06:00:00.000Z",
          endTime: "2026-06-12T14:00:00.000Z",
          breakMinutes: 30,
        },
      },
    ],
    handlerCheck: true,
  },
  "POST /api/v1/time-entries/:id/breaks": {
    // Handler check #31: owner or MANAGER/ADMIN, else 403 "Kein Zugriff". A 15-minute break
    // inside the closed entry that does not touch the fixture break.
    ...mutateWith(
      { id: "timeEntry.closed" },
      { startTime: "2026-06-15T12:00:00.000Z", endTime: "2026-06-15T12:15:00.000Z" },
    ),
    handlerCheck: true,
  },
  "PUT /api/v1/time-entries/:id": {
    // Handler check #34 (+ correction semantics: a manager editing someone else's entry must give
    // a reason, which this body carries).
    ...mutateWith({ id: "timeEntry.closed" }, { note: "Matrix Notiz", reason: "Matrix Korrektur" }),
    handlerCheck: true,
  },
  "PATCH /api/v1/time-entries/:id/break-status": {
    // Handler check #36.
    ...mutateWith({ id: "timeEntry.closed" }, { action: "confirm" }),
    handlerCheck: true,
  },
  "PATCH /api/v1/time-entries/:id/revalidate": mutate({ id: "timeEntry.invalid" }),
  // No ownership check exists on this route today: any authenticated caller of the tenant,
  // an EMPLOYEE included, can clock out a colleague's open entry by its id (the `foreign` cells
  // answer 200). Pre-existing, no role decision involved, recorded as-is.
  "POST /api/v1/time-entries/:id/clock-out": mutateWith({ id: "timeEntry.open" }, {}),
  "DELETE /api/v1/time-entries/:id": {
    // Handler check #35.
    ...mutateWith({ id: "timeEntry.closed" }, { reason: "Matrix Löschung" }),
    handlerCheck: true,
  },

  // vocational school (Berufsschule)
  "POST /api/v1/vocational-school/generate": mutate(),
  "POST /api/v1/vocational-school/manual-insert": mutate(),
  "POST /api/v1/vocational-school/retroactive-apply": mutate(),
  "DELETE /api/v1/vocational-school/:absenceId": mutate({ absenceId: "vocationalSchool.absence" }),

  // own settings (self-service)
  "PUT /api/v1/me/availability": mutateWith(undefined, {
    entries: [{ dayOfWeek: 2, status: "PREFERRED", validFrom: "2026-07-01" }],
  }),
  "PUT /api/v1/me/preferences": mutateWith(undefined, { theme: "wald" }),
  "PUT /api/v1/me/release-notes-seen": mutateWith(undefined, { version: "1.11.1" }),

  // avatars: upload (sharp needs a real image) before the delete
  "POST /api/v1/avatars/:employeeId": {
    phase: "mutate",
    params: { employeeId: "employee" },
    // Handler check #18 (before the tenant 404): self or MANAGER/ADMIN, else 403 "Keine
    // Berechtigung".
    variants: [
      {
        name: "own",
        target: "own",
        multipart: { filename: "avatar.png", contentType: "image/png", content: "png" },
      },
      {
        name: "foreign",
        target: "foreign",
        multipart: { filename: "avatar.png", contentType: "image/png", content: "png" },
      },
    ],
    handlerCheck: true,
  },
  "DELETE /api/v1/avatars/:employeeId": {
    // Handler check #19.
    ...mutate({ employeeId: "employee" }),
    handlerCheck: true,
  },

  // ── self-destructive (run last within an actor, Pitfall 4) ───────────────────────────────────
  // Order: credential-revoking cells first (none exists under these bodies — the only credential
  // a cell could revoke is an API key, and `DELETE /api-keys/:id` targets the tenant's second
  // key), then deactivating the own person, then the hard-delete pair, then anonymizing the own
  // person last. The anchor admin keeps the 74b lockout guard from tripping for the ADMIN actors.
  "PATCH /api/v1/employees/:id/deactivate": selfDestructive({ id: "employee" }),
  "POST /api/v1/employees/:id/hard-delete/authorize": {
    ...selfDestructive({ id: "employee" }),
    // own/foreign are not anonymized (409); `hardDeleteTarget` is an anonymized former employee
    // outside the two-year floor, which an ADMIN may authorize.
    variants: [
      { name: "own", target: "own" },
      { name: "foreign", target: "foreign" },
      {
        name: "hardDeleteTarget",
        target: "tenant",
        params: { id: "hardDeleteTarget.employee" },
      },
    ],
  },
  "DELETE /api/v1/employees/:id/hard-delete": {
    ...selfDestructive({ id: "employee" }),
    // AC-75-17 lock cell `fourEyes`: a force-delete inside the retention window needs an
    // authorization by a DIFFERENT admin; the only authorizations of the target are the actor's
    // own (fixture + the cell above), so an ADMIN is refused with the 4-eyes message.
    variants: [
      { name: "own", target: "own" },
      { name: "foreign", target: "foreign" },
      {
        name: "fourEyes",
        target: "tenant",
        params: { id: "hardDeleteTarget.employee" },
        body: { forceDelete: true },
      },
    ],
  },
  "DELETE /api/v1/employees/:id": selfDestructive({ id: "employee" }),
};
