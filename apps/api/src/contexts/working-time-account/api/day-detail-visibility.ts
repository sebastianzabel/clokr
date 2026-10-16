// Issue #86 (Phase 86b, D-02, DSGVO Art. 5 Abs. 1 lit. c) - which persons' DAY LISTS a caller of an
// Arbeitszeitkonto read route may see.
//
// Why this module exists: `overtime:read` and `month-close:read` are account-level grants. They let
// the Personalabteilung read a saldo, a carry-over or the state of a month close for every person
// of the tenant - and that is the point of the role. The same responses, however, also carry
// per-day structures (the cumulative day series of `GET /overtime/month-saldo`, the missing-day
// and break-finding day lists of the month-close reads, the gap dates of the deferred close). A day
// list is attendance data: which day a person worked or did not. It belongs to the readers of the
// time entries (`time-entry:read`), not to every reader of the account. So the saldo header stays
// readable under the account grants, and only the per-day structure requires time-entry reach.
//
// Redaction instead of a 403: the figures (saldo, counts, status) are still the caller's business;
// a refusal would take the whole month-close page away from the Personalabteilung for no gain. The
// route empties the day arrays of a person this module does not cover and says so with
// `dayDetailsWithheld: true`; counts are computed BEFORE the redaction and stay.
//
// The rule mirrors who could read that person's time entries: the caller's own employee for a
// holder of `time-entry:read:EIGENE`; anyone else only for a holder of `time-entry:read:ZUGEWIESEN`
// whose reach covers the person (whole tenant, or the person's Stammsalon / listed person at the
// route's Stichtag - the same scope helpers the account routes' own gates use). The person-level
// Stammsalon test is deliberately the conservative one: a salon manager who could see a single
// entry of a Springer in the manager's salon does not thereby see the person's whole day series,
// which also lists days worked elsewhere.
//
// This is the sibling of `warningsVisibleToCaller()` (#85). It is the ONE place in the context that
// decides this; a new day-level field in an Arbeitszeitkonto response goes through it, never
// through a second inline check. The decision is memoised per request object, so a route that
// asks for many persons resolves the caller's reach once.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  accessContextFromRequest,
  hasPermission,
  isStammsalonScopeMatch,
  resolveAccessReach,
  resolveStammsalonScopedEmployeeIds,
  type AccessReach,
} from "../../platform";

/** The decision handle of one request. */
export interface DayDetailVisibility {
  /** True when the caller may see `employeeId`'s day lists (Stichtag: the day the route reads). */
  coversEmployee(employeeId: string, stichtag: Date): Promise<boolean>;
  /** The subset of `employeeIds` whose day lists the caller may see (Stichtag as above). */
  coveredAmong(employeeIds: readonly string[], stichtag: Date): Promise<ReadonlySet<string>>;
}

interface CallerGrants {
  readonly own: boolean;
  readonly assigned: boolean;
}

const memo = new WeakMap<FastifyRequest, DayDetailVisibility>();

/**
 * The visibility decision of `req`. Cheap to call repeatedly: the grants and the reach are
 * resolved lazily, once per request object.
 */
export function dayDetailVisibility(
  app: FastifyInstance,
  req: FastifyRequest,
): DayDetailVisibility {
  const cached = memo.get(req);
  if (cached) return cached;

  let grantsPromise: Promise<CallerGrants> | null = null;
  const grants = (): Promise<CallerGrants> => {
    grantsPromise ??= (async () => ({
      own: await hasPermission(req, "time-entry:read:EIGENE"),
      assigned: await hasPermission(req, "time-entry:read:ZUGEWIESEN"),
    }))();
    return grantsPromise;
  };

  let reachPromise: Promise<AccessReach> | null = null;
  const reach = (): Promise<AccessReach> => {
    reachPromise ??= resolveAccessReach(
      app.prisma,
      accessContextFromRequest(req),
      "time-entry:read:ZUGEWIESEN",
    );
    return reachPromise;
  };

  const isOwn = (employeeId: string) =>
    req.user.employeeId !== undefined &&
    req.user.employeeId !== null &&
    req.user.employeeId === employeeId;

  const decision: DayDetailVisibility = {
    async coversEmployee(employeeId, stichtag) {
      const { own, assigned } = await grants();
      if (own && isOwn(employeeId)) return true;
      if (!assigned) return false;
      const resolved = await reach();
      if (resolved.kind === "wholeTenant") return true;
      return isStammsalonScopeMatch(app.prisma, req.user.tenantId, resolved, employeeId, stichtag);
    },

    async coveredAmong(employeeIds, stichtag) {
      const covered = new Set<string>();
      const { own, assigned } = await grants();
      if (own) {
        for (const id of employeeIds) if (isOwn(id)) covered.add(id);
      }
      if (!assigned) return covered;
      const resolved = await reach();
      if (resolved.kind === "wholeTenant") {
        for (const id of employeeIds) covered.add(id);
        return covered;
      }
      const scoped = await resolveStammsalonScopedEmployeeIds(
        app.prisma,
        req.user.tenantId,
        resolved,
        stichtag,
      );
      if (scoped === "all") {
        for (const id of employeeIds) covered.add(id);
      } else {
        const scopedSet = new Set(scoped);
        for (const id of employeeIds) if (scopedSet.has(id)) covered.add(id);
      }
      return covered;
    },
  };

  memo.set(req, decision);
  return decision;
}
