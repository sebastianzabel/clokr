<script lang="ts">
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { authStore } from "$stores/auth";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import ListDetail from "$lib/components/admin/ListDetail.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import DangerZone from "$lib/components/admin/DangerZone.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import {
    type EmployeeClassification,
    CLASSIFICATION_OPTIONS,
    CLASSIFICATION_LABELS,
    applyDefaults,
    isOverridden,
  } from "$lib/employee-classification";
  import { isWorkDay } from "$lib/utils/work-schedule";

  // ── Types ──────────────────────────────────────────────────────────────────
  type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";
  type ScheduleType = "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";

  interface WorkSchedule {
    type: ScheduleType;
    weeklyHours: number | string | null;
    monthlyHours: number | string | null;
    mondayHours: number | string;
    tuesdayHours: number | string;
    wednesdayHours: number | string;
    thursdayHours: number | string;
    fridayHours: number | string;
    saturdayHours: number | string;
    sundayHours: number | string;
    overtimeThreshold: number | string;
    allowOvertimePayout: boolean;
    validFrom: string;
    overtimeMode?: "CARRY_FORWARD" | "TRACK_ONLY";
    coreStart?: string | null;
    coreEnd?: string | null;
    coreDays?: number[];
    workDays?: number[];
  }

  interface VacationEntitlement {
    year: number;
    totalDays: number | null;
    usedDays: number;
    carriedOverDays: number;
    carryOverDeadline: string | null;
  }

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
    nfcCardId?: string | null;
    exitDate?: string | null;
    classification?: EmployeeClassification;
    coverageWeight?: number | null;
    requiresSupervision?: boolean;
    // Phase 64/65 — Pausendauer per-Employee overrides
    birthDate?: string | null; // ISO date or null
    breakOver6hOverride?: number | null; // null = use tenant default
    breakOver9hOverride?: number | null;
    // Phase 85.1.1 (D-01, D-03) — Phorest Vor-/Nachbereitungszeit per-Employee
    // overrides. null = use tenant default (TenantConfig.phorestPrepMinutes/
    // phorestWrapupMinutes); 0 = explicit "no puffer".
    phorestPrepMinutesOverride?: number | null;
    phorestWrapupMinutesOverride?: number | null;
    // Phase 76.7 (UI-V19-04a) — § 18 ArbZG exemption flag (ADMIN-only toggle).
    isTimeTrackingExempt?: boolean;
    // Phase 76.36 — per-employee bsSlot* overrides (highest layer of 4-layer hierarchy).
    // null = inherit from Pattern → TenantConfig → daily Soll.
    bsSlotFirstLongDayMinutes?: number | null;
    bsSlotSecondLongDayMinutes?: number | null;
    bsSlotShortDayMinutes?: number | null;
    bsSlotBlockWeekMinutes?: number | null;
    user?: {
      role: Role;
      email: string;
      isActive: boolean;
      lastLoginAt?: string | null;
    } | null;
  }

  // Phase 65 — Tenant defaults consumed for placeholder display (D-08)
  // Phase 76.36 — extended with bsSlot* tenant-layer values for inheritance display
  interface TenantBreakConfig {
    defaultBreakOver6h?: number;
    defaultBreakOver9h?: number;
    bsSlotFirstLongDayMinutes?: number | null;
    bsSlotSecondLongDayMinutes?: number | null;
    bsSlotShortDayMinutes?: number | null;
    bsSlotBlockWeekMinutes?: number | null;
    // Phase 85.1.1 (D-03) — tenant Phorest puffer defaults for the inherit hint
    // (returned by GET /settings/work per Task 1; reuses this existing fetch).
    phorestPrepMinutes?: number;
    phorestWrapupMinutes?: number;
  }

  // Phase 67 (BERSCH-15) — Vocational-school pattern row returned by
  // GET /api/v1/employees/:id/vocational-school-pattern
  // Source: apps/api/src/routes/vocational-school-pattern.ts lines 62-66
  interface VocationalSchoolPattern {
    id: string;
    employeeId: string;
    // Phase 67.1 — `dayOfWeek` is the legacy single-value field (still emitted by the
    // API during the v1.7.4 soak when daysOfWeek has exactly one entry). `daysOfWeek`
    // is the canonical multi-day source; new code MUST read this.
    dayOfWeek: number | null; // legacy 0=Mo..6=So (derived from daysOfWeek[0])
    daysOfWeek: number[]; // canonical 0=Mo..6=So array
    blockWeeks: number[]; // ISO week numbers; empty array when only daysOfWeek set
    blockYear: number | null;
    validFrom: string; // "YYYY-MM-DD"
    validUntil: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    // Phase 67.2 — Schulferien-Behandlung (Plan 03): generator skips overlapping
    // school-holiday dates when true (default). Pflegeschulen/Berufsakademien set false.
    respectSchoolHolidays?: boolean;
    // Phase 67.2 — Pendler-Azubi: BS-Schule in anderem Bundesland als Tenant.
    // null = use Tenant.federalState (default).
    federalStateOverride?: FederalState | null;
    // Phase 76.37 — per-pattern bsSlot* overrides (middle layer Employee > Pattern > TenantConfig > daily-Soll).
    // null = delegate down to TenantConfig / daily-Soll.
    bsSlotFirstLongDayMinutes?: number | null;
    bsSlotSecondLongDayMinutes?: number | null;
    bsSlotShortDayMinutes?: number | null;
    bsSlotBlockWeekMinutes?: number | null;
  }

  // Phase 67.2 (Plan 05) — Federal-state enum mirrored from packages/db/prisma/schema.prisma.
  // Used for `federalStateOverride` dropdown in BS-Pattern editor + the existing /admin/system
  // selector. Kept in sync with STATES[] in /admin/system manually (no shared type pkg yet).
  type FederalState =
    | "BADEN_WUERTTEMBERG"
    | "BAYERN"
    | "BERLIN"
    | "BRANDENBURG"
    | "BREMEN"
    | "HAMBURG"
    | "HESSEN"
    | "MECKLENBURG_VORPOMMERN"
    | "NIEDERSACHSEN"
    | "NORDRHEIN_WESTFALEN"
    | "RHEINLAND_PFALZ"
    | "SAARLAND"
    | "SACHSEN"
    | "SACHSEN_ANHALT"
    | "SCHLESWIG_HOLSTEIN"
    | "THUERINGEN";

  // Phase 67.2 (Plan 05) — Federal-state labels for the dropdown (sorted by label).
  // Matches the verbatim label strings from /admin/system STATES.
  const BS_FEDERAL_STATE_OPTIONS: { value: FederalState; label: string }[] = [
    { value: "BADEN_WUERTTEMBERG", label: "Baden-Württemberg" },
    { value: "BAYERN", label: "Bayern" },
    { value: "BERLIN", label: "Berlin" },
    { value: "BRANDENBURG", label: "Brandenburg" },
    { value: "BREMEN", label: "Bremen" },
    { value: "HAMBURG", label: "Hamburg" },
    { value: "HESSEN", label: "Hessen" },
    { value: "MECKLENBURG_VORPOMMERN", label: "Mecklenburg-Vorpommern" },
    { value: "NIEDERSACHSEN", label: "Niedersachsen" },
    { value: "NORDRHEIN_WESTFALEN", label: "Nordrhein-Westfalen" },
    { value: "RHEINLAND_PFALZ", label: "Rheinland-Pfalz" },
    { value: "SAARLAND", label: "Saarland" },
    { value: "SACHSEN", label: "Sachsen" },
    { value: "SACHSEN_ANHALT", label: "Sachsen-Anhalt" },
    { value: "SCHLESWIG_HOLSTEIN", label: "Schleswig-Holstein" },
    { value: "THUERINGEN", label: "Thüringen" },
  ];

  // Phase 67 Plan 02 (BERSCH-15) — Local editor draft. NEVER sent to the API as-is;
  // the _key field is for {#each} keyed iteration only. On Save we serialise to the
  // API's putPatternsSchema (apps/api/src/routes/vocational-school-pattern.ts lines 10-31).
  //
  // Phase 67.1 (v1.7.4): `daysOfWeek: number[]` replaces single-value `dayOfWeek`.
  // The chip strip in the editor toggles set-membership; multi-select is supported.
  //
  // v1.7.4 hotfix: `mode` makes the two BBiG semantics mutually exclusive in the UI —
  // 'weekly' = recurring weekday BS (Mo + Mi), 'block' = block weeks (Pflege, Friseur).
  // Backend Zod refine already accepts either-or; this only enforces the discipline
  // in the editor so the inactive mode's array is always empty on save.
  type BSPatternMode = "weekly" | "block";
  interface BSPatternDraft {
    _key: string;
    mode: BSPatternMode;
    daysOfWeek: number[];
    blockWeeks: number[];
    blockYear: number | null;
    validFrom: string; // "YYYY-MM-DD"
    validUntil: string | null;
    // Phase 67.2 (Plan 05) — Per-Pattern toggles (Plan 03 backend support).
    // - respectSchoolHolidays: when false, generator ignores SchoolHolidayPeriod cache for
    //   this pattern (Pflegeschulen, Berufsakademien). Default true.
    // - federalStateOverride: when set, generator uses this BL's holiday cache instead of
    //   the tenant's. null = inherit from Tenant.federalState. Default null.
    respectSchoolHolidays: boolean;
    federalStateOverride: FederalState | null;
    // Phase 76.37 — per-pattern bsSlot* overrides. "" = null (inherit from TenantConfig / daily-Soll).
    // String state matches the "leer = erben" UX: empty input → send null to API.
    bsSlotFirstLong: string; // bsSlotFirstLongDayMinutes — "" = inherit
    bsSlotSecondLong: string; // bsSlotSecondLongDayMinutes
    bsSlotShortDay: string; // bsSlotShortDayMinutes
    bsSlotBlockWeek: string; // bsSlotBlockWeekMinutes
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  let loading = $state(true);
  let loadError = $state("");

  // ── Data state (populated on mount) ───────────────────────────────────────
  let employee = $state<Employee | null>(null);
  let workSchedule = $state<WorkSchedule | null>(null);
  let vacationEntitlement = $state<VacationEntitlement | null>(null);
  // Phase 65 — Tenant break-default config for placeholder display
  let tenantBreakConfig = $state<TenantBreakConfig | null>(null);

  // Phase 67 — BS-Pattern list (AZUBI-only Section in Stammdaten tab)
  // Plan 02: bsPatterns is a draft array (mutated by the editor, PUT en-bloc on Save)
  let bsPatterns = $state<BSPatternDraft[]>([]);
  let bsPatternsLoadError = $state<string>("");
  let bsPatternsSaving = $state(false);
  let bsPatternsSaveError = $state<string>("");
  let bsPatternsSaved = $state(false);
  // Monotonically-increasing counter for synthetic keys on unsaved rows
  let bsNewKeyCounter = $state(0);

  const employeeId = $derived($page.params.id);

  onMount(async () => {
    loading = true;
    loadError = "";
    try {
      const [empRes, schedRes, vacRes, cfgRes, bsRes] = await Promise.allSettled([
        api.get<Employee>(`/employees/${employeeId}`),
        api.get<WorkSchedule>(`/settings/work/${employeeId}`),
        api.get<VacationEntitlement>(
          `/settings/vacation/${employeeId}?year=${new Date().getFullYear()}`,
        ),
        api.get<TenantBreakConfig>(`/settings/work`),
        api.get<VocationalSchoolPattern[]>(`/employees/${employeeId}/vocational-school-pattern`),
      ]);

      if (empRes.status === "rejected") {
        loadError = "Mitarbeiter nicht gefunden.";
        return;
      }
      employee = empRes.value;
      workSchedule = schedRes.status === "fulfilled" ? schedRes.value : null;
      vacationEntitlement = vacRes.status === "fulfilled" ? vacRes.value : null;
      // Phase 65 — tenant defaults for placeholder display (D-08)
      tenantBreakConfig = cfgRes.status === "fulfilled" ? cfgRes.value : null;

      // Phase 67 — BS-Patterns (fail-soft: empty array on rejection, message banner in Section)
      // Plan 02: map API response → editor drafts (persisted id becomes the {#each} key)
      if (bsRes.status === "fulfilled") {
        // Phase 67.1: prefer canonical `daysOfWeek` array; fall back to legacy
        // single `dayOfWeek` for rows from a pre-v1.7.4 API response that survived
        // a cache miss (defensive — should not happen against an in-sync API).
        bsPatterns = bsRes.value.map((p) => {
          const hydratedDays =
            p.daysOfWeek && p.daysOfWeek.length > 0
              ? [...p.daysOfWeek]
              : p.dayOfWeek != null
                ? [p.dayOfWeek]
                : [];
          const hydratedWeeks = [...p.blockWeeks];
          // v1.7.4 hotfix — Mode is derived from the data shape:
          // blockWeeks.length > 0 → 'block' (Pflege / Friseur), else 'weekly' (default).
          // Existing rows that have BOTH (legacy ambiguity) are coerced to 'block' since
          // that was the visually dominant choice in the old OR-semantics UI.
          const mode: BSPatternMode = hydratedWeeks.length > 0 ? "block" : "weekly";
          return {
            _key: p.id,
            mode,
            daysOfWeek: hydratedDays,
            blockWeeks: hydratedWeeks,
            blockYear: p.blockYear,
            validFrom: p.validFrom,
            validUntil: p.validUntil,
            // Phase 67.2 (Plan 05) — surface Ferien fields with defensive defaults so the editor
            // never crashes on a pre-67.2 API response that lacks the columns.
            respectSchoolHolidays: p.respectSchoolHolidays ?? true,
            federalStateOverride: p.federalStateOverride ?? null,
            // Phase 76.37 — hydrate bsSlot* overrides: null/undefined → "" (inherit).
            bsSlotFirstLong:
              p.bsSlotFirstLongDayMinutes != null ? String(p.bsSlotFirstLongDayMinutes) : "",
            bsSlotSecondLong:
              p.bsSlotSecondLongDayMinutes != null ? String(p.bsSlotSecondLongDayMinutes) : "",
            bsSlotShortDay: p.bsSlotShortDayMinutes != null ? String(p.bsSlotShortDayMinutes) : "",
            bsSlotBlockWeek:
              p.bsSlotBlockWeekMinutes != null ? String(p.bsSlotBlockWeekMinutes) : "",
          };
        });
        bsPatternsLoadError = "";
      } else {
        bsPatterns = [];
        bsPatternsLoadError = "Berufsschultage konnten nicht geladen werden.";
      }

      // Initialise form fields from loaded data
      initFields();
    } catch {
      loadError = "Fehler beim Laden des Mitarbeiters.";
    } finally {
      loading = false;
    }
  });

  // ── Tabs ───────────────────────────────────────────────────────────────────
  const TABS = [
    { id: "stammdaten", label: "Stammdaten" },
    { id: "arbeitszeit", label: "Arbeitszeit" },
    { id: "urlaub", label: "Urlaub" },
    { id: "berechtigungen", label: "Berechtigungen" },
    { id: "danger", label: "Danger Zone" },
  ];

  let activeTab = $state<string>("stammdaten");

  $effect(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      const hash = decodeURIComponent(window.location.hash.slice(1));
      if (TABS.some((t) => t.id === hash)) activeTab = hash;
    }
  });

  $effect(() => {
    if (typeof window !== "undefined" && activeTab) {
      history.replaceState(null, "", `#${encodeURIComponent(activeTab)}`);
    }
  });

  // ── Stammdaten state ───────────────────────────────────────────────────────
  let eFirstName = $state<string>("");
  let eLastName = $state<string>("");
  let eEmployeeNumber = $state<string>("");
  let eRole = $state<Role>("EMPLOYEE");
  let eNfcCardId = $state<string>("");
  let eExitDate = $state<string>("");
  let eBirthDate = $state<string>(""); // Phase 65 — JArbSchG §9 needs DOB for AZUBI <18 check
  let eClassification = $state<EmployeeClassification>("VOLLZEIT");
  let eCoverageWeight = $state<number>(applyDefaults("VOLLZEIT").coverageWeight);
  let eRequiresSupervision = $state<boolean>(applyDefaults("VOLLZEIT").requiresSupervision);
  let stammdatenSaving = $state(false);
  let stammdatenError = $state("");
  let stammdatenSaved = $state(false);

  // Phase 65 — Per-employee Pausendauer override (BREAK-06)
  // String state lets us distinguish "" (= null, use tenant) from typed integer values
  let eBreakOver6hOverride = $state<string>("");
  let eBreakOver9hOverride = $state<string>("");
  let pausendauerSaving = $state(false);
  let pausendauerError = $state("");
  let pausendauerSaved = $state(false);

  // Phase 85.1.1 (D-01, D-03) — Per-employee Phorest Vor-/Nachbereitungszeit override
  // String state lets us distinguish "" (= null, use tenant) from typed integer values
  let ePhorestPrepOverride = $state<string>("");
  let ePhorestWrapupOverride = $state<string>("");
  let phorestPufferSaving = $state(false);
  let phorestPufferError = $state("");
  let phorestPufferSaved = $state(false);

  // Phase 76.36 — per-employee bsSlot* overrides (BBIG-V19-03 employee layer).
  // "" = inherit (field cleared → PATCH sends null → re-enables inheritance).
  // Bounds mirror apps/api/src/utils/vocational-school-constants.ts.
  const EMP_BS_DAILY_MIN = 240;
  const EMP_BS_DAILY_MAX = 600;
  const EMP_BS_BLOCK_MIN = 1200;
  const EMP_BS_BLOCK_MAX = 3000;

  let empBsSlotFirstLong = $state<string>(""); // bsSlotFirstLongDayMinutes
  let empBsSlotSecondLong = $state<string>(""); // bsSlotSecondLongDayMinutes
  let empBsSlotShortDay = $state<string>(""); // bsSlotShortDayMinutes
  let empBsSlotBlockWeek = $state<string>(""); // bsSlotBlockWeekMinutes

  let empBsSlotSaving = $state(false);
  let empBsSlotSaved = $state(false);
  let empBsSlotError = $state("");

  // Stunden-hints — only shown when a value is set (empty = inherited, no hint)
  let empBsSlotFirstLongHint = $derived(
    empBsSlotFirstLong !== "" && Number.isFinite(Number(empBsSlotFirstLong))
      ? `= ${(Number(empBsSlotFirstLong) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let empBsSlotSecondLongHint = $derived(
    empBsSlotSecondLong !== "" && Number.isFinite(Number(empBsSlotSecondLong))
      ? `= ${(Number(empBsSlotSecondLong) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let empBsSlotShortDayHint = $derived(
    empBsSlotShortDay !== "" && Number.isFinite(Number(empBsSlotShortDay))
      ? `= ${(Number(empBsSlotShortDay) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );
  let empBsSlotBlockWeekHint = $derived(
    empBsSlotBlockWeek !== "" && Number.isFinite(Number(empBsSlotBlockWeek))
      ? `= ${(Number(empBsSlotBlockWeek) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`
      : "",
  );

  // Inheritance-source display: "Erbt aus: <layer> = <value>"
  // Priority: Pattern > TenantConfig > Tages-Soll (daily Soll from schedule)
  // The first active pattern's bsSlot* takes precedence; then tenant config.
  // Daily Soll = round(weeklyHours * 60 / workDays). Shown when field is empty.
  let empDailySollMin = $derived(
    (() => {
      // Only meaningful when schedule is loaded
      if (!workSchedule) return null;
      const wh = Number(workSchedule.weeklyHours ?? 0);
      if (!Number.isFinite(wh) || wh <= 0) return null;
      // Count work days from schedule (workDays array > per-day hours > default 5)
      const sched = workSchedule as WorkSchedule & { workDays?: number[] };
      const wdCount =
        sched.workDays && sched.workDays.length > 0
          ? sched.workDays.length
          : [
              sched.mondayHours,
              sched.tuesdayHours,
              sched.wednesdayHours,
              sched.thursdayHours,
              sched.fridayHours,
              sched.saturdayHours,
              sched.sundayHours,
            ].filter((h) => Number(h) > 0).length || 5;
      return Math.round((wh * 60) / wdCount);
    })(),
  );

  // First active pattern's bsSlot* values (Pattern layer — 2nd precedence below Employee)
  let firstPatternBsFirst = $derived(
    bsPatterns.length > 0
      ? ((bsPatterns[0] as BSPatternDraft & { bsSlotFirstLongDayMinutes?: number | null })
          .bsSlotFirstLongDayMinutes ?? null)
      : null,
  );
  let firstPatternBsSecond = $derived(
    bsPatterns.length > 0
      ? ((bsPatterns[0] as BSPatternDraft & { bsSlotSecondLongDayMinutes?: number | null })
          .bsSlotSecondLongDayMinutes ?? null)
      : null,
  );
  let firstPatternBsShort = $derived(
    bsPatterns.length > 0
      ? ((bsPatterns[0] as BSPatternDraft & { bsSlotShortDayMinutes?: number | null })
          .bsSlotShortDayMinutes ?? null)
      : null,
  );
  let firstPatternBsBlock = $derived(
    bsPatterns.length > 0
      ? ((bsPatterns[0] as BSPatternDraft & { bsSlotBlockWeekMinutes?: number | null })
          .bsSlotBlockWeekMinutes ?? null)
      : null,
  );

  // §3.2 over-credit warning: 2nd-Langtag credit > 1st-Langtag credit (Über-Kreditierungs-Schutz).
  // Fires only when 2nd-long is explicitly set AND exceeds the effective 1st-long credit.
  let empBsSlotOverCreditWarning = $derived(
    (() => {
      const v2 = empBsSlotSecondLong !== "" ? Number(empBsSlotSecondLong) : null;
      if (v2 === null || !Number.isFinite(v2)) return "";
      // Effective 1st-long: employee override → pattern → tenant → daily Soll
      const effectiveFirst =
        (empBsSlotFirstLong !== "" ? Number(empBsSlotFirstLong) : null) ??
        firstPatternBsFirst ??
        tenantBreakConfig?.bsSlotFirstLongDayMinutes ??
        null ??
        empDailySollMin;
      if (effectiveFirst === null || !Number.isFinite(effectiveFirst)) return "";
      if (v2 > effectiveFirst) {
        return `§3.2-Warnung: 2. Langtag (${v2} Min = ${(v2 / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h) übersteigt den 1. Langtag (${effectiveFirst} Min = ${(effectiveFirst / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h). Über-Kreditierung des zweiten BS-Langtags prüfen.`;
      }
      return "";
    })(),
  );

  // Phase 76.7 (UI-V19-04a) — § 18 ArbZG exemption toggle (ADMIN-only).
  // `eIsTimeTrackingExempt` mirrors the checkbox UI state. `preChangeExempt`
  // is the last server-confirmed value used to revert when the user cancels
  // the ConfirmDialog. `intendedExempt` snapshots the requested new value so
  // the modal description can render the correct verb.
  let eIsTimeTrackingExempt = $state<boolean>(false);
  let preChangeExempt = $state<boolean>(false);
  let intendedExempt = $state<boolean>(false);
  let exemptConfirmOpen = $state<boolean>(false);
  let exemptSaving = $state<boolean>(false);

  let eCoverageOverridden = $derived(
    isOverridden(eClassification, "coverageWeight", eCoverageWeight),
  );
  let eSupervisionOverridden = $derived(
    isOverridden(eClassification, "requiresSupervision", eRequiresSupervision),
  );

  /**
   * Pure age-at-date helper (mirrors apps/api/src/utils/jarbschg.ts ageAtDate, no date-fns dep).
   * Returns full years between birthDate and atDate. Returns NaN for invalid input.
   */
  function ageAtDate(birthDate: string | Date | null | undefined, atDate: Date): number {
    if (!birthDate) return Number.NaN;
    const b = birthDate instanceof Date ? birthDate : new Date(birthDate);
    if (Number.isNaN(b.getTime())) return Number.NaN;
    let age = atDate.getFullYear() - b.getFullYear();
    const m = atDate.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && atDate.getDate() < b.getDate())) {
      age--;
    }
    return age;
  }

  // Phase 65 — JArbSchG §9 trigger: AZUBI + under 18 → 30/60 Min suggestion (BREAK-07, D-06)
  // Read from local state (eBirthDate / eClassification) so the pill + suggestion update
  // live as the admin edits Stammdaten — no need to save first.
  let isAzubiUnder18 = $derived(
    eClassification === "AZUBI" &&
      Number.isFinite(ageAtDate(eBirthDate || null, new Date())) &&
      ageAtDate(eBirthDate || null, new Date()) < 18,
  );
  let bothOverridesEmpty = $derived(eBreakOver6hOverride === "" && eBreakOver9hOverride === "");
  let showAzubiSuggestionButton = $derived(isAzubiUnder18 && bothOverridesEmpty);

  function initFields() {
    if (!employee) return;
    eFirstName = employee.firstName ?? "";
    eLastName = employee.lastName ?? "";
    eEmployeeNumber = employee.employeeNumber ?? "";
    eRole = employee.user?.role ?? "EMPLOYEE";
    eNfcCardId = employee.nfcCardId ?? "";
    eExitDate = employee.exitDate ? String(employee.exitDate).split("T")[0] : "";
    eBirthDate = employee.birthDate ? String(employee.birthDate).split("T")[0] : "";
    eClassification = employee.classification ?? "VOLLZEIT";
    eCoverageWeight =
      employee.coverageWeight !== undefined && employee.coverageWeight !== null
        ? Number(employee.coverageWeight)
        : applyDefaults(employee.classification ?? "VOLLZEIT").coverageWeight;
    eRequiresSupervision =
      employee.requiresSupervision ??
      applyDefaults(employee.classification ?? "VOLLZEIT").requiresSupervision;

    // Phase 65 — override fields ("" = null in PATCH body, fall back to tenant default)
    eBreakOver6hOverride =
      employee.breakOver6hOverride !== undefined && employee.breakOver6hOverride !== null
        ? String(employee.breakOver6hOverride)
        : "";
    eBreakOver9hOverride =
      employee.breakOver9hOverride !== undefined && employee.breakOver9hOverride !== null
        ? String(employee.breakOver9hOverride)
        : "";

    // Phase 85.1.1 (D-01, D-03) — override fields ("" = null in PATCH body,
    // fall back to tenant default)
    ePhorestPrepOverride =
      employee.phorestPrepMinutesOverride !== undefined &&
      employee.phorestPrepMinutesOverride !== null
        ? String(employee.phorestPrepMinutesOverride)
        : "";
    ePhorestWrapupOverride =
      employee.phorestWrapupMinutesOverride !== undefined &&
      employee.phorestWrapupMinutesOverride !== null
        ? String(employee.phorestWrapupMinutesOverride)
        : "";

    // Phase 76.7 (UI-V19-04a) — hydrate § 18 ArbZG exemption flag.
    // `preChangeExempt` tracks the last server-confirmed value so a Abbrechen
    // click on the ConfirmDialog can revert the visual toggle.
    eIsTimeTrackingExempt = employee.isTimeTrackingExempt === true;
    preChangeExempt = eIsTimeTrackingExempt;
    intendedExempt = eIsTimeTrackingExempt;

    // Phase 76.36 — hydrate per-employee bsSlot* overrides ("" = null, inherit from lower layer)
    empBsSlotFirstLong =
      employee.bsSlotFirstLongDayMinutes != null ? String(employee.bsSlotFirstLongDayMinutes) : "";
    empBsSlotSecondLong =
      employee.bsSlotSecondLongDayMinutes != null
        ? String(employee.bsSlotSecondLongDayMinutes)
        : "";
    empBsSlotShortDay =
      employee.bsSlotShortDayMinutes != null ? String(employee.bsSlotShortDayMinutes) : "";
    empBsSlotBlockWeek =
      employee.bsSlotBlockWeekMinutes != null ? String(employee.bsSlotBlockWeekMinutes) : "";

    const sched = workSchedule;
    eType = sched?.type ?? "FIXED_SCHEDULE";
    eWeeklyHours = sched ? Number(sched.weeklyHours ?? 40) : 40;
    eMonthlyHours = sched?.monthlyHours ? Number(sched.monthlyHours) : 0;
    eCoreStart = (sched as (WorkSchedule & { coreStart?: string | null }) | null)?.coreStart ?? "";
    eCoreEnd = (sched as (WorkSchedule & { coreEnd?: string | null }) | null)?.coreEnd ?? "";
    eCoreDays = Array.isArray((sched as (WorkSchedule & { coreDays?: number[] }) | null)?.coreDays)
      ? [...((sched as WorkSchedule & { coreDays?: number[] })?.coreDays ?? [])]
      : [];
    eWorkDays =
      Array.isArray((sched as (WorkSchedule & { workDays?: number[] }) | null)?.workDays) &&
      ((sched as WorkSchedule & { workDays?: number[] })?.workDays?.length ?? 0) > 0
        ? [...((sched as WorkSchedule & { workDays?: number[] })?.workDays ?? [])]
        : [1, 2, 3, 4, 5];
    eMon = sched ? Number(sched.mondayHours) : 8;
    eTue = sched ? Number(sched.tuesdayHours) : 8;
    eWed = sched ? Number(sched.wednesdayHours) : 8;
    eThu = sched ? Number(sched.thursdayHours) : 8;
    eFri = sched ? Number(sched.fridayHours) : 8;
    eSat = sched ? Number(sched.saturdayHours) : 0;
    eSun = sched ? Number(sched.sundayHours) : 0;
    // Phase 76.3 (SALDO-V19-01): derive weekday booleans via the shared
    // work-schedule helper so workDays (Phase 61) wins over per-day-hours.
    // Reference week: 2026-06-01 (Mon) ... 2026-06-07 (Sun). Stub dates are
    // only used to call isWorkDay() — the helper looks at date.getDay()
    // (0=Sun..6=Sat) and never reads year/month.
    const refMon = new Date(2026, 5, 1);
    const refTue = new Date(2026, 5, 2);
    const refWed = new Date(2026, 5, 3);
    const refThu = new Date(2026, 5, 4);
    const refFri = new Date(2026, 5, 5);
    const refSat = new Date(2026, 5, 6);
    const refSun = new Date(2026, 5, 7);
    eMonWd = isWorkDay(sched, refMon);
    eTueWd = isWorkDay(sched, refTue);
    eWedWd = isWorkDay(sched, refWed);
    eThuWd = isWorkDay(sched, refThu);
    eFriWd = isWorkDay(sched, refFri);
    eSatWd = isWorkDay(sched, refSat);
    eSunWd = isWorkDay(sched, refSun);
    eThreshold = sched ? Number(sched.overtimeThreshold) : 60;
    ePayout = sched ? sched.allowOvertimePayout : false;
    eOvertimeMode = sched?.overtimeMode ?? "CARRY_FORWARD";
    eValidFrom = sched
      ? String(sched.validFrom).split("T")[0]
      : new Date().toISOString().split("T")[0];

    const vacData = vacationEntitlement;
    eVacTotal = vacData?.totalDays ?? null;
    eVacCarried = vacData?.carriedOverDays ?? 0;
    eVacDeadline = vacData?.carryOverDeadline
      ? String(vacData.carryOverDeadline).split("T")[0]
      : "";
  }

  function onClassificationChange() {
    const def = applyDefaults(eClassification);
    eCoverageWeight = def.coverageWeight;
    eRequiresSupervision = def.requiresSupervision;
  }

  function resetCoverage() {
    eCoverageWeight = applyDefaults(eClassification).coverageWeight;
  }

  function resetSupervision() {
    eRequiresSupervision = applyDefaults(eClassification).requiresSupervision;
  }

  async function saveStammdaten() {
    if (!employee) return;
    stammdatenSaving = true;
    stammdatenError = "";
    stammdatenSaved = false;
    try {
      const res = await api.patch<typeof employee & { proRataWarning?: { message: string } }>(
        `/employees/${employee.id}`,
        {
          firstName: eFirstName,
          lastName: eLastName,
          employeeNumber: eEmployeeNumber,
          role: eRole,
          nfcCardId: eNfcCardId || null,
          exitDate: eExitDate ? new Date(eExitDate).toISOString() : null,
          birthDate: eBirthDate ? new Date(eBirthDate).toISOString() : null,
          classification: eClassification,
          coverageWeight: eCoverageWeight,
          requiresSupervision: eRequiresSupervision,
        },
      );
      employee = { ...employee, firstName: eFirstName, lastName: eLastName };
      stammdatenSaved = true;
      setTimeout(() => (stammdatenSaved = false), 3000);
      if (res.proRataWarning) {
        toasts.warning(res.proRataWarning.message, 8000);
      }
    } catch (e: unknown) {
      stammdatenError = e instanceof Error ? e.message : "Fehler beim Speichern";
    } finally {
      stammdatenSaving = false;
    }
  }

  // Phase 65 — Persist per-employee Pausendauer override (BREAK-06)
  async function savePausendauer() {
    if (!employee) return;
    pausendauerSaving = true;
    pausendauerError = "";
    pausendauerSaved = false;

    // Empty/cleared → null (fall back to tenant); typed → integer.
    // NOTE: Even though state is typed `string`, Svelte 5 `bind:value` on
    // `<input type="number">` coerces the bound value to `number | null` at
    // runtime. Accept both shapes so .trim() never lands on a non-string.
    const parse = (v: string | number | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
      if (v.trim() === "") return null;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };

    try {
      const newOver6 = parse(eBreakOver6hOverride);
      const newOver9 = parse(eBreakOver9hOverride);
      await api.patch(`/employees/${employee.id}`, {
        breakOver6hOverride: newOver6,
        breakOver9hOverride: newOver9,
      });
      // Reflect persisted state so derived flags (suggestion button visibility) update
      employee = {
        ...employee,
        breakOver6hOverride: newOver6,
        breakOver9hOverride: newOver9,
      };
      pausendauerSaved = true;
      setTimeout(() => (pausendauerSaved = false), 3000);
    } catch (e: unknown) {
      // Server returns one of 4 verbatim German messages (Phase 64 D-08) — surface as-is
      pausendauerError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      pausendauerSaving = false;
    }
  }

  // Phase 85.1.1 (D-01, D-03) — Persist per-employee Phorest puffer override
  async function savePhorestPuffer() {
    if (!employee) return;
    phorestPufferSaving = true;
    phorestPufferError = "";
    phorestPufferSaved = false;

    // Empty/cleared → null (fall back to tenant); typed → integer.
    // NOTE: Even though state is typed `string`, Svelte 5 `bind:value` on
    // `<input type="number">` coerces the bound value to `number | null` at
    // runtime. Accept both shapes so .trim() never lands on a non-string.
    const parse = (v: string | number | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
      if (v.trim() === "") return null;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };

    try {
      const newPrep = parse(ePhorestPrepOverride);
      const newWrapup = parse(ePhorestWrapupOverride);
      await api.patch(`/employees/${employee.id}`, {
        phorestPrepMinutesOverride: newPrep,
        phorestWrapupMinutesOverride: newWrapup,
      });
      // Reflect persisted state so derived flags update
      employee = {
        ...employee,
        phorestPrepMinutesOverride: newPrep,
        phorestWrapupMinutesOverride: newWrapup,
      };
      phorestPufferSaved = true;
      setTimeout(() => (phorestPufferSaved = false), 3000);
    } catch (e: unknown) {
      phorestPufferError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      phorestPufferSaving = false;
    }
  }

  // Phase 65 — One-click JArbSchG-Vorschlag (D-06)
  function applyAzubiSuggestion() {
    eBreakOver6hOverride = "30";
    eBreakOver9hOverride = "60";
  }

  // Phase 76.36 — Persist per-employee bsSlot* overrides (BBIG-V19-03).
  // Partial PATCH: only send fields the admin explicitly touched.
  // "" → null (clear override → re-enables inheritance for that field).
  // Bounds mirror apps/api/src/utils/vocational-school-constants.ts.
  async function saveBsSlotEmp() {
    if (!employee) return;
    empBsSlotError = "";
    empBsSlotSaved = false;

    const parseSlot = (
      raw: string,
      min: number,
      max: number,
      label: string,
    ): number | null | "error" => {
      if (raw === "") return null; // explicit null → clear employee override
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        empBsSlotError = `${label}: Bitte eine ganze Zahl eingeben.`;
        return "error";
      }
      if (n < min || n > max) {
        empBsSlotError = `${label}: Wert muss zwischen ${min} und ${max} Minuten liegen.`;
        return "error";
      }
      return n;
    };

    const v1 = parseSlot(empBsSlotFirstLong, EMP_BS_DAILY_MIN, EMP_BS_DAILY_MAX, "1. Langtag");
    if (v1 === "error") return;
    const v2 = parseSlot(empBsSlotSecondLong, EMP_BS_DAILY_MIN, EMP_BS_DAILY_MAX, "2. Langtag");
    if (v2 === "error") return;
    const v3 = parseSlot(empBsSlotShortDay, EMP_BS_DAILY_MIN, EMP_BS_DAILY_MAX, "Kurztag");
    if (v3 === "error") return;
    const v4 = parseSlot(
      empBsSlotBlockWeek,
      EMP_BS_BLOCK_MIN,
      EMP_BS_BLOCK_MAX,
      "Blockunterricht-Woche",
    );
    if (v4 === "error") return;

    empBsSlotSaving = true;
    try {
      await api.patch(`/employees/${employee.id}`, {
        bsSlotFirstLongDayMinutes: v1,
        bsSlotSecondLongDayMinutes: v2,
        bsSlotShortDayMinutes: v3,
        bsSlotBlockWeekMinutes: v4,
      });
      // Reflect persisted values back into the cached employee record
      employee = {
        ...employee,
        bsSlotFirstLongDayMinutes: v1,
        bsSlotSecondLongDayMinutes: v2,
        bsSlotShortDayMinutes: v3,
        bsSlotBlockWeekMinutes: v4,
      };
      empBsSlotSaved = true;
      setTimeout(() => (empBsSlotSaved = false), 3000);
    } catch (e: unknown) {
      empBsSlotError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      empBsSlotSaving = false;
    }
  }

  // ── Phase 76.7 (UI-V19-04a) — § 18 ArbZG exemption toggle handlers ─────────
  // The toggle is bind:checked={eIsTimeTrackingExempt}. We intercept the change
  // via `onchange`, snapshot the requested value into `intendedExempt`, and open
  // the ConfirmDialog. The PATCH only fires from `confirmExemptToggle()`; an
  // Abbrechen click invokes `cancelExemptToggle()` via the ConfirmDialog's
  // `onCancel` prop, which reverts the visual checkbox to its pre-change state.
  function onExemptToggleChange(ev: Event) {
    const target = ev.currentTarget as HTMLInputElement;
    const newValue = target.checked;
    if (newValue === preChangeExempt) {
      // No-op (user re-clicked back to the original) — do nothing.
      return;
    }
    intendedExempt = newValue;
    exemptConfirmOpen = true;
  }

  async function confirmExemptToggle() {
    if (!employee) return;
    exemptSaving = true;
    try {
      await api.patch(`/employees/${employee.id}`, {
        isTimeTrackingExempt: intendedExempt,
      });
      preChangeExempt = intendedExempt;
      eIsTimeTrackingExempt = intendedExempt;
      // Reflect new value on the cached employee record so subsequent reverts
      // resolve to the new server-confirmed baseline.
      employee = { ...employee, isTimeTrackingExempt: intendedExempt };
      toasts.success("Befreiung aktualisiert");
    } catch (e: unknown) {
      // Roll back the visual toggle to the last server-confirmed state.
      eIsTimeTrackingExempt = preChangeExempt;
      const msg = e instanceof Error ? e.message : "Speichern fehlgeschlagen";
      toasts.error(msg);
    } finally {
      exemptSaving = false;
    }
  }

  function cancelExemptToggle() {
    // Revert the checkbox to the last server-confirmed value.
    eIsTimeTrackingExempt = preChangeExempt;
    intendedExempt = preChangeExempt;
  }

  // ── BS-Pattern editor helpers (Phase 67 Plan 02, BERSCH-15) ───────────────

  const BS_WEEKDAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

  function bsAddPattern() {
    bsNewKeyCounter += 1;
    bsPatterns = [
      ...bsPatterns,
      {
        _key: `new-${bsNewKeyCounter}`,
        // v1.7.4 hotfix — default new rows to 'weekly' (the much more common case;
        // block-Berufsschulen are pflege/friseur-specific).
        mode: "weekly",
        daysOfWeek: [],
        blockWeeks: [],
        blockYear: null,
        validFrom: new Date().toISOString().slice(0, 10), // today (D-default per CONTEXT)
        validUntil: null,
        // Phase 67.2 (Plan 05) — new-row defaults match the API Zod defaults
        // (apps/api/src/routes/vocational-school-pattern.ts lines 52-55).
        respectSchoolHolidays: true,
        federalStateOverride: null,
        // Phase 76.37 — bsSlot* default "" = inherit (no override set on new rows).
        bsSlotFirstLong: "",
        bsSlotSecondLong: "",
        bsSlotShortDay: "",
        bsSlotBlockWeek: "",
      },
    ];
  }

  // v1.7.4 hotfix — Switch mode and immediately clear the OTHER mode's data so the
  // payload sent to the API never carries leftover values from the discarded mode.
  // Backend Zod still accepts either-or, but a 'block' row with stray daysOfWeek would
  // re-confuse the UI on the next round-trip.
  function bsSetMode(key: string, mode: BSPatternMode) {
    bsPatterns = bsPatterns.map((p) => {
      if (p._key !== key) return p;
      if (p.mode === mode) return p;
      if (mode === "weekly") {
        return { ...p, mode, blockWeeks: [], blockYear: null };
      }
      return { ...p, mode, daysOfWeek: [] };
    });
  }

  // Phase 67.2 (Plan 05) — toggle helpers for the new per-pattern fields.
  function bsToggleRespectSchoolHolidays(key: string) {
    bsPatterns = bsPatterns.map((p) =>
      p._key === key ? { ...p, respectSchoolHolidays: !p.respectSchoolHolidays } : p,
    );
  }
  function bsSetFederalStateOverride(key: string, value: FederalState | null) {
    bsPatterns = bsPatterns.map((p) =>
      p._key === key ? { ...p, federalStateOverride: value } : p,
    );
  }

  function bsRemovePattern(key: string) {
    bsPatterns = bsPatterns.filter((p) => p._key !== key);
  }

  function bsToggleDayOfWeek(key: string, idx: number) {
    // Phase 67.1 — Multi-select: toggle set-membership in `daysOfWeek`.
    // Clicking an active chip removes it; clicking an inactive chip adds it
    // (kept sorted for stable {#each} render order).
    bsPatterns = bsPatterns.map((p) => {
      if (p._key !== key) return p;
      const has = p.daysOfWeek.includes(idx);
      const nextDays = has
        ? p.daysOfWeek.filter((d) => d !== idx)
        : [...p.daysOfWeek, idx].sort((a, b) => a - b);
      return { ...p, daysOfWeek: nextDays };
    });
  }

  function bsToggleBlockWeek(key: string, wk: number) {
    bsPatterns = bsPatterns.map((p) => {
      if (p._key !== key) return p;
      const has = p.blockWeeks.includes(wk);
      const nextWeeks = has
        ? p.blockWeeks.filter((w) => w !== wk)
        : [...p.blockWeeks, wk].sort((a, b) => a - b);
      // If all weeks removed, also clear blockYear (matches API refine — blockYear is only
      // meaningful when blockWeeks is non-empty).
      const nextYear = nextWeeks.length === 0 ? null : (p.blockYear ?? new Date().getFullYear());
      return { ...p, blockWeeks: nextWeeks, blockYear: nextYear };
    });
  }

  // v1.7.4 hotfix — Clear-all helper. Without this users have to click 53 chips
  // individually to deactivate the block-school mode, which is a footgun (one
  // accidental "select all" leaves the pattern claiming every weekday of the
  // year and overrides the daysOfWeek choice). Mirrors the blockYear-reset
  // semantics of bsToggleBlockWeek when blockWeeks ends up empty.
  function bsClearBlockWeeks(key: string) {
    bsPatterns = bsPatterns.map((p) => {
      if (p._key !== key) return p;
      return { ...p, blockWeeks: [], blockYear: null };
    });
  }

  function bsSetBlockYear(key: string, year: number | null) {
    bsPatterns = bsPatterns.map((p) =>
      p._key === key ? { ...p, blockYear: year != null && Number.isFinite(year) ? year : null } : p,
    );
  }

  function bsSetValidFrom(key: string, value: string) {
    bsPatterns = bsPatterns.map((p) => (p._key === key ? { ...p, validFrom: value } : p));
  }

  function bsSetValidUntil(key: string, value: string) {
    // Empty string from <input type="date"> means "no end date"
    bsPatterns = bsPatterns.map((p) =>
      p._key === key ? { ...p, validUntil: value === "" ? null : value } : p,
    );
  }

  // Phase 76.37 — bsSlot* per-pattern override helpers.
  // field: one of "bsSlotFirstLong" | "bsSlotSecondLong" | "bsSlotShortDay" | "bsSlotBlockWeek".
  // value: raw string from the input — "" means clear (inherit from TenantConfig / daily-Soll).
  function bsSetSlotField(
    key: string,
    field: "bsSlotFirstLong" | "bsSlotSecondLong" | "bsSlotShortDay" | "bsSlotBlockWeek",
    value: string,
  ) {
    bsPatterns = bsPatterns.map((p) => (p._key === key ? { ...p, [field]: value } : p));
  }

  // Bounds mirror apps/api/src/utils/vocational-school-constants.ts
  const BS_SLOT_DAILY_MIN = 240;
  const BS_SLOT_DAILY_MAX = 600;
  const BS_SLOT_BLOCK_MIN = 1200;
  const BS_SLOT_BLOCK_MAX = 3000;

  // Std-hint: minutes → hours string for display next to the input.
  // Returns "" when value is empty or non-numeric (no hint needed).
  function bsSlotHint(value: string): string {
    if (value === "" || !Number.isFinite(Number(value))) return "";
    return `= ${(Number(value) / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h`;
  }

  // Parse a slot string field to an API-ready integer | null.
  // "" → null (clear/inherit). Non-integer or out-of-bounds → null (soft-fallthrough).
  function parseSlotField(value: string, min: number, max: number): number | null {
    if (value === "") return null;
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  }

  // Client-side validation mirroring apps/api/src/routes/vocational-school-pattern.ts
  // Returns an error string for the first invalid row, or "" if all rows pass.
  // Phase 67.1: refine on `daysOfWeek.length > 0` instead of single-value check.
  // v1.7.4 hotfix: mode-aware. 'weekly' requires daysOfWeek; 'block' requires blockWeeks + blockYear.
  function bsValidationError(): string {
    for (let i = 0; i < bsPatterns.length; i++) {
      const p = bsPatterns[i];
      if (p.mode === "weekly") {
        if (p.daysOfWeek.length === 0) {
          return `Zeile ${i + 1}: Mindestens ein Wochentag muss ausgewählt sein`;
        }
      } else {
        if (p.blockWeeks.length === 0) {
          return `Zeile ${i + 1}: Mindestens eine Block-Woche muss ausgewählt sein`;
        }
        if (p.blockYear == null) {
          return `Zeile ${i + 1}: Jahr ist erforderlich wenn Block-Wochen gesetzt sind`;
        }
      }
      if (p.validUntil && p.validUntil < p.validFrom) {
        return `Zeile ${i + 1}: Gültig-bis muss >= Gültig-ab sein`;
      }
    }
    return "";
  }

  // Phase 67 Plan 02 — derived validation message (empty string = OK)
  let bsLocalValidationError = $derived.by(() => bsValidationError());
  let bsCanSave = $derived(bsLocalValidationError === "" && !bsPatternsSaving);

  // Phase 67 Plan 02 — Persist editor draft via PUT (replace semantics per API contract).
  // Server-side Zod re-validates; on error the verbatim German message is shown inline.
  async function savePatterns() {
    if (!employee) return;
    // Defensive re-check: button is disabled when invalid, but a quick keyboard activation
    // could race with $derived. Bail with inline message.
    const localErr = bsValidationError();
    if (localErr !== "") {
      bsPatternsSaveError = localErr;
      return;
    }
    bsPatternsSaving = true;
    bsPatternsSaveError = "";
    bsPatternsSaved = false;
    try {
      // Strip the _key field — API expects only persistable fields.
      // Phase 67.1: send `daysOfWeek` (array). The API still tolerates legacy
      // `dayOfWeek` but the canonical write path is the array.
      const payload = {
        patterns: bsPatterns.map((p) => ({
          daysOfWeek: p.daysOfWeek,
          blockWeeks: p.blockWeeks,
          blockYear: p.blockYear,
          validFrom: p.validFrom,
          validUntil: p.validUntil,
          // Phase 67.2 (Plan 05) — persist Ferien fields. The API has defaults so
          // omitting them is safe; we still send them to keep the round-trip explicit.
          respectSchoolHolidays: p.respectSchoolHolidays,
          federalStateOverride: p.federalStateOverride,
          // Phase 76.37 — persist per-pattern bsSlot* overrides.
          // "" → null (clear/inherit from TenantConfig / daily-Soll).
          bsSlotFirstLongDayMinutes: parseSlotField(
            p.bsSlotFirstLong,
            BS_SLOT_DAILY_MIN,
            BS_SLOT_DAILY_MAX,
          ),
          bsSlotSecondLongDayMinutes: parseSlotField(
            p.bsSlotSecondLong,
            BS_SLOT_DAILY_MIN,
            BS_SLOT_DAILY_MAX,
          ),
          bsSlotShortDayMinutes: parseSlotField(
            p.bsSlotShortDay,
            BS_SLOT_DAILY_MIN,
            BS_SLOT_DAILY_MAX,
          ),
          bsSlotBlockWeekMinutes: parseSlotField(
            p.bsSlotBlockWeek,
            BS_SLOT_BLOCK_MIN,
            BS_SLOT_BLOCK_MAX,
          ),
        })),
      };
      const res = await api.put<{ patterns: VocationalSchoolPattern[] }>(
        `/employees/${employee.id}/vocational-school-pattern`,
        payload,
      );
      // Reflect persisted rows back into the draft so newly-created rows get their server id
      // as the _key (replacing the synthetic "new-{n}"). This stabilises the {#each} key.
      bsPatterns = res.patterns.map((p) => {
        const hydratedDays =
          p.daysOfWeek && p.daysOfWeek.length > 0
            ? [...p.daysOfWeek]
            : p.dayOfWeek != null
              ? [p.dayOfWeek]
              : [];
        const hydratedWeeks = [...p.blockWeeks];
        const mode: BSPatternMode = hydratedWeeks.length > 0 ? "block" : "weekly";
        return {
          _key: p.id,
          mode,
          daysOfWeek: hydratedDays,
          blockWeeks: hydratedWeeks,
          blockYear: p.blockYear,
          validFrom: p.validFrom,
          validUntil: p.validUntil,
          // Phase 67.2 (Plan 05) — round-trip Ferien fields from PUT response
          respectSchoolHolidays: p.respectSchoolHolidays ?? true,
          federalStateOverride: p.federalStateOverride ?? null,
          // Phase 76.37 — round-trip bsSlot* overrides from PUT response
          bsSlotFirstLong:
            p.bsSlotFirstLongDayMinutes != null ? String(p.bsSlotFirstLongDayMinutes) : "",
          bsSlotSecondLong:
            p.bsSlotSecondLongDayMinutes != null ? String(p.bsSlotSecondLongDayMinutes) : "",
          bsSlotShortDay: p.bsSlotShortDayMinutes != null ? String(p.bsSlotShortDayMinutes) : "",
          bsSlotBlockWeek: p.bsSlotBlockWeekMinutes != null ? String(p.bsSlotBlockWeekMinutes) : "",
        };
      });
      bsNewKeyCounter = 0; // reset — all rows have server ids now
      bsPatternsSaved = true;
      toasts.success("Berufsschultage gespeichert", 2000);
      setTimeout(() => (bsPatternsSaved = false), 2000);
    } catch (e: unknown) {
      // Verbatim API error (Zod refine message or domain message)
      bsPatternsSaveError =
        e instanceof Error ? e.message : "Berufsschultage konnten nicht gespeichert werden.";
      toasts.error(bsPatternsSaveError, 4000);
    } finally {
      bsPatternsSaving = false;
    }
  }

  // ── Arbeitszeit state ──────────────────────────────────────────────────────
  let eType = $state<ScheduleType>("FIXED_SCHEDULE");
  let eWeeklyHours = $state<number>(40);
  let eMonthlyHours = $state<number>(0);
  let eCoreStart = $state<string>("");
  let eCoreEnd = $state<string>("");
  let eCoreDays = $state<number[]>([]);
  let eWorkDays = $state<number[]>([1, 2, 3, 4, 5]);
  let eMon = $state<number>(8);
  let eTue = $state<number>(8);
  let eWed = $state<number>(8);
  let eThu = $state<number>(8);
  let eFri = $state<number>(8);
  let eSat = $state<number>(0);
  let eSun = $state<number>(0);
  let eMonWd = $state<boolean>(true);
  let eTueWd = $state<boolean>(true);
  let eWedWd = $state<boolean>(true);
  let eThuWd = $state<boolean>(true);
  let eFriWd = $state<boolean>(true);
  let eSatWd = $state<boolean>(false);
  let eSunWd = $state<boolean>(false);
  let eThreshold = $state<number>(60);
  let ePayout = $state<boolean>(false);
  let eOvertimeMode = $state<"CARRY_FORWARD" | "TRACK_ONLY">("CARRY_FORWARD");
  let eValidFrom = $state<string>(new Date().toISOString().split("T")[0]);
  let arbeitszeitSaving = $state(false);
  let arbeitszeitError = $state("");
  let arbeitszeitSaved = $state(false);

  // Orphan-Schichten
  interface OrphanShiftPreview {
    date: string;
    startTime: string;
    endTime: string;
  }
  let orphanModalOpen = $state(false);
  let orphanPendingCount = $state(0);
  let orphanPreview = $state<OrphanShiftPreview[]>([]);

  let eWeekly = $derived(eMon + eTue + eWed + eThu + eFri + eSat + eSun);
  let eWorkingDays = $derived(
    [eMon, eTue, eWed, eThu, eFri, eSat, eSun].filter((h) => h > 0).length,
  );

  let orphanNewTypeLabel = $derived(
    eType === "FIXED_SCHEDULE"
      ? "Fester Stundenplan"
      : eType === "FLEXTIME"
        ? "Gleitzeit"
        : eType === "MONTHLY_HOURS"
          ? "Monatsstunden"
          : eType,
  );

  function onScheduleTypeChange(newType: ScheduleType) {
    eType = newType;
  }

  // Phase 60 (#220) — WorkSchedule.validFrom MUST be the 1st of a calendar month.
  // Snap the user's date pick to the 1st of its month on every change so the
  // input box immediately reflects what the server will accept. The API enforces
  // the same rule via Zod (apps/api/src/utils/month-first-date.ts).
  function snapValidFromToMonthFirst() {
    if (!eValidFrom) return; // empty input — leave alone
    // eValidFrom is "YYYY-MM-DD" from <input type="date">. Rewrite the day part.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eValidFrom);
    if (!m) return; // unexpected shape — leave alone, server-side Zod will reject
    if (m[3] === "01") return; // already month-1st — idempotent no-op
    eValidFrom = `${m[1]}-${m[2]}-01`;
  }

  function buildSchedulePayload(extra?: {
    keepOrphanShifts?: boolean;
    cancelOrphanShifts?: boolean;
  }) {
    return {
      type: eType,
      weeklyHours:
        eType === "SHIFT_BASED" || eType === "FLEXTIME"
          ? eWeeklyHours
          : eType === "FIXED_SCHEDULE"
            ? eWeekly
            : null,
      monthlyHours: eType === "MONTHLY_HOURS" ? eMonthlyHours : null,
      coreStart: eType === "FLEXTIME" ? eCoreStart || null : null,
      coreEnd: eType === "FLEXTIME" ? eCoreEnd || null : null,
      coreDays: eType === "FLEXTIME" ? eCoreDays : [],
      mondayHours: eType === "FIXED_SCHEDULE" ? eMon : eMonWd ? 1 : 0,
      tuesdayHours: eType === "FIXED_SCHEDULE" ? eTue : eTueWd ? 1 : 0,
      wednesdayHours: eType === "FIXED_SCHEDULE" ? eWed : eWedWd ? 1 : 0,
      thursdayHours: eType === "FIXED_SCHEDULE" ? eThu : eThuWd ? 1 : 0,
      fridayHours: eType === "FIXED_SCHEDULE" ? eFri : eFriWd ? 1 : 0,
      saturdayHours: eType === "FIXED_SCHEDULE" ? eSat : eSatWd ? 1 : 0,
      sundayHours: eType === "FIXED_SCHEDULE" ? eSun : eSunWd ? 1 : 0,
      overtimeThreshold: eThreshold,
      allowOvertimePayout: ePayout,
      overtimeMode: eType === "MONTHLY_HOURS" ? eOvertimeMode : "CARRY_FORWARD",
      workDays: eWorkDays,
      validFrom: eValidFrom,
      ...extra,
    };
  }

  async function doSaveSchedule(extra?: {
    keepOrphanShifts?: boolean;
    cancelOrphanShifts?: boolean;
  }) {
    if (!employee) return;
    arbeitszeitSaving = true;
    arbeitszeitError = "";
    try {
      await api.put<WorkSchedule>(`/settings/work/${employee.id}`, buildSchedulePayload(extra));
      arbeitszeitSaved = true;
      setTimeout(() => (arbeitszeitSaved = false), 3000);
    } catch (e: unknown) {
      if (
        (e as { status?: number })?.status === 409 &&
        (e as { data?: { code?: string } })?.data?.code === "ORPHAN_SHIFTS_PENDING"
      ) {
        const payload = (
          e as { data?: { pendingShifts?: number; shiftPreview?: OrphanShiftPreview[] } }
        )?.data;
        orphanPendingCount = payload?.pendingShifts ?? 0;
        orphanPreview = payload?.shiftPreview ?? [];
        orphanModalOpen = true;
      } else {
        arbeitszeitError = e instanceof Error ? e.message : "Fehler beim Speichern";
      }
    } finally {
      arbeitszeitSaving = false;
    }
  }

  async function saveSchedule() {
    return doSaveSchedule();
  }

  async function orphanKeep() {
    orphanModalOpen = false;
    await doSaveSchedule({ keepOrphanShifts: true });
  }

  async function orphanCancel() {
    orphanModalOpen = false;
    await doSaveSchedule({ cancelOrphanShifts: true });
  }

  function orphanAbort() {
    orphanModalOpen = false;
    eType = "SHIFT_BASED";
  }

  // ── Urlaub state ───────────────────────────────────────────────────────────
  const vacYear = new Date().getFullYear();
  let eVacSuggestion = $derived(Math.round((30 * eWorkingDays) / 5));
  let eVacTotal = $state<number | null>(null);
  let eVacCarried = $state<number>(0);
  let eVacDeadline = $state<string>("");
  let urlaubSaving = $state(false);
  let urlaubError = $state("");
  let urlaubSaved = $state(false);

  async function saveVacation() {
    if (!employee) return;
    urlaubSaving = true;
    urlaubError = "";
    urlaubSaved = false;
    try {
      await api.put(`/settings/vacation/${employee.id}`, {
        year: vacYear,
        totalDays: eVacTotal ?? eVacSuggestion,
        carriedOverDays: eVacCarried,
        carryOverDeadline: eVacDeadline || null,
      });
      urlaubSaved = true;
      setTimeout(() => (urlaubSaved = false), 3000);
    } catch (e: unknown) {
      urlaubError = e instanceof Error ? e.message : "Fehler beim Speichern";
    } finally {
      urlaubSaving = false;
    }
  }

  // ── Danger Zone state ──────────────────────────────────────────────────────
  let anonConfirmOpen = $state(false);
  let hardDelConfirmOpen = $state(false);
  let hardDeleteForce = $state(false);
  let hardDeleteRetentionExpiresAt = $state<string | null>(null);
  let hardDeleteError = $state("");

  async function anonymize() {
    if (!employee) return;
    await api.delete(`/employees/${employee.id}`);
    goto("/admin/employees");
  }

  async function hardDelete() {
    if (!employee) return;
    hardDeleteError = "";
    try {
      const body = hardDeleteForce ? { forceDelete: true } : undefined;
      await api.delete(`/employees/${employee.id}/hard-delete`, body);
      goto("/admin/employees");
    } catch (e: unknown) {
      if (e instanceof Error) {
        hardDeleteError = e.message;
        const apiData = (e as { data?: { retentionExpiresAt?: string } }).data;
        hardDeleteRetentionExpiresAt = apiData?.retentionExpiresAt ?? null;
      } else {
        hardDeleteError = "Fehler beim endgültigen Löschen";
      }
      throw e;
    }
  }

  // ── Derived display ────────────────────────────────────────────────────────
  let displayName = $derived(`${eFirstName} ${eLastName}`.trim());

  // Phase 76.7 (UI-V19-04a) — verb for the ConfirmDialog description.
  // OFF→ON (`intendedExempt === true`) = "befreien" (exempting the employee)
  // ON→OFF (`intendedExempt === false`) = "unterstellen" (re-subjecting to tracking)
  let exemptActionVerb = $derived(intendedExempt ? "befreien" : "unterstellen");
  let exemptDialogDescription = $derived(
    `Sie sind im Begriff, die Zeiterfassungs-Pflicht für ${employee?.firstName ?? ""} ${employee?.lastName ?? ""} zu ${exemptActionVerb}. Diese Änderung wird im Audit-Log protokolliert. Hinweis: Urlaubsanspruch nach BUrlG bleibt unverändert.`,
  );
</script>

{#if loading}
  <div class="page-loading">Laden…</div>
{:else if loadError || !employee}
  <div class="page-error">{loadError || "Mitarbeiter nicht gefunden."}</div>
{:else}
  <ListDetail
    view="detail"
    eyebrow="Personal"
    title={displayName || "Mitarbeiter"}
    sub={eEmployeeNumber ? `Personalnummer: ${eEmployeeNumber}` : undefined}
    crumbs={[
      { label: "Personal" },
      { label: "Mitarbeitende", href: "/admin/employees" },
      { label: displayName || "Mitarbeiter" },
    ]}
    tabs={TABS}
    bind:activeTab
  >
    {#snippet tabContent(tab)}
      {#if tab === "stammdaten"}
        <!-- ── Stammdaten ──────────────────────────────────────────────────── -->
        <Section title="Persönliche Daten" sub="Name, Mitarbeiternummer, NFC, Austrittsdatum">
          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveStammdaten} disabled={stammdatenSaving}>
              {stammdatenSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if stammdatenSaved}<span class="saved-hint">Gespeichert</span>{/if}
          {/snippet}

          {#if stammdatenError}
            <div class="callout error">{stammdatenError}</div>
          {/if}

          <div class="form-grid">
            <div class="form-group">
              <label class="form-label" for="e-firstname">Vorname</label>
              <input id="e-firstname" type="text" bind:value={eFirstName} class="input" />
            </div>
            <div class="form-group">
              <label class="form-label" for="e-lastname">Nachname</label>
              <input id="e-lastname" type="text" bind:value={eLastName} class="input" />
            </div>
            <div class="form-group">
              <label class="form-label" for="e-empno">Mitarbeiter-Nr.</label>
              <input id="e-empno" type="text" bind:value={eEmployeeNumber} class="input" />
            </div>

            <!-- Personalstruktur -->
            <div class="form-group form-group--full form-subhead">
              <h4 class="form-subhead-title">Personalstruktur</h4>
            </div>
            <div class="form-group">
              <label class="form-label" for="e-classification">Personalkategorie</label>
              <select
                id="e-classification"
                bind:value={eClassification}
                onchange={onClassificationChange}
                class="select"
              >
                {#each CLASSIFICATION_OPTIONS as opt (opt)}
                  <option value={opt}>{CLASSIFICATION_LABELS[opt]}</option>
                {/each}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="e-coverage">Schicht-Gewicht</label>
              <input
                id="e-coverage"
                type="number"
                bind:value={eCoverageWeight}
                class="input"
                min="0"
                max="9.99"
                step="0.05"
              />
              {#if eCoverageOverridden}
                <div class="override-row">
                  <span class="chip chip-warn">Manuell überschrieben</span>
                  <button type="button" class="btn btn-ghost btn-sm" onclick={resetCoverage}
                    >Auf Standard zurück</button
                  >
                </div>
              {/if}
            </div>
            <div class="form-group form-group--full">
              <label class="toggle-label">
                <input type="checkbox" bind:checked={eRequiresSupervision} />
                Aufsichtspflichtig
              </label>
              {#if eSupervisionOverridden}
                <div class="override-row">
                  <span class="chip chip-warn">Manuell überschrieben</span>
                  <button type="button" class="btn btn-ghost btn-sm" onclick={resetSupervision}
                    >Auf Standard zurück</button
                  >
                </div>
              {/if}
            </div>

            <!-- Phase 76.7 (UI-V19-04a) — § 18 ArbZG exemption toggle (ADMIN-only) -->
            {#if $authStore.user?.role === "ADMIN"}
              <div class="form-group form-group--full form-subhead">
                <h4 class="form-subhead-title">Zeiterfassungs-Pflicht</h4>
              </div>
              <div class="form-group form-group--full" data-testid="exemption-toggle-row">
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    bind:checked={eIsTimeTrackingExempt}
                    onchange={onExemptToggleChange}
                    disabled={exemptSaving}
                    data-testid="exemption-toggle"
                  />
                  <span>Keine Zeiterfassungs-Pflicht (§ 18 ArbZG)</span>
                </label>
                <p class="hint">
                  Inhaber, Geschäftsführer und leitende Angestellte sind nach § 18 ArbZG von der
                  Arbeitszeiterfassung befreit. Urlaubsanspruch nach BUrlG bleibt bestehen.
                </p>
              </div>
            {/if}

            <!-- Weitere Stammdaten -->
            <div class="form-group form-group--full form-subhead">
              <h4 class="form-subhead-title">Weitere Stammdaten</h4>
            </div>
            <div class="form-group form-group--full">
              <label class="form-label" for="e-birthdate">Geburtsdatum (optional)</label>
              <input id="e-birthdate" type="date" bind:value={eBirthDate} class="input" />
              <p class="hint">
                Für Azubis unter 18 Jahren werden bei der Pausendauer JArbSchG §9 Schutzregeln
                vorgeschlagen (30 / 60 Min).
              </p>
            </div>
            <div class="form-group form-group--full">
              <label class="form-label" for="e-exitdate">Austrittsdatum (optional)</label>
              <input id="e-exitdate" type="date" bind:value={eExitDate} class="input" />
              <p class="hint">
                Bei gesetztem Datum wird der Jahresurlaub anteilig berechnet (<span translate="no"
                  >§ 5 Abs. 2 BUrlG</span
                >).
              </p>
            </div>
            <div class="form-group form-group--full">
              <label class="form-label" for="e-nfc">NFC-Karten-ID</label>
              <input
                id="e-nfc"
                type="text"
                bind:value={eNfcCardId}
                class="input"
                placeholder="z.B. NFC-A1B2C3D4"
              />
              <p class="hint">Optional. Ermöglicht Stempeln per NFC-Karte.</p>
            </div>
          </div>
        </Section>
      {:else if tab === "arbeitszeit"}
        <!-- ── Arbeitszeit ─────────────────────────────────────────────────── -->
        <Section
          title="Arbeitszeitmodell"
          sub="Festzeit, Gleitzeit, Monatsstunden oder Schichtplan"
        >
          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveSchedule} disabled={arbeitszeitSaving}>
              {arbeitszeitSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if arbeitszeitSaved}<span class="saved-hint">Gespeichert</span>{/if}
          {/snippet}

          {#if arbeitszeitError}
            <div class="callout error">{arbeitszeitError}</div>
          {/if}

          <!-- Type picker -->
          <div class="form-group">
            <label class="form-label">Arbeitszeitmodell</label>
            <div class="schedule-type-picker" role="group" aria-label="Arbeitszeitmodell">
              {#each [{ value: "FIXED_SCHEDULE", label: "Fester Stundenplan", tooltip: "Per-Tag-Stunden festgelegt — z.B. Mo–Fr je 8h." }, { value: "FLEXTIME", label: "Gleitzeit", tooltip: "Wochenstundensoll mit freier Tagesverteilung. Optional Kernarbeitszeit." }, { value: "MONTHLY_HOURS", label: "Monatsstunden (Minijob)", tooltip: "Monatsstunden-Budget — z.B. 15h/Monat für Minijobber." }, { value: "SHIFT_BASED", label: "Schichtplan", tooltip: "Schichtplan ist führend. Wochenstunden als Soll-Target." }] as seg (seg.value)}
                <button
                  type="button"
                  class="stp-btn"
                  class:stp-btn--active={eType === seg.value}
                  aria-pressed={eType === seg.value}
                  title={seg.tooltip}
                  onclick={() => onScheduleTypeChange(seg.value as ScheduleType)}
                  >{seg.label}</button
                >
              {/each}
            </div>
          </div>

          <!-- FIXED_SCHEDULE: per-day hour inputs -->
          {#if eType === "FIXED_SCHEDULE"}
            <p class="form-hint">Wochenstunden werden automatisch aus den Tagen summiert.</p>
            <div class="day-grid">
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-mo">Mo</label>
                <input
                  id="emp-day-mo"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eMon}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-di">Di</label>
                <input
                  id="emp-day-di"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eTue}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-mi">Mi</label>
                <input
                  id="emp-day-mi"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eWed}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-do">Do</label>
                <input
                  id="emp-day-do"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eThu}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-fr">Fr</label>
                <input
                  id="emp-day-fr"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eFri}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-sa">Sa</label>
                <input
                  id="emp-day-sa"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eSat}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input">
                <label class="day-label form-label" for="emp-day-so">So</label>
                <input
                  id="emp-day-so"
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  bind:value={eSun}
                  class="form-input day-field"
                />
              </div>
              <div class="day-input total-col">
                <span class="day-label form-label">Sigma</span>
                <span class="weekly-total">{eWeekly.toFixed(1)}&thinsp;h</span>
              </div>
            </div>
          {:else if eType === "FLEXTIME"}
            <div class="form-group">
              <label class="form-label" for="e-weekly-flex">Wochenstunden-Soll</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-weekly-flex"
                  type="number"
                  min="0"
                  max="60"
                  step="0.25"
                  bind:value={eWeeklyHours}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">h/Woche</span>
              </div>
            </div>

            <h3 class="modal-section-heading">Kernarbeitszeit (optional)</h3>
            <p class="form-hint">
              Zeitfenster, in dem alle Mitarbeiter anwesend sein müssen. Leer lassen für reine
              Gleitzeit ohne Kernzeit.
            </p>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="e-core-start">Kernzeitbeginn</label>
                <input
                  id="e-core-start"
                  type="time"
                  bind:value={eCoreStart}
                  placeholder="—"
                  class="form-input"
                />
              </div>
              <div class="form-group">
                <label class="form-label" for="e-core-end">Kernzeitende</label>
                <input
                  id="e-core-end"
                  type="time"
                  bind:value={eCoreEnd}
                  placeholder="—"
                  class="form-input"
                />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Kerntage</label>
              <div class="weekday-chips" role="group" aria-label="Kerntage">
                {#each [{ value: 1, label: "Mo" }, { value: 2, label: "Di" }, { value: 3, label: "Mi" }, { value: 4, label: "Do" }, { value: 5, label: "Fr" }, { value: 6, label: "Sa" }, { value: 0, label: "So" }] as day (day.value)}
                  <button
                    type="button"
                    class="wd-chip"
                    class:wd-chip--active={eCoreDays.includes(day.value)}
                    onclick={() => {
                      if (eCoreDays.includes(day.value)) {
                        eCoreDays = eCoreDays.filter((d) => d !== day.value);
                      } else {
                        eCoreDays = [...eCoreDays, day.value];
                      }
                    }}>{day.label}</button
                  >
                {/each}
              </div>
            </div>
          {:else if eType === "MONTHLY_HOURS"}
            <div class="form-group">
              <label class="form-label" for="e-monthly-hours">Stunden/Monat</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-monthly-hours"
                  type="number"
                  min="0"
                  max="744"
                  step="0.5"
                  bind:value={eMonthlyHours}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">Stunden</span>
              </div>
              <p class="form-hint">Keine festen Wochentage – Soll wird monatlich berechnet.</p>
            </div>

            <div class="form-group">
              <label class="form-label" for="e-overtime-mode">Überstunden-Modus</label>
              <select id="e-overtime-mode" bind:value={eOvertimeMode} class="form-input">
                <option value="CARRY_FORWARD">Übertragen (CARRY_FORWARD)</option>
                <option value="TRACK_ONLY">Nur erfassen (TRACK_ONLY)</option>
              </select>
            </div>

            <div class="form-group">
              <span class="form-label">Feste Arbeitstage</span>
              <div class="weekday-chips">
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eMonWd}
                  onclick={() => (eMonWd = !eMonWd)}>Mo</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eTueWd}
                  onclick={() => (eTueWd = !eTueWd)}>Di</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eWedWd}
                  onclick={() => (eWedWd = !eWedWd)}>Mi</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eThuWd}
                  onclick={() => (eThuWd = !eThuWd)}>Do</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eFriWd}
                  onclick={() => (eFriWd = !eFriWd)}>Fr</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eSatWd}
                  onclick={() => (eSatWd = !eSatWd)}>Sa</button
                >
                <button
                  type="button"
                  class="wd-chip"
                  class:wd-chip--active={eSunWd}
                  onclick={() => (eSunWd = !eSunWd)}>So</button
                >
              </div>
            </div>
          {:else}
            <!-- SHIFT_BASED -->
            <div class="form-group">
              <label class="form-label" for="e-weekly-hours">Wochenstunden-Soll</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-weekly-hours"
                  type="number"
                  min="1"
                  max="168"
                  step="0.5"
                  bind:value={eWeeklyHours}
                  class="form-input threshold-input"
                  aria-required="true"
                />
                <span class="input-suffix">Stunden</span>
              </div>
              <p class="form-hint">
                Schichtplan ist führend — Soll wird wöchentlich als Gesamtstunden erfasst.
              </p>
            </div>
          {/if}

          <!-- Arbeitstage/Woche (unabhängig vom AZ-Modell, Phase 49.5) -->
          <div class="form-group" style="margin-top: 1rem;">
            <label class="form-label" for="e-workdays">Arbeitstage/Woche</label>
            <div class="input-suffix-wrap" style="max-width: 240px;">
              <input
                id="e-workdays"
                type="number"
                min="1"
                max="7"
                step="1"
                class="form-input threshold-input"
                value={eWorkDays.length}
                oninput={(ev) => {
                  const n = Math.max(
                    1,
                    Math.min(7, Number((ev.target as HTMLInputElement).value) || 0),
                  );
                  const canonical = [1, 2, 3, 4, 5, 6, 0];
                  eWorkDays = canonical.slice(0, n).sort((a, b) => a - b);
                }}
              />
              <span class="input-suffix">Tage</span>
            </div>
            <p class="form-hint">
              Anzahl Arbeitstage pro Woche — unabhängig vom AZ-Modell. Quelle für Urlaubsverbrauch
              und Pro-Rata-Urlaubsberechnung.
            </p>
          </div>

          <!-- Threshold + Payout -->
          <div class="extra-row spaced-top-md">
            <div class="form-group">
              <label class="form-label" for="e-threshold">Überstunden-Warnschwelle</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-threshold"
                  type="number"
                  min="1"
                  max="500"
                  bind:value={eThreshold}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">Stunden</span>
              </div>
            </div>
            <div class="form-group">
              <span class="form-label">Überstunden-Auszahlung</span>
              <label class="toggle-label">
                <input type="checkbox" bind:checked={ePayout} class="toggle-cb" />
                <span>{ePayout ? "Erlaubt" : "Gesperrt"}</span>
              </label>
            </div>
          </div>

          <!-- Valid From — Phase 60 (#220) enforces month-1st snap -->
          <div class="form-group spaced-top-md">
            <label class="form-label" for="e-valid-from">Gültig ab</label>
            <input
              id="e-valid-from"
              type="date"
              bind:value={eValidFrom}
              onchange={snapValidFromToMonthFirst}
              class="form-input"
            />
            <p class="form-hint">Wechsel werden zum 1. eines Monats wirksam.</p>
          </div>
        </Section>

        <!-- Phase 65 — Pausendauer (Optional) per-Employee Override (BREAK-06, BREAK-07, D-04..D-07) -->
        <!-- Phase 73-05: data-testid surface for the per-employee Pausendauer editor.
             Clokr's break model has 2 fixed thresholds (>6h / >9h), not a table of N
             rows — so the plan's pausendauer-row-${i} pattern doesn't apply. Plan
             says: "apply only to elements that exist; don't invent UI." -->
        <div data-testid="pausendauer-editor" style="display: contents;">
          <Section
            title="Pausendauer (Optional)"
            sub="Überschreibt Tenant-Standard für diesen Mitarbeiter. Leer = Standard verwenden."
          >
            {#snippet footer()}
              <button
                class="btn btn-primary"
                onclick={savePausendauer}
                disabled={pausendauerSaving}
                data-testid="pausendauer-save"
              >
                {pausendauerSaving ? "Speichern…" : "Speichern"}
              </button>
              {#if pausendauerSaved}<span class="saved-hint">Gespeichert</span>{/if}
            {/snippet}

            {#if pausendauerError}
              <div class="callout error" data-testid="pausendauer-error">{pausendauerError}</div>
            {/if}

            {#if isAzubiUnder18}
              <!-- JArbSchG §9 info pill (recommendation, not violation — uses .alert-info per app.css) -->
              <div
                class="alert alert-info"
                role="status"
                style="margin-bottom: 1rem;"
                data-testid="pausendauer-azubi-pill"
              >
                <span>ℹ️</span><span>Azubi unter 18 — JArbSchG §9 Empfehlung</span>
              </div>
              {#if showAzubiSuggestionButton}
                <div style="margin-bottom: 1rem;">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={applyAzubiSuggestion}
                    data-testid="pausendauer-azubi-apply"
                    >Azubi-Vorschlag übernehmen (30 / 60 Min)</button
                  >
                </div>
              {/if}
            {/if}

            <p class="form-hint text-muted" style="margin-bottom: 1rem;">
              Leer = Tenant-Standard nutzen ({tenantBreakConfig?.defaultBreakOver6h ??
                30}/{tenantBreakConfig?.defaultBreakOver9h ?? 45} Min)
            </p>

            <div class="form-group">
              <label class="form-label" for="emp-break-over6h">Pause &gt;6h (Min)</label>
              <input
                id="emp-break-over6h"
                type="number"
                min="30"
                max="120"
                step="1"
                bind:value={eBreakOver6hOverride}
                placeholder={isAzubiUnder18
                  ? "30 Min — JArbSchG-Empfehlung"
                  : `Standard: ${tenantBreakConfig?.defaultBreakOver6h ?? 30} Min`}
                class="form-input"
                disabled={pausendauerSaving}
                data-testid="pausendauer-over6h"
              />
              <p class="form-hint text-muted">ArbZG-Minimum: 30 Min</p>
            </div>

            <div class="form-group" style="margin-top: 1rem;">
              <label class="form-label" for="emp-break-over9h">Pause &gt;9h (Min)</label>
              <input
                id="emp-break-over9h"
                type="number"
                min="45"
                max="180"
                step="1"
                bind:value={eBreakOver9hOverride}
                placeholder={isAzubiUnder18
                  ? "60 Min — JArbSchG-Empfehlung"
                  : `Standard: ${tenantBreakConfig?.defaultBreakOver9h ?? 45} Min`}
                class="form-input"
                disabled={pausendauerSaving}
                data-testid="pausendauer-over9h"
              />
              <p class="form-hint text-muted">ArbZG-Minimum: 45 Min</p>
            </div>
          </Section>
        </div>

        <!-- Phase 85.1.1 (D-01, D-03) — Phorest Vor-/Nachbereitungszeit (Optional) per-Employee
             Override. Mirrors the Pausendauer (Optional) Section above end-to-end. -->
        <div data-testid="phorest-puffer-editor" style="display: contents;">
          <Section
            title="Phorest Vor-/Nachbereitungszeit (Optional)"
            sub="Überschreibt Tenant-Standard für diesen Mitarbeiter. Leer = Standard verwenden."
          >
            {#snippet footer()}
              <button
                class="btn btn-primary"
                onclick={savePhorestPuffer}
                disabled={phorestPufferSaving}
                data-testid="phorest-puffer-save"
              >
                {phorestPufferSaving ? "Speichern…" : "Speichern"}
              </button>
              {#if phorestPufferSaved}<span class="saved-hint">Gespeichert</span>{/if}
            {/snippet}

            {#if phorestPufferError}
              <div class="callout error" data-testid="phorest-puffer-error">
                {phorestPufferError}
              </div>
            {/if}

            <p class="form-hint text-muted" style="margin-bottom: 1rem;">
              Leer = Firmenstandard nutzen ({tenantBreakConfig?.phorestPrepMinutes ??
                0}/{tenantBreakConfig?.phorestWrapupMinutes ?? 0} Min)
            </p>

            <div class="form-group">
              <label class="form-label" for="emp-phorest-prep">Vorbereitungszeit (Min.)</label>
              <input
                id="emp-phorest-prep"
                type="number"
                min="0"
                max="30"
                step="1"
                bind:value={ePhorestPrepOverride}
                placeholder={`Standard: ${tenantBreakConfig?.phorestPrepMinutes ?? 0} Min`}
                class="form-input"
                disabled={phorestPufferSaving}
                data-testid="phorest-puffer-prep"
              />
            </div>

            <div class="form-group" style="margin-top: 1rem;">
              <label class="form-label" for="emp-phorest-wrapup">Nachbereitungszeit (Min.)</label>
              <input
                id="emp-phorest-wrapup"
                type="number"
                min="0"
                max="30"
                step="1"
                bind:value={ePhorestWrapupOverride}
                placeholder={`Standard: ${tenantBreakConfig?.phorestWrapupMinutes ?? 0} Min`}
                class="form-input"
                disabled={phorestPufferSaving}
                data-testid="phorest-puffer-wrapup"
              />
            </div>
          </Section>
        </div>

        <!-- Phase 67 (BERSCH-15) — Berufsschultag (Optional) editor (full edit semantics) -->
        {#if eClassification === "AZUBI"}
          <Section
            title="Berufsschultag (Optional)"
            sub="Wiederkehrende Berufsschultage und Block-Wochen für BBiG-§15-Freistellung"
          >
            {#snippet footer()}
              <button
                class="btn btn-primary"
                onclick={savePatterns}
                disabled={!bsCanSave}
                title={bsLocalValidationError || ""}
              >
                {bsPatternsSaving ? "Speichern…" : "Speichern"}
              </button>
              {#if bsPatternsSaved}<span class="saved-hint">Gespeichert</span>{/if}
            {/snippet}

            {#if bsPatternsLoadError}
              <div class="callout error">{bsPatternsLoadError}</div>
            {/if}
            {#if bsPatternsSaveError}
              <div class="callout error">{bsPatternsSaveError}</div>
            {/if}
            {#if bsLocalValidationError && bsPatterns.length > 0}
              <div class="callout">{bsLocalValidationError}</div>
            {/if}

            {#if bsPatterns.length === 0}
              <p class="form-hint text-muted" style="margin-bottom: 1rem;">
                Keine Berufsschultage konfiguriert.
              </p>
            {/if}

            {#if bsPatterns.length > 0}
              <ul class="bs-pattern-list">
                {#each bsPatterns as p, idx (p._key)}
                  <li class="bs-pattern-card">
                    <!-- Row header with delete -->
                    <div class="bs-pattern-row bs-pattern-head">
                      <span class="bs-pattern-label">Pattern {idx + 1}</span>
                      <button
                        type="button"
                        class="btn btn-ghost btn-sm"
                        onclick={() => bsRemovePattern(p._key)}
                        disabled={bsPatternsSaving}
                        aria-label="Pattern entfernen"
                      >
                        Entfernen
                      </button>
                    </div>

                    <!-- v1.7.4 hotfix — Mode toggle: mutually-exclusive BBiG semantics.
                         'weekly' = wöchentlich wiederkehrende BS-Tage (Mo + Mi)
                         'block'  = Blockunterricht (komplette Wochen, Pflege/Friseur)
                         Reuses the .schedule-type-picker / .stp-btn recipe from the
                         Arbeitszeitmodell widget above so the BS section visually fits
                         the rest of the Arbeitszeit tab. -->
                    <div class="form-group">
                      <label class="form-label">BS-Modus</label>
                      <div class="schedule-type-picker" role="radiogroup" aria-label="BS-Modus">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={p.mode === "weekly"}
                          class="stp-btn"
                          class:stp-btn--active={p.mode === "weekly"}
                          title="Wöchentlich 1-2 BS-Tage (Standard für IHK-Berufe)"
                          onclick={() => bsSetMode(p._key, "weekly")}
                          disabled={bsPatternsSaving}
                        >
                          Wöchentlicher BS-Tag
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={p.mode === "block"}
                          class="stp-btn"
                          class:stp-btn--active={p.mode === "block"}
                          title="Blockunterricht — komplette Wochen am Stück (Pflege, Friseur)"
                          onclick={() => bsSetMode(p._key, "block")}
                          disabled={bsPatternsSaving}
                        >
                          Blockunterricht
                        </button>
                      </div>
                    </div>

                    {#if p.mode === "weekly"}
                      <!-- daysOfWeek chip-row (toggle, multi-select) -->
                      <!-- Phase 67.1 (v1.7.4): chip-strip toggles set-membership in
                           `daysOfWeek`. Multiple selections produce one DB row covering
                           all chosen weekdays (Mo + Mi + Fr -> one pattern, three days). -->
                      <div class="bs-pattern-row">
                        <span class="bs-pattern-label">Wochentage:</span>
                        <div class="bs-chip-row">
                          {#each BS_WEEKDAY_LABELS as label, didx (label)}
                            <button
                              type="button"
                              class="chip chip-button"
                              class:chip-brand={p.daysOfWeek.includes(didx)}
                              onclick={() => bsToggleDayOfWeek(p._key, didx)}
                              disabled={bsPatternsSaving}
                            >
                              {label}
                            </button>
                          {/each}
                        </div>
                      </div>
                      <p class="bs-pattern-hint bs-mode-help">
                        Wähle 1-7 Wochentage, an denen der/die Azubi zur Berufsschule geht.
                      </p>
                    {:else}
                      <!-- blockWeeks chip-grid 1..53 (toggle, multi-select) -->
                      <div class="bs-pattern-row">
                        <span class="bs-pattern-label">
                          Block-Wochen
                          {#if p.blockWeeks.length > 0}
                            <span class="bs-week-count">({p.blockWeeks.length})</span>
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm bs-week-clear"
                              onclick={() => bsClearBlockWeeks(p._key)}
                              disabled={bsPatternsSaving}
                              title="Alle Block-Wochen abwählen"
                            >
                              Alle abwählen
                            </button>
                          {/if}:
                        </span>
                        <div class="bs-week-grid">
                          {#each Array.from({ length: 53 }, (_, i) => i + 1) as wk (wk)}
                            <button
                              type="button"
                              class="chip chip-week chip-button"
                              class:chip-brand={p.blockWeeks.includes(wk)}
                              onclick={() => bsToggleBlockWeek(p._key, wk)}
                              disabled={bsPatternsSaving}
                            >
                              {wk}
                            </button>
                          {/each}
                        </div>
                      </div>

                      <!-- Year picker (always visible in block mode; blockYear is required) -->
                      <div class="bs-pattern-row">
                        <span class="bs-pattern-label">Jahr:</span>
                        <input
                          type="number"
                          class="form-input bs-year-input"
                          min={new Date().getFullYear() - 2}
                          max={new Date().getFullYear() + 2}
                          step="1"
                          value={p.blockYear ?? new Date().getFullYear()}
                          oninput={(e) =>
                            bsSetBlockYear(
                              p._key,
                              Number.parseInt((e.currentTarget as HTMLInputElement).value, 10),
                            )}
                          disabled={bsPatternsSaving}
                        />
                      </div>
                      <p class="bs-pattern-hint bs-mode-help">
                        Markiere die KWs, in denen Blockunterricht stattfindet. Jeder Tag dieser
                        Wochen zählt dann als Berufsschultag.
                      </p>
                    {/if}

                    <!-- Validity inputs -->
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">Gültig-ab:</span>
                      <input
                        type="date"
                        class="form-input"
                        value={p.validFrom}
                        oninput={(e) =>
                          bsSetValidFrom(p._key, (e.currentTarget as HTMLInputElement).value)}
                        disabled={bsPatternsSaving}
                      />
                    </div>
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">Gültig-bis:</span>
                      <input
                        type="date"
                        class="form-input"
                        value={p.validUntil ?? ""}
                        placeholder="Unbefristet"
                        oninput={(e) =>
                          bsSetValidUntil(p._key, (e.currentTarget as HTMLInputElement).value)}
                        disabled={bsPatternsSaving}
                      />
                    </div>

                    <!-- Phase 67.2 (Plan 05) — Schulferien-Behandlung toggle.
                         Deaktivieren für Pflegeschulen / Berufsakademien, die nicht den
                         KMK-Schulferien folgen (Generator ignoriert dann den Cache). -->
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">Schulferien:</span>
                      <label class="bs-checkbox">
                        <input
                          type="checkbox"
                          checked={p.respectSchoolHolidays}
                          onchange={() => bsToggleRespectSchoolHolidays(p._key)}
                          disabled={bsPatternsSaving}
                        />
                        <span>Schulferien beachten</span>
                      </label>
                      <small class="bs-pattern-hint"
                        >Pflegeschulen / Berufsakademien: deaktivieren</small
                      >
                    </div>

                    <!-- Phase 67.2 (Plan 05) — Bundesland-Override (Pendler-Azubi).
                         v1.7.4 hotfix: cross-cutting field — always visible regardless of mode. -->
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">BS-Bundesland:</span>
                      <select
                        class="form-input bs-state-select"
                        value={p.federalStateOverride ?? ""}
                        onchange={(e) => {
                          const val = (e.currentTarget as HTMLSelectElement).value;
                          bsSetFederalStateOverride(
                            p._key,
                            val === "" ? null : (val as FederalState),
                          );
                        }}
                        disabled={bsPatternsSaving}
                      >
                        <option value="">Wie Mandant (Standard)</option>
                        {#each BS_FEDERAL_STATE_OPTIONS as opt (opt.value)}
                          <option value={opt.value}>{opt.label}</option>
                        {/each}
                      </select>
                      <small class="bs-pattern-hint"
                        >Nur bei Pendler-Azubi: Schule in anderem Bundesland</small
                      >
                    </div>

                    <!-- Phase 76.37 — per-pattern bsSlot* Zeitgutschrift overrides.
                         Middle layer: Employee > Pattern (here) > TenantConfig > daily-Soll.
                         "Leer = erben" pattern: empty input → null → delegate down the chain.
                         Never pre-filled from lower layers so the admin sees exactly what's
                         set at the pattern level, not an inherited value.
                         Bounds: daily [240..600 min] (4-10 h), block-week [1200..3000 min] (20-50 h). -->
                    <div class="bs-slot-section">
                      <p class="bs-pattern-label bs-slot-section-title">
                        Zeitgutschrift-Slots (optional)
                      </p>
                      <p class="bs-pattern-hint" style="margin-bottom: 0.75rem;">
                        Leer = Wert wird aus Mandant-Konfiguration bzw. Tages-Soll geerbt.
                        Tages-Slots: 240–600 Min (4–10 h). Blockunterricht-Woche: 1200–3000 Min
                        (20–50 h).
                      </p>

                      <!-- 1. Berufsschul-Langtag -->
                      <div class="form-group bs-slot-group">
                        <label class="form-label" for="bs-p-slot-first-{p._key}">
                          1. BS-Langtag (Minuten)
                        </label>
                        <div class="bs-slot-input-row">
                          <input
                            id="bs-p-slot-first-{p._key}"
                            type="number"
                            min={BS_SLOT_DAILY_MIN}
                            max={BS_SLOT_DAILY_MAX}
                            step="1"
                            class="form-input modal-input-sm"
                            value={p.bsSlotFirstLong}
                            placeholder="Erbt aus: Tages-Soll"
                            oninput={(e) =>
                              bsSetSlotField(
                                p._key,
                                "bsSlotFirstLong",
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            disabled={bsPatternsSaving}
                          />
                          {#if bsSlotHint(p.bsSlotFirstLong)}
                            <span class="bs-slot-hint">{bsSlotHint(p.bsSlotFirstLong)}</span>
                          {/if}
                          {#if p.bsSlotFirstLong !== ""}
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm bs-clear-btn"
                              onclick={() => bsSetSlotField(p._key, "bsSlotFirstLong", "")}
                              disabled={bsPatternsSaving}
                              title="Auf Vorgabe zurücksetzen"
                              aria-label="1. Langtag auf Vorgabe zurücksetzen"
                            >
                              × Erben
                            </button>
                          {/if}
                        </div>
                        {#if p.bsSlotFirstLong === ""}
                          <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
                        {/if}
                      </div>

                      <!-- 2. Berufsschul-Langtag -->
                      <div class="form-group bs-slot-group">
                        <label class="form-label" for="bs-p-slot-second-{p._key}">
                          2. BS-Langtag (Minuten)
                        </label>
                        <div class="bs-slot-input-row">
                          <input
                            id="bs-p-slot-second-{p._key}"
                            type="number"
                            min={BS_SLOT_DAILY_MIN}
                            max={BS_SLOT_DAILY_MAX}
                            step="1"
                            class="form-input modal-input-sm"
                            value={p.bsSlotSecondLong}
                            placeholder="Erbt aus: Tages-Soll"
                            oninput={(e) =>
                              bsSetSlotField(
                                p._key,
                                "bsSlotSecondLong",
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            disabled={bsPatternsSaving}
                          />
                          {#if bsSlotHint(p.bsSlotSecondLong)}
                            <span class="bs-slot-hint">{bsSlotHint(p.bsSlotSecondLong)}</span>
                          {/if}
                          {#if p.bsSlotSecondLong !== ""}
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm bs-clear-btn"
                              onclick={() => bsSetSlotField(p._key, "bsSlotSecondLong", "")}
                              disabled={bsPatternsSaving}
                              title="Auf Vorgabe zurücksetzen"
                              aria-label="2. Langtag auf Vorgabe zurücksetzen"
                            >
                              × Erben
                            </button>
                          {/if}
                        </div>
                        {#if p.bsSlotSecondLong === ""}
                          <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
                        {/if}
                      </div>

                      <!-- Berufsschul-Kurztag -->
                      <div class="form-group bs-slot-group">
                        <label class="form-label" for="bs-p-slot-short-{p._key}">
                          BS-Kurztag (Minuten)
                        </label>
                        <div class="bs-slot-input-row">
                          <input
                            id="bs-p-slot-short-{p._key}"
                            type="number"
                            min={BS_SLOT_DAILY_MIN}
                            max={BS_SLOT_DAILY_MAX}
                            step="1"
                            class="form-input modal-input-sm"
                            value={p.bsSlotShortDay}
                            placeholder="Erbt aus: Tages-Soll"
                            oninput={(e) =>
                              bsSetSlotField(
                                p._key,
                                "bsSlotShortDay",
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            disabled={bsPatternsSaving}
                          />
                          {#if bsSlotHint(p.bsSlotShortDay)}
                            <span class="bs-slot-hint">{bsSlotHint(p.bsSlotShortDay)}</span>
                          {/if}
                          {#if p.bsSlotShortDay !== ""}
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm bs-clear-btn"
                              onclick={() => bsSetSlotField(p._key, "bsSlotShortDay", "")}
                              disabled={bsPatternsSaving}
                              title="Auf Vorgabe zurücksetzen"
                              aria-label="Kurztag auf Vorgabe zurücksetzen"
                            >
                              × Erben
                            </button>
                          {/if}
                        </div>
                        {#if p.bsSlotShortDay === ""}
                          <p class="form-hint text-muted">Erbt aus: Tages-Soll des Mitarbeiters</p>
                        {/if}
                      </div>

                      <!-- Blockunterricht-Woche -->
                      <div class="form-group bs-slot-group">
                        <label class="form-label" for="bs-p-slot-block-{p._key}">
                          Blockunterricht-Woche (Minuten)
                        </label>
                        <div class="bs-slot-input-row">
                          <input
                            id="bs-p-slot-block-{p._key}"
                            type="number"
                            min={BS_SLOT_BLOCK_MIN}
                            max={BS_SLOT_BLOCK_MAX}
                            step="1"
                            class="form-input modal-input-sm"
                            value={p.bsSlotBlockWeek}
                            placeholder="Erbt aus: Wochenstunden-Soll"
                            oninput={(e) =>
                              bsSetSlotField(
                                p._key,
                                "bsSlotBlockWeek",
                                (e.currentTarget as HTMLInputElement).value,
                              )}
                            disabled={bsPatternsSaving}
                          />
                          {#if bsSlotHint(p.bsSlotBlockWeek)}
                            <span class="bs-slot-hint">{bsSlotHint(p.bsSlotBlockWeek)}</span>
                          {/if}
                          {#if p.bsSlotBlockWeek !== ""}
                            <button
                              type="button"
                              class="btn btn-ghost btn-sm bs-clear-btn"
                              onclick={() => bsSetSlotField(p._key, "bsSlotBlockWeek", "")}
                              disabled={bsPatternsSaving}
                              title="Auf Vorgabe zurücksetzen"
                              aria-label="Blockunterricht-Woche auf Vorgabe zurücksetzen"
                            >
                              × Erben
                            </button>
                          {/if}
                        </div>
                        {#if p.bsSlotBlockWeek === ""}
                          <p class="form-hint text-muted">
                            Erbt aus: Wochenstunden-Soll des Mitarbeiters
                          </p>
                        {/if}
                      </div>

                      <div class="alert alert-info bs-revision-alert" role="alert">
                        <span>ℹ</span><span
                          >Änderungen wirken nur auf offene und künftige Monate.</span
                        >
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}

            <div style="margin-top: 1rem;">
              <button
                type="button"
                class="btn btn-secondary"
                onclick={bsAddPattern}
                disabled={bsPatternsSaving}
              >
                + Berufsschultag hinzufügen
              </button>
            </div>
          </Section>

          <!-- Phase 76.36 — Per-employee bsSlot* override panel (BBIG-V19-03).
               Highest layer in Employee > Pattern > TenantConfig > daily-Soll hierarchy.
               Empty field = inherit (never prefilled with inherited value).
               Clearing a field sends null → re-enables inheritance for that slot. -->
          <Section
            title="Zeitgutschrift Berufsschule (Mitarbeiter-Override)"
            sub="Überschreibt Pattern- und Mandanten-Vorgabe für diesen Azubi. Leer = von tieferer Schicht erben."
          >
            {#snippet footer()}
              <button class="btn btn-primary" onclick={saveBsSlotEmp} disabled={empBsSlotSaving}>
                {empBsSlotSaving ? "Speichern…" : "Speichern"}
              </button>
              {#if empBsSlotSaved}<span class="saved-hint">✓ Gespeichert</span>{/if}
            {/snippet}

            <p class="form-hint text-muted" style="margin-bottom: 1.25rem;">
              Mitarbeiter-Overrides haben höchste Priorität (Employee &gt; Pattern &gt; Mandant &gt;
              Tages-Soll). Tages-Slots: {EMP_BS_DAILY_MIN}–{EMP_BS_DAILY_MAX} Min ({EMP_BS_DAILY_MIN /
                60}–{EMP_BS_DAILY_MAX / 60} h). Blockunterricht-Woche:
              {EMP_BS_BLOCK_MIN}–{EMP_BS_BLOCK_MAX} Min ({EMP_BS_BLOCK_MIN / 60}–{EMP_BS_BLOCK_MAX /
                60} h).
            </p>

            {#if empBsSlotError}
              <div class="alert alert-error" role="alert" style="margin-bottom: 1rem;">
                <span>⚠</span><span>{empBsSlotError}</span>
              </div>
            {/if}

            {#if empBsSlotOverCreditWarning}
              <div class="alert alert-warning" role="alert" style="margin-bottom: 1rem;">
                <span>⚠</span><span>{empBsSlotOverCreditWarning}</span>
              </div>
            {/if}

            <!-- 1. Langtag -->
            <div class="form-group bs-slot-group">
              <label class="form-label" for="emp-bs-slot-first-long">
                1. Berufsschul-Langtag (Minuten)
              </label>
              <div class="bs-slot-input-row">
                <input
                  id="emp-bs-slot-first-long"
                  type="number"
                  min={EMP_BS_DAILY_MIN}
                  max={EMP_BS_DAILY_MAX}
                  step="1"
                  class="form-input modal-input-sm"
                  bind:value={empBsSlotFirstLong}
                  placeholder="Leer = erben"
                  disabled={empBsSlotSaving}
                />
                {#if empBsSlotFirstLongHint}
                  <span class="bs-slot-hint">{empBsSlotFirstLongHint}</span>
                {/if}
                {#if empBsSlotFirstLong !== ""}
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm bs-clear-btn"
                    onclick={() => (empBsSlotFirstLong = "")}
                    title="Auf Vorgabe zurücksetzen (erben)"
                    aria-label="1. Langtag auf Vorgabe zurücksetzen"
                    disabled={empBsSlotSaving}
                  >
                    × Erben
                  </button>
                {/if}
              </div>
              {#if empBsSlotFirstLong === ""}
                <p class="form-hint text-muted">
                  {#if firstPatternBsFirst != null}
                    Erbt aus: Pattern = {firstPatternBsFirst} Min ({(
                      firstPatternBsFirst / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if tenantBreakConfig?.bsSlotFirstLongDayMinutes != null}
                    Erbt aus: Mandant = {tenantBreakConfig.bsSlotFirstLongDayMinutes} Min ({(
                      tenantBreakConfig.bsSlotFirstLongDayMinutes / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if empDailySollMin != null}
                    Erbt aus: Tages-Soll = {empDailySollMin} Min ({(
                      empDailySollMin / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else}
                    Erbt aus: Tages-Soll des Mitarbeiters
                  {/if}
                </p>
              {/if}
            </div>

            <!-- 2. Langtag -->
            <div class="form-group bs-slot-group">
              <label class="form-label" for="emp-bs-slot-second-long">
                2. Berufsschul-Langtag (Minuten)
              </label>
              <div class="bs-slot-input-row">
                <input
                  id="emp-bs-slot-second-long"
                  type="number"
                  min={EMP_BS_DAILY_MIN}
                  max={EMP_BS_DAILY_MAX}
                  step="1"
                  class="form-input modal-input-sm"
                  bind:value={empBsSlotSecondLong}
                  placeholder="Leer = erben"
                  disabled={empBsSlotSaving}
                />
                {#if empBsSlotSecondLongHint}
                  <span class="bs-slot-hint">{empBsSlotSecondLongHint}</span>
                {/if}
                {#if empBsSlotSecondLong !== ""}
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm bs-clear-btn"
                    onclick={() => (empBsSlotSecondLong = "")}
                    title="Auf Vorgabe zurücksetzen (erben)"
                    aria-label="2. Langtag auf Vorgabe zurücksetzen"
                    disabled={empBsSlotSaving}
                  >
                    × Erben
                  </button>
                {/if}
              </div>
              {#if empBsSlotSecondLong === ""}
                <p class="form-hint text-muted">
                  {#if firstPatternBsSecond != null}
                    Erbt aus: Pattern = {firstPatternBsSecond} Min ({(
                      firstPatternBsSecond / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if tenantBreakConfig?.bsSlotSecondLongDayMinutes != null}
                    Erbt aus: Mandant = {tenantBreakConfig.bsSlotSecondLongDayMinutes} Min ({(
                      tenantBreakConfig.bsSlotSecondLongDayMinutes / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if empDailySollMin != null}
                    Erbt aus: Tages-Soll = {empDailySollMin} Min ({(
                      empDailySollMin / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else}
                    Erbt aus: Tages-Soll des Mitarbeiters
                  {/if}
                </p>
              {/if}
            </div>

            <!-- Kurztag -->
            <div class="form-group bs-slot-group">
              <label class="form-label" for="emp-bs-slot-short-day">
                Berufsschul-Kurztag (Minuten)
              </label>
              <div class="bs-slot-input-row">
                <input
                  id="emp-bs-slot-short-day"
                  type="number"
                  min={EMP_BS_DAILY_MIN}
                  max={EMP_BS_DAILY_MAX}
                  step="1"
                  class="form-input modal-input-sm"
                  bind:value={empBsSlotShortDay}
                  placeholder="Leer = erben"
                  disabled={empBsSlotSaving}
                />
                {#if empBsSlotShortDayHint}
                  <span class="bs-slot-hint">{empBsSlotShortDayHint}</span>
                {/if}
                {#if empBsSlotShortDay !== ""}
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm bs-clear-btn"
                    onclick={() => (empBsSlotShortDay = "")}
                    title="Auf Vorgabe zurücksetzen (erben)"
                    aria-label="Kurztag auf Vorgabe zurücksetzen"
                    disabled={empBsSlotSaving}
                  >
                    × Erben
                  </button>
                {/if}
              </div>
              {#if empBsSlotShortDay === ""}
                <p class="form-hint text-muted">
                  {#if firstPatternBsShort != null}
                    Erbt aus: Pattern = {firstPatternBsShort} Min ({(
                      firstPatternBsShort / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if tenantBreakConfig?.bsSlotShortDayMinutes != null}
                    Erbt aus: Mandant = {tenantBreakConfig.bsSlotShortDayMinutes} Min ({(
                      tenantBreakConfig.bsSlotShortDayMinutes / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if empDailySollMin != null}
                    Erbt aus: Tages-Soll = {empDailySollMin} Min ({(
                      empDailySollMin / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else}
                    Erbt aus: Tages-Soll des Mitarbeiters
                  {/if}
                </p>
              {/if}
            </div>

            <!-- Blockunterricht-Woche -->
            <div class="form-group bs-slot-group">
              <label class="form-label" for="emp-bs-slot-block-week">
                Blockunterricht-Woche (Minuten)
              </label>
              <div class="bs-slot-input-row">
                <input
                  id="emp-bs-slot-block-week"
                  type="number"
                  min={EMP_BS_BLOCK_MIN}
                  max={EMP_BS_BLOCK_MAX}
                  step="1"
                  class="form-input modal-input-sm"
                  bind:value={empBsSlotBlockWeek}
                  placeholder="Leer = erben"
                  disabled={empBsSlotSaving}
                />
                {#if empBsSlotBlockWeekHint}
                  <span class="bs-slot-hint">{empBsSlotBlockWeekHint}</span>
                {/if}
                {#if empBsSlotBlockWeek !== ""}
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm bs-clear-btn"
                    onclick={() => (empBsSlotBlockWeek = "")}
                    title="Auf Vorgabe zurücksetzen (erben)"
                    aria-label="Blockunterricht-Woche auf Vorgabe zurücksetzen"
                    disabled={empBsSlotSaving}
                  >
                    × Erben
                  </button>
                {/if}
              </div>
              {#if empBsSlotBlockWeek === ""}
                <p class="form-hint text-muted">
                  {#if firstPatternBsBlock != null}
                    Erbt aus: Pattern = {firstPatternBsBlock} Min ({(
                      firstPatternBsBlock / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else if tenantBreakConfig?.bsSlotBlockWeekMinutes != null}
                    Erbt aus: Mandant = {tenantBreakConfig.bsSlotBlockWeekMinutes} Min ({(
                      tenantBreakConfig.bsSlotBlockWeekMinutes / 60
                    ).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h)
                  {:else}
                    Erbt aus: Wochenstunden-Soll des Mitarbeiters
                  {/if}
                </p>
              {/if}
            </div>
          </Section>
        {/if}

        <!-- Orphan-Schichten modal -->
        {#if orphanModalOpen}
          <div
            class="orphan-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Geplante Schichten vorhanden"
          >
            <div class="orphan-card">
              <h3 class="orphan-title">Geplante Schichten vorhanden</h3>
              <p class="orphan-intro">
                Beim Wechsel auf <strong>{orphanNewTypeLabel}</strong>
                {orphanPendingCount === 1
                  ? "ist 1 geplante Schicht"
                  : `sind ${orphanPendingCount} geplante Schichten`}
                noch in der Datenbank.
              </p>
              {#if orphanPreview.length > 0}
                <ul class="orphan-list">
                  {#each orphanPreview as s (s.date)}
                    <li class="orphan-item">
                      <span class="orphan-date">{s.date}</span>
                      <span class="orphan-time">{s.startTime} – {s.endTime}</span>
                    </li>
                  {/each}
                  {#if orphanPendingCount > orphanPreview.length}
                    <li class="orphan-more">
                      … und {orphanPendingCount - orphanPreview.length} weitere
                    </li>
                  {/if}
                </ul>
              {/if}
              <p class="orphan-question">Was soll mit den zukünftigen Schichten passieren?</p>
              <div class="orphan-footer">
                <button class="btn btn-ghost" onclick={orphanAbort} disabled={arbeitszeitSaving}
                  >Abbrechen</button
                >
                <button class="btn btn-secondary" onclick={orphanKeep} disabled={arbeitszeitSaving}>
                  {arbeitszeitSaving ? "Speichern…" : "Behalten"}
                </button>
                <button class="btn btn-danger" onclick={orphanCancel} disabled={arbeitszeitSaving}>
                  {arbeitszeitSaving ? "Speichern…" : "Stornieren"}
                </button>
              </div>
            </div>
          </div>
        {/if}
      {:else if tab === "urlaub"}
        <!-- ── Urlaub ───────────────────────────────────────────────────────── -->
        <Section title="Urlaubsanspruch {vacYear}" sub="Jahresurlaub, Übertrag und Verfalldatum">
          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveVacation} disabled={urlaubSaving}>
              {urlaubSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if urlaubSaved}<span class="saved-hint">Gespeichert</span>{/if}
          {/snippet}

          {#if urlaubError}
            <div class="callout error">{urlaubError}</div>
          {/if}

          <p class="form-hint">
            Berechnet aus Arbeitstagen: {eWorkingDays} Tage/Woche →
            <strong>{eVacSuggestion} Urlaubstage</strong> vorgeschlagen.
          </p>

          <div class="extra-row">
            <div class="form-group">
              <label class="form-label" for="e-vac-total">Urlaubstage gesamt</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-vac-total"
                  type="number"
                  min="0"
                  max="365"
                  step="0.5"
                  bind:value={eVacTotal}
                  placeholder={String(eVacSuggestion)}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">Tage</span>
              </div>
              <p class="form-hint">Leer lassen für automatischen Wert ({eVacSuggestion})</p>
            </div>

            <div class="form-group">
              <label class="form-label" for="e-vac-carried">Resturlaub Vorjahr</label>
              <div class="input-suffix-wrap">
                <input
                  id="e-vac-carried"
                  type="number"
                  min="0"
                  max="365"
                  step="0.5"
                  bind:value={eVacCarried}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">Tage</span>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="e-vac-deadline">Resturlaub verfällt am</label>
              <input id="e-vac-deadline" type="date" bind:value={eVacDeadline} class="form-input" />
              <p class="form-hint">Leer lassen für globale Einstellung</p>
            </div>
          </div>

          {#if vacationEntitlement}
            <div class="vac-summary-row">
              <span class="vac-stat">
                <span class="vac-label">Genommen</span>
                <span class="vac-value">{vacationEntitlement.usedDays}</span>
              </span>
              <span class="vac-stat">
                <span class="vac-label">Übertrag</span>
                <span class="vac-value">{vacationEntitlement.carriedOverDays}</span>
              </span>
            </div>
          {/if}
        </Section>
      {:else if tab === "berechtigungen"}
        <!-- ── Berechtigungen ─────────────────────────────────────────────── -->
        <Section title="Rolle & Zugang" sub="Benutzerkonto, Rolle und Einladungsstatus">
          {#snippet footer()}
            <button class="btn btn-primary" onclick={saveStammdaten} disabled={stammdatenSaving}>
              {stammdatenSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if stammdatenSaved}<span class="saved-hint">Gespeichert</span>{/if}
          {/snippet}

          {#if stammdatenError}
            <div class="callout error">{stammdatenError}</div>
          {/if}

          <div class="form-grid">
            <div class="form-group">
              <label class="form-label" for="e-role">Rolle</label>
              <select id="e-role" bind:value={eRole} class="select">
                <option value="EMPLOYEE">Mitarbeiter</option>
                <option value="MANAGER">Manager</option>
                <option value="ADMIN">Administrator</option>
              </select>
            </div>

            {#if employee.user}
              <div class="form-group">
                <span class="form-label">E-Mail</span>
                <p class="field-value">{employee.user.email}</p>
              </div>
              <div class="form-group">
                <span class="form-label">Status</span>
                <p class="field-value">
                  {#if employee.user.isActive}
                    <span class="badge badge-ok">Aktiv</span>
                  {:else}
                    <span class="badge badge-muted">Inaktiv</span>
                  {/if}
                </p>
              </div>
              {#if employee.user.lastLoginAt}
                <div class="form-group">
                  <span class="form-label">Letzter Login</span>
                  <p class="field-value">
                    {new Date(employee.user.lastLoginAt).toLocaleDateString("de-DE", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              {/if}
            {/if}
          </div>
        </Section>
      {:else if tab === "danger"}
        <!-- ── Danger Zone ─────────────────────────────────────────────────── -->
        <DangerZone
          title="Anonymisieren (DSGVO Art. 17)"
          description="Persönliche Daten werden anonymisiert (Name → 'Gelöscht / GELÖSCHT-XXX', E-Mail anonymisiert). Zeiterfassungen, Urlaubsanträge und Salden bleiben aus rechtlichen Gründen für die Aufbewahrungsfrist (10 Jahre nach § 147 AO) erhalten."
          animate
        >
          {#snippet actions()}
            <button class="btn btn-danger" onclick={() => (anonConfirmOpen = true)}>
              Anonymisieren
            </button>
          {/snippet}
        </DangerZone>

        <DangerZone
          title="Endgültig löschen"
          description="Datensatz permanent entfernen. Nur möglich nach Anonymisierung und Ablauf der gesetzlichen Aufbewahrungsfrist (§ 147 AO, 10 Jahre)."
          animate
        >
          {#snippet actions()}
            {#if hardDeleteError}
              <div class="callout error">{hardDeleteError}</div>
            {/if}
            {#if hardDeleteRetentionExpiresAt}
              <div class="callout">
                <b>Aufbewahrungsfrist noch nicht abgelaufen.</b>
                Die gesetzliche Aufbewahrungsfrist (<span translate="no">§ 147 AO</span>, 10 Jahre)
                läuft ab am:
                <strong>
                  {new Date(hardDeleteRetentionExpiresAt).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </strong>.
              </div>
              <label class="force-delete-checkbox">
                <input type="checkbox" bind:checked={hardDeleteForce} />
                Ich bestätige, dass ich diese Aufbewahrungsfrist kenne und den Datensatz trotzdem unwiderruflich
                löschen möchte (z. B. Testdaten). Diese Aktion wird im Audit-Log protokolliert.
              </label>
            {/if}
            <button
              class="btn btn-danger"
              onclick={() => (hardDelConfirmOpen = true)}
              disabled={hardDeleteRetentionExpiresAt !== null && !hardDeleteForce}
            >
              Endgültig löschen
            </button>
          {/snippet}
        </DangerZone>
      {/if}
    {/snippet}
  </ListDetail>

  <!-- ── Confirm Dialogs ─────────────────────────────────────────────────────── -->
  <ConfirmDialog
    bind:open={anonConfirmOpen}
    title="Mitarbeiter anonymisieren?"
    description="Möchten Sie diesen Mitarbeiter wirklich anonymisieren? Persönliche Daten (Name, E-Mail, Notizen) werden gemäß DSGVO gelöscht. Zeiteinträge, Urlaubsanträge und Salden bleiben erhalten."
    confirmLabel="Anonymisieren"
    danger
    onConfirm={anonymize}
  />

  <ConfirmDialog
    bind:open={hardDelConfirmOpen}
    title="Datensatz endgültig löschen?"
    description="Den anonymisierten Datensatz endgültig und unwiderruflich löschen? Diese Aktion entfernt alle verbleibenden Daten dauerhaft (DSGVO Art. 17)."
    confirmLabel="Endgültig löschen"
    danger
    onConfirm={hardDelete}
  />

  <!-- Phase 76.7 (UI-V19-04a, D-18, D-20) — § 18 ArbZG exemption confirmation -->
  {#if $authStore.user?.role === "ADMIN"}
    <ConfirmDialog
      bind:open={exemptConfirmOpen}
      title="§ 18 ArbZG — Zeiterfassungs-Befreiung"
      description={exemptDialogDescription}
      confirmLabel="Bestätigen"
      onConfirm={confirmExemptToggle}
      onCancel={cancelExemptToggle}
    />
  {/if}
{/if}

<style>
  /* ── Loading / error states ─────────────────────────────────────────────── */
  .page-loading,
  .page-error {
    padding: var(--s-6);
    color: var(--text-muted);
    font-size: 14px;
  }

  .page-error {
    color: var(--bad);
  }

  /* ── Form grid ──────────────────────────────────────────────────────────── */
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-4);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .form-group--full {
    grid-column: 1 / -1;
  }

  .form-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .input,
  .select,
  .form-input {
    height: 38px;
    padding: 0 var(--s-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-card);
    color: var(--text);
    font-size: 14px;
  }

  .input:focus,
  .select:focus,
  .form-input:focus {
    outline: none;
    border-color: var(--brand);
  }

  .hint,
  .form-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: var(--s-1);
  }

  /* ── Subheadings in form ────────────────────────────────────────────────── */
  .form-subhead {
    border-top: 1px solid var(--border);
    padding-top: var(--s-3);
    margin-top: var(--s-2);
  }

  .form-subhead-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint, var(--text-muted));
    margin: 0;
  }

  /* ── Override badges ────────────────────────────────────────────────────── */
  .override-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    margin-top: var(--s-1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--r-sm);
    font-size: 11px;
    font-weight: 600;
  }

  .chip-warn {
    background: var(--warn-soft, oklch(97% 0.05 80));
    color: var(--warn, oklch(65% 0.18 80));
    border: 1px solid var(--warn, oklch(65% 0.18 80));
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
    font-size: 14px;
    color: var(--text);
  }

  /* ── Schedule type picker ───────────────────────────────────────────────── */
  .schedule-type-picker {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .stp-btn {
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 13px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s,
      color 0.15s;
  }

  .stp-btn:hover {
    border-color: var(--brand);
    color: var(--text);
  }

  .stp-btn--active {
    border-color: var(--brand);
    background: var(--brand-soft);
    color: var(--brand);
    font-weight: 600;
  }

  /* ── Day grid ───────────────────────────────────────────────────────────── */
  .day-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin-top: var(--s-3);
    align-items: flex-end;
  }

  .day-input {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 52px;
  }

  .day-label {
    text-align: center;
  }

  .day-field {
    width: 58px;
    text-align: center;
  }

  .total-col {
    min-width: 56px;
  }

  .weekly-total {
    font-size: 14px;
    font-weight: 700;
    color: var(--text);
    font-family: var(--font-mono);
    padding: 8px 0;
  }

  /* ── Weekday chips ──────────────────────────────────────────────────────── */
  .weekday-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .wd-chip {
    min-width: 40px;
    padding: var(--s-1) var(--s-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s,
      color 0.15s;
  }

  .wd-chip--active {
    border-color: var(--brand);
    background: var(--brand-soft);
    color: var(--brand);
  }

  /* ── Input suffix ───────────────────────────────────────────────────────── */
  .input-suffix-wrap {
    display: flex;
    align-items: stretch;
    gap: 0;
  }

  .input-suffix-wrap .form-input,
  .input-suffix-wrap .threshold-input {
    border-radius: var(--r-sm) 0 0 var(--r-sm);
    border-right: none;
  }

  .input-suffix {
    display: flex;
    align-items: center;
    padding: 0 var(--s-3);
    border: 1px solid var(--border);
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 13px;
    white-space: nowrap;
  }

  .threshold-input {
    width: 80px;
  }

  /* ── Form row / extra row ───────────────────────────────────────────────── */
  .form-row {
    display: flex;
    gap: var(--s-4);
    flex-wrap: wrap;
  }

  .extra-row {
    display: flex;
    gap: var(--s-6);
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .spaced-top-md {
    margin-top: var(--s-5);
  }

  .modal-section-heading {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint, var(--text-muted));
    margin: var(--s-5) 0 var(--s-2);
  }

  /* ── Callout ────────────────────────────────────────────────────────────── */
  .callout {
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    font-size: 14px;
    color: var(--text);
    margin-bottom: var(--s-3);
  }

  .callout.error {
    background: var(--bad-soft);
    border-color: var(--bad);
    color: var(--bad);
  }

  /* ── Saved hint ─────────────────────────────────────────────────────────── */
  .saved-hint {
    font-size: 13px;
    color: var(--good);
    font-weight: 500;
  }

  /* ── Toggle ─────────────────────────────────────────────────────────────── */
  .toggle-cb {
    width: 16px;
    height: 16px;
  }

  /* ── Force delete checkbox ──────────────────────────────────────────────── */
  .force-delete-checkbox {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    line-height: 1.5;
  }

  /* ── Vacation summary row ───────────────────────────────────────────────── */
  .vac-summary-row {
    display: flex;
    gap: var(--s-6);
    margin-top: var(--s-4);
    padding-top: var(--s-4);
    border-top: 1px solid var(--border);
  }

  .vac-stat {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .vac-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 600;
  }

  .vac-value {
    font-size: 24px;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--text);
  }

  /* ── Berechtigungen: field value display ────────────────────────────────── */
  .field-value {
    font-size: 14px;
    color: var(--text);
    margin: 0;
    padding: var(--s-2) 0;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: var(--r-sm);
    font-size: 12px;
    font-weight: 600;
  }

  .badge-ok {
    background: var(--good-soft);
    color: var(--good);
    border: 1px solid var(--good);
  }

  .badge-muted {
    background: var(--bg-subtle);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }

  /* ── Orphan shifts overlay (inline, not modal) ──────────────────────────── */
  .orphan-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }

  .orphan-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--pad-card);
    max-width: 480px;
    width: 100%;
    box-shadow: var(--shadow-md);
  }

  .orphan-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 var(--s-3);
  }

  .orphan-intro {
    font-size: 14px;
    color: var(--text);
    margin: 0 0 var(--s-3);
  }

  .orphan-list {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--s-3);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    overflow: hidden;
  }

  .orphan-item {
    display: flex;
    gap: var(--s-4);
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text);
  }

  .orphan-item:last-child {
    border-bottom: none;
  }

  .orphan-date {
    font-weight: 600;
    font-family: var(--font-mono);
  }

  .orphan-time {
    color: var(--text-muted);
  }

  .orphan-more {
    padding: var(--s-2) var(--s-3);
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  .orphan-question {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin: var(--s-3) 0 var(--s-4);
  }

  .orphan-footer {
    display: flex;
    gap: var(--s-3);
    flex-wrap: wrap;
    align-items: center;
  }

  /* Phase 67 (BERSCH-15) — BS-Pattern read-only list */
  .bs-pattern-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .bs-pattern-card {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .bs-pattern-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
  }

  .bs-pattern-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    min-width: 9rem;
  }

  .bs-pattern-value {
    font-size: 0.9375rem;
    color: var(--text);
    font-family: var(--font-mono);
  }

  .bs-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }

  /* 6-column block-week grid per CONTEXT.md ("6 columns × 9 rows fits the section width") */
  .bs-week-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(2rem, 1fr));
    gap: var(--s-1);
    width: 100%;
    max-width: 28rem;
  }

  .chip-week {
    justify-content: center;
    text-align: center;
    min-width: 2rem;
    padding: var(--s-1) var(--s-2);
  }

  /* Mobile fallback: 4-column grid (per CONTEXT.md) */
  @media (max-width: 640px) {
    .bs-week-grid {
      grid-template-columns: repeat(4, minmax(2rem, 1fr));
    }
  }

  /* Phase 67 Plan 02 — editor controls */
  .bs-pattern-head {
    justify-content: space-between;
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--s-2);
  }

  /* button-shaped chip variant — keeps .chip recipe + adds button reset */
  .chip-button {
    cursor: pointer;
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    font: inherit;
  }

  /* Selected-state — scoped specificity beats global .chip-brand */
  .chip-button.chip-brand {
    background: var(--brand-soft);
    color: var(--brand);
    border-color: var(--brand);
  }

  .chip-button:hover:not(:disabled) {
    border-color: var(--brand);
  }

  .chip-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .bs-year-input {
    max-width: 8rem;
  }

  /* Phase 67.2 (Plan 05) — Schulferien toggle + Bundesland-Override per Pattern */
  .bs-checkbox {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    font-size: 0.9375rem;
    color: var(--text);
    cursor: pointer;
  }

  .bs-checkbox input[type="checkbox"]:disabled {
    cursor: not-allowed;
  }

  .bs-pattern-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .bs-state-select {
    max-width: 16rem;
  }

  /* v1.7.4 hotfix — BS-mode picker now reuses the .schedule-type-picker /
     .stp-btn recipe from the Arbeitszeitmodell widget for visual consistency
     within the Arbeitszeit tab. Only the help-text helper remains scoped. */
  .bs-mode-help {
    margin: 0 0 0 9rem;
    font-style: italic;
  }

  @media (max-width: 640px) {
    .bs-mode-help {
      margin-left: 0;
    }
  }

  /* ── Phase 76.36 — bsSlot* per-employee override panel (mirrors 76.35 system page) ── */
  .modal-input-sm {
    max-width: 180px;
  }

  .bs-slot-group {
    margin-bottom: 1.25rem;
  }

  .bs-slot-input-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .bs-slot-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .bs-clear-btn {
    font-size: 0.8125rem;
    color: var(--text-muted);
    padding: 0.25rem 0.625rem;
    min-height: unset;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: transparent;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .bs-clear-btn:hover:not(:disabled) {
    color: var(--bad);
    border-color: var(--bad);
  }

  .bs-clear-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Phase 76.37 — per-pattern bsSlot* section inside pattern card ── */
  .bs-slot-section {
    border-top: 1px solid var(--border);
    margin-top: 1rem;
    padding-top: 1rem;
  }

  .bs-slot-section-title {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--text);
    margin-bottom: 0.25rem;
  }

  .bs-revision-alert {
    margin-top: 0.75rem;
    font-size: 0.8125rem;
  }
</style>
