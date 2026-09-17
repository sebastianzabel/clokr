// The DSGVO-anonymization sentinel filter — lifted out of ./anonymize.ts in Phase 101B
// (Issue #101, owner's Nachtrag 2026-09-17). Both `Prisma.EmployeeWhereInput` fragments are pure
// and import nothing — the cleanest possible leaf. Splitting them out lets platform/index.ts
// re-export this filter without also re-exporting anonymize.ts, which imports ../time-tracking
// and ../absence (E-5, DSGVO Art. 17 — unchanged by this move). Measured to take the projected
// cycle from 27 modules to 21 (101B-ZYKLEN-BEFUND.md §2, §7 — 21 is the owner-confirmed corrected
// figure, not the originally-pinned 20) and to remove platform from the component entirely. The
// bodies are unchanged — this was a relocation, not a rewrite.

import type { Prisma } from "@clokr/db";

/**
 * The sentinel that marks a DSGVO-anonymized Employee row (set by anonymizeEmployeeData below):
 * firstName === "Gelöscht" AND lastName startsWith "GELÖSCHT-". Centralized here so every list
 * query that must hide anonymized employees uses the exact same predicate (single source of truth).
 * GET /employees/:id (audit view) is intentionally NOT filtered — anonymized rows stay resolvable by
 * UUID for audit-trail traceability.
 */
export const ANONYMIZED_EMPLOYEE_WHERE = {
  AND: [{ firstName: "Gelöscht" }, { lastName: { startsWith: "GELÖSCHT-" } }],
} satisfies Prisma.EmployeeWhereInput;

/** Negation to splice into a list query's `where` to EXCLUDE anonymized employees. */
export const NOT_ANONYMIZED_EMPLOYEE_WHERE = {
  NOT: ANONYMIZED_EMPLOYEE_WHERE,
} satisfies Prisma.EmployeeWhereInput;
