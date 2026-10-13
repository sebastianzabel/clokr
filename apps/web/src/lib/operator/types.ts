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

/** The coupling choices of the salon form: no coupling, or Phorest (D-11: nothing else is offered). */
export type CouplingProvider = "NONE" | "PHOREST";

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

/** Step 1 of the sign-in: the short-lived challenge that step 2 redeems. */
export interface OperatorChallenge {
  challengeToken: string;
  /** Seconds the challenge stays valid. */
  expiresIn: number;
}

/** Exactly one second factor per verify call (the API refuses both or neither). */
export type OperatorFactor = { code: string } | { recoveryCode: string };

export interface OperatorAccessGrant {
  accessToken: string;
  /** Seconds the access token stays valid (no refresh exists). */
  expiresIn: number;
}

export interface OperatorMe {
  id: string;
  email: string;
  displayName: string;
  lastLoginAt: string | null;
}

/** Body of `POST /operator/tenants`; the strict API schema accepts exactly these keys. */
export interface CreateTenantBody {
  name: string;
  slug: string;
  federalState: FederalState;
  timezone?: string;
  admin: {
    email: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
  };
}

/** 201 body of `POST /operator/tenants`. The invitation token is never part of it (T-88-52). */
export interface CreateTenantResult {
  tenant: OperatorTenant;
  defaultSalonId: string;
  adminEmployeeId: string;
  invitationMailSent: boolean;
}

/** 200 body of `POST /operator/tenants/:id/resend-admin-invitation`; the token is never part of it. */
export interface ResendInvitationResult {
  invitationMailSent: boolean;
}
