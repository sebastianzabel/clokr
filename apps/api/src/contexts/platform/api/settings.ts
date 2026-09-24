import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireRole } from "../../../middleware/auth";
import { FederalState, type TenantConfig } from "@clokr/db";
import { encrypt } from "../../../utils/crypto";
// Phase 64b (issue #64, D-16): mirrors a storeHours change into the tenant's sole active salon.
import { syncSoleActiveSalonOpeningHours } from "../facade/salons";
// eslint-disable-next-line no-restricted-imports -- E-3: PUT /settings/work/:employeeId triggers saldo recalculation and shift cancellation as side effects of a contract change — same defect class as E-1. Disappears in Block 2 via a schedule-changed event. ADR 0001 Eintrag H.
import { recalculateSnapshots } from "../../working-time-account/recalculate-snapshots";
import {
  monthFirstRefinement,
  MONTH_FIRST_ERROR,
  MODEL_SWITCH_SAME_MONTH_ERROR,
  snapToMonthFirstUtc,
} from "../month-first-date";
import { normalizeWorkDays, type PerDayHours } from "../calculate-work-days";
import { accessContextFromRequest, employeeScopeFor } from "../access-context";
import { DEFAULT_MISSING_ENTRIES_DAYS } from "../../working-time-account"; // issue #246, E-6
import { getShiftsInRange, cancelOrphanShifts } from "../../scheduling"; // Phase 100B Plan 05 — S1/S3
import {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
} from "../../time-tracking"; // issue #246, E-6
import {
  BS_DAILY_MIN_BOUND,
  BS_DAILY_MAX_BOUND,
  BS_BLOCK_WEEKLY_MIN_BOUND,
  BS_BLOCK_WEEKLY_MAX_BOUND,
} from "../../absence"; // issue #246, E-6

const VALID_FEDERAL_STATES = Object.values(FederalState) as string[];

/**
 * A `Decimal` column round-tripped through this API's own GET.
 *
 * Prisma serialises `Decimal` as a STRING in JSON, so `GET /settings/work` answers
 * `"defaultWeeklyHours": "40.00"` — while this PUT schema declared `z.number()`. The admin forms
 * echo the whole config back on save (apps/web/.../admin/export sends
 * `{ ..._gOtherFields, datev… }`, where `_gOtherFields` is the untouched GET response), so the
 * API rejected its own output: ten Decimal columns at once, reported as a single bare
 * "Validierungsfehler" on a page that displays none of them.
 *
 * Accepting the string form is the narrow fix — it makes "read the config, send it back
 * unchanged" a property the API guarantees, which is the shape every settings form uses. The
 * pattern is deliberately strict (optional sign, digits, optional decimal part): unlike
 * `z.coerce.number()` it does not turn `true` into 1, `null` into 0, or `""` into 0, and any
 * bound declared after it still applies to the parsed number.
 */
const decimalFromApi = (schema: z.ZodType<number>) =>
  z.preprocess(
    (v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    schema,
  );

const tenantConfigSchema = z
  .object({
    tenantName: z.string().min(1).max(200).optional(),
    applyToExisting: z.boolean().optional(), // Auf bestehende MA ohne manuelle Änderung anwenden
    defaultWeeklyHours: decimalFromApi(z.number().min(1).max(60)).optional(),
    defaultMondayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultTuesdayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultWednesdayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultThursdayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultFridayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultSaturdayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    defaultSundayHours: decimalFromApi(z.number().min(0).max(24)).optional(),
    overtimeThreshold: decimalFromApi(z.number().min(1).max(500)).optional(),
    allowOvertimePayout: z.boolean().optional(),
    federalState: z
      .string()
      .refine((s) => VALID_FEDERAL_STATES.includes(s))
      .optional(),
    carryOverDeadlineDay: z.number().int().min(1).max(31).optional(),
    carryOverDeadlineMonth: z.number().int().min(1).max(12).optional(),
    defaultVacationDays: decimalFromApi(z.number().min(0.5).max(365).multipleOf(0.5)).optional(),
    timezone: z.string().min(1).max(100).optional(),
    arbzgEnabled: z.boolean().optional(),
    // Phase 47.3 — Verfügbarkeits-System toggle (default true, feature-on)
    availabilityEnabled: z.boolean().optional(),
    clockOutReminderHours: z.number().int().min(1).max(48).optional(),
    missingEntriesDays: z.number().int().min(1).max(90).optional(),
    autoDeleteOpenHours: z.number().int().min(0).max(168).optional(), // legacy name: actually invalidates, not deletes
    autoBreakEnabled: z.boolean().optional(),
    defaultBreakStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    // Heiligabend/Silvester
    christmasEveRule: z.enum(["NORMAL", "HALF_DAY", "FULL_DAY_OFF"]).optional(),
    newYearsEveRule: z.enum(["NORMAL", "HALF_DAY", "FULL_DAY_OFF"]).optional(),
    // `.nullable()` as well as `.optional()`: the column is nullable and the admin forms echo
    // the WHOLE config back on save (e.g. admin/export sends `{ ..._gOtherFields, datev… }`),
    // so an unset year arrives as an explicit `null`. With `.optional()` alone that null made
    // the entire PUT fail as a bare "Validierungsfehler" — on a page that does not even show
    // this field, which is why it read as "entering the DATEV numbers is broken". This was the
    // only one of the 23 nullable TenantConfig columns still missing it (measured against
    // schema.prisma, not assumed). See CLAUDE.md § Zod .optional() vs .nullable().
    holidayRulesValidFromYear: z.number().int().min(2020).max(2100).nullable().optional(),
    // Leave config
    vacationLeadTimeDays: z.number().int().min(0).max(365).optional(),
    vacationMaxAdvanceMonths: z.number().int().min(0).max(24).optional(),
    halfDayAllowed: z.boolean().optional(),
    sickSelfReport: z.boolean().optional(),
    // Phase 104 (D-22 / R4): § 5 Abs. 1 EFZG spricht wörtlich von "länger als drei
    // Kalendertage" — mehr als 3 ist kein zulässiger Schwellwert. Bereich daher 0-3
    // (vorher 1-30). 0 = jeder Krankheitstag ist nachweispflichtig.
    // Bestandszeilen mit Altwerten > 3 werden NICHT migriert (Revisionssicherheit) —
    // sie werden beim Lesen von normalizeKarenzDays() auf 3 geklammert.
    // Phase 104 review (WR-08): .nullable() as well as .optional(). Clokr frontends send
    // `field: x ? x : null`, and a cleared number input yields null via Svelte's bind:value —
    // with .optional() alone that null was a bare "Validierungsfehler" for the WHOLE page
    // (CLAUDE.md's Zod gotcha). null is normalized to the default 3 in the handler below —
    // the column is NOT NULL, so it must never reach Prisma as null.
    sickNoteRequiredAfterDays: z.number().int().min(0).max(3).nullable().optional(),
    // Part-time vacation
    autoCalcPartTimeVacation: z.boolean().optional(),
    fullTimeWorkDaysPerWeek: z.number().int().min(1).max(7).optional(),
    // Carry-over / statutory minimum
    enforceMinVacation: z.boolean().optional(),
    carryOverRequiresReason: z.boolean().optional(),
    vacationReminderStartMonth: z.number().int().min(1).max(12).optional(),
    // BUrlG § 7 Hinweispflicht (EuGH C-684/16) — threshold-based warnings
    carryoverWarningEnabled: z.boolean().optional(),
    carryoverWarningThresholds: z.array(z.number().int().min(1).max(365)).max(10).optional(),
    // Data retention (Phase 31 — ADM-03)
    // Minimum 2 years (§ 16 Abs. 2 ArbZG), default 10 years (§ 147 AO / § 257 HGB)
    dataRetentionYears: z.number().int().min(2).max(10).optional(),
    // Reminders
    reminderPendingLeaveHours: z.number().int().min(1).max(720).optional(),
    reminderUpcomingAbsenceDays: z.number().int().min(1).max(30).optional(),
    reminderPendingLeaveEnabled: z.boolean().optional(),
    reminderUpcomingAbsenceEnabled: z.boolean().optional(),
    // DATEV Lohnartennummern (Phase 4 — DATEV-03)
    datevNormalstundenNr: z.number().int().min(1).max(9999).optional(),
    datevUrlaubNr: z.number().int().min(1).max(9999).optional(),
    datevKrankNr: z.number().int().min(1).max(9999).optional(),
    datevSonderurlaubNr: z.number().int().min(1).max(9999).optional(),
    // Issue #256 (Befund 3) — the BeraterNr/MandantenNr pair of the DATEV [Allgemein] header.
    // `.nullable()` as well as `.optional()`: the Clokr admin forms send `x ? x : null`
    // and a cleared number input yields null via Svelte's bind:value — with `.optional()`
    // alone that null is a bare "Validierungsfehler" for the WHOLE page (CLAUDE.md's Zod
    // gotcha). The columns are nullable, so null passes straight through and means
    // "not configured", which the export refuses to guess around.
    // Upper bounds follow DATEV's own field widths: Beraternummer 7 digits,
    // Mandantennummer 5 digits.
    datevBeraterNr: z.number().int().min(1).max(9999999).nullable().optional(),
    datevMandantenNr: z.number().int().min(1).max(99999).nullable().optional(),
    // MONTHLY_HOURS Feiertagsabzug (Phase 15 — TENANT-01)
    monthlyHoursHolidayDeduction: z.boolean().optional(),
    // Ladenöffnungszeiten (Phase 42) — 7 entries Mo-So. Phase 64b (issue #64): deliberately the
    // pre-64b legacy schema, NOT the Salon facade's stricter salonOpeningHoursSchema — the admin UI
    // round-trips the stored value, and a stricter check would lock tenants whose stored hours it
    // rejects out of this whole settings section (review WR-03; D-04: legacy values are not
    // re-validated). `TenantConfig.storeHours` is DEPRECATED (no new code reads it, #325); this PUT
    // still writes it and mirrors a CHANGED value verbatim into a tenant's sole active salon (D-16,
    // see below), exactly as the migration copied it.
    storeHours: z
      .array(
        z.object({
          day: z.number().int().min(0).max(6),
          open: z.string().regex(/^\d{2}:\d{2}$/),
          close: z.string().regex(/^\d{2}:\d{2}$/),
          closed: z.boolean().optional(),
        }),
      )
      .length(7)
      .optional(),
    // Phase 47.5 — STRICT / DAY_ONLY / OFF
    shiftStoreHoursMode: z.enum(["STRICT", "DAY_ONLY", "OFF"]).optional(),
    // Phase 49.2 — FLEXTIME Kernarbeitszeit-Defaults (tenant-level pre-fill suggestion)
    defaultCoreStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    defaultCoreEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    defaultCoreDays: z.array(z.number().int().min(0).max(6)).optional(),
    // Phase 49.5 — Standard-Arbeitstage Mo-So (Tenant-Default)
    defaultWorkDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Mindestens ein Arbeitstag muss aktiv sein")
      .max(7)
      .optional(),
    // Phase 63 D-02 / D-24 — per-tenant Berufsschule duration.
    // Bounds: 240..600 daily (4h..10h, ArbZG-compatible); 1200..3000 weekly
    // (20h..50h block-week cap). Values mirrored in
    // apps/api/src/utils/vocational-school-constants.ts so a fail-open lookup
    // matches schema @default(...) exactly.
    vocationalSchoolMinutesPerDay: z
      .number()
      .int()
      .min(240, "Berufsschul-Tagesdauer muss mindestens 240 Min (4h) sein")
      .max(600, "Berufsschul-Tagesdauer darf höchstens 600 Min (10h) sein")
      .optional(),
    vocationalSchoolBlockMinutesPerWeek: z
      .number()
      .int()
      .min(1200, "Berufsschul-Block pro Woche muss mindestens 1200 Min (20h) sein")
      .max(3000, "Berufsschul-Block pro Woche darf höchstens 3000 Min (50h) sein")
      .optional(),
    // Phase 76.31 D-06 — 4-layer bsSlot* override hierarchy (TenantConfig layer).
    // Nullable: an explicit null CLEARS the tenant override so resolution delegates
    // down to the daily-Soll fallback. Daily bounds 240..600 (4h..10h);
    // block-week bounds 1200..3000 (20h..50h). Bounds constants mirror
    // apps/api/src/utils/vocational-school-constants.ts (single source of truth).
    bsSlotFirstLongDayMinutes: z
      .number()
      .int()
      .min(BS_DAILY_MIN_BOUND)
      .max(BS_DAILY_MAX_BOUND)
      .nullable()
      .optional(),
    bsSlotSecondLongDayMinutes: z
      .number()
      .int()
      .min(BS_DAILY_MIN_BOUND)
      .max(BS_DAILY_MAX_BOUND)
      .nullable()
      .optional(),
    bsSlotShortDayMinutes: z
      .number()
      .int()
      .min(BS_DAILY_MIN_BOUND)
      .max(BS_DAILY_MAX_BOUND)
      .nullable()
      .optional(),
    bsSlotBlockWeekMinutes: z
      .number()
      .int()
      .min(BS_BLOCK_WEEKLY_MIN_BOUND)
      .max(BS_BLOCK_WEEKLY_MAX_BOUND)
      .nullable()
      .optional(),
    // Phase 64 — Pausendauer (D-07, BREAK-04): per-tenant default auto-break duration.
    // Floor enforces ArbZG §4 Pflichtpause (30/45 Min); cap is a sane upper bound
    // (2h/3h). Defaults 30/45 in schema match the floors → no behavior change for
    // tenants who never edit. Constants live in apps/api/src/utils/break-constants.ts.
    defaultBreakOver6h: z
      .number()
      .int()
      .min(
        ARBZG_FLOOR_OVER_6H,
        "Pausendauer für Arbeitstage über 6 Stunden darf nicht unter 30 Minuten liegen (ArbZG §4 Pflichtpause).",
      )
      .max(
        BREAK_MAX_OVER_6H,
        "Pausendauer für Arbeitstage über 6 Stunden darf 120 Minuten nicht überschreiten.",
      )
      .optional(),
    defaultBreakOver9h: z
      .number()
      .int()
      .min(
        ARBZG_FLOOR_OVER_9H,
        "Pausendauer für Arbeitstage über 9 Stunden darf nicht unter 45 Minuten liegen (ArbZG §4 Pflichtpause).",
      )
      .max(
        BREAK_MAX_OVER_9H,
        "Pausendauer für Arbeitstage über 9 Stunden darf 180 Minuten nicht überschreiten.",
      )
      .optional(),
    // Phase 93.06 — v1.9.3 Pausen-Enforcement (BREAK-05 / BREAK-01).
    // enforceBreakConfirmation gates whether employees must confirm/adjust/mark
    // auto-inserted mandatory breaks as "durchgearbeitet"; when off the check is
    // advisory-only. blockMonthCloseOnUnconfirmedBreak escalates unconfirmed
    // breaks from a warning to a hard Monatsabschluss block (only meaningful
    // when enforceBreakConfirmation is on). Both flow into the PUT /work upsert
    // via the ...configBody spread; schema @default(false).
    enforceBreakConfirmation: z.boolean().optional(),
    blockMonthCloseOnUnconfirmedBreak: z.boolean().optional(),
    // Phase 76.29 — CFG-01: Retro-entry window (RETRO-01).
    // How many calendar days back an employee can create or edit time entries without
    // an approved RetroEntryRequest. Default 10 days (see retro-config.ts).
    // Bounds: min 1 (same-day only), max 90 (~3 months, ArbZG §16 audit window floor).
    retroEntryWindowDays: z
      .number()
      .int()
      .min(1, "Rückerfassungszeitraum muss mindestens 1 Tag betragen.")
      .max(90, "Rückerfassungszeitraum darf höchstens 90 Tage betragen.")
      .optional(),
    // Phase 76.28 / 76.29 — CFG-01: Allow closing a month that has gap days
    // (days with no time entry on scheduled workdays). When false, the
    // Monatsabschluss is blocked until all gaps are resolved.
    closeMonthWithGapsAllowed: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // Half-null guard: defaultCoreStart and defaultCoreEnd must be set together or both absent
    if (
      (data.defaultCoreStart && !data.defaultCoreEnd) ||
      (!data.defaultCoreStart && data.defaultCoreEnd)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCoreEnd"],
        message: "Kernzeitbeginn und Kernzeitende müssen gemeinsam gesetzt oder beide leer sein",
      });
    }
    // Both present: coreEnd must be strictly after coreStart (HH:MM string comparison)
    if (
      data.defaultCoreStart &&
      data.defaultCoreEnd &&
      data.defaultCoreEnd <= data.defaultCoreStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCoreEnd"],
        message: "Kernzeitende muss nach Kernzeitbeginn liegen",
      });
    }
  });

export const employeeScheduleSchema = z
  .object({
    type: z
      .enum(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED"])
      .default("FIXED_SCHEDULE"),
    weeklyHours: z.number().min(0).max(60).nullable().optional().default(40),
    monthlyHours: z.number().min(0).max(999).nullable().optional(),
    mondayHours: z.number().min(0).max(24).default(8),
    tuesdayHours: z.number().min(0).max(24).default(8),
    wednesdayHours: z.number().min(0).max(24).default(8),
    thursdayHours: z.number().min(0).max(24).default(8),
    fridayHours: z.number().min(0).max(24).default(8),
    saturdayHours: z.number().min(0).max(24).default(0),
    sundayHours: z.number().min(0).max(24).default(0),
    overtimeThreshold: z.number().min(0).max(500).default(60),
    allowOvertimePayout: z.boolean().default(false),
    overtimeMode: z.enum(["CARRY_FORWARD", "TRACK_ONLY"]).default("CARRY_FORWARD"),
    // Phase 100 (T-100-01): upper-bounded at 999h (= 59_940 min), matching the max="999" the
    // shipped admin form already advertises (apps/web .../admin/vacation/+page.svelte). Without
    // this bound an ADMIN could set a figure large enough that the OVERTIME_COMP gate
    // (leave.ts) can mathematically never reject — turning the control into a silent no-op
    // while it still reads as "configured".
    maxNegativeBalanceMinutes: z
      .number()
      .int()
      .min(0)
      .max(999 * 60)
      .nullable()
      .optional(),
    // Phase 49.1 — FLEXTIME Kernarbeitszeit (all optional; UI metadata only)
    coreStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    coreEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
      .nullable()
      .optional(),
    coreDays: z.array(z.number().int().min(0).max(6)).optional().default([]),
    // Phase 49.5 — Arbeitstage/Woche (unabhängig vom AZ-Modell)
    workDays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Mindestens ein Arbeitstag muss aktiv sein")
      .max(7)
      .optional(),
    // Phase 107 (D-01, issue #94) — vertragliche Anzahl Arbeitstage/Woche, NUR für
    // SHIFT_BASED befüllt. .optional().nullable() (not bare .optional()): this
    // project's Svelte forms send `field: x ? x : null`, and a bare .optional() 400s
    // the whole payload on an explicit null (documented Zod gotcha). Bounds mirror
    // fullTimeWorkDaysPerWeek above verbatim.
    contractWorkDaysPerWeek: z.number().int().min(1).max(7).optional().nullable(),
    validFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(monthFirstRefinement, { message: MONTH_FIRST_ERROR })
      .optional(),
    // Phase 49.3 — Orphan-Shift-Lifecycle: when switching away from SHIFT_BASED,
    // caller must explicitly choose what to do with future shifts.
    // Exactly one (or neither) of these flags may be true.
    keepOrphanShifts: z.boolean().optional(),
    cancelOrphanShifts: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // SHIFT_BASED and FLEXTIME both require weeklyHours > 0 (weekly-target models)
    if (
      (data.type === "SHIFT_BASED" || data.type === "FLEXTIME") &&
      (!data.weeklyHours || data.weeklyHours <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["weeklyHours"],
        message: "Wochenstunden-Soll muss größer als 0 sein",
      });
    }
    // FLEXTIME Kernarbeitszeit cross-field: must be set together or both empty.
    // Half-null case (only one provided) is invalid — would leave a dangling Kernzeit.
    if ((data.coreStart && !data.coreEnd) || (!data.coreStart && data.coreEnd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coreEnd"],
        message: "Kernzeitbeginn und Kernzeitende müssen gemeinsam gesetzt oder beide leer sein",
      });
    }
    // Both present: coreEnd must be strictly greater than coreStart
    // (string comparison works for HH:MM)
    if (data.coreStart && data.coreEnd && data.coreEnd <= data.coreStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coreEnd"],
        message: "Kernzeitende muss nach Kernzeitbeginn liegen",
      });
    }
    // Phase 49.3 — keepOrphanShifts and cancelOrphanShifts are mutually exclusive
    if (data.keepOrphanShifts && data.cancelOrphanShifts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cancelOrphanShifts"],
        message: "keepOrphanShifts und cancelOrphanShifts schließen sich gegenseitig aus",
      });
    }
  });

// ── PUT/GET /api/v1/settings/security — the writable field set, stated ONCE ──────────────────────
//
// Issue #148: the audit row of `PUT /settings/security` used to carry a hand-written, three-field
// `oldValue` (twoFaEnabled, passwordMinLength, maxNegativeBalanceMinutes) while the very same
// request could write twenty-two fields — the e-mail notification flags among them. For nineteen
// fields the before-state was therefore not reconstructible from the trail, against CLAUDE.md
// § Audit-Proof ("before/after values", "who changed what, when and why").
//
// The hand-written list IS the defect: it is a second statement of the writable set that nothing
// forced to stay in step with the schema. So the schema below is the single source of that set,
// and `projectSecuritySettings()` is the single projection that GET, the PUT response and the
// audit row's oldValue/newValue all share. Adding a field to the schema without extending the
// projection is now a compile error, not a silent hole in the trail.
export const securitySettingsSchema = z.object({
  twoFaEnabled: z.boolean().optional(),
  passwordMinLength: z.number().int().min(8).max(128).optional(),
  passwordRequireUpper: z.boolean().optional(),
  passwordRequireLower: z.boolean().optional(),
  passwordRequireDigit: z.boolean().optional(),
  passwordRequireSpecial: z.boolean().optional(),
  // Phase 100 (T-100-01): same upper bound as employeeScheduleSchema above — the
  // tenant-wide default must not be settable beyond what the admin form advertises
  // either, or a tenant default alone could turn the OVERTIME_COMP gate into a no-op.
  maxNegativeBalanceMinutes: z
    .number()
    .int()
    .min(0)
    .max(999 * 60)
    .nullable()
    .optional(),
  emailNotificationsEnabled: z.boolean().optional(),
  emailOnLeaveRequest: z.boolean().optional(),
  emailOnLeaveDecision: z.boolean().optional(),
  emailOnOvertimeWarning: z.boolean().optional(),
  emailOnMissingEntries: z.boolean().optional(),
  emailOnClockOutReminder: z.boolean().optional(),
  emailOnMonthClose: z.boolean().optional(),
  emailOnRetroEntry: z.boolean().optional(),
  sessionTimeoutMinutes: z.number().int().min(0).max(480).optional(),
  refreshTokenDays: z.number().int().min(1).max(90).optional(),
  rememberMeEnabled: z.boolean().optional(),
  rememberMeDays: z.number().int().min(1).max(365).optional(),
  maxSessionsPerUser: z.number().int().min(0).max(20).optional(),
  loginMaxAttempts: z.number().int().min(1).max(20).optional(),
  loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
});

/** Every field the security request can write, with `undefined` stripped — the shape of a
 *  fully-resolved security-settings view. */
export type SecuritySettings = Required<z.infer<typeof securitySettingsSchema>>;

/** What each field reports for a tenant that has no TenantConfig row yet. Mirrors the
 *  `@default()` of the matching column in packages/db/prisma/schema.prisma, so a read of an
 *  absent row reports what a write would have found. The `SecuritySettings` annotation is the
 *  gate: a field added to `securitySettingsSchema` without a default here fails `tsc`, which is
 *  what keeps the projection from ever falling behind the writable set again (issue #148). */
export const SECURITY_SETTINGS_DEFAULTS: SecuritySettings = {
  twoFaEnabled: false,
  passwordMinLength: 12,
  passwordRequireUpper: true,
  passwordRequireLower: true,
  passwordRequireDigit: true,
  passwordRequireSpecial: true,
  maxNegativeBalanceMinutes: null,
  emailNotificationsEnabled: false,
  emailOnLeaveRequest: true,
  emailOnLeaveDecision: true,
  emailOnOvertimeWarning: false,
  emailOnMissingEntries: false,
  emailOnClockOutReminder: false,
  emailOnMonthClose: true,
  emailOnRetroEntry: true,
  sessionTimeoutMinutes: 60,
  refreshTokenDays: 7,
  rememberMeEnabled: true,
  rememberMeDays: 30,
  maxSessionsPerUser: 0,
  loginMaxAttempts: 5,
  loginLockoutMinutes: 15,
};

/** The writable field set of `PUT /settings/security`, derived — never re-typed. */
export const SECURITY_SETTINGS_FIELDS = Object.keys(
  SECURITY_SETTINGS_DEFAULTS,
) as (keyof SecuritySettings)[];

/** Reads every writable security field off `cfg`, falling back to the column default where the
 *  row is absent or the column is null. Used for GET, for the PUT response and for BOTH sides of
 *  the audit row, so the trail can never describe fewer fields than the request can change. */
export function projectSecuritySettings(cfg: TenantConfig | null): SecuritySettings {
  const out: Record<string, unknown> = {};
  for (const field of SECURITY_SETTINGS_FIELDS) {
    const stored = cfg?.[field];
    out[field] =
      stored === undefined || stored === null ? SECURITY_SETTINGS_DEFAULTS[field] : stored;
  }
  return out as SecuritySettings;
}

export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/v1/settings/work  — globale Vorgaben
  app.get("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const [config, tenant] = await Promise.all([
        app.prisma.tenantConfig.findUnique({ where: { tenantId } }),
        app.prisma.tenant.findUnique({ where: { id: tenantId } }),
      ]);

      const base = config ?? {
        tenantId,
        defaultWeeklyHours: 40,
        defaultMondayHours: 8,
        defaultTuesdayHours: 8,
        defaultWednesdayHours: 8,
        defaultThursdayHours: 8,
        defaultFridayHours: 8,
        defaultSaturdayHours: 0,
        defaultSundayHours: 0,
        overtimeThreshold: 60,
        allowOvertimePayout: false,
        carryOverDeadlineDay: 31,
        carryOverDeadlineMonth: 3,
        defaultVacationDays: 30,
        arbzgEnabled: true,
        availabilityEnabled: true,
        clockOutReminderHours: 10,
        missingEntriesDays: DEFAULT_MISSING_ENTRIES_DAYS,
        autoDeleteOpenHours: 14,
        autoBreakEnabled: false,
        defaultBreakStart: null,
        christmasEveRule: "NORMAL",
        newYearsEveRule: "NORMAL",
        holidayRulesValidFromYear: new Date().getFullYear(),
        vacationLeadTimeDays: 0,
        vacationMaxAdvanceMonths: 0,
        halfDayAllowed: true,
        sickSelfReport: true,
        sickNoteRequiredAfterDays: 3,
        autoCalcPartTimeVacation: true,
        fullTimeWorkDaysPerWeek: 5,
        enforceMinVacation: true,
        carryOverRequiresReason: true,
        vacationReminderStartMonth: 10,
        reminderPendingLeaveHours: 48,
        reminderUpcomingAbsenceDays: 3,
        reminderPendingLeaveEnabled: true,
        reminderUpcomingAbsenceEnabled: true,
        datevNormalstundenNr: 100,
        datevUrlaubNr: 300,
        datevKrankNr: 200,
        datevSonderurlaubNr: 302,
        // Issue #256 (Befund 3): no default — an unset Berater-/Mandantennummer must stay
        // visibly unset so the export can refuse, not silently become a usable-looking 0.
        datevBeraterNr: null,
        datevMandantenNr: null,
        monthlyHoursHolidayDeduction: false,
        dataRetentionYears: 10,
        carryoverWarningEnabled: true,
        carryoverWarningThresholds: [60, 30, 14, 7],
        storeHours: [
          { day: 0, open: "08:00", close: "20:00" },
          { day: 1, open: "08:00", close: "20:00" },
          { day: 2, open: "08:00", close: "20:00" },
          { day: 3, open: "08:00", close: "20:00" },
          { day: 4, open: "08:00", close: "20:00" },
          { day: 5, open: "08:00", close: "20:00" },
          { day: 6, open: "08:00", close: "20:00", closed: true },
        ],
        shiftStoreHoursMode: "DAY_ONLY",
        defaultCoreStart: null,
        defaultCoreEnd: null,
        defaultCoreDays: [],
        // Phase 49.5 — Tenant-Default Arbeitstage (Mo-Fr)
        defaultWorkDays: [1, 2, 3, 4, 5],
        // Phase 63 D-02 / D-24 — Berufsschule defaults (mirror schema @default).
        vocationalSchoolMinutesPerDay: 480,
        vocationalSchoolBlockMinutesPerWeek: 2400,
        // Phase 64 D-07 — Pausendauer defaults (mirror schema @default 30/45).
        defaultBreakOver6h: 30,
        defaultBreakOver9h: 45,
        // Phase 85.1.1 (D-03) — Phorest Vor-/Nachbereitungszeit tenant defaults
        // (mirror schema @default 0), exposed so the per-employee UI inherit
        // hint can show "leer = Firmenstandard (X Min.)".
        phorestPrepMinutes: 0,
        phorestWrapupMinutes: 0,
      };

      return {
        ...base,
        federalState: tenant?.federalState ?? "NIEDERSACHSEN",
        tenantName: tenant?.name ?? "",
        // Phase 63 D-24 — fail-open defaults when config row has null/missing values.
        // The spread above carries through when the column has a value; these ??-falls
        // catch the "config row exists but column is null/undefined" path.
        vocationalSchoolMinutesPerDay:
          (base as { vocationalSchoolMinutesPerDay?: number | null })
            .vocationalSchoolMinutesPerDay ?? 480,
        vocationalSchoolBlockMinutesPerWeek:
          (base as { vocationalSchoolBlockMinutesPerWeek?: number | null })
            .vocationalSchoolBlockMinutesPerWeek ?? 2400,
        // Phase 64 D-07 — fail-open break defaults (mirror schema @default 30/45).
        defaultBreakOver6h:
          (base as { defaultBreakOver6h?: number | null }).defaultBreakOver6h ?? 30,
        defaultBreakOver9h:
          (base as { defaultBreakOver9h?: number | null }).defaultBreakOver9h ?? 45,
        // Phase 85.1.1 (D-03) — fail-open Phorest puffer tenant defaults (mirror
        // schema @default 0). The ...base spread above already carries the real
        // values when the config row exists; this guarantees the keys are always
        // present for the per-employee UI inherit hint.
        phorestPrepMinutes:
          (base as { phorestPrepMinutes?: number | null }).phorestPrepMinutes ?? 0,
        phorestWrapupMinutes:
          (base as { phorestWrapupMinutes?: number | null }).phorestWrapupMinutes ?? 0,
      };
    },
  });

  // PUT /api/v1/settings/work  — globale Vorgaben speichern (nur Admin)
  app.put("/work", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = tenantConfigSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      // Phase 64 (D-11): Snapshot pre-change break-default values so the
      // dedicated BREAK_DEFAULT_CHANGED audit row below carries a stable
      // before-image even if the upsert later mutates the row in place.
      const previousConfig = await app.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: { defaultBreakOver6h: true, defaultBreakOver9h: true },
      });

      // federalState and tenantName belong to Tenant, not to TenantConfig (D-17: renaming the
      // tenant here never renames its default salon — the salon's name is its own master data
      // once created).
      const {
        federalState,
        tenantName,
        applyToExisting,
        sickNoteRequiredAfterDays,
        ...configBody
      } = body;

      // Phase 104 review (WR-08): the Zod field now accepts an explicit null (Clokr frontends
      // send `x ? x : null`, and clearing the number input yields null via Svelte's
      // bind:value), but the column is `Int @default(3)` NOT NULL — passing the null straight
      // through to Prisma would trade the bare 400 for a 500. null means "cleared" and resets
      // to the documented default, which is what the form's hint ("Standard: 3") promises.
      // An OMITTED key stays omitted, so an unrelated PUT never touches the value.
      const configData = {
        ...configBody,
        ...(sickNoteRequiredAfterDays !== undefined
          ? { sickNoteRequiredAfterDays: sickNoteRequiredAfterDays ?? 3 }
          : {}),
      };

      // Build tenant update data (name + federalState live on Tenant model)
      const tenantUpdate: Record<string, unknown> = {};
      if (federalState) tenantUpdate.federalState = federalState as FederalState;
      if (tenantName !== undefined) tenantUpdate.name = tenantName;

      // Phase 64b (issue #64, D-16, research Pitfall 1): the tenantConfig upsert, the optional
      // tenant update, and — ONLY when this PUT CHANGES storeHours — the D-16 salon mirror plus
      // its own UPDATE Salon audit row all run in ONE transaction, so a mirror failure rolls back
      // the tenantConfig write too. The applyToExisting employee loop below and the
      // TenantConfig/BREAK_DEFAULT_CHANGED audits stay OUTSIDE this transaction — separate,
      // pre-existing code paths this task does not widen the lock scope around.
      const config = await app.prisma.$transaction(async (tx) => {
        // Review WR-02: the tenant value BEFORE this write. The admin UI resends the full week on
        // every save of its section (also when only shiftStoreHoursMode changed), so "the body
        // carries storeHours" is not "storeHours changed" — mirroring on the former would
        // overwrite a salon edited via PATCH /api/v1/salons/:id with the unchanged tenant value.
        const previousTenantHours =
          configData.storeHours === undefined
            ? undefined
            : (
                await tx.tenantConfig.findUnique({
                  where: { tenantId },
                  select: { storeHours: true },
                })
              )?.storeHours;

        const upserted = await tx.tenantConfig.upsert({
          where: { tenantId },
          update: configData,
          create: { tenantId, ...configData },
        });

        if (Object.keys(tenantUpdate).length > 0) {
          await tx.tenant.update({
            where: { id: tenantId },
            data: tenantUpdate,
          });
        }

        const hours = configData.storeHours;
        if (hours !== undefined) {
          const mirrored = await syncSoleActiveSalonOpeningHours(tx, tenantId, {
            previousTenantHours,
            openingHours: hours,
          });
          if (mirrored) {
            await app.audit({
              userId: req.user.sub,
              action: "UPDATE",
              entity: "Salon",
              entityId: mirrored.updated.id,
              oldValue: mirrored.existing,
              newValue: mirrored.updated,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
              tx,
            });
          }
        }

        return upserted;
      });

      // Auf bestehende MA anwenden: Neue Schedule-Version für alle MA,
      // deren aktueller Schedule noch den alten Defaults entspricht
      let appliedCount = 0;
      // Phase 76.24 (D-01) — tracks employees skipped due to same-month model-switch
      // collision (existing row at validFrom has a different type than FIXED_SCHEDULE).
      // Returned in the response so operators can handle them via the single-employee path.
      let skippedModelSwitch = 0;
      if (applyToExisting) {
        const employees = await app.prisma.employee.findMany({
          where: { tenantId },
          include: { workSchedules: { orderBy: { validFrom: "desc" }, take: 1 } },
        });

        // Phase 60 (#220) — bulk apply MUST write month-1st validFrom so the contract
        // change is unambiguous at the saldo engine. Snap once here, reuse in both
        // branches below (employees-without-schedule + FIXED_SCHEDULE update).
        const now = snapToMonthFirstUtc(new Date());
        for (const emp of employees) {
          const current = emp.workSchedules[0];
          if (!current) {
            // MA ohne Schedule → neuen mit Defaults erstellen
            // Phase 61 (v1.6.5) — workDays MUST be derived from the per-day-hours
            // we're writing. Bulk-apply has no per-employee body, so we use the
            // tenant defaults that are about to be persisted. tenantConfig
            // defaultWorkDays acts as the fallback when defaults are all-zero.
            const noScheduleHours: PerDayHours = {
              mondayHours: configBody.defaultMondayHours ?? 8,
              tuesdayHours: configBody.defaultTuesdayHours ?? 8,
              wednesdayHours: configBody.defaultWednesdayHours ?? 8,
              thursdayHours: configBody.defaultThursdayHours ?? 8,
              fridayHours: configBody.defaultFridayHours ?? 8,
              saturdayHours: configBody.defaultSaturdayHours ?? 0,
              sundayHours: configBody.defaultSundayHours ?? 0,
            };
            const created = await app.prisma.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: "FIXED_SCHEDULE",
                weeklyHours: configBody.defaultWeeklyHours ?? 40,
                mondayHours: noScheduleHours.mondayHours as number,
                tuesdayHours: noScheduleHours.tuesdayHours as number,
                wednesdayHours: noScheduleHours.wednesdayHours as number,
                thursdayHours: noScheduleHours.thursdayHours as number,
                fridayHours: noScheduleHours.fridayHours as number,
                saturdayHours: noScheduleHours.saturdayHours as number,
                sundayHours: noScheduleHours.sundayHours as number,
                overtimeThreshold: configBody.overtimeThreshold ?? 60,
                allowOvertimePayout: configBody.allowOvertimePayout ?? false,
                workDays: normalizeWorkDays(undefined, noScheduleHours, configBody.defaultWorkDays),
                validFrom: now,
              },
            });
            await app.audit({
              userId: req.user.sub,
              action: "CREATE",
              entity: "WorkSchedule",
              entityId: created.id,
              newValue: created,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            appliedCount++;
          } else if (current.type === "FIXED_SCHEDULE") {
            // Nur FIXED_SCHEDULE MA updaten (nicht Minijobber)

            // Phase 76.24 (D-01 / T-76.24-03) — same-month type-change collision guard.
            // Bulk apply always writes FIXED_SCHEDULE at `now` (month-1st). If a row
            // already exists at that validFrom with a DIFFERENT type, skip this employee
            // to prevent a silent overwrite of their AZ-model history. Surface skipped
            // employees via `skippedModelSwitch` in the response body so the operator
            // can handle them individually via PUT /settings/work/:employeeId.
            const existingAtNow = await app.prisma.workSchedule.findFirst({
              where: { employeeId: emp.id, validFrom: now },
              select: { type: true },
            });
            if (existingAtNow && existingAtNow.type !== "FIXED_SCHEDULE") {
              skippedModelSwitch++;
              continue;
            }

            // Phase 61 (v1.6.5) — same as above: derive workDays from the
            // per-day-hours that are actually being written for this employee.
            const updateHours: PerDayHours = {
              mondayHours: configBody.defaultMondayHours ?? Number(current.mondayHours),
              tuesdayHours: configBody.defaultTuesdayHours ?? Number(current.tuesdayHours),
              wednesdayHours: configBody.defaultWednesdayHours ?? Number(current.wednesdayHours),
              thursdayHours: configBody.defaultThursdayHours ?? Number(current.thursdayHours),
              fridayHours: configBody.defaultFridayHours ?? Number(current.fridayHours),
              saturdayHours: configBody.defaultSaturdayHours ?? Number(current.saturdayHours),
              sundayHours: configBody.defaultSundayHours ?? Number(current.sundayHours),
            };
            const created = await app.prisma.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: "FIXED_SCHEDULE",
                weeklyHours: configBody.defaultWeeklyHours ?? Number(current.weeklyHours),
                mondayHours: updateHours.mondayHours as number,
                tuesdayHours: updateHours.tuesdayHours as number,
                wednesdayHours: updateHours.wednesdayHours as number,
                thursdayHours: updateHours.thursdayHours as number,
                fridayHours: updateHours.fridayHours as number,
                saturdayHours: updateHours.saturdayHours as number,
                sundayHours: updateHours.sundayHours as number,
                overtimeThreshold:
                  configBody.overtimeThreshold ?? Number(current.overtimeThreshold),
                allowOvertimePayout: configBody.allowOvertimePayout ?? current.allowOvertimePayout,
                workDays: normalizeWorkDays(undefined, updateHours, configBody.defaultWorkDays),
                validFrom: now,
              },
            });
            await app.audit({
              userId: req.user.sub,
              action: "CREATE",
              entity: "WorkSchedule",
              entityId: created.id,
              oldValue: current,
              newValue: created,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });
            appliedCount++;
          }
        }
      }

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: config.id,
        newValue: { ...body, appliedCount },
      });

      // Phase 64 (D-11): Dedicated audit row for break-default changes — emitted
      // ONLY when the PUT body actually changed at least one of the two fields.
      // A no-op PUT (body field absent or identical to previous) does NOT emit.
      const newOver6h = configBody.defaultBreakOver6h;
      const newOver9h = configBody.defaultBreakOver9h;
      const changedOver6h =
        newOver6h !== undefined && newOver6h !== previousConfig?.defaultBreakOver6h;
      const changedOver9h =
        newOver9h !== undefined && newOver9h !== previousConfig?.defaultBreakOver9h;
      if (changedOver6h || changedOver9h) {
        await app.audit({
          userId: req.user.sub,
          action: "BREAK_DEFAULT_CHANGED",
          entity: "TenantConfig",
          entityId: config.id,
          oldValue: {
            defaultBreakOver6h: previousConfig?.defaultBreakOver6h ?? null,
            defaultBreakOver9h: previousConfig?.defaultBreakOver9h ?? null,
          },
          newValue: {
            defaultBreakOver6h: changedOver6h
              ? newOver6h
              : (previousConfig?.defaultBreakOver6h ?? null),
            defaultBreakOver9h: changedOver9h
              ? newOver9h
              : (previousConfig?.defaultBreakOver9h ?? null),
          },
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
      }

      // Phase 76.34 (SC-3) — non-blocking over-crediting warning. §15 Abs. 2 BBiG:
      // the FIRST BS-Langtag credits the full daily Soll; the 2nd Langtag and the
      // Kurztag are "at most" that. A CONFIGURED bsSlotSecondLongDayMinutes /
      // bsSlotShortDayMinutes that exceeds the CONFIGURED bsSlotFirstLongDayMinutes
      // (the 1st-long-day / daily-Soll ceiling) over-credits the shorter slot. We do
      // NOT block the save (over-crediting is never bußgeldbewehrt) — surface a German
      // warning so the admin can confirm the intent.
      const warnings: string[] = [];
      const firstCeiling = config.bsSlotFirstLongDayMinutes;
      if (firstCeiling != null) {
        if (
          config.bsSlotSecondLongDayMinutes != null &&
          config.bsSlotSecondLongDayMinutes > firstCeiling
        ) {
          warnings.push(
            `Der 2. Berufsschul-Langtag (${config.bsSlotSecondLongDayMinutes} Min) ist höher angesetzt als der 1. Berufsschul-Langtag (${firstCeiling} Min). Nach §15 Abs. 2 BBiG sollte der 2. Langtag höchstens dem individuellen Tages-Soll entsprechen. Bitte prüfen.`,
          );
        }
        if (config.bsSlotShortDayMinutes != null && config.bsSlotShortDayMinutes > firstCeiling) {
          warnings.push(
            `Der Berufsschul-Kurztag (${config.bsSlotShortDayMinutes} Min) ist höher angesetzt als der 1. Berufsschul-Langtag (${firstCeiling} Min). Nach §15 Abs. 2 BBiG sollte der Kurztag höchstens dem individuellen Tages-Soll entsprechen. Bitte prüfen.`,
          );
        }
      }

      return {
        ...config,
        federalState: federalState ?? undefined,
        appliedCount,
        skippedModelSwitch,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  });

  // GET /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters
  app.get("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireAuth,
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };
      const isManager = ["ADMIN", "MANAGER"].includes(req.user.role);

      if (!isManager && req.user.employeeId !== employeeId) {
        return reply.code(403).send({ error: "Kein Zugriff" });
      }

      // Phase 100 (CR-01 fix, code review) — tenant isolation guard, mirroring the PUT
      // handler below (T-100-02) verbatim in structure. This route returns
      // maxNegativeBalanceMinutes, a real entitlement input since this phase — an
      // ADMIN/MANAGER of one tenant must not be able to read another tenant's
      // employee's WorkSchedule. The 404 body is IDENTICAL to the genuine
      // not-found branch below so this endpoint cannot be used as a
      // tenant-membership oracle (T-100-09).
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        if (employee) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "WorkSchedule",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Kein Arbeitszeitmodell gefunden" });
      }

      const schedule = await app.prisma.workSchedule.findFirst({
        where: { employeeId },
        orderBy: { validFrom: "desc" },
      });
      if (!schedule) return reply.code(404).send({ error: "Kein Arbeitszeitmodell gefunden" });

      return schedule;
    },
  });

  // PUT /api/v1/settings/work/:employeeId  — Arbeitszeit eines Mitarbeiters setzen
  app.put("/work/:employeeId", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const access = accessContextFromRequest(req);
      const { employeeId } = req.params as { employeeId: string };
      const body = employeeScheduleSchema.parse(req.body);

      const employee = await app.prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });

      // Phase 100 (T-100-02): tenant isolation guard, mirroring overtime.ts:85-97 verbatim in
      // structure. This route now writes maxNegativeBalanceMinutes, which was inert
      // configuration until this phase and is now an input to the OVERTIME_COMP entitlement
      // gate — an ADMIN/MANAGER of one tenant must not be able to alter another tenant's
      // employee's booking limit (or any other WorkSchedule field). The 404 body is IDENTICAL
      // to the not-found branch above so this endpoint cannot be used as a tenant-membership
      // oracle (T-100-09).
      if (employee.tenantId !== req.user.tenantId) {
        await app.audit({
          userId: req.user.sub,
          action: "CROSS_TENANT_ACCESS_DENIED",
          entity: "WorkSchedule",
          entityId: employeeId,
          request: { ip: req.ip, headers: req.headers as Record<string, string> },
        });
        return reply.code(404).send({ error: "Mitarbeiter nicht gefunden" });
      }

      // Phase 60 (#220) — when caller omits validFrom we default to the 1st of the
      // current UTC month, so the saldo engine sees an unambiguous month boundary.
      // (When caller PROVIDES validFrom, the Zod refinement above already enforced it.)
      const validFrom = body.validFrom ? new Date(body.validFrom) : snapToMonthFirstUtc(new Date());

      // ── Phase 49.3 — Orphan-Shift-Lifecycle detection ──────────────────────
      // When switching FROM SHIFT_BASED to any other type, check for future shifts.
      // Past shifts (date < today) are immutable (Phase 47.2) and are never touched.
      if (body.type !== "SHIFT_BASED") {
        // Resolve the current (prior) effective schedule for this employee
        const priorSchedule = await app.prisma.workSchedule.findFirst({
          where: { employeeId, validFrom: { lte: new Date() } },
          orderBy: { validFrom: "desc" },
          select: { type: true },
        });

        if (priorSchedule?.type === "SHIFT_BASED") {
          // Build today's ISO date string for "future shifts" threshold.
          // We compare date (YYYY-MM-DD) string directly — no timezone conversion
          // needed because Shift.date is stored as @db.Date (calendar date, not instant).
          const now = new Date();
          const todayIso =
            `${now.getFullYear()}-` +
            `${String(now.getMonth() + 1).padStart(2, "0")}-` +
            `${String(now.getDate()).padStart(2, "0")}`;

          // Count future shifts (today and beyond are "future" for this check)
          // Phase 100B Plan 05 — S1, contexts/scheduling facade.
          const futureShifts = await getShiftsInRange(
            app.prisma,
            employeeScopeFor(access, { employeeId }),
            new Date(todayIso),
          );

          if (futureShifts.length > 0 && !body.keepOrphanShifts && !body.cancelOrphanShifts) {
            // Neither flag set — ask the client what to do
            return reply.code(409).send({
              error: "Pending shifts",
              code: "ORPHAN_SHIFTS_PENDING",
              pendingShifts: futureShifts.length,
              shiftPreview: futureShifts.slice(0, 3).map((s) => ({
                date: s.date.toISOString().split("T")[0],
                startTime: s.startTime,
                endTime: s.endTime,
              })),
            });
          }

          if (body.cancelOrphanShifts && futureShifts.length > 0) {
            // cancelOrphanShifts: hard-delete all future shifts + audit each one,
            // then write the WorkSchedule change — all in one $transaction.
            const futureShiftIds = futureShifts.map((s) => s.id);
            const scheduleData = {
              type: body.type,
              weeklyHours: body.weeklyHours,
              monthlyHours: body.monthlyHours ?? null,
              mondayHours: body.mondayHours,
              tuesdayHours: body.tuesdayHours,
              wednesdayHours: body.wednesdayHours,
              thursdayHours: body.thursdayHours,
              fridayHours: body.fridayHours,
              saturdayHours: body.saturdayHours,
              sundayHours: body.sundayHours,
              overtimeThreshold: body.overtimeThreshold,
              allowOvertimePayout: body.allowOvertimePayout,
              overtimeMode: body.overtimeMode,
              // Phase 100 (Rule 1 fix; WR-01 code-review follow-up) — this field was
              // validated by the Zod schema and returned in the response type, but never
              // written here: a caller's maxNegativeBalanceMinutes was silently discarded
              // on every PUT through the cancelOrphanShifts branch. Now that this value is
              // a real entitlement input (Plan 01), a silently-dropped write is a
              // correctness bug, not a stub. PARTIAL-UPDATE semantics: only include the key
              // when the caller actually sent it (`!== undefined`), so an omitted field
              // preserves whatever is already stored instead of wiping it to null — an
              // explicit `null` still clears it. Mirrors PUT /settings/security's `update:
              // body` pattern, which lets Prisma skip undefined keys. Without this, the one
              // web caller of this route (admin/employees/[id]/+page.svelte, which has no
              // form control for this field yet) would silently null out any per-employee
              // override the next time it saved an unrelated schedule change.
              ...(body.maxNegativeBalanceMinutes !== undefined
                ? { maxNegativeBalanceMinutes: body.maxNegativeBalanceMinutes }
                : {}),
              coreStart: body.coreStart ?? null,
              coreEnd: body.coreEnd ?? null,
              coreDays: body.coreDays ?? [],
              // Phase 61 (v1.6.5) — derive workDays from per-day-hours when the
              // caller either omitted workDays or sent the literal Mo-Fr default
              // alongside per-day-hours that disagree. Closes an employee's
              // class of bug (mondayHours=0 but workDays=[1,2,3,4,5]).
              workDays: normalizeWorkDays(body.workDays, body as PerDayHours),
              validFrom,
            };

            const existingForDate = await app.prisma.workSchedule.findFirst({
              where: { employeeId, validFrom },
            });

            // Phase 76.24 (D-01) — same-month type-change collision guard.
            // A type change requires a CLEAN month boundary (no existing row at
            // validFrom with a differing type). If a row exists with a different
            // type, reject with MODEL_SWITCH_SAME_MONTH_ERROR. A pure hours-only
            // edit (existing.type === body.type) keeps the update-in-place path.
            if (existingForDate && existingForDate.type !== body.type) {
              return reply.code(400).send({ error: MODEL_SWITCH_SAME_MONTH_ERROR });
            }

            // $transaction returns the created/updated schedule via Promise.
            const schedule = await app.prisma.$transaction(async (tx) => {
              // 1. Delete all future shifts (Phase 100B Plan 05 — S3, contexts/scheduling
              //    facade; `tx` is the caller's own transaction client, D-07).
              await cancelOrphanShifts(tx, req.user.tenantId, futureShiftIds);

              // 2. Write the WorkSchedule change and return it so the transaction
              //    result is the schedule (TypeScript can narrow the type)
              if (existingForDate) {
                return tx.workSchedule.update({
                  where: { id: existingForDate.id },
                  data: scheduleData,
                });
              } else {
                return tx.workSchedule.create({
                  data: { employeeId, ...scheduleData },
                });
              }
            });

            // 3. Audit each deleted shift (outside $transaction so failures don't
            //    roll back the schedule change; audit is best-effort but typed)
            for (const shift of futureShifts) {
              await app.audit({
                userId: req.user.sub,
                action: "DELETE",
                entity: "Shift",
                entityId: shift.id,
                oldValue: { ...shift, note: "SHIFT_CANCELLED_SCHEDULE_TYPE_CHANGE" },
                newValue: null,
                request: { ip: req.ip, headers: req.headers as Record<string, string> },
              });
            }

            await app.audit({
              userId: req.user.sub,
              action: existingForDate ? "UPDATE" : "CREATE",
              entity: "WorkSchedule",
              entityId: schedule.id,
              oldValue: existingForDate ?? null,
              newValue: schedule,
              request: { ip: req.ip, headers: req.headers as Record<string, string> },
            });

            if (validFrom < new Date()) {
              await recalculateSnapshots(app, employeeId, validFrom).catch((err) =>
                app.log.error(
                  { err, employeeId },
                  "Failed to recalculate snapshots after schedule change",
                ),
              );
            }

            return schedule;
          }
          // keepOrphanShifts: true → fall through to normal write below (no shift changes)
        }
      }
      // ── end Phase 49.3 ────────────────────────────────────────────────────

      // Check if a schedule with the exact same validFrom exists
      const existing = await app.prisma.workSchedule.findFirst({
        where: { employeeId, validFrom },
      });

      // Phase 76.24 (D-01) — same-month type-change collision guard.
      // A type change requires a CLEAN month boundary (no existing row at
      // validFrom with a differing type). If a row exists with a different
      // type, reject with MODEL_SWITCH_SAME_MONTH_ERROR. A pure hours-only
      // edit (existing.type === body.type) keeps the update-in-place path (D-01a).
      if (existing && existing.type !== body.type) {
        return reply.code(400).send({ error: MODEL_SWITCH_SAME_MONTH_ERROR });
      }

      // Phase 107 (D-01/D-02, issue #94) — SHIFT_BASED freeze: workDays is never
      // derived (guessed) for this type again. Update-in-place reuses the existing
      // row's own workDays verbatim; a brand-new validFrom row inherits the most
      // recent PRIOR row's workDays (the schedule this new period continues from),
      // falling back to the schema default only when no prior row exists at all.
      // normalizeWorkDays() (the Phase 61 per-day-hours guesser) is never invoked on
      // this branch — that is what makes the freeze structural, not a matter of care.
      // contractWorkDaysPerWeek is written ONLY for SHIFT_BASED and explicitly `null`
      // for every other type, so the column stays self-describing (D-01) and a type
      // switch away from SHIFT_BASED clears any stale count.
      let workDaysForWrite: number[];
      let contractWorkDaysPerWeekForWrite: number | null;
      if (body.type === "SHIFT_BASED") {
        if (existing) {
          workDaysForWrite = existing.workDays;
        } else {
          const priorForWorkDays = await app.prisma.workSchedule.findFirst({
            where: { employeeId, validFrom: { lt: validFrom } },
            orderBy: { validFrom: "desc" },
            select: { workDays: true },
          });
          workDaysForWrite = priorForWorkDays?.workDays ?? [1, 2, 3, 4, 5];
        }
        contractWorkDaysPerWeekForWrite =
          body.contractWorkDaysPerWeek ?? existing?.contractWorkDaysPerWeek ?? 5;
      } else {
        workDaysForWrite = normalizeWorkDays(body.workDays, body as PerDayHours);
        contractWorkDaysPerWeekForWrite = null;
      }

      const scheduleData = {
        type: body.type,
        weeklyHours: body.weeklyHours,
        monthlyHours: body.monthlyHours ?? null,
        mondayHours: body.mondayHours,
        tuesdayHours: body.tuesdayHours,
        wednesdayHours: body.wednesdayHours,
        thursdayHours: body.thursdayHours,
        fridayHours: body.fridayHours,
        saturdayHours: body.saturdayHours,
        sundayHours: body.sundayHours,
        overtimeThreshold: body.overtimeThreshold,
        allowOvertimePayout: body.allowOvertimePayout,
        overtimeMode: body.overtimeMode,
        // Phase 100 (Rule 1 fix; WR-01 code-review follow-up) — same fix as the
        // cancelOrphanShifts branch above: this field was validated by the Zod schema and
        // returned in the response type, but never written here, so a caller's
        // maxNegativeBalanceMinutes was silently discarded on every normal-path PUT. Now
        // that this value is a real entitlement input (Plan 01), a silently-dropped write
        // is a correctness bug, not a stub. PARTIAL-UPDATE semantics: only include the key
        // when the caller actually sent it — see the cancelOrphanShifts branch above for
        // the full rationale.
        ...(body.maxNegativeBalanceMinutes !== undefined
          ? { maxNegativeBalanceMinutes: body.maxNegativeBalanceMinutes }
          : {}),
        coreStart: body.coreStart ?? null,
        coreEnd: body.coreEnd ?? null,
        coreDays: body.coreDays ?? [],
        workDays: workDaysForWrite,
        contractWorkDaysPerWeek: contractWorkDaysPerWeekForWrite,
        validFrom,
      };

      let schedule;
      const old = existing;
      if (existing) {
        schedule = await app.prisma.workSchedule.update({
          where: { id: existing.id },
          data: scheduleData,
        });
      } else {
        schedule = await app.prisma.workSchedule.create({
          data: { employeeId, ...scheduleData },
        });
      }

      await app.audit({
        userId: req.user.sub,
        action: old ? "UPDATE" : "CREATE",
        entity: "WorkSchedule",
        entityId: schedule.id,
        oldValue: old,
        newValue: schedule,
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      // Retroactive recalculation: if validFrom is in the past,
      // recalculate affected snapshots
      if (validFrom < new Date()) {
        await recalculateSnapshots(app, employeeId, validFrom).catch((err) =>
          app.log.error(
            { err, employeeId },
            "Failed to recalculate snapshots after schedule change",
          ),
        );
      }

      return schedule;
    },
  });

  // GET /api/v1/settings/smtp
  app.get("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return {
        smtpHost: cfg?.smtpHost ?? null,
        smtpPort: cfg?.smtpPort ?? null,
        smtpUser: cfg?.smtpUser ?? null,
        smtpPasswordSet: !!cfg?.smtpPassword,
        smtpFromEmail: cfg?.smtpFromEmail ?? null,
        smtpFromName: cfg?.smtpFromName ?? null,
        smtpSecure: cfg?.smtpSecure ?? false,
      };
    },
  });

  // PUT /api/v1/settings/smtp
  app.put("/smtp", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const smtpSchema = z.object({
        smtpHost: z.string().min(1),
        smtpPort: z.number().int().min(1).max(65535),
        smtpUser: z.string().min(1),
        smtpPassword: z.string().optional(),
        smtpFromEmail: z.string().email(),
        smtpFromName: z.string().min(1),
        smtpSecure: z.boolean(),
      });
      const body = smtpSchema.parse(req.body);
      const tenantId = req.user.tenantId;

      const updateData: Record<string, unknown> = {
        smtpHost: body.smtpHost,
        smtpPort: body.smtpPort,
        smtpUser: body.smtpUser,
        smtpFromEmail: body.smtpFromEmail,
        smtpFromName: body.smtpFromName,
        smtpSecure: body.smtpSecure,
      };
      if (body.smtpPassword) updateData.smtpPassword = encrypt(body.smtpPassword);

      const oldConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      await app.prisma.tenantConfig.upsert({
        where: { tenantId },
        update: updateData,
        create: { tenantId, ...updateData },
      });

      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: tenantId,
        oldValue: oldConfig
          ? {
              smtpHost: oldConfig.smtpHost,
              smtpPort: oldConfig.smtpPort,
              smtpUser: oldConfig.smtpUser,
              smtpFromEmail: oldConfig.smtpFromEmail,
            }
          : null,
        newValue: {
          smtpHost: body.smtpHost,
          smtpPort: body.smtpPort,
          smtpUser: body.smtpUser,
          smtpFromEmail: body.smtpFromEmail,
        },
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });

      return { success: true };
    },
  });

  // POST /api/v1/settings/smtp/test
  app.post("/smtp/test", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req, reply) => {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      try {
        await app.mailer.sendTestMail(email, req.user.tenantId);
        return { success: true, message: "Testmail erfolgreich gesendet" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: `SMTP-Fehler: ${msg}` });
      }
    },
  });

  // GET /api/v1/settings/security
  app.get("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;
      const cfg = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      return projectSecuritySettings(cfg);
    },
  });

  // PUT /api/v1/settings/security
  app.put("/security", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN"),
    handler: async (req) => {
      const body = securitySettingsSchema.parse(req.body);
      const tenantId = req.user.tenantId;
      const oldConfig = await app.prisma.tenantConfig.findUnique({ where: { tenantId } });
      const config = await app.prisma.tenantConfig.upsert({
        where: { tenantId },
        update: body,
        create: { tenantId, ...body },
      });
      await app.audit({
        userId: req.user.sub,
        action: "UPDATE",
        entity: "TenantConfig",
        entityId: tenantId,
        // Issue #148: BOTH sides are the FULL writable field set, projected by the same
        // function the read endpoints use. `newValue` used to be the raw `body` — i.e. only the
        // keys the caller happened to send — which left the after-state of every unsent field
        // implicit as well. Full-on-both-sides makes the row self-contained: what changed is the
        // diff, and neither side can list fewer fields than the request can write.
        oldValue: projectSecuritySettings(oldConfig),
        newValue: projectSecuritySettings(config),
        request: { ip: req.ip, headers: req.headers as Record<string, string> },
      });
      return projectSecuritySettings(config);
    },
  });

  // GET /api/v1/settings/work/:employeeId/history  — alle Schedule-Versionen eines Mitarbeiters
  app.get("/work/:employeeId/history", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req, reply) => {
      const { employeeId } = req.params as { employeeId: string };

      // Tenant isolation guard — copied verbatim from GET /work/:employeeId above
      // (T-100-09 pattern): the 404 body is IDENTICAL to the genuine not-found
      // branch so this endpoint cannot be used as a tenant-membership oracle.
      const employee = await app.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { tenantId: true },
      });
      if (!employee || employee.tenantId !== req.user.tenantId) {
        if (employee) {
          await app.audit({
            userId: req.user.sub,
            action: "CROSS_TENANT_ACCESS_DENIED",
            entity: "WorkSchedule",
            entityId: employeeId,
            request: { ip: req.ip, headers: req.headers as Record<string, string> },
          });
        }
        return reply.code(404).send({ error: "Kein Arbeitszeitmodell gefunden" });
      }

      const schedules = await app.prisma.workSchedule.findMany({
        where: { employeeId },
        orderBy: { validFrom: "desc" },
      });
      return schedules;
    },
  });

  // GET /api/v1/settings/employees  — alle Mitarbeiter mit ihren Arbeitszeitmodellen
  app.get("/employees", {
    schema: { tags: ["Einstellungen"], security: [{ bearerAuth: [] }] },
    preHandler: requireRole("ADMIN", "MANAGER"),
    handler: async (req) => {
      const tenantId = req.user.tenantId;

      const employees = await app.prisma.employee.findMany({
        where: { tenantId },
        include: {
          user: { select: { email: true } },
          workSchedules: { orderBy: { validFrom: "desc" } },
        },
        orderBy: { employeeNumber: "asc" },
      });

      return employees.map((e) => ({
        id: e.id,
        employeeNumber: e.employeeNumber,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.user.email,
        workSchedule: e.workSchedules[0] ?? null,
      }));
    },
  });
}
