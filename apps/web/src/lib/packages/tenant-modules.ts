/**
 * Display mirror of the bookable add-on modules (Phase 566, D-03).
 *
 * The API decides every write (`apps/api/src/contexts/platform/tenant-packages.ts`, Prisma enum
 * `TenantModule`); the web only names the modules in calm hints. The web cannot import API code, so
 * this file holds its own copy, pinned to the API source by `__tests__/tenant-modules.test.ts`
 * (names, labels and order cannot drift). The web decides nothing from these values.
 */
export type TenantModule = "CHAIN" | "INTEGRATIONS" | "HARDWARE_CLOCK" | "ANALYTICS";

/** The four modules in the API's canonical (declaration) order. */
export const TENANT_MODULES: readonly TenantModule[] = [
  "CHAIN",
  "INTEGRATIONS",
  "HARDWARE_CLOCK",
  "ANALYTICS",
];

/** German product names, identical to `TENANT_MODULE_LABEL_DE` of the API. */
export const TENANT_MODULE_LABELS: Record<TenantModule, string> = {
  CHAIN: "Ketten-Paket",
  INTEGRATIONS: "Integrationen",
  HARDWARE_CLOCK: "Hardware-Stempeln",
  ANALYTICS: "Auswertungen",
};
