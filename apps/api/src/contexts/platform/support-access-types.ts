/**
 * Issue #93 (Phase 93b-01) — types and control values of the support access. Types and constants only:
 * no Prisma call and no behaviour live here, so the composition layer may import this file (through
 * `contexts/platform/index.ts`) without reaching the decider.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

/** Derived status of a grant at a given instant (see `supportAccessStatus` in `support-access.ts`). */
export type SupportAccessStatus = "ACTIVE" | "EXPIRED" | "ENDED";

/** Who ended a grant early. Control values; stored in `SupportAccess.endedBy` (CHECK in the DB). */
export type SupportAccessEndedBy = "OPERATOR" | "TENANT";

/**
 * The categories of data a support read can open (D-05, D-06). Control values written to both audit
 * logs as `newValue.category`; never a display string.
 */
export const SUPPORT_READ_CATEGORIES = [
  "EMPLOYEES",
  "EMPLOYEE_MONTH",
  "CONTRACTS",
  "AUDIT_LOG",
] as const;

export type SupportReadCategory = (typeof SUPPORT_READ_CATEGORIES)[number];

/** Operator view of one grant. Instants are ISO strings; explicit keys only, never a row spread. */
export interface SupportAccessDto {
  id: string;
  tenantId: string;
  reason: string;
  durationHours: number;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: SupportAccessEndedBy | null;
  status: SupportAccessStatus;
}

/**
 * One employee as the operator sees it in the support list (D-05): no e-mail, birth date, NFC card id
 * or address. `status` is derived by `supportEmployeeStatus`; an anonymised employee keeps its stored
 * (anonymised) name.
 */
export interface SupportEmployeeDto {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  exitDate: string | null;
  status: "ACTIVE" | "EXITED" | "ANONYMIZED";
  homeSalon: { id: string; name: string } | null;
  scheduleType: string | null;
}

/**
 * The reads the operator support routes receive from the composition layer (pattern of the operator
 * salon ports). Declared structurally here so the Unterbau names no context; 93b-02 implements it in
 * `composition/operator-support-ports.ts` and later plans extend it.
 */
export interface OperatorSupportPorts {
  /** True when the employee exists in the tenant; a foreign or unknown id is indistinguishable. */
  employeeExists(
    db: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
  ): Promise<boolean>;
  listEmployees(app: FastifyInstance, tenantId: string): Promise<SupportEmployeeDto[]>;
}
