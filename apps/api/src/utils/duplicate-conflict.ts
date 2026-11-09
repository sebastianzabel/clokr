/**
 * Issue #573 (D-08…D-10) — the ONE table that turns a database conflict nobody handled into a 409
 * with plain German text instead of a 500.
 *
 * A route that knows its conflict keeps its own answer (it catches the Prisma error itself); only a
 * `P2002` (unique violation) or `P2034` (write conflict) that reaches the global error handler in
 * `app.ts` is read here. The violated index is read through `uniqueViolationTarget()` (structured
 * metadata, never `err.message`, Issue #567) and named by KIND only — never a value of the
 * colliding row (no e-mail, no name).
 *
 * Every unique index of `schema.prisma` and every hand-written unique index has an entry: a text, or
 * `null` for the generic text (technical keys a person cannot collide on). The guard test
 * `duplicate-conflict-573.test.ts` fails when a new unique index has none.
 *
 * A technical helper: it owns no model and carries no business rule.
 */
import { uniqueViolationTarget } from "./prisma-unique-violation";

export const GENERIC_DUPLICATE = "Diesen Eintrag gibt es bereits.";
export const WRITE_CONFLICT =
  "Die Daten wurden gerade gleichzeitig geändert. Bitte versuche es erneut.";

/** Unique index name → German text (`null` = the generic text). */
export const DUPLICATE_MESSAGES: Readonly<Record<string, string | null>> = {
  // Prisma-declared (`@unique` / `@@unique`), default names `<Model>_<fields>_key`
  Tenant_slug_key: "Diese Kennung ist bereits vergeben.",
  TenantConfig_tenantId_key: null,
  User_email_key: "Diese E-Mail-Adresse wird bereits verwendet.",
  RefreshToken_token_key: null,
  PushSubscription_endpoint_key: "Dieses Gerät ist bereits registriert.",
  Invitation_token_key: null,
  Employee_userId_key: null,
  Employee_nfcCardId_key: "Diese NFC-Karte ist bereits einer anderen Person zugeordnet.",
  Employee_tenantId_employeeNumber_key: "Diese Personalnummer ist bereits vergeben.",
  TimeEntry_retroRequestId_key: null,
  TimeEntryActivityShare_timeEntryId_kind_key:
    "Diese Tätigkeitsart ist für den Eintrag bereits erfasst.",
  OvertimeAccount_employeeId_key: null,
  LeaveType_tenantId_name_key: "Eine Abwesenheitsart mit diesem Namen gibt es bereits.",
  LeaveType_tenantId_code_key: "Diese Abwesenheitsart gibt es bereits.",
  LeaveEntitlement_employeeId_leaveTypeId_year_key:
    "Für dieses Jahr gibt es bereits einen Anspruch dieser Art.",
  SpecialLeaveRule_tenantId_name_key: "Diesen Anlass gibt es bereits.",
  Section9Credit_supersedesId_key: null,
  Section9Credit_sickRequestId_vacationRequestId_revision_key: null,
  ParentalLeaveReduction_leaveRequestId_year_key:
    "Für dieses Jahr gibt es bereits eine Kürzung zu diesem Antrag.",
  Absence_employeeId_startDate_type_key: "Diese Abwesenheit ist für den Tag bereits erfasst.",
  PublicHoliday_salonId_date_key: "Für diesen Tag gibt es bereits einen Feiertag.",
  SchoolHolidayPeriod_tenantId_federalState_startDate_endDate_source_key:
    "Diese Ferienzeit gibt es bereits.",
  OperatorAccount_email_key: "Diese E-Mail-Adresse wird bereits verwendet.",
  TerminalApiKey_keyHash_key: null,
  PresenceSource_keyHash_key: null,
  PresenceDevice_tenantId_mac_key: "Dieses Gerät ist bereits gekoppelt.",
  PresencePairingCode_codeHash_key: null,
  ApiKey_keyHash_key: null,
  AccessRole_tenantId_nameKey_key: "Eine Rolle mit diesem Namen gibt es bereits.",
  RoleAssignment_userId_accessRoleId_scopeType_key: "Diese Rollenzuweisung gibt es bereits.",
  PhorestStaffMapping_tenantId_phorestStaffId_key: "Diese Phorest-Zuordnung gibt es bereits.",
  SalonCoupling_salonId_key: "Dieser Salon ist bereits gekoppelt.",
  SalonCoupling_tenantId_provider_externalBranchId_key: "Diese Filiale ist bereits gekoppelt.",
  PhorestAppointment_externalId_key: null,
  CompanyShutdownException_shutdownId_employeeId_key:
    "Für diese Person gibt es bereits eine Ausnahme.",
  LeavePlanWish_leaveRequestId_key: null,
  Shift_externalId_key: null,
  EmployeeShiftPattern_employeeId_dayOfWeek_validFrom_key:
    "Für diesen Wochentag gibt es ab diesem Datum bereits ein Muster.",
  // Hand-written partial unique indexes (migrations; Prisma models none)
  TimeEntry_employeeId_date_open_unique: "An diesem Tag gibt es bereits einen offenen Eintrag.",
  OpeningBalance_active_unique: "Es gibt bereits einen aktiven Eröffnungssaldo.",
  SaldoSnapshot_active_unique: null,
  LeavePlan_open_unique: "Für diesen Salon und dieses Jahr gibt es bereits eine offene Planung.",
};

/** The German text for an unhandled unique violation, or `null` when `err` is no `P2002`. */
export function duplicateConflictMessage(err: unknown): string | null {
  const target = uniqueViolationTarget(err);
  if (target === null) return null;
  // Longest matching name first, so a name never wins over a longer one that contains it.
  const names = Object.keys(DUPLICATE_MESSAGES).sort((a, b) => b.length - a.length);
  const hit = names.find((name) => target.includes(name));
  return (hit ? DUPLICATE_MESSAGES[hit] : null) ?? GENERIC_DUPLICATE;
}

/** True for Prisma's `P2034` (write conflict / serialization failure; retrying helps). */
export function isWriteConflict(err: unknown): boolean {
  return err !== null && typeof err === "object" && (err as { code?: unknown }).code === "P2034";
}
