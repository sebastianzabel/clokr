// Wire types of the operator API (Issue #89). Mirrors the metadata-only DTOs of
// `contexts/platform/api/operator/{tenants,salons}.ts`; the console shows master data only.
import type { FederalState } from "@clokr/types";
import type { TenantModule } from "$lib/packages/tenant-modules";

/** Booked packages of a tenant as the operator API reports them (Phase 566). */
export interface OperatorTenantPackages {
  bookedModules: TenantModule[];
  salonQuota: number;
  /** Number of active salons; display only (the warning when the limit lies below it). */
  activeSalonCount: number;
}

/** Body of `PUT /operator/tenants/:id/packages`; the strict API schema accepts exactly these keys. */
export interface SetTenantPackagesBody {
  bookedModules: TenantModule[];
  salonQuota: number;
}

export interface OperatorTenant {
  id: string;
  name: string;
  slug: string;
  federalState: FederalState;
  createdAt: string;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  packages: OperatorTenantPackages;
}

/** Totals block of `GET /operator/dashboard` (Issue #90): counts only. */
export interface OperatorDashboardTotals {
  tenants: number;
  activeTenants: number;
  deactivatedTenants: number;
  activeSalons: number;
  activeEmployees: number;
  inactiveTenants: number;
}

/** One tenant's aggregate metrics (Issue #90): numbers and one calendar day, never a person. */
export interface OperatorDashboardTenant {
  id: string;
  name: string;
  slug: string;
  deactivatedAt: string | null;
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  /** `YYYY-MM-DD` (UTC day) of the tenant's most recent sign-in, or null when there never was one. */
  lastActivityAt: string | null;
  inactive: boolean;
}

/** Wire type of `GET /operator/dashboard` (Issue #90, aggregates only). */
export interface OperatorDashboard {
  /** The server's inactivity threshold in days; the console never hard-codes it. */
  inactivityDays: number;
  totals: OperatorDashboardTotals;
  tenants: OperatorDashboardTenant[];
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

/** The coupling object of a salon write: an object sets or replaces it, `null` removes it. */
export interface SalonCouplingInput {
  externalBranchId: string;
}

/** Body of `POST /operator/tenants/:id/salons`; the strict API schema accepts exactly these keys. */
export interface CreateSalonBody {
  name: string;
  street?: string;
  postalCode?: string;
  city?: string;
  /** Always all seven days, explicit `closed`. */
  openingHours: OpeningHoursDay[];
  federalState: FederalState;
  /** Absent = no coupling. */
  coupling?: SalonCouplingInput;
}

/**
 * Body of `PATCH /operator/tenants/:id/salons/:salonId`: only the keys that changed. An address
 * field cleared by the operator is sent as `null`; `coupling` absent = unchanged.
 */
export interface UpdateSalonBody {
  name?: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  federalState?: FederalState;
  openingHours?: OpeningHoursDay[];
  coupling?: SalonCouplingInput | null;
}

/** Derived status of a support access at the time the server answered (Issue #93). */
export type SupportAccessStatus = "ACTIVE" | "EXPIRED" | "ENDED";

/** Who ended a support access early. */
export type SupportAccessEndedBy = "OPERATOR" | "TENANT";

/** The durations the server accepts for a support access, in hours (D-03). */
export type SupportDurationHours = 1 | 4 | 8 | 24;

/** One support access as `GET /operator/tenants/:id/support-access` reports it (mirror of the API DTO). */
export interface OperatorSupportAccess {
  id: string;
  tenantId: string;
  reason: string;
  durationHours: number;
  /** ISO instants. */
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: SupportAccessEndedBy | null;
  status: SupportAccessStatus;
}

/** Wire type of `GET /operator/tenants/:id/support-access`: the running access and every own grant, newest first. */
export interface OperatorSupportAccessState {
  active: OperatorSupportAccess | null;
  history: OperatorSupportAccess[];
}

/** Body of `POST /operator/tenants/:id/support-access`; the strict API schema accepts exactly these keys. */
export interface RequestSupportAccessBody {
  reason: string;
  durationHours: SupportDurationHours;
}

/** 201 body of the request and 200 body of the end call. */
export interface SupportAccessResult {
  access: OperatorSupportAccess;
}
