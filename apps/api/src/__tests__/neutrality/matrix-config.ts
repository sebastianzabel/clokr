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
   * EMPLOYEE and ADMIN cells of `checkVariant` (default `foreign`) must differ — full records,
   * projections included — which proves the request reaches the ownership branch instead of
   * failing earlier (e.g. a 400 before the check). A string: the written reason why the two cells
   * may coincide.
   */
  handlerCheck?: true | string;
  /** The variant the discriminating check compares (default `foreign`). */
  checkVariant?: string;
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

const mutate = (params?: Record<string, string>): RouteSpec => ({ phase: "mutate", params });
const selfDestructive = (params: Record<string, string>): RouteSpec => ({
  phase: "self-destructive",
  params,
});

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
  "GET /api/v1/holidays": { phase: "read", variants: none(YEAR) },
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

  // ── mutate (cells built by plan 75b-03) ───────────────────────────────────────────────────────
  "DELETE /api/v1/admin/presence-sources/:id": mutate({ id: "presenceSource" }),
  "DELETE /api/v1/admin/presence-sources/:id/devices/:mac": mutate({
    id: "presenceSource",
    mac: "presenceDevice.mac",
  }),
  "DELETE /api/v1/api-keys/:id": mutate({ id: "apiKey.secondary" }),
  "DELETE /api/v1/avatars/:employeeId": mutate({ employeeId: "employee" }),
  "DELETE /api/v1/company-shutdowns/:id": mutate({ id: "companyShutdown" }),
  "DELETE /api/v1/company-shutdowns/:id/exceptions/:employeeId": mutate({
    id: "companyShutdown",
    employeeId: "employee",
  }),
  "DELETE /api/v1/employees/me/wifi/devices/:id": mutate({ id: "wifiDevice" }),
  "DELETE /api/v1/holidays/:id": mutate({ id: "holiday" }),
  "DELETE /api/v1/integrations/phorest/mappings/:phorestStaffId": mutate({
    phorestStaffId: "phorestMapping",
  }),
  "DELETE /api/v1/leave/requests/:id": mutate({ id: "leaveRequest.pending" }),
  "DELETE /api/v1/notifications/:id": mutate({ id: "notification" }),
  "DELETE /api/v1/notifications/dismiss-all": mutate(),
  "DELETE /api/v1/retro-entry-requests/:id": mutate({ id: "retroRequest.pending" }),
  "DELETE /api/v1/role-assignments/:id": mutate({ id: "roleAssignment.customer" }),
  "DELETE /api/v1/roles/:id": mutate({ id: "customRole.free" }),
  "DELETE /api/v1/shifts/:id": mutate({ id: "shift" }),
  "DELETE /api/v1/shifts/coverage-rules/:id": mutate({ id: "coverageRule" }),
  "DELETE /api/v1/shifts/templates/:id": mutate({ id: "shiftTemplate" }),
  "DELETE /api/v1/special-leave/rules/:id": mutate({ id: "specialLeaveRule" }),
  "DELETE /api/v1/terminals/:id": mutate({ id: "terminal" }),
  "DELETE /api/v1/time-entries/:id": mutate({ id: "timeEntry.closed" }),
  "DELETE /api/v1/vocational-school/:absenceId": mutate({ absenceId: "vocationalSchool.absence" }),
  "PATCH /api/v1/admin/presence-sources/:id": mutate({ id: "presenceSource" }),
  "PATCH /api/v1/company-shutdowns/:id": mutate({ id: "companyShutdown" }),
  "PATCH /api/v1/employees/:id": mutate({ id: "employee" }),
  "PATCH /api/v1/employees/:id/reactivate": mutate({ id: "employee" }),
  "PATCH /api/v1/employees/:id/unlock": mutate({ id: "employee" }),
  "PATCH /api/v1/employees/me/wifi": mutate(),
  "PATCH /api/v1/leave/requests/:id": mutate({ id: "leaveRequest.pending" }),
  "PATCH /api/v1/leave/requests/:id/attest": mutate({ id: "leaveRequest.sick" }),
  "PATCH /api/v1/leave/requests/:id/correct": mutate({ id: "leaveRequest.approved" }),
  "PATCH /api/v1/leave/requests/:id/review": mutate({ id: "leaveRequest.pending" }),
  "PATCH /api/v1/notifications/:id/read": mutate({ id: "notification" }),
  "PATCH /api/v1/notifications/read-all": mutate(),
  "PATCH /api/v1/retro-entry-requests/:id/review": mutate({ id: "retroRequest.pending" }),
  "PATCH /api/v1/role-assignments/:id": mutate({ id: "roleAssignment.customer" }),
  "PATCH /api/v1/roles/:id": mutate({ id: "customRole.free" }),
  "PATCH /api/v1/salons/:id": mutate({ id: "salon" }),
  "PATCH /api/v1/time-entries/:id/break-status": mutate({ id: "timeEntry.closed" }),
  "PATCH /api/v1/time-entries/:id/revalidate": mutate({ id: "timeEntry.invalid" }),
  "POST /api/v1/admin/presence-sources": mutate(),
  "POST /api/v1/admin/presence-sources/:id/devices/:mac/assign": mutate({
    id: "presenceSource",
    mac: "presenceDevice.mac",
  }),
  "POST /api/v1/admin/school-holidays/refresh": mutate(),
  "POST /api/v1/api-keys": mutate(),
  "POST /api/v1/avatars/:employeeId": mutate({ employeeId: "employee" }),
  "POST /api/v1/company-shutdowns": mutate(),
  "POST /api/v1/company-shutdowns/:id/exceptions": mutate({ id: "companyShutdown" }),
  "POST /api/v1/employees": mutate(),
  "POST /api/v1/employees/:id/hard-delete/authorize": mutate({ id: "employee" }),
  "POST /api/v1/employees/:id/resend-invitation": mutate({ id: "employee" }),
  "POST /api/v1/employees/:id/salon-assignments": mutate({ id: "employee" }),
  "POST /api/v1/employees/:id/salon-assignments/:assignmentId/end": mutate({
    id: "employee",
    assignmentId: "salonAssignment",
  }),
  "POST /api/v1/employees/:id/salon-assignments/home": mutate({ id: "employee" }),
  "POST /api/v1/employees/me/wifi/devices": mutate(),
  "POST /api/v1/holidays": mutate(),
  "POST /api/v1/imports/employees": mutate(),
  "POST /api/v1/imports/time-entries": mutate(),
  "POST /api/v1/integrations/phorest/mappings": mutate(),
  "POST /api/v1/integrations/phorest/sync-shifts": mutate(),
  "POST /api/v1/integrations/phorest/test": mutate(),
  "POST /api/v1/leave/requests": mutate(),
  "POST /api/v1/leave/section9/:id/confirm": mutate({ id: "section9.credit" }),
  "POST /api/v1/leave/section9/:id/reject": mutate({ id: "section9.credit" }),
  "POST /api/v1/leave/section9/:id/reopen": mutate({ id: "section9.credit" }),
  "POST /api/v1/overtime/close-month": mutate(),
  "POST /api/v1/overtime/close-year": mutate(),
  "POST /api/v1/overtime/opening-balance": mutate(),
  "POST /api/v1/overtime/payout": mutate(),
  "POST /api/v1/overtime/plans": mutate(),
  "POST /api/v1/overtime/unlock-month": mutate(),
  "POST /api/v1/reports/carryover-warn": mutate(),
  "POST /api/v1/retro-entry-requests": mutate(),
  "POST /api/v1/role-assignments": mutate(),
  "POST /api/v1/roles": mutate(),
  "POST /api/v1/roles/:id/copy": mutate({ id: "customRole.assigned" }),
  "POST /api/v1/salons": mutate(),
  "POST /api/v1/salons/:id/activate": mutate({ id: "salonInactive" }),
  "POST /api/v1/salons/:id/deactivate": mutate({ id: "salon" }),
  "POST /api/v1/section9-documents/:creditId": mutate({ creditId: "section9.credit" }),
  "POST /api/v1/settings/smtp/test": mutate(),
  "POST /api/v1/shifts": mutate(),
  "POST /api/v1/shifts/:id/restore": mutate({ id: "shift" }),
  "POST /api/v1/shifts/bulk": mutate(),
  "POST /api/v1/shifts/copy-week": mutate(),
  "POST /api/v1/shifts/coverage-rules": mutate(),
  "POST /api/v1/shifts/generate-week": mutate(),
  "POST /api/v1/shifts/templates": mutate(),
  "POST /api/v1/special-leave/rules": mutate(),
  "POST /api/v1/terminals": mutate(),
  "POST /api/v1/time-entries": {
    phase: "mutate",
    // Handler check #33: a non-manager's `employeeId` is silently replaced by the own person,
    // a manager's is honoured. Two different days, both inside the retro window and free of
    // fixture entries, so the EMPLOYEE's foreign request can succeed for itself instead of
    // colliding with its own-variant entry — the ids show whose entry was created.
    variants: [
      {
        name: "own",
        target: "own",
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
  "POST /api/v1/time-entries/:id/breaks": mutate({ id: "timeEntry.closed" }),
  "POST /api/v1/time-entries/:id/clock-out": mutate({ id: "timeEntry.open" }),
  "POST /api/v1/time-entries/clock-in": mutate(),
  "POST /api/v1/vocational-school/generate": mutate(),
  "POST /api/v1/vocational-school/manual-insert": mutate(),
  "POST /api/v1/vocational-school/retroactive-apply": mutate(),
  "PUT /api/v1/employees/:id/availability": mutate({ id: "employee" }),
  "PUT /api/v1/employees/:id/shift-patterns": mutate({ id: "employee" }),
  "PUT /api/v1/employees/:id/vocational-school-pattern": mutate({ id: "employee" }),
  "PUT /api/v1/integrations/phorest/config": mutate(),
  "PUT /api/v1/me/availability": mutate(),
  "PUT /api/v1/me/preferences": mutate(),
  "PUT /api/v1/me/release-notes-seen": mutate(),
  "PUT /api/v1/settings/leave-types/:id": mutate({ id: "leaveType.VACATION" }),
  "PUT /api/v1/settings/security": mutate(),
  "PUT /api/v1/settings/smtp": mutate(),
  "PUT /api/v1/settings/vacation/:employeeId": mutate({ employeeId: "employee" }),
  "PUT /api/v1/settings/work": mutate(),
  "PUT /api/v1/settings/work/:employeeId": mutate({ employeeId: "employee" }),
  "PUT /api/v1/shifts/:id": mutate({ id: "shift" }),
  "PUT /api/v1/shifts/coverage-rules/:id": mutate({ id: "coverageRule" }),
  "PUT /api/v1/shifts/templates/:id": mutate({ id: "shiftTemplate" }),
  "PUT /api/v1/special-leave/rules/:id": mutate({ id: "specialLeaveRule" }),
  "PUT /api/v1/time-entries/:id": mutate({ id: "timeEntry.closed" }),

  // ── self-destructive (run last within an actor, Pitfall 4) ───────────────────────────────────
  "DELETE /api/v1/employees/:id": selfDestructive({ id: "employee" }),
  "DELETE /api/v1/employees/:id/hard-delete": selfDestructive({ id: "employee" }),
  "PATCH /api/v1/employees/:id/deactivate": selfDestructive({ id: "employee" }),
};
