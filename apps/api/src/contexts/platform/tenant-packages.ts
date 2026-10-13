/**
 * Phase 566 (#566) — booked packages per tenant, Unterbau.
 *
 * This is the ONE place that decides whether a package is booked and what the salon limit of a
 * tenant is. The two stored facts live on `Tenant`: `bookedModules` (which add-on modules are
 * booked) and `salonQuota` (how many active salons the Ketten-Paket allows). No other production
 * file reads those columns; every other context asks this module through
 * `contexts/platform/index.ts`.
 *
 * Rules (CONTEXT D-01 … D-11):
 * - The Grundversion (no module booked, one salon) is never gated; the bookable modules only
 *   widen it.
 * - The effective salon limit is `salonQuota` when CHAIN is booked, else 1 (D-02). A quota above 1
 *   without CHAIN therefore has no effect.
 * - NEVER retroactive (D-06): nothing in this module deactivates, revokes or rewrites existing
 *   data. A package that is not booked refuses a NEW creation or activation only.
 * - `isMultiSalonTenant()` / `showSalonOptions()` never read packages: whether the salon choice
 *   is shown depends on the number of active salons, not on what is booked.
 * - Written only by the operator through {@link changeTenantPackages} (and by the e2e test
 *   bootstrap); this module has no tenant-facing write.
 * - Legal-core paths (saldo, Monatsabschluss, ArbZG, retention, DATEV) must not import this
 *   module — packages gate convenience features, never a legal duty.
 *
 * Every function takes `db: Prisma.TransactionClient` first and a REQUIRED `tenantId`.
 */
import { TenantModule, type Prisma } from "@clokr/db";

/** The four bookable add-on modules in canonical (declaration) order. */
export const TENANT_MODULES: readonly TenantModule[] = [
  TenantModule.CHAIN,
  TenantModule.INTEGRATIONS,
  TenantModule.HARDWARE_CLOCK,
  TenantModule.ANALYTICS,
];

export interface TenantPackages {
  bookedModules: TenantModule[];
  salonQuota: number;
}

/** What every tenant has without booking anything: no module, one salon. */
export const GRUNDVERSION: Readonly<TenantPackages> = Object.freeze({
  bookedModules: Object.freeze([] as TenantModule[]) as TenantModule[],
  salonQuota: 1,
});

/** German product names of the modules, shown to tenant users and the operator. */
export const TENANT_MODULE_LABEL_DE: Record<TenantModule, string> = {
  CHAIN: "Ketten-Paket",
  INTEGRATIONS: "Integrationen",
  HARDWARE_CLOCK: "Hardware-Stempeln",
  ANALYTICS: "Auswertungen",
};

/** The only column projection of the package columns; callers select through this constant. */
export const TENANT_PACKAGES_SELECT = {
  bookedModules: true,
  salonQuota: true,
} satisfies Prisma.TenantSelect;

/**
 * Turns a stored row into the canonical shape: a NULL array (the column is nullable because
 * Prisma cannot express NOT NULL for a list) reads as empty, duplicates are removed, and the
 * modules come in canonical order.
 */
export function normalizeStoredPackages(row: {
  bookedModules: readonly TenantModule[] | null;
  salonQuota: number;
}): TenantPackages {
  const stored = new Set(row.bookedModules ?? []);
  return {
    bookedModules: TENANT_MODULES.filter((module) => stored.has(module)),
    salonQuota: row.salonQuota,
  };
}

/** D-02: the effective salon limit — `salonQuota` with the Ketten-Paket, else 1. */
export function salonLimit(p: {
  bookedModules: readonly TenantModule[];
  salonQuota: number;
}): number {
  return p.bookedModules.includes(TenantModule.CHAIN) ? p.salonQuota : 1;
}

/** Pure membership test on an already-read package set. */
export function moduleBookedIn(
  p: { bookedModules: readonly TenantModule[] },
  module: TenantModule,
): boolean {
  return p.bookedModules.includes(module);
}

/** The booked packages of a tenant, or null for an unknown tenant. */
export async function readTenantPackages(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<TenantPackages | null> {
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: TENANT_PACKAGES_SELECT,
  });
  return row ? normalizeStoredPackages(row) : null;
}

/** Whether a module is booked; an unknown tenant has nothing booked. */
export async function isModuleBooked(
  db: Prisma.TransactionClient,
  tenantId: string,
  module: TenantModule,
): Promise<boolean> {
  const packages = await readTenantPackages(db, tenantId);
  return packages !== null && moduleBookedIn(packages, module);
}

/**
 * Display values for the tenant UI: the booked modules and the effective salon limit. An unknown
 * tenant shows the Grundversion. Display only — a decision always goes through the assert
 * functions below.
 */
export async function packagesForDisplay(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<{ bookedModules: TenantModule[]; salonLimit: number }> {
  const packages = (await readTenantPackages(db, tenantId)) ?? {
    bookedModules: [...GRUNDVERSION.bookedModules],
    salonQuota: GRUNDVERSION.salonQuota,
  };
  return { bookedModules: packages.bookedModules, salonLimit: salonLimit(packages) };
}

/**
 * Takes the Tenant row lock `FOR NO KEY UPDATE`. Every activation or creation of an active salon
 * serialises on it and counts only afterwards, so two concurrent requests cannot both pass the
 * limit. The lock order is Tenant first, then any Salon row lock. Idempotent inside one
 * transaction. Same statement and the same lock-mode reasoning as `lockTenantForRoleChanges`:
 * `FOR NO KEY UPDATE` conflicts with itself but not with the `FOR KEY SHARE` that every
 * foreign-key check on the Tenant row takes, so unrelated inserts do not wait.
 */
export async function lockTenantForPackages(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR NO KEY UPDATE`;
}

export const SALON_QUOTA_REACHED_MESSAGE =
  "Das Salon-Kontingent ist erreicht. Weitere aktive Salons sind mit dem Ketten-Paket und einem passenden Salon-Kontingent möglich. Ihr Anbieter schaltet das frei.";

export function moduleNotBookedMessage(module: TenantModule): string {
  return `Dafür wird das Zusatzmodul „${TENANT_MODULE_LABEL_DE[module]}“ benötigt. Ihr Anbieter schaltet es frei.`;
}

/**
 * A booked-package refusal. `app.ts` maps every instance to 409 `{ error, code }`, so no caller can
 * leak a 500 and no caller has to build the body itself. The message names the package and carries
 * no count.
 */
export class PackageRefusalError extends Error {
  readonly statusCode = 409 as const;

  constructor(
    readonly code: "SALON_QUOTA_REACHED" | "MODULE_NOT_BOOKED",
    message: string,
  ) {
    super(message);
    this.name = "PackageRefusalError";
  }
}

export class SalonQuotaReachedError extends PackageRefusalError {
  constructor() {
    super("SALON_QUOTA_REACHED", SALON_QUOTA_REACHED_MESSAGE);
    this.name = "SalonQuotaReachedError";
  }
}

export class ModuleNotBookedError extends PackageRefusalError {
  constructor(readonly module: TenantModule) {
    super("MODULE_NOT_BOOKED", moduleNotBookedMessage(module));
    this.name = "ModuleNotBookedError";
  }
}

/**
 * Throws {@link SalonQuotaReachedError} when activating (or creating as active) one more salon
 * would exceed the effective limit. Takes the Tenant lock first (idempotent) and counts after it.
 * An unknown tenant also throws. MUST run inside the interactive transaction that performs the
 * write, with the same client.
 */
export async function assertSalonActivationAllowed(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await lockTenantForPackages(db, tenantId);
  const packages = await readTenantPackages(db, tenantId);
  const activeCount = await db.salon.count({ where: { tenantId, isActive: true } });
  if (!packages || activeCount >= salonLimit(packages)) {
    throw new SalonQuotaReachedError();
  }
}

/** Throws {@link ModuleNotBookedError} when the module is not booked for the tenant. */
export async function assertModuleBooked(
  db: Prisma.TransactionClient,
  tenantId: string,
  module: TenantModule,
): Promise<void> {
  if (!(await isModuleBooked(db, tenantId, module))) {
    throw new ModuleNotBookedError(module);
  }
}

export type ChangeTenantPackagesResult =
  | { status: "NOT_FOUND" }
  | { status: "TENANT_DEACTIVATED" }
  | { status: "UNCHANGED"; packages: TenantPackages }
  | { status: "OK"; before: TenantPackages; after: TenantPackages };

/**
 * The ONE writer of the two package columns. Operator only: the operator route calls it inside
 * its audit transaction; the e2e test bootstrap calls it without a principal.
 *
 * Takes the same Tenant row lock as {@link assertSalonActivationAllowed}, so a package change and
 * a salon activation serialise (D-04). It changes nothing but `bookedModules` and `salonQuota`
 * (D-06): no salon is deactivated and nothing is revoked, even when the new values fall below the
 * current usage. It writes no audit row itself — the caller audits. The input range (module set,
 * quota upper bound) is validated by the caller; a quota below 1 is still refused here as defense
 * in depth, the database CHECK is the last line.
 */
export async function changeTenantPackages(
  db: Prisma.TransactionClient,
  tenantId: string,
  next: TenantPackages,
): Promise<ChangeTenantPackagesResult> {
  if (!Number.isInteger(next.salonQuota) || next.salonQuota < 1) {
    throw new RangeError("salonQuota must be an integer of at least 1");
  }
  await lockTenantForPackages(db, tenantId);
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { deactivatedAt: true, ...TENANT_PACKAGES_SELECT },
  });
  if (!row) return { status: "NOT_FOUND" };
  if (row.deactivatedAt) return { status: "TENANT_DEACTIVATED" };

  const before = normalizeStoredPackages(row);
  const after = normalizeStoredPackages({
    bookedModules: next.bookedModules,
    salonQuota: next.salonQuota,
  });
  const unchanged =
    before.salonQuota === after.salonQuota &&
    before.bookedModules.length === after.bookedModules.length &&
    before.bookedModules.every((module, i) => module === after.bookedModules[i]);
  if (unchanged) return { status: "UNCHANGED", packages: before };

  await db.tenant.update({
    where: { id: tenantId },
    data: { bookedModules: after.bookedModules, salonQuota: after.salonQuota },
    select: { id: true },
  });
  return { status: "OK", before, after };
}
