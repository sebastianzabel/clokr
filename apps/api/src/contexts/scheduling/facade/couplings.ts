/**
 * Phase 89 (#89, D-12a) — Schichtplanung's `SalonCoupling` facade.
 *
 * SalonCoupling is owned by Schichtplanung. This module is the one place other contexts read it
 * through: the tenant routes and the operator's composition port call the same functions. It takes
 * already-resolved identifiers from its callers, imports only the Unterbau index (the Shared
 * Kernel, for the package gate) and writes no audit entry — the caller audits (the operator writes
 * `OperatorAuditLog`, a tenant route `AuditLog`).
 *
 * Issue #566 (D-05): a NEW coupling is a new integration setup and needs the Integrationen module
 * (`createSalonCoupling`, and `setSalonCoupling` on its create branch). Replacing the branch of an
 * existing coupling or removing it maintains an existing setup and stays free (D-06).
 */
import type { Prisma } from "@clokr/db";
import { assertModuleBooked } from "../../platform";
import { uniqueViolationTarget } from "../../../utils/prisma-unique-violation.js";

/** All coupling rows of a tenant, ordered deterministically (`salonId`, then `id`). */
export async function listSalonCouplings(db: Prisma.TransactionClient, tenantId: string) {
  return db.salonCoupling.findMany({
    where: { tenantId },
    orderBy: [{ salonId: "asc" }, { id: "asc" }],
  });
}

// ── Writes (D-08, D-11, D-12, D-12a) ─────────────────────────────────────────────────────────

/** The already-resolved salon a caller couples. Callers resolve it with the Unterbau `findSalon`. */
export interface CouplingSalon {
  id: string;
  isActive: boolean;
}

/** A coupling row as the facade hands it back (what the caller audits). */
export interface CouplingRow {
  id: string;
  tenantId: string;
  salonId: string;
  provider: "PHOREST";
  externalBranchId: string;
}

/**
 * Thrown when an insert collides on a unique index after the pre-checks passed (a concurrent
 * writer won). It is thrown, never re-queried: inside an interactive transaction a failed insert
 * poisons the transaction, so the caller maps the typed error outside the transaction.
 *
 * `name` is set explicitly so a caller in another context (the operator route of the Unterbau)
 * can recognise it structurally without importing Schichtplanung.
 */
export class SalonCouplingConflictError extends Error {
  readonly code: "SALON_ALREADY_COUPLED" | "BRANCH_ALREADY_COUPLED";
  constructor(code: "SALON_ALREADY_COUPLED" | "BRANCH_ALREADY_COUPLED") {
    super(code);
    this.name = "SalonCouplingConflictError";
    this.code = code;
  }
}

export type CreateSalonCouplingResult =
  | { status: "SALON_INACTIVE" }
  | { status: "SALON_ALREADY_COUPLED" }
  | { status: "BRANCH_ALREADY_COUPLED" }
  | { status: "CREATED"; coupling: CouplingRow };

export type SetSalonCouplingResult =
  | { status: "SALON_INACTIVE" }
  | { status: "BRANCH_ALREADY_COUPLED" }
  | { status: "CREATED"; coupling: CouplingRow }
  | { status: "UNCHANGED"; coupling: CouplingRow }
  | { status: "REPLACED"; removed: CouplingRow; created: CouplingRow };

export type RemoveSalonCouplingResult =
  { status: "NOT_FOUND" } | { status: "REMOVED"; removed: CouplingRow };

/**
 * Classify a Prisma P2002 by the violated unique index; `null` when `err` is not a P2002.
 *
 * The index name comes from `uniqueViolationTarget` (`utils/prisma-unique-violation.ts`), which reads
 * structured metadata only. `err.message` is deliberately NOT searched: Prisma echoes the failed
 * invocation there, including the `externalBranchId` the caller passed, so a salon collision would
 * read as a branch collision.
 */
function conflictFromUniqueViolation(
  err: unknown,
): "SALON_ALREADY_COUPLED" | "BRANCH_ALREADY_COUPLED" | null {
  const target = uniqueViolationTarget(err);
  if (target === null) return null;
  // The branch index is (tenantId, provider, externalBranchId); the salon index is `salonId` alone.
  return target.includes("externalBranchId") ? "BRANCH_ALREADY_COUPLED" : "SALON_ALREADY_COUPLED";
}

/** Insert one PHOREST coupling; a unique-index collision becomes the typed conflict error. */
async function insertCoupling(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
  externalBranchId: string,
): Promise<CouplingRow> {
  try {
    return await db.salonCoupling.create({
      data: { tenantId, salonId, provider: "PHOREST", externalBranchId },
    });
  } catch (err: unknown) {
    const code = conflictFromUniqueViolation(err);
    if (code) throw new SalonCouplingConflictError(code);
    throw err;
  }
}

/** The coupling that already uses `externalBranchId` in this tenant, if any (provider is fixed). */
function findBranchCoupling(
  db: Prisma.TransactionClient,
  tenantId: string,
  externalBranchId: string,
) {
  return db.salonCoupling.findFirst({
    where: { tenantId, provider: "PHOREST", externalBranchId },
  });
}

/**
 * Couple a salon to a Phorest branch.
 *
 * Rules, in this order: an inactive salon cannot be coupled (`SALON_INACTIVE`); a salon has at
 * most one coupling (`SALON_ALREADY_COUPLED`); a branch id belongs to at most one salon of the
 * tenant (`BRANCH_ALREADY_COUPLED` — the same id in another tenant is fine). The provider is
 * always PHOREST and is never a parameter (D-11). A concurrent insert that still hits a unique
 * index throws `SalonCouplingConflictError`.
 */
export async function createSalonCoupling(
  db: Prisma.TransactionClient,
  tenantId: string,
  salon: CouplingSalon,
  externalBranchId: string,
): Promise<CreateSalonCouplingResult> {
  if (!salon.isActive) return { status: "SALON_INACTIVE" };
  const salonCoupled = await db.salonCoupling.findFirst({
    where: { salonId: salon.id, tenantId },
    select: { id: true },
  });
  if (salonCoupled) return { status: "SALON_ALREADY_COUPLED" };
  if (await findBranchCoupling(db, tenantId, externalBranchId)) {
    return { status: "BRANCH_ALREADY_COUPLED" };
  }
  // A new coupling is a new integration setup (D-05, Issue #566): the Unterbau decides, and the
  // salon/branch answers above keep precedence. Throws `ModuleNotBookedError` (409 in app.ts).
  await assertModuleBooked(db, tenantId, "INTEGRATIONS");
  const coupling = await insertCoupling(db, tenantId, salon.id, externalBranchId);
  return { status: "CREATED", coupling };
}

/**
 * Set a salon's coupling to a branch (the operator's single "set" action, D-12).
 *
 * No coupling yet creates one (needs the Integrationen module, D-05); the same branch id is `UNCHANGED` (no write); a different branch
 * id REPLACES: the old row is removed and a new one created in the caller's transaction, and
 * both rows are returned so the caller audits both (replace = remove + create — a coupling is
 * configuration and is never updated in place here). A branch id already used by another salon
 * of the tenant leaves the old row untouched (`BRANCH_ALREADY_COUPLED`).
 */
export async function setSalonCoupling(
  db: Prisma.TransactionClient,
  tenantId: string,
  salon: CouplingSalon,
  externalBranchId: string,
): Promise<SetSalonCouplingResult> {
  if (!salon.isActive) return { status: "SALON_INACTIVE" };
  const existing = await db.salonCoupling.findFirst({ where: { salonId: salon.id, tenantId } });
  if (!existing) {
    if (await findBranchCoupling(db, tenantId, externalBranchId)) {
      return { status: "BRANCH_ALREADY_COUPLED" };
    }
    // Create branch only (D-05, Issue #566): UNCHANGED and REPLACED maintain an existing setup and
    // stay free without the module (D-06).
    await assertModuleBooked(db, tenantId, "INTEGRATIONS");
    const coupling = await insertCoupling(db, tenantId, salon.id, externalBranchId);
    return { status: "CREATED", coupling };
  }
  if (existing.externalBranchId === externalBranchId) {
    return { status: "UNCHANGED", coupling: existing };
  }
  if (await findBranchCoupling(db, tenantId, externalBranchId)) {
    return { status: "BRANCH_ALREADY_COUPLED" };
  }
  await db.salonCoupling.delete({ where: { id: existing.id, tenantId } });
  const created = await insertCoupling(db, tenantId, salon.id, externalBranchId);
  return { status: "REPLACED", removed: existing, created };
}

/**
 * Remove a salon's coupling.
 *
 * This is the one documented hard delete of the phase (D-08): a coupling is configuration with no
 * time relation. Shifts, appointments and sync runs reference the SALON, not the coupling, so
 * nothing recorded is lost. `NOT_FOUND` covers an unknown salon id, a never-coupled salon and a
 * salon of another tenant alike (one null path, nothing distinguishable).
 */
export async function removeSalonCoupling(
  db: Prisma.TransactionClient,
  tenantId: string,
  salonId: string,
): Promise<RemoveSalonCouplingResult> {
  const existing = await db.salonCoupling.findFirst({ where: { salonId, tenantId } });
  if (!existing) return { status: "NOT_FOUND" };
  await db.salonCoupling.delete({ where: { id: existing.id, tenantId } });
  return { status: "REMOVED", removed: existing };
}
