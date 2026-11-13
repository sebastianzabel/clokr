// Issue #854 (D-854-06) - the model of the guided "Person anlegen" flow: the four steps, the
// per-step validation and the ONE builder of the `POST /employees` body. Pure: no DOM, no request.
// The server stays the authority for every rule (employee number reserved, Stammsalon, statutory
// minimum vacation, SHIFT_BASED Angabe); the checks here only save a round trip.
//
// What the body deliberately does NOT contain (CLAUDE.md):
//  - no `role`: the requested role travels only as drafts posted to `/role-assignments` (#580);
//  - no day hours: the API derives the FIXED_SCHEDULE day hours from `weeklyHours` (#848);
//  - the hire date is a calendar day built from the DatePicker's ISO value, never from a local Date.
import { applyDefaults, type EmployeeClassification } from "$lib/employee-classification";
import { homeSalonPayload } from "$lib/employees/salon-assignments";
import { statutoryMinimumFiveDayWeek } from "$lib/statutory-minimum-vacation";
import { annualVacationDaysPayload, vacationBaseDefaultFor } from "$lib/vacation-base-default";
import {
  buildUsualWorkDaysPayload,
  usualWorkDaysMissing,
  usualWorkDaysShortfall,
} from "$lib/utils/work-schedule";

export const CREATE_STEPS = ["person", "salon-rolle", "vertrag", "einladung"] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

export const CREATE_STEP_LABELS: Readonly<Record<CreateStep, string>> = {
  person: "Person",
  "salon-rolle": "Salon & Rolle",
  vertrag: "Vertrag",
  einladung: "Einladung",
};

export type CreateScheduleType = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";

export const SCHEDULE_TYPE_OPTIONS: ReadonlyArray<{ value: CreateScheduleType; label: string }> = [
  { value: "FIXED_SCHEDULE", label: "Feste Arbeitszeit" },
  { value: "FLEXTIME", label: "Gleitzeit" },
  { value: "MONTHLY_HOURS", label: "Monatsstunden" },
  { value: "SHIFT_BASED", label: "Nach Schichtplan" },
];

/** What the form holds. Strings are "" while empty; the dates are ISO days (`YYYY-MM-DD`) or null. */
export interface CreatePersonDraft {
  firstName: string;
  lastName: string;
  email: string;
  employeeNumber: string;
  hireDate: string | null;
  birthDate: string | null;
  homeSalonId: string;
  scheduleType: CreateScheduleType;
  weeklyHours: number | null;
  monthlyHours: number | null;
  contractWorkDays: number;
  usualWorkDays: number[];
  coreStart: string;
  coreEnd: string;
  coreDays: number[];
  classification: EmployeeClassification;
  coverageWeight: number;
  requiresSupervision: boolean;
  annualVacationDays: number | null;
  usePassword: boolean;
  password: string;
}

/** Facts the draft cannot know: the tenant's vacation Standards and whether a Stammsalon is required. */
export interface CreateContext {
  tenantDefaultVacationDays: number | null;
  tenantDefaultApprenticeVacationDays: number | null;
  /** True in a tenant with several active salons, for a caller who can list them. */
  homeSalonRequired: boolean;
}

export const EMPTY_CONTEXT: CreateContext = {
  tenantDefaultVacationDays: null,
  tenantDefaultApprenticeVacationDays: null,
  homeSalonRequired: false,
};

/** The key of each field message; a step reports only the keys of its own fields. */
export type CreateField =
  | "firstName"
  | "lastName"
  | "email"
  | "employeeNumber"
  | "hireDate"
  | "birthDate"
  | "homeSalonId"
  | "weeklyHours"
  | "monthlyHours"
  | "contractWorkDays"
  | "usualWorkDays"
  | "coverageWeight"
  | "annualVacationDays"
  | "password";

export type StepErrors = Partial<Record<CreateField, string>>;

/** A blank draft; `today` is the browser-local calendar day (the hire date starts on it). */
export function emptyDraft(today: string): CreatePersonDraft {
  const defaults = applyDefaults("VOLLZEIT");
  return {
    firstName: "",
    lastName: "",
    email: "",
    employeeNumber: "",
    hireDate: today,
    birthDate: null,
    homeSalonId: "",
    scheduleType: "FIXED_SCHEDULE",
    weeklyHours: 40,
    monthlyHours: null,
    contractWorkDays: 5,
    usualWorkDays: [],
    coreStart: "",
    coreEnd: "",
    coreDays: [],
    classification: "VOLLZEIT",
    coverageWeight: defaults.coverageWeight,
    requiresSupervision: defaults.requiresSupervision,
    annualVacationDays: null,
    usePassword: false,
    password: "",
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isWeeklyType(type: CreateScheduleType): boolean {
  return type !== "MONTHLY_HOURS";
}

/**
 * The vacation days the form proposes (the classification's own Standard, raised to the statutory
 * minimum of the person's age) - `null` while the Standard is not known. A display mirror of the
 * server's `resolveVacationBaseDays()`; it never overwrites a value the person typed (the dialog
 * decides that).
 */
export function suggestedVacationDays(draft: CreatePersonDraft, ctx: CreateContext): number | null {
  const base = vacationBaseDefaultFor(
    draft.classification,
    ctx.tenantDefaultVacationDays,
    ctx.tenantDefaultApprenticeVacationDays,
  );
  if (base === null) return null;
  return Math.max(base, statutoryMinimum(draft).days);
}

/** Without a birth date the adult minimum (§ 3 BUrlG) still applies - never "no minimum". */
export function statutoryMinimum(draft: CreatePersonDraft) {
  const year = Number((draft.hireDate ?? "").slice(0, 4)) || new Date().getFullYear();
  return statutoryMinimumFiveDayWeek(draft.birthDate, year);
}

function personErrors(draft: CreatePersonDraft): StepErrors {
  const errors: StepErrors = {};
  if (!draft.firstName.trim()) errors.firstName = "Gib den Vornamen ein.";
  if (!draft.lastName.trim()) errors.lastName = "Gib den Nachnamen ein.";
  const email = draft.email.trim();
  if (!email) errors.email = "Gib eine E-Mail-Adresse ein.";
  else if (!EMAIL_RE.test(email)) errors.email = "Diese E-Mail-Adresse ist nicht gültig.";
  if (!draft.employeeNumber.trim()) errors.employeeNumber = "Gib die Personalnummer ein.";
  if (!draft.hireDate || !ISO_DAY_RE.test(draft.hireDate)) {
    errors.hireDate = "Wähle das Eintrittsdatum.";
  }
  if (draft.birthDate !== null && !ISO_DAY_RE.test(draft.birthDate)) {
    errors.birthDate = "Das Geburtsdatum ist nicht gültig.";
  }
  return errors;
}

function salonErrors(draft: CreatePersonDraft, ctx: CreateContext): StepErrors {
  return ctx.homeSalonRequired && draft.homeSalonId === ""
    ? { homeSalonId: "Wähle den Stammsalon." }
    : {};
}

function vertragErrors(draft: CreatePersonDraft): StepErrors {
  const errors: StepErrors = {};
  if (isWeeklyType(draft.scheduleType)) {
    const hours = draft.weeklyHours;
    if (hours === null || !Number.isFinite(hours) || hours <= 0 || hours > 60) {
      errors.weeklyHours = "Gib die Wochenstunden zwischen 0,5 und 60 ein.";
    }
  } else if (draft.monthlyHours !== null) {
    const hours = draft.monthlyHours;
    if (!Number.isFinite(hours) || hours < 0 || hours > 999) {
      errors.monthlyHours = "Gib die Monatsstunden zwischen 0 und 999 ein.";
    }
  }
  if (draft.scheduleType === "SHIFT_BASED") {
    const days = draft.contractWorkDays;
    if (!Number.isInteger(days) || days < 1 || days > 7) {
      errors.contractWorkDays = "Gib 1 bis 7 Arbeitstage pro Woche ein.";
    } else if (usualWorkDaysMissing(draft.scheduleType, draft.usualWorkDays)) {
      errors.usualWorkDays =
        "Bitte kreuze die üblichen Arbeitstage an - bei Schichtbetrieb Pflicht. Ohne Angabe kann die Person nicht angelegt werden.";
    } else if (usualWorkDaysShortfall(draft.usualWorkDays, days) > 0) {
      errors.usualWorkDays = `Bitte kreuze mindestens ${days} Tage an - so viele Arbeitstage hat der Vertrag. Sonst wird die Angabe beim Speichern abgelehnt.`;
    }
  }
  if (
    !Number.isFinite(draft.coverageWeight) ||
    draft.coverageWeight < 0 ||
    draft.coverageWeight > 9.99
  ) {
    errors.coverageWeight = "Das Schicht-Gewicht liegt zwischen 0 und 9,99.";
  }
  const vacation = draft.annualVacationDays;
  if (vacation !== null) {
    const minimum = statutoryMinimum(draft);
    if (!Number.isFinite(vacation) || vacation < 0.5 || vacation > 365) {
      errors.annualVacationDays = "Gib die Urlaubstage zwischen 0,5 und 365 ein.";
    } else if (vacation < minimum.days) {
      errors.annualVacationDays = `Unter dem gesetzlichen Mindesturlaub von ${minimum.days.toLocaleString(
        "de-DE",
        { maximumFractionDigits: 2 },
      )} Tagen (${minimum.law}) - das Speichern wird abgelehnt.`;
    }
  }
  return errors;
}

function einladungErrors(draft: CreatePersonDraft): StepErrors {
  return draft.usePassword && draft.password.length < 8
    ? { password: "Das Passwort braucht mindestens 8 Zeichen." }
    : {};
}

/** The field messages of one step; an empty object means the step may be left. */
export function validateStep(
  step: CreateStep,
  draft: CreatePersonDraft,
  ctx: CreateContext = EMPTY_CONTEXT,
): StepErrors {
  switch (step) {
    case "person":
      return personErrors(draft);
    case "salon-rolle":
      return salonErrors(draft, ctx);
    case "vertrag":
      return vertragErrors(draft);
    case "einladung":
      return einladungErrors(draft);
  }
}

/** The first step that still has a message, or null when the whole draft may be sent. */
export function firstInvalidStep(
  draft: CreatePersonDraft,
  ctx: CreateContext = EMPTY_CONTEXT,
): CreateStep | null {
  return (
    CREATE_STEPS.find((step) => Object.keys(validateStep(step, draft, ctx)).length > 0) ?? null
  );
}

/** An ISO day as the UTC-midnight instant the API stores for a calendar day. */
function dayInstant(isoDay: string): string {
  return `${isoDay}T00:00:00.000Z`;
}

/**
 * The `POST /employees` body. Keys and value shapes are those of the former single-form handler;
 * `homeSalonId` and `password` are added only when set.
 */
export function employeeCreatePayload(
  draft: CreatePersonDraft,
  ctx: CreateContext = EMPTY_CONTEXT,
): Record<string, unknown> {
  const type = draft.scheduleType;
  const payload: Record<string, unknown> = {
    email: draft.email.trim(),
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    employeeNumber: draft.employeeNumber.trim(),
    hireDate: dayInstant(draft.hireDate ?? ""),
    scheduleType: type,
    weeklyHours: isWeeklyType(type) ? draft.weeklyHours : 0,
    monthlyHours: type === "MONTHLY_HOURS" ? draft.monthlyHours : null,
    // FLEXTIME Kernarbeitszeit (Phase 49.2)
    coreStart: type === "FLEXTIME" ? draft.coreStart || null : null,
    coreEnd: type === "FLEXTIME" ? draft.coreEnd || null : null,
    coreDays: type === "FLEXTIME" ? draft.coreDays : [],
    // SHIFT_BASED contract day count and übliche Arbeitstage (Phase 436, Issue #481)
    contractWorkDaysPerWeek: type === "SHIFT_BASED" ? draft.contractWorkDays : null,
    ...buildUsualWorkDaysPayload(type, draft.usualWorkDays),
    // Personalstruktur (Phase 41)
    classification: draft.classification,
    coverageWeight: draft.coverageWeight,
    requiresSupervision: draft.requiresSupervision,
    birthDate: draft.birthDate ? dayInstant(draft.birthDate) : null,
    // Issue #482: a value equal to the classification's OWN Standard is sent as null, so the person
    // keeps following later changes of that Standard.
    annualVacationDays: annualVacationDaysPayload(
      draft.annualVacationDays,
      draft.classification,
      ctx.tenantDefaultVacationDays,
      ctx.tenantDefaultApprenticeVacationDays,
    ),
  };
  Object.assign(payload, homeSalonPayload(draft.homeSalonId));
  if (draft.usePassword && draft.password) payload.password = draft.password;
  return payload;
}
