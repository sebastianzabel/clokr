/**
 * Phase 100B Plan 09 (Wave 4, closing) — Zeiterfassung's `PresenceDevice` facade.
 *
 * ADR 0001 rule 3: no direct table access across foreign schemas; every caller outside this
 * context reaches `PresenceDevice` through one of the functions below, never through
 * `prisma.presenceDevice`/`tx.presenceDevice` directly. `PresenceDevice` is added to
 * `convertedModels` in `apps/api/scripts/foreign-context-access-exceptions.json` in the same
 * commit, so a future direct access is a hard error, not a slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the SAME function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * This is the smallest conversion unit in the whole phase — five accesses, one file
 * (at the time, `contexts/platform/api/employees.ts`), because the ENTIRE `/api/v1/employees/me/wifi`
 * PresenceDevice CRUD lived inside an Unterbau route file (a misplaced route group, filed as a
 * GitHub issue per D-13 rather than moved here — see this plan's own SUMMARY). Phase 243 Plan 02
 * (B2) later moved that route group to `contexts/time-tracking/api/employee-wifi.ts`, resolving
 * the misplacement this note originally just recorded; the URL is unchanged. Five call sites
 * become five facade functions, not because the domain has five questions.
 *
 * ── The `getPresenceDevice`/`deletePresenceDevice` pair — the one behaviour-relevant decision in
 *    this file ──────────────────────────────────────────────────────────────────────────────────
 * Today (pre-facade) both are `where: { id }` reads/writes, `fetch-then-compare`-scoped: the DELETE
 * route fetches by bare `id`, then compares `device.employeeId !== employeeId` in the ROUTE to
 * decide 403 (wrong owner) vs proceeding. Moving JUST the fetch behind a facade while leaving the
 * compare in the route would let that proof evaporate silently — `findScopingComparison` cannot
 * see a compare in one file gating a fetch in another, so the gate would either stop recognising
 * this candidate at all (if not both are moved) or flag it UNSCOPED, and #100B-09-PLAN's own Task
 * 2 verification pins the ONLY acceptable resolved verdict as `inline-principal-field` for both —
 * not `fetch-then-compare` reproduced across the call. So `employeeId` moves INTO the `where` for
 * BOTH functions (`{ id, employeeId }`, an "extended where-unique" filter Prisma has supported
 * since well before this schema's generator version — verified against the generated
 * `PresenceDeviceWhereUniqueInput` type, `AtLeast<{...}, "id" | "tenantId_mac">`, which is exactly
 * what allows an ADDITIONAL non-unique field alongside the unique key).
 *
 * **Consequence, stated rather than made silently:** a query-level `{ id, employeeId }` filter
 * cannot distinguish "no such device" from "exists, but belongs to someone else" any more than a
 * scoped `delete` can — both collapse to the SAME outcome (`null` / a thrown not-found). The
 * DELETE route's previous separate 403 "Forbidden" branch for the wrong-owner case is therefore
 * UNREACHABLE after this change: a caller attempting to delete another employee's device now gets
 * the SAME 404 "Gerät nicht gefunden" a caller deleting a nonexistent id already got — which is
 * also the SAFER of the two prior responses (it stops confirming a foreign id's existence to a
 * caller who does not own it). `apps/api/src/__tests__/me-wifi.test.ts`'s
 * "employee cannot delete another employee's device" case is updated to assert 404, not 403 — see
 * this plan's own SUMMARY for the full reasoning and the German decision comment on issue #100.
 */
import type { Prisma } from "@clokr/db";

/** GET /me/wifi's device list — every device registered to `employeeId`, additionally
 * constrained to `tenantId` (a proven no-op given the caller's own upstream
 * `employee.findUnique({ where: { id: employeeId, tenantId } })` check, but a real,
 * defence-in-depth constraint in the query itself rather than assumed from the caller). */
export async function listPresenceDevices(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
) {
  return db.presenceDevice.findMany({
    where: { employeeId, tenantId },
    select: { id: true, mac: true, label: true, addedAt: true },
    orderBy: { addedAt: "asc" },
  });
}

/** POST /me/wifi/devices' duplicate-MAC guard. The uniqueness this checks is `@@unique([tenantId,
 * mac])` — per-TENANT, not per-employee (one MAC maps to exactly one employee in a tenant) — so
 * the real query has never taken an `employeeId` at all; it is deliberately not a parameter here
 * (the plan's own shorthand signature listed one, but the call site's actual `where` never has —
 * see this plan's SUMMARY for the correction). */
export async function findPresenceDeviceByMac(
  db: Prisma.TransactionClient,
  mac: string,
  tenantId: string,
) {
  return db.presenceDevice.findUnique({
    where: { tenantId_mac: { tenantId, mac } },
  });
}

export type CreatePresenceDeviceData = {
  tenantId: string;
  employeeId: string;
  mac: string;
  label?: string;
};

/** POST /me/wifi/devices' insert, after the duplicate-MAC guard above has passed. */
export async function createPresenceDevice(
  db: Prisma.TransactionClient,
  data: CreatePresenceDeviceData,
) {
  return db.presenceDevice.create({
    data,
    select: { id: true, mac: true, label: true, addedAt: true },
  });
}

/** DELETE /me/wifi/devices/:id's existence+ownership check — see the module header for why this
 * is constrained on `employeeId` IN THE QUERY (not a route-level compare afterward), and for the
 * resulting 403->404 collapse for the wrong-owner case. */
export async function getPresenceDevice(
  db: Prisma.TransactionClient,
  id: string,
  employeeId: string,
) {
  return db.presenceDevice.findUnique({
    where: { id, employeeId },
  });
}

/** DELETE /me/wifi/devices/:id's actual delete — reached only after {@link getPresenceDevice} has
 * already confirmed the row exists and belongs to `employeeId`; scoped identically so the delete
 * itself carries its own proof rather than relying solely on the preceding read. */
export async function deletePresenceDevice(
  db: Prisma.TransactionClient,
  id: string,
  employeeId: string,
) {
  return db.presenceDevice.delete({
    where: { id, employeeId },
  });
}
