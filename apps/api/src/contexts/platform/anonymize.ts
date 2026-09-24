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
 *   - Section9Credit.documentPath → null AND Section9Credit.reason → null (Phase 104,
 *     D-26 — Art. 9 DSGVO health datum + free text; rows preserved, see below)
 *   - Invitation, OtpToken, RefreshToken: hard-deleted (not retention-relevant)
 *   - AuditLog.userId          → null (for rows owned by that user)
 *   - AuditLog.oldValue/newValue → redacted for Employee + User audit rows
 *     (prevents name/email from surviving in historical JSON — COMP-V1814-01)
 *   - Notification.title/message → "ANONYMIZED" (for the user's own notifications)
 *   - RoleAssignment: every row of the user is hard-deleted (Phase 74b, D-22 — an anonymized
 *     person must not hold rights, and a leftover row would block deleting its role). The
 *     removed rows are RETURNED so the route can write one DELETE audit entry per row; the
 *     batch script (`scripts/anonymize-dump.ts`) records them in its ANONYMIZATION_RUN summary
 *     instead (`removedRoleAssignmentCount` plus every removed row in `removedRoleAssignments`,
 *     74b review WR-05). Person-scope lists of other users that contain this employee's id are
 *     left unchanged (ids only — the permission resolution ignores anonymized targets).
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
 *     The batch script emits action="ANONYMIZATION_RUN" (whole-DB sweep), whose newValue lists
 *     the returned `removedRoleAssignments` of every employee it processed.
 *     The route also emits one action="DELETE" entity="RoleAssignment" entry per row in the
 *     returned `removedRoleAssignments` (newValue.reason "Anonymisierung", Phase 74b D-22).
 *   - Delete MinIO avatar + absence-document objects AFTER the tx commits
 *     (MinIO is not transactional with Postgres; pre-fetch paths before calling).
 *
 * The helper assumes the employee exists and has a non-null userId. Callers
 * are expected to validate that before opening the transaction.
 */
import type { Prisma } from "@clokr/db";
import { clearEntryNotesForEmployee } from "../time-tracking"; // Phase 100B Plan 08 — T10
import { anonymizeSection9CreditsForEmployee } from "../absence"; // Phase 100B Plan 11 — T-100B-48
import { anonymizeAbsencesForEmployee } from "../absence"; // Phase 100B Plan 12 — F3
import { anonymizeLeaveRequestsForEmployee } from "../absence"; // Phase 100B Plan 13 — F3
import { removeRoleAssignmentsOfUser, type RemovedRoleAssignment } from "./facade/role-assignments";
// Phase 101B (Issue #101, Nachtrag 2026-09-17): the two sentinel `where` fragments lifted out of
// this file into ./employee-anonymization-filter.ts — re-exported below (unchanged) so
// scheduling/api/shifts.ts and ./api/employees.ts (neither touched by this plan) keep resolving
// them from this same path until a later wave converts them to import from platform/index.ts.
export {
  ANONYMIZED_EMPLOYEE_WHERE,
  NOT_ANONYMIZED_EMPLOYEE_WHERE,
} from "./employee-anonymization-filter";

export interface AnonymizeEmployeeOptions {
  tx: Prisma.TransactionClient;
  employeeId: string;
}

/** What the anonymization removed that the caller must audit (Phase 74b, D-22). */
export interface AnonymizeEmployeeResult {
  removedRoleAssignments: RemovedRoleAssignment[];
}

/**
 * Anonymize a single employee in place. Caller controls the transaction
 * boundary so multiple employees can be anonymized atomically or
 * one-employee-per-transaction depending on the caller's needs.
 */
export async function anonymizeEmployeeData(
  opts: AnonymizeEmployeeOptions,
): Promise<AnonymizeEmployeeResult> {
  const { tx, employeeId } = opts;

  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, tenantId: true, userId: true, employeeNumber: true },
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

  // Phase 74b (D-22): an anonymized person holds no rights — remove every role assignment.
  const removedRoleAssignments = await removeRoleAssignmentsOfUser(tx, employee.tenantId, userId);

  // Notizen in Zeiteinträgen anonymisieren (können persönliche Daten enthalten)
  // Phase 100B Plan 08 — T10, contexts/time-tracking facade (reaches soft-deleted rows too).
  await clearEntryNotesForEmployee(tx, employeeId);

  // Notizen in Urlaubsanträgen anonymisieren
  // Phase 100B Plan 13 — F3, contexts/absence facade.
  await anonymizeLeaveRequestsForEmployee(tx, employeeId);

  // Notizen in Abwesenheiten anonymisieren + Dokument-Pfad entfernen
  // Phase 100B Plan 12 — F3, contexts/absence facade.
  await anonymizeAbsencesForEmployee(tx, employeeId);

  // Phase 104 (D-26): Papier-AU zu § 9-BUrlG-Vorgängen ist ein Gesundheitsdatum nach Art. 9
  // DSGVO. Der Zeiger darauf wird gelöscht; das MinIO-Objekt selbst löscht der Aufrufer NACH
  // dem Commit (MinIO ist nicht transaktional mit Postgres — routes/employees.ts).
  // Die Section9Credit-ZEILEN bleiben erhalten: sie sind der Korrektureintrag, mit dem die
  // Urlaubsgutschrift rekonstruierbar bleibt (Revisionssicherheit, R7). Gelöscht wird nur,
  // was personenbezogen bzw. gesundheitsbezogen ist — documentPath und die Freitext-Begründung.
  await anonymizeSection9CreditsForEmployee(tx, employeeId);

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

  return { removedRoleAssignments };
}
