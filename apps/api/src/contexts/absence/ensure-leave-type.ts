/**
 * Issue #614 — `ensureLeaveType` moved out of `api/leave.ts` verbatim so the correction core
 * (`leave-correction.ts`) and the route share the one find-or-create without an import cycle
 * between them. Phase 97 (T2, AC-1) provenance and the Issue #206 notes stay with the function.
 *
 * `RequestableCode`, not `LeaveTypeCode` (Phase 98b, D-01): `ensureLeaveType()` resolves a
 * `LeaveType` row, and a `LeaveType` row never exists for an imposed absence — every one of its
 * call sites only ever passes a requestable code.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import type { FastifyInstance } from "fastify";
import { leaveTypeFields, type RequestableCode } from "./leave-type";

type TypeCode = RequestableCode;

/**
 * Resolves the LeaveType row for `tenantId` / `code`, creating it when absent. Returns its id.
 *
 * Phase 97 (T2, AC-1): the CODE is the identity. `name` is display text a tenant may rename
 * freely (AC-2), so this function never rewrites the name of a row that already has a code.
 *
 * Two steps: an identity lookup by `{ tenantId, code }`, then a P2002-guarded create for the
 * first request of a given code. Issue #206 made `LeaveType.code` NOT NULL in the database, so
 * a row with no code can no longer exist; the self-heal step that used to repair one (a one-time
 * migration path for rows written before the phase-97 backfill, or by the OLD image during a
 * rolling-deploy window, D-21) is gone — its target row is unreachable by construction, not
 * merely unused, and the six preconditions measured against int/prod on 2026-09-23 (recorded on
 * issue #206) confirm no such row survived to this point.
 *
 * Auditing: unchanged from the pre-phase-97 implementation — this find-or-create writes no
 * AuditLog row and did not before either. Not a regression introduced here; tracked as the
 * pre-existing gap it is.
 *
 * Review WR-01 (phase 97): step 2's create is P2002-guarded — step 1 above is a
 * check-then-create race, so two concurrent first-time requests for the same code can both
 * reach the create. The loser re-reads by `{ tenantId, code }` and resolves to the winner's
 * row instead of surfacing a bare 500. If that re-read comes up empty, the P2002 did not come
 * from `@@unique([tenantId, code])` (the model also carries `@@unique([tenantId, name])`) and
 * is rethrown unchanged rather than guessed at.
 */
export async function ensureLeaveType(
  prisma: FastifyInstance["prisma"],
  log: FastifyInstance["log"],
  tenantId: string,
  code: TypeCode,
): Promise<string> {
  // 1. Identity path.
  const byCode = await prisma.leaveType.findFirst({ where: { tenantId, code } });
  if (byCode) return byCode.id;

  // 2. Create. leaveTypeFields() makes code and name structurally inseparable.
  //
  // Review WR-01 (phase 97): step 1 above is a check-then-create race. Two concurrent
  // first-time requests for the same (tenantId, code) both pass them and both arrive here;
  // @@unique([tenantId, code]) lets exactly one win and raises P2002 on the loser, which
  // used to surface as a bare HTTP 500 for an operation that had in fact succeeded. Same
  // race class, same shape as the Section9Credit create below ("§ 9: concurrent detection
  // lost the race"). Not a phase-97 regression — the name-keyed version had the same gap.
  try {
    const created = await prisma.leaveType.create({ data: { tenantId, ...leaveTypeFields(code) } });
    return created.id;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "P2002"
    ) {
      // The winner committed between our step-1 read and this create — re-read and use it.
      const winner = await prisma.leaveType.findFirst({ where: { tenantId, code } });
      if (winner) {
        log.info(
          { tenantId, code },
          "LeaveType: concurrent create lost the race, row already exists",
        );
        return winner.id;
      }
      // No row for this code, so the P2002 did NOT come from @@unique([tenantId, code]) —
      // LeaveType also carries @@unique([tenantId, name]), which a tenant-renamed row can
      // violate. There is no id to return here, and returning any other type's id would
      // book the request onto the WRONG absence type. Fall through and rethrow unchanged.
    }
    throw err;
  }
}
