/**
 * Phase 77b (Issue #77) — the central, fail-closed access context: which tenant a piece of work
 * runs in, who performs it, and how far it reaches.
 *
 * ADR 0001 states that permissions are resolved once, centrally ("Berechtigungen werden einmal
 * zentral gelöst", `docs/adr/0001-drei-kontexte.md:51-52`). This module is the place that frame is
 * built. It is pure: no Prisma call, no database handle anywhere in a signature, so "the tenant is
 * checked before any DB query" holds by construction, not by call order.
 *
 * Exactly two constructors exist, and both throw {@link AccessContextError} on an `undefined`,
 * `null`, empty or whitespace-only tenant:
 * - {@link accessContextFromRequest} — for an authenticated route handler (reads `req.user`,
 *   which `requireAuth` has already verified; it does not re-verify the JWT).
 * - {@link accessContextForJob} — for background work that names its tenant explicitly.
 *
 * Route files build every `EmployeeScope` through {@link employeeScopeFor} only — never as an
 * object literal. That is the single hook where Issue #91 will narrow a scope to salons or
 * persons. The reach discriminator is deliberately `"wholeTenant"`, not `"tenant"`, so a reach
 * literal can never be mistaken for an `EmployeeScope` literal (`kind: "tenant"`) by the route-file
 * literal check.
 *
 * A missing context is a programming error, not a tenant-membership question: `app.ts` maps the
 * error to HTTP 500 `{ error: "Interner Serverfehler" }` with a logged route. A foreign id keeps
 * answering 404 exactly as before (T-100-09) — nothing here changes a rejection.
 */
import type { FastifyRequest } from "fastify";
import type { EmployeeScope } from "./facade/employee-scope";
import { AccessContextError, requireTenantId } from "./access-context-error";

export { AccessContextError };

/** Who performs the work. `apiKey` is derived from the `apikey:<id>` subject `requireAuth` sets. */
export type AccessActor =
  | { kind: "user"; userId: string; employeeId?: string }
  | { kind: "apiKey"; apiKeyId: string }
  | { kind: "system"; job: string };

/**
 * How far the work reaches inside its tenant. `wholeTenant` is the only variant today; Issue #91
 * adds the narrower ones here — no speculative variants before that (CLAUDE.md "No generalization
 * on spec").
 */
export type AccessReach = { kind: "wholeTenant" };

export interface AccessContext {
  readonly tenantId: string;
  readonly actor: AccessActor;
  readonly reach: AccessReach;
}

/**
 * The `apikey:<id>` subject prefix `requireAuth` sets on `req.user.sub` for an API-key caller.
 * Exported so `plugins/audit.ts` (Issue #333) can recognise the same prefix without duplicating
 * the literal — that plugin is the single place a raw `req.user.sub` is ever written toward
 * `AuditLog.userId`, so it must know exactly what this module considers an API-key subject.
 */
export const API_KEY_SUBJECT_PREFIX = "apikey:";

/**
 * Build the access context of an authenticated request. Throws {@link AccessContextError} when
 * `req.user` is missing or carries no usable tenant — `req.user` is typed as always present, but a
 * handler reached without `requireAuth` has none at runtime, hence the defensive read.
 */
export function accessContextFromRequest(req: FastifyRequest): AccessContext {
  const user = (req as { user?: Partial<FastifyRequest["user"]> | null }).user;
  if (!user) {
    throw new AccessContextError("accessContextFromRequest: request carries no authenticated user");
  }
  const tenantId = requireTenantId(user.tenantId, "accessContextFromRequest");
  const sub = typeof user.sub === "string" ? user.sub : "";

  let actor: AccessActor;
  if (sub.startsWith(API_KEY_SUBJECT_PREFIX)) {
    actor = { kind: "apiKey", apiKeyId: sub.slice(API_KEY_SUBJECT_PREFIX.length) };
  } else if (typeof user.employeeId === "string" && user.employeeId !== "") {
    actor = { kind: "user", userId: sub, employeeId: user.employeeId };
  } else {
    actor = { kind: "user", userId: sub };
  }

  return { tenantId, actor, reach: { kind: "wholeTenant" } };
}

/** Build the access context of background work (cron job, script) that names its tenant explicitly. */
export function accessContextForJob(
  tenantId: string | null | undefined,
  job: string,
): AccessContext {
  return {
    tenantId: requireTenantId(tenantId, "accessContextForJob"),
    actor: { kind: "system", job },
    reach: { kind: "wholeTenant" },
  };
}

/**
 * The ONE function that turns an access context into an {@link EmployeeScope}.
 *
 * No target → the whole tenant; `{ employeeId }` → that employee; `{ employeeIds }` → those
 * employees — each carrying the context's tenant. The tenant is re-asserted here (defence in depth
 * against a hand-built context object). The switch over `reach.kind` is exhaustive: adding a reach
 * variant (Issue #91) fails compilation here until it is evaluated.
 */
export function employeeScopeFor(
  ctx: AccessContext,
  target?: { employeeId: string } | { employeeIds: string[] },
): EmployeeScope {
  const tenantId = requireTenantId(ctx?.tenantId, "employeeScopeFor");
  const reachKind = ctx.reach.kind;
  switch (reachKind) {
    case "wholeTenant": {
      if (!target) return { kind: "tenant", tenantId };
      if ("employeeIds" in target) {
        return { kind: "employees", employeeIds: target.employeeIds, tenantId };
      }
      return { kind: "employee", employeeId: target.employeeId, tenantId };
    }
    default: {
      const unhandled: never = reachKind;
      throw new AccessContextError(`employeeScopeFor: unhandled reach ${String(unhandled)}`);
    }
  }
}
