// Wire types of the operator API (Issue #89). Mirrors the metadata-only DTOs of
// `contexts/platform/api/operator/{tenants,salons}.ts`; the console shows master data only.
import type { FederalState } from "@clokr/types";

export interface OperatorTenant {
  id: string;
  name: string;
  slug: string;
  federalState: FederalState;
  createdAt: string;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
}

/** One weekday of the opening hours; `day` 0 = Montag … 6 = Sonntag (API order). */
export interface OpeningHoursDay {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
}

export interface OperatorCoupling {
  provider: string;
  externalBranchId: string;
}

export interface OperatorSalon {
  id: string;
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  openingHours: OpeningHoursDay[];
  federalState: FederalState;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  isDefault: boolean;
  coupling: OperatorCoupling | null;
}
