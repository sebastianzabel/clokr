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
 * - Written only by the operator (the writer arrives with the operator packages route); this
 *   module has no tenant-facing write.
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
