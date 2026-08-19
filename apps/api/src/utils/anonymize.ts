/**
 * DSGVO Employee Anonymization Helper
 *
 * Single source of truth for the per-employee anonymization transformation.
 * Lifted from `routes/employees.ts` (DELETE /api/v1/employees/:id handler)
 * so that both the route AND the batch anonymizer script
 * (`scripts/anonymize-dump.ts`) can call the exact same logic.
 *
 * Behavior contract (must match CLAUDE.md "DSGVO Employee Deletion =
 * Anonymization" rules):
 *
 *   - Employee.firstName       → "Gelöscht"
 *   - Employee.lastName        → "GELÖSCHT-{employeeNumber-or-id-prefix}"
 *   - Employee.employeeNumber  → same anonymized label as lastName
 *   - Employee.nfcCardId       → null
 *   - User.email               → "deleted-{id-prefix}@anonymized.local"
 *   - User.passwordHash        → "ANONYMIZED"
 *   - User.isActive            → false
 *   - TimeEntry.note           → null (for that employee)
 *   - LeaveRequest.note        → null (for that employee)
 *   - Absence.note             → null AND Absence.documentPath → null
 *   - Invitation, OtpToken, RefreshToken: hard-deleted (not retention-relevant)
 *   - AuditLog.userId          → null (for rows owned by that user)
 *   - AuditLog.oldValue/newValue → redacted for Employee + User audit rows
 *     (prevents name/email from surviving in historical JSON — COMP-V1814-01)
 *   - Notification.title/message → "ANONYMIZED" (for the user's own notifications)
 *
 * Preserved (for retention compliance §147 AO / §257 HGB / § 16 ArbZG):
 *   TimeEntry, LeaveRequest, Absence, Schedule, OvertimeAccount row counts
 *   stay unchanged — rows are mutated in place, never deleted.
 *   OpeningBalance (Phase 99, OB-05): likewise preserved by omission — the row IS the
 *   Nachweis that a migrated Alt-Überstunden value existed and why. It carries no PII of
 *   its own (employeeId reference only; reason/evidenceRef are operational text, and MUST
 *   NOT be used to store personal data). createdBy/approvedBy are left untouched by
 *   anonymization, following the established SaldoSnapshot.closedBy precedent (also
 *   preserved by omission — neither this function nor the batch script touches it).
 *   Retention: default 10-year §147 AO bucket, same as SaldoSnapshot/OvertimeAccount —
 *   an opening balance is payroll-relevant Buchungsbeleg material, not merely a working-
 *   time record, so the shorter 2-year §16 ArbZG floor does not apply to it.
 *
 * Caller responsibilities:
 *   - Open the transaction (`prisma.$transaction(...)`)
 *   - Emit the AuditLog entry — this helper does NOT log itself.
 *     The route emits action="ANONYMIZE" (per-employee).
 *     The batch script emits action="ANONYMIZATION_RUN" (whole-DB sweep).
 *   - Delete MinIO avatar + absence-document objects AFTER the tx commits
 *     (MinIO is not transactional with Postgres; pre-fetch paths before calling).
 *
 * The helper assumes the employee exists and has a non-null userId. Callers
 * are expected to validate that before opening the transaction.
 */
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

export interface AnonymizeEmployeeOptions {
  tx: Prisma.TransactionClient;
  employeeId: string;
}

/**
 * Anonymize a single employee in place. Caller controls the transaction
 * boundary so multiple employees can be anonymized atomically or
 * one-employee-per-transaction depending on the caller's needs.
 */
export async function anonymizeEmployeeData(opts: AnonymizeEmployeeOptions): Promise<void> {
  const { tx, employeeId } = opts;

  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, userId: true, employeeNumber: true },
  });
  if (!employee) {
    throw new Error(`anonymizeEmployeeData: employee ${employeeId} not found`);
  }
  const { userId } = employee;
  const anonymizedLabel = `GELÖSCHT-${employee.employeeNumber || employeeId.slice(0, 8)}`;

  // AuditLog anonymisieren (userId → null)
  await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });

  // Employee: personenbezogene Daten anonymisieren, Record behalten
  await tx.employee.update({
    where: { id: employeeId },
    data: {
      firstName: "Gelöscht",
      lastName: anonymizedLabel,
      employeeNumber: anonymizedLabel,
      nfcCardId: null,
    },
  });

  // User: deaktivieren + anonymisieren (kein Login mehr möglich)
  await tx.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${employeeId.slice(0, 8)}@anonymized.local`,
      passwordHash: "ANONYMIZED",
      isActive: false,
    },
  });

  // Notizen in Zeiteinträgen anonymisieren (können persönliche Daten enthalten)
  await tx.timeEntry.updateMany({
    where: { employeeId, note: { not: null } },
    data: { note: null },
  });

  // Notizen in Urlaubsanträgen anonymisieren
  await tx.leaveRequest.updateMany({
    where: { employeeId, note: { not: null } },
    data: { note: null },
  });

  // Notizen in Abwesenheiten anonymisieren + Dokument-Pfad entfernen
  await tx.absence.updateMany({
    where: { employeeId },
    data: { note: null, documentPath: null },
  });

  // AuditLog JSON-Felder (oldValue/newValue) für Employee- und User-Einträge redigieren.
  // Verhindert, dass Name/E-Mail in historischen JSON-Blobs erhalten bleiben (COMP-V1814-01).
  await tx.auditLog.updateMany({
    where: {
      OR: [
        { entity: "Employee", entityId: employeeId },
        { entity: "User", entityId: userId },
      ],
    },
    data: {
      oldValue: { anonymized: true, redacted: "COMP-V1814-01" },
      newValue: { anonymized: true, redacted: "COMP-V1814-01" },
    },
  });

  // Benachrichtigungen des Nutzers anonymisieren (können Namen/Informationen enthalten)
  await tx.notification.updateMany({
    where: { userId },
    data: { title: "ANONYMIZED", message: "ANONYMIZED" },
  });

  // Auth-Tokens löschen (nicht aufbewahrungspflichtig)
  await tx.invitation.deleteMany({ where: { employeeId } });
  await tx.otpToken.deleteMany({ where: { userId } });
  await tx.refreshToken.deleteMany({ where: { userId } });
}
