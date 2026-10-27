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
 *   - Employee.employeeNumber  → KEPT unchanged (Issue #614, D-03, owner decision 16.10.2026). Legal
 *     basis: § 41 EStG (Lohnkonto, 6 years), § 147 AO (10 years), Art. 17 Abs. 3 lit. b DSGVO; the
 *     payroll office assigns corrections of old months by the DATEV `pnr`. Without name, e-mail and
 *     notes the number is a pseudonym. It stays reserved in the tenant (the unique constraint stays;
 *     create/change answer 409, see employee-creation.ts). The anonymization sentinel
 *     (firstName + lastName) does not depend on it.
 *   - Employee.nfcCardId       → null
 *   - Employee.wifiMacs        → [] AND wifiPresenceEnabled → false, wifiOptInAt → null (Issue #388)
 *   - PresenceDevice (enrolled WLAN devices) → hard-deleted (Issue #388; MAC = personal device id)
 *   - Employee.exitDate        → the caller's `exitDayIfUnset`, ONLY when it was empty (Issue #614,
 *     D-01: an anonymized person is no longer employed; an existing exit date, past or future,
 *     is never changed). The caller passes the tenant-local calendar day as UTC midnight (the
 *     convention of web-entered exit dates) and, when it was newly set, runs the #447 exit-year
 *     entitlement sync.
 *   - User.email               → "deleted-{id-prefix}@anonymized.local"
 *   - User.passwordHash        → "ANONYMIZED"
 *   - User.isActive            → false
 *   - User.role                → EMPLOYEE (Issue #357 sub-fix C, revises Phase 75b D-14 — see
 *     below and CLAUDE.md "DSGVO Employee Deletion = Anonymization")
 *   - TimeEntry.note           → null (for that employee)
 *   - TimeEntry.breakWaivedReason → null (Issue #508; breakStatus and the entry stay)
 *   - LeaveRequest.note        → null (for that employee)
 *   - LeaveRequest.reviewNote  → null (Issue #718; status, reviewer and timestamp stay)
 *   - RetroEntryRequest.reason → "Gelöscht (Anonymisierung)" (required column, neutral text) AND
 *     RetroEntryRequest.reviewNote → null (Issue #718; the row, its status and times stay)
 *   - OvertimePlan.note, Shift.note, EmployeeAvailability.note → null (Issue #718)
 *   - Absence.note             → null AND Absence.documentPath → null
 *   - Section9Credit.documentPath → null AND Section9Credit.reason → null (Phase 104,
 *     D-26 — Art. 9 DSGVO health datum + free text; rows preserved, see below)
 *   - Invitation, OtpToken, RefreshToken: hard-deleted (not retention-relevant)
 *   - AuditLog.userId          → null (for rows owned by that user)
 *   - AuditLog.oldValue/newValue → redacted for Employee + User audit rows
 *     (prevents name/email from surviving in historical JSON — COMP-V1814-01)
 *   - AuditLog old/new value free text → "[ausgeblendet]" by TYPE for rows authored by the user or
 *     naming the employee (Issue #512, `audit-freetext-redaction.ts`; who/when/what and every
 *     figure stay, rows are never deleted)
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
 *   Deliberately KEPT free texts (Issue #718, owner decision delegated 26.10.2026): the texts the
 *   business itself writes to document a booking - SaldoSnapshot.note / supersededReason and
 *   OpeningBalance.reason / evidenceRef / supersededReason. They are not person-authored, they are
 *   Buchungsbeleg material (§ 147 AO, GoBD, Art. 17 Abs. 3 lit. b DSGVO). AuditLog free texts
 *   are redacted by type, see the AuditLog bullet above (#512).
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
 *   - Route only (Issue #614): end the person's absences through `app.absenceExit` BEFORE calling
 *     this helper, so the PII sweep below also nulls the notes / document paths / § 9 reasons of
 *     every row the exit wrote. The batch copy-erasure (`scripts/anonymize-dump.ts`) does not.
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
import { clearEntryNotesForEmployee, deletePresenceDevicesOfEmployee } from "../time-tracking"; // Phase 100B Plan 08 — T10
import { anonymizeSection9CreditsForEmployee } from "../absence"; // Phase 100B Plan 11 — T-100B-48
import { anonymizeAbsencesForEmployee } from "../absence"; // Phase 100B Plan 12 — F3
import { anonymizeLeaveRequestsForEmployee } from "../absence"; // Phase 100B Plan 13 — F3
import { clearSchedulingNotesForEmployee } from "../scheduling"; // Issue #718
import { clearOvertimePlanNotesForEmployee } from "../working-time-account"; // Issue #718
import { redactAuditFreeTextOfPerson, type AuditRedactionResult } from "./audit-freetext-redaction"; // Issue #512
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
  /**
   * Issue #614 (D-01): UTC midnight of the tenant-local calendar day the caller decided to be the
   * exit day (`todayInTz`). Written to `Employee.exitDate` only when the stored value is null.
   */
  exitDayIfUnset: Date;
}

/** What the anonymization removed that the caller must audit (Phase 74b, D-22). */
export interface AnonymizeEmployeeResult {
  removedRoleAssignments: RemovedRoleAssignment[];
  /** Issue #614 (D-01): the exit date before and after; `before` null means this call set it. */
  exitDate: { before: Date | null; after: Date };
  /** Issue #388: counts only of the cleared device identifiers; the addresses are never returned. */
  clearedDeviceIdentifiers: { wifiMacs: number; presenceDevices: number };
  /** Issue #512: AuditLog rows whose free text was redacted; counts only, never text. */
  auditRedaction: AuditRedactionResult;
  /** Issue #718: row counts of the cleared free-text fields; counts only, never text. */
  clearedFreeText: {
    leaveReviewNotes: number;
    retroReasons: number;
    retroReviewNotes: number;
    overtimePlanNotes: number;
    shiftNotes: number;
    availabilityNotes: number;
  };
}

/**
 * Anonymize a single employee in place. Caller controls the transaction
 * boundary so multiple employees can be anonymized atomically or
 * one-employee-per-transaction depending on the caller's needs.
 */
export async function anonymizeEmployeeData(
  opts: AnonymizeEmployeeOptions,
): Promise<AnonymizeEmployeeResult> {
  const { tx, employeeId, exitDayIfUnset } = opts;

  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      employeeNumber: true,
      exitDate: true,
      wifiMacs: true,
    },
  });
  if (!employee) {
    throw new Error(`anonymizeEmployeeData: employee ${employeeId} not found`);
  }
  const { userId } = employee;
  const anonymizedLabel = `GELÖSCHT-${employee.employeeNumber || employeeId.slice(0, 8)}`;

  // Issue #512: person-authored free text inside the person's audit values is redacted by type
  // (rows stay). MUST run before the userId -> null step: rows authored by the user are found by it.
  const auditRedaction = await redactAuditFreeTextOfPerson(tx, { employeeId, userId });

  // AuditLog anonymisieren (userId → null)
  await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });

  // Employee: personenbezogene Daten anonymisieren, Record behalten
  await tx.employee.update({
    where: { id: employeeId },
    data: {
      firstName: "Gelöscht",
      lastName: anonymizedLabel,
      // The employee number is deliberately NOT written here (Issue #614, D-03, see the header contract).
      nfcCardId: null,
      // Issue #388: WLAN presence identifiers of private devices are personal data (Art. 17).
      wifiMacs: [],
      wifiPresenceEnabled: false,
      wifiOptInAt: null,
      // Issue #614 (D-01): ends the employment when no exit date was entered; never moves one.
      ...(employee.exitDate === null ? { exitDate: exitDayIfUnset } : {}),
    },
  });

  // User: deaktivieren + anonymisieren (kein Login mehr möglich)
  // Issue #357 sub-fix C (revises Phase 75b D-14 / ADR 0001-abweichungen Eintrag N): `role` is
  // rewritten to EMPLOYEE here too. Phase 75b deliberately left it standing so a still-valid
  // access token of a self-anonymizing admin would not lose its rights mid-request-sequence — but
  // that is exactly the security-review finding of #357: with the role assignments removed below
  // and the column left at MANAGER/ADMIN, the Altrollen-Rückfall (D-08, `request-permissions.ts`)
  // hands that still-valid token FULL Manager/Admin rights for the rest of its lifetime (up to the
  // access-token TTL), even though the person is anonymized and `isActive: false` (which nothing
  // re-checks per request, D-10). Anonymization must not leave a live grant behind, so the column
  // is reset in the SAME update as `isActive`.
  await tx.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${employeeId.slice(0, 8)}@anonymized.local`,
      passwordHash: "ANONYMIZED",
      isActive: false,
      role: "EMPLOYEE",
    },
  });

  // Phase 74b (D-22): an anonymized person holds no rights — remove every role assignment.
  const removedRoleAssignments = await removeRoleAssignmentsOfUser(tx, employee.tenantId, userId);

  // Issue #388: enrolled WLAN devices (MAC + label) are removed with the employee's own MAC list.
  const presenceDevices = await deletePresenceDevicesOfEmployee(tx, employeeId, employee.tenantId);

  // Notizen in Zeiteinträgen anonymisieren (können persönliche Daten enthalten)
  // Phase 100B Plan 08 — T10, contexts/time-tracking facade (reaches soft-deleted rows too).
  const retro = await clearEntryNotesForEmployee(tx, employeeId);

  // Notizen in Urlaubsanträgen anonymisieren
  // Phase 100B Plan 13 — F3, contexts/absence facade.
  // Issue #718: also reviewNote.
  const leaveReviewNotes = await anonymizeLeaveRequestsForEmployee(tx, employeeId);

  // Issue #718: Überstundenplan-, Schicht- and Verfügbarkeitsnotizen (person-authored free text).
  const overtimePlanNotes = await clearOvertimePlanNotesForEmployee(tx, employeeId);
  const scheduling = await clearSchedulingNotesForEmployee(tx, employeeId);

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

  return {
    removedRoleAssignments,
    exitDate: { before: employee.exitDate, after: employee.exitDate ?? exitDayIfUnset },
    clearedDeviceIdentifiers: { wifiMacs: employee.wifiMacs.length, presenceDevices },
    auditRedaction,
    clearedFreeText: { leaveReviewNotes, ...retro, overtimePlanNotes, ...scheduling },
  };
}
