<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { authStore } from "$stores/auth";
  import { employeeAdminRights, contractShiftRights } from "$lib/page-rights";
  import { DETAIL_TAB_ALIASES, employeeDetailTabs } from "$lib/employees/detail-tabs";
  import { markUnsaved } from "$stores/unsaved";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import PersonTab from "$lib/components/employees/detail/PersonTab.svelte";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { employmentState, localCalendarDay } from "$lib/employees/employment-state";
  import { dayOf, type PersonEmployee } from "$lib/employees/person-form";
  import type { VacationEntitlement } from "$lib/employees/urlaub-form";
  import Section from "$lib/components/admin/Section.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import RetroactiveBSWizard from "$lib/components/vocational-school/RetroactiveBSWizard.svelte";
  import SalonAssignmentsSection from "$lib/components/employees/SalonAssignmentsSection.svelte";
  import {
    shouldOfferRetroactiveRun,
    type RetroactivePreview,
  } from "$lib/components/vocational-school/retroactive";
  import type { EmployeeClassification } from "$lib/employee-classification";
  import type { FormRole } from "$lib/employees/form-role";
  import UrlaubTab from "$lib/components/employees/detail/UrlaubTab.svelte";
  import VertragTab from "$lib/components/employees/detail/VertragTab.svelte";
  import type { ContractSchedule } from "$lib/employees/vertrag-form";
  import ZugangTab from "$lib/components/employees/detail/ZugangTab.svelte";
  import { salonContext } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";

  // ── Types ──────────────────────────────────────────────────────────────────
  // The stored work schedule; the Vertrag tab owns its form (plan 854-21).
  type WorkSchedule = ContractSchedule;

  interface Employee {
    id: string;
    userId: string;
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
    // Issue #482: per-person vacation base value; null = the classification's own Standard,
    // resolved server-side (resolveVacationBaseDays()).
    annualVacationDays?: number | string | null;
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
    // Issue #854: the Zugang tab words the account state from it (GET /employees/:id sends it).
    invitationStatus?: "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
    user?: {
      role: FormRole | null;
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
    // Issue #435 (D-13) — tenant default for the Stammdaten placeholder (same response).
    defaultVacationDays?: number | string;
    // Issue #482 — the Azubi-Standard, same GET /settings/work response; feeds the Stammdaten
    // placeholder for an AZUBI (vacationBaseDefaultPlaceholder).
    defaultApprenticeVacationDays?: number | string;
  }

  // Phase 67 (BERSCH-15) — Vocational-school pattern row returned by
  // GET /api/v1/employees/:id/vocational-school-pattern
  // Source: apps/api/src/contexts/absence/api/vocational-school-pattern.ts lines 62-66
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
  // API's putPatternsSchema (apps/api/src/contexts/absence/api/vocational-school-pattern.ts lines 10-31).
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

  // Phase 103 plan 04 — retroactive wizard state. RetroactiveBSWizard.svelte owns
  // pending/result/error internally; the page only tracks what preview to show and
  // whether the wizard is open.
  let retroPreview = $state<RetroactivePreview | null>(null);
  let retroOpen = $state(false);

  const employeeId = $derived($page.params.id ?? "");

  onMount(async () => {
    activeTab = tabFromHash(
      $page.url.hash,
      tabs.map((t) => t.id),
      DETAIL_TAB_ALIASES,
    );
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

      // Phase 109 (D-11/D-12) — baseline snapshots, taken once every field above is hydrated,
      // so no section starts marked "Nicht gespeichert" right after load.
      pausendauerSnapshot = snap(eBreakOver6hOverride, eBreakOver9hOverride);
      phorestPufferSnapshot = snap(ePhorestPrepOverride, ePhorestWrapupOverride);
      patternsSnapshot = snap(bsPatterns);
      bsSlotEmpSnapshot = snap(
        empBsSlotFirstLong,
        empBsSlotSecondLong,
        empBsSlotShortDay,
        empBsSlotBlockWeek,
      );
      snapshotsReady = true;
    } catch {
      loadError = "Fehler beim Laden des Mitarbeiters.";
    } finally {
      loading = false;
    }
  });

  // ── Tabs ───────────────────────────────────────────────────────────────────
  // The tab list follows the caller's permissions (Issue #86, D-04); it is derived below, next to
  // `rights`, from employeeDetailTabs(). The selected tab lives in the URL hash (Issue #854): the
  // hash is read against the VISIBLE ids only, and the former ids (`#stammdaten`, `#arbeitszeit`,
  // `#berechtigungen`, `#danger`) resolve through DETAIL_TAB_ALIASES.
  let activeTab = $state<string>("person");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // Permission-driven controls (Issue #538): the API refuses anything beyond these, the page only
  // hides. Setting a role needs role-assignment:manage; the § 18 ArbZG exemption rides on the
  // employee PATCH, hence employee:update.
  let rights = $derived(employeeAdminRights($authStore.user));
  let canReadRoles = $derived(hasPermission($authStore.user, "role:read:ZUGEWIESEN"));
  let tabs = $derived(employeeDetailTabs(rights));
  let canDiscardShifts = $derived(contractShiftRights($authStore.user).canDiscardShifts);
  let canUpdateEmployee = $derived(rights.canUpdate);
  // PUT /settings/work/:id needs contract:update; presentation only, the API refuses anyway.
  let canUpdateContract = $derived(hasPermission($authStore.user, "contract:update:ZUGEWIESEN"));
  let canEditVacation = $derived(
    hasPermission($authStore.user, "leave-entitlement:update:ZUGEWIESEN"),
  );
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
  // Bounds mirror apps/api/src/contexts/absence/vocational-school-constants.ts.
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
        empDailySollMin;
      if (effectiveFirst === null || !Number.isFinite(effectiveFirst)) return "";
      if (v2 > effectiveFirst) {
        return `§3.2-Warnung: 2. Langtag (${v2} Min = ${(v2 / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h) übersteigt den 1. Langtag (${effectiveFirst} Min = ${(effectiveFirst / 60).toLocaleString("de-DE", { maximumFractionDigits: 2 })} h). Über-Kreditierung des zweiten BS-Langtags prüfen.`;
      }
      return "";
    })(),
  );

  /**
   * Pure age-at-date helper (mirrors apps/api/src/contexts/absence/jarbschg.ts ageAtDate, no date-fns dep).
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

  // Issue #574 (D-574-12) — § 11 JArbSchG applies to ANY person under 18, whatever the
  // classification (the API decides the break regime per work date the same way): 30/60 Min
  // suggestion. Read from the saved birth date of the Person tab (plan 854-20: the field has its own
  // SaveBar there, the Vertrag tab follows what the record holds).
  let birthDay = $derived(dayOf(employee?.birthDate));
  let classification = $derived<EmployeeClassification>(employee?.classification ?? "VOLLZEIT");
  let isUnder18 = $derived(
    Number.isFinite(ageAtDate(birthDay, new Date())) && ageAtDate(birthDay, new Date()) < 18,
  );
  let bothOverridesEmpty = $derived(eBreakOver6hOverride === "" && eBreakOver9hOverride === "");
  let showUnder18SuggestionButton = $derived(isUnder18 && bothOverridesEmpty);

  function initFields() {
    if (!employee) return;
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
      pausendauerSnapshot = snap(eBreakOver6hOverride, eBreakOver9hOverride);
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
      phorestPufferSnapshot = snap(ePhorestPrepOverride, ePhorestWrapupOverride);
      setTimeout(() => (phorestPufferSaved = false), 3000);
    } catch (e: unknown) {
      phorestPufferError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      phorestPufferSaving = false;
    }
  }

  // Phase 65 / Issue #574 — one-click § 11 JArbSchG suggestion for a person under 18
  function applyUnder18Suggestion() {
    // § 11 Abs. 1 JArbSchG: 30 Min above 4.5 h, 60 Min above 6 h — so both the ">6h" and the
    // ">9h" field carry 60; the 4.5 h band is enforced by the API's break regime for minors.
    eBreakOver6hOverride = "60";
    eBreakOver9hOverride = "60";
  }

  // Phase 76.36 — Persist per-employee bsSlot* overrides (BBIG-V19-03).
  // Partial PATCH: only send fields the admin explicitly touched.
  // "" → null (clear override → re-enables inheritance for that field).
  // Bounds mirror apps/api/src/contexts/absence/vocational-school-constants.ts.
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
      bsSlotEmpSnapshot = snap(
        empBsSlotFirstLong,
        empBsSlotSecondLong,
        empBsSlotShortDay,
        empBsSlotBlockWeek,
      );
      setTimeout(() => (empBsSlotSaved = false), 3000);
    } catch (e: unknown) {
      empBsSlotError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      empBsSlotSaving = false;
    }
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
        // (apps/api/src/contexts/absence/api/vocational-school-pattern.ts lines 52-55).
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

  // Bounds mirror apps/api/src/contexts/absence/vocational-school-constants.ts
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

  // Client-side validation mirroring apps/api/src/contexts/absence/api/vocational-school-pattern.ts
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
      patternsSnapshot = snap(bsPatterns); // bsPatterns already holds the just-hydrated rows above
      toasts.success("Berufsschultage gespeichert", 2000);
      setTimeout(() => (bsPatternsSaved = false), 2000);

      // Phase 103 (D-01) — post-save retroactive check. Non-blocking follow-up: the
      // pattern save above already succeeded and is reported as such regardless of
      // what happens here. Only probes the backend when at least one just-hydrated
      // row's validFrom is strictly before today — a purely-forward pattern change
      // must not open any dialog.
      const todayIso = new Date().toISOString().slice(0, 10);
      const hasRetroactiveRow = bsPatterns.some((p) => p.validFrom < todayIso);
      if (hasRetroactiveRow) {
        try {
          const preview = await api.get<RetroactivePreview>(
            `/vocational-school/retroactive-preview?employeeId=${employee.id}`,
          );
          retroPreview = preview;
          if (shouldOfferRetroactiveRun(preview)) {
            retroOpen = true;
          }
        } catch (e: unknown) {
          // A failing preview call must NEVER surface as a save failure.
          const message =
            e instanceof Error ? e.message : "Rückwirkende Prüfung konnte nicht geladen werden.";
          toasts.error(message, 4000);
        }
      }
    } catch (e: unknown) {
      // Verbatim API error (Zod refine message or domain message)
      bsPatternsSaveError =
        e instanceof Error ? e.message : "Berufsschultage konnten nicht gespeichert werden.";
      toasts.error(bsPatternsSaveError, 4000);
    } finally {
      bsPatternsSaving = false;
    }
  }

  // Phase 103 plan 04 — onConfirm callback passed to RetroactiveBSWizard. The wizard
  // owns the pending guard (T-103-REPLAY) and its own error display; this function
  // only does the POST and either returns the REAL server result (D-01 — never a
  // synthesised success message) or rethrows for the wizard to show inline.
  async function handleRetroConfirm(overrideDates: string[]): Promise<RetroactivePreview> {
    if (!employee) throw new Error("Kein Mitarbeiter geladen.");
    return api.post<RetroactivePreview>("/vocational-school/retroactive-apply", {
      employeeId: employee.id,
      overrideDates,
    });
  }

  // Phase 103 plan 04 — fired by the wizard on every close path (Abbrechen, ESC,
  // backdrop, the post-apply "Schließen"). The wizard itself guards against closing
  // while a confirm is in flight, so no pending check is needed here. This page holds
  // no BS-day/Absence list to refresh — only the pattern editor — so there is nothing
  // else to re-fetch after a write (per plan 04 Task 3: skip the refresh rather than
  // inventing one).
  function handleRetroClose() {
    retroOpen = false;
    retroPreview = null;
  }

  // ── Urlaub ─────────────────────────────────────────────────────────────────
  // The entitlement of the current year is read here with the rest of the page and handed to the
  // Urlaub tab, which owns its form, its snapshot and its save.
  const vacYear = new Date().getFullYear();

  // ── Unsaved-section tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ──────────────
  // One snapshot per button-gated group, taken at load (onMount above) and re-taken after each
  // successful save. Snapshot comparison rather than per-field oninput flags — same pattern as
  // admin/system/+page.svelte (plan 109-06): three lines per section instead of one per input,
  // and undoing an edit by hand clears the marker again, which a per-field flag cannot do.
  // N-02: every save path on this page is already button-gated — there is no instant-save
  // control here to exclude, unlike admin/system.
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let pausendauerSnapshot = $state("");
  let pausendauerDirty = $derived(
    snap(eBreakOver6hOverride, eBreakOver9hOverride) !== pausendauerSnapshot,
  );

  let phorestPufferSnapshot = $state("");
  let phorestPufferDirty = $derived(
    snap(ePhorestPrepOverride, ePhorestWrapupOverride) !== phorestPufferSnapshot,
  );

  // bsPatterns is the whole array savePatterns() maps over — snapshotting it as one JSON string
  // catches every field of every row (add/remove/reorder included), not just edits to one field.
  let patternsSnapshot = $state("");
  let patternsDirty = $derived(snap(bsPatterns) !== patternsSnapshot);

  let bsSlotEmpSnapshot = $state("");
  let bsSlotEmpDirty = $derived(
    snap(empBsSlotFirstLong, empBsSlotSecondLong, empBsSlotShortDay, empBsSlotBlockWeek) !==
      bsSlotEmpSnapshot,
  );

  // Phase 109 (D-12) — one registry entry per page. Cleanup de-registers on unmount so a saved
  // page that the operator leaves cannot strand a stale entry and trap the next navigation
  // (T-109-27, mirrors T-109-23 on admin/system). Registry id ("admin-employee-detail") is
  // distinct from admin/system's ("admin-system") so the two pages cannot clear each other.
  // The Person tab owns its snapshots and reports the count of unsaved changes through
  // `bind:changes`; this page sums everything into ONE registration.
  let personChanges = $state(0);
  let vacationChanges = $state(0);
  let vertragChanges = $state(0);
  let anyUnsaved = $derived(
    personChanges > 0 ||
      vertragChanges > 0 ||
      pausendauerDirty ||
      phorestPufferDirty ||
      patternsDirty ||
      bsSlotEmpDirty ||
      vacationChanges > 0,
  );

  // Gate the registration on "the baseline has been taken" (WR-01). Every snapshot starts as ""
  // and only gets its real value at the end of onMount's try, so every *Dirty flag reads true
  // until then. A stale bookmark to a deleted employee hits the early `loadError` return before
  // that block, which would otherwise trap the operator behind a discard dialog on a page that
  // renders only an error and shows no "Nicht gespeichert" marker to explain it.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-employee-detail", snapshotsReady && anyUnsaved);
    return () => markUnsaved("admin-employee-detail", false);
  });

  // ── Derived display ────────────────────────────────────────────────────────
  let displayName = $derived(`${employee?.firstName ?? ""} ${employee?.lastName ?? ""}`.trim());
  // The head's second line: the employee number and the employment state (Issue #86, D-01). The
  // state is decided from the exit date and a calendar day, never from a display string.
  let headSub = $derived.by(() => {
    const state = employmentState(employee?.exitDate, localCalendarDay());
    const parts: string[] = [];
    if (employee?.employeeNumber) parts.push(`Personalnummer ${employee.employeeNumber}`);
    parts.push(state.kind === "EMPLOYED" ? "Beschäftigt" : state.label);
    return parts.join(" · ");
  });

  // Tenant defaults for the placeholder of the vacation base value (Person tab).
  let tenantDefaultVacationDays = $derived(Number(tenantBreakConfig?.defaultVacationDays) || 30);
  // Issue #482 — the Azubi-Standard, same fallback as the vacation rules page (20).
  let tenantDefaultApprenticeVacationDays = $derived(
    Number(tenantBreakConfig?.defaultApprenticeVacationDays) || 20,
  );

  /** The Vertrag tab reports the saved schedule; the Überschreibungen below read its weekly hours. */
  function onContractSaved(saved: ContractSchedule) {
    workSchedule = saved;
  }

  /** The Person tab reports what a PATCH wrote; the record (and so the head and the Vertrag tab) follows. */
  function onPersonSaved(written: Partial<PersonEmployee>) {
    if (employee) employee = { ...employee, ...(written as Partial<Employee>) };
  }
</script>

{#if loading}
  <div class="page-loading"><Skeleton shape="card" lines={3} /></div>
{:else if loadError || !employee}
  <div class="page-error">{loadError || "Mitarbeiter nicht gefunden."}</div>
{:else}
  <Breadcrumb
    crumbs={[
      { label: pageLabel("/admin/employees"), href: "/admin/employees" },
      { label: displayName || "Mitarbeiter" },
    ]}
  />
  <PageHead title={displayName || "Mitarbeiter"} sub={headSub} />

  <PageTabs
    tabs={tabs.map((t) => ({ value: t.id, label: t.label }))}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche der Person"
  >
    {#snippet panel(tab)}
      {#if tab === "person"}
        {#if employee}
          <PersonTab
            {employee}
            canEdit={canUpdateEmployee}
            {tenantDefaultVacationDays}
            {tenantDefaultApprenticeVacationDays}
            bind:changes={personChanges}
            onSaved={onPersonSaved}
          />
        {/if}
      {:else if tab === "vertrag"}
        <VertragTab
          {employeeId}
          schedule={workSchedule}
          employee={{ classification }}
          canEdit={canUpdateContract}
          {canDiscardShifts}
          bind:changes={vertragChanges}
          onSaved={onContractSaved}
        />

        <!-- Phase 65 — Pausendauer (Optional) per-Employee Override (BREAK-06, BREAK-07, D-04..D-07) -->
        <!-- Phase 73-05: data-testid surface for the per-employee Pausendauer editor.
             Clokr's break model has 2 fixed thresholds (>6h / >9h), not a table of N
             rows — so the plan's pausendauer-row-${i} pattern doesn't apply. Plan
             says: "apply only to elements that exist; don't invent UI." -->
        <div data-testid="pausendauer-editor" style="display: contents;">
          <Section
            title="Pausendauer (Optional)"
            sub="Überschreibt den Unternehmensstandard für diese Person. Leer = Standard verwenden."
            dirty={pausendauerDirty}
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

            {#if isUnder18}
              <!-- § 11 JArbSchG info pill (recommendation, not violation — uses .alert-info per app.css) -->
              <div
                class="alert alert-info"
                role="status"
                style="margin-bottom: 1rem;"
                data-testid="pausendauer-azubi-pill"
              >
                <span>ℹ️</span><span>Unter 18 — Pausen nach § 11 JArbSchG</span>
              </div>
              {#if showUnder18SuggestionButton}
                <div style="margin-bottom: 1rem;">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onclick={applyUnder18Suggestion}
                    data-testid="pausendauer-azubi-apply"
                    >Vorschlag nach § 11 JArbSchG übernehmen (60 Min ab 6 h)</button
                  >
                </div>
              {/if}
            {/if}

            <p class="form-hint text-muted" style="margin-bottom: 1rem;">
              Leer = Unternehmensstandard ({tenantBreakConfig?.defaultBreakOver6h ??
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
                placeholder={isUnder18
                  ? "60 Min — nach § 11 JArbSchG"
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
                placeholder={isUnder18
                  ? "60 Min — nach § 11 JArbSchG"
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
            sub="Überschreibt den Unternehmensstandard für diese Person. Leer = Standard verwenden."
            dirty={phorestPufferDirty}
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
        {#if classification === "AZUBI"}
          <Section
            title="Berufsschultag (Optional)"
            sub="Wiederkehrende Berufsschultage und Block-Wochen für BBiG-§15-Freistellung"
            dirty={patternsDirty}
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
                      <span class="form-label">BS-Modus</span>
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
                        <option value="">Wie Unternehmen (Standard)</option>
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
                        Leer = Wert kommt aus den Einstellungen des Unternehmens bzw. dem
                        Tages-Soll. Tages-Slots: 240–600 Min (4–10 h). Blockunterricht-Woche:
                        1200–3000 Min (20–50 h).
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
            sub="Überschreibt Muster- und Unternehmensvorgabe für diese Person. Leer = Wert aus der nächsten Ebene."
            dirty={bsSlotEmpDirty}
          >
            {#snippet footer()}
              <button class="btn btn-primary" onclick={saveBsSlotEmp} disabled={empBsSlotSaving}>
                {empBsSlotSaving ? "Speichern…" : "Speichern"}
              </button>
              {#if empBsSlotSaved}<span class="saved-hint">✓ Gespeichert</span>{/if}
            {/snippet}

            <p class="form-hint text-muted" style="margin-bottom: 1.25rem;">
              Werte für die Person haben Vorrang (Person &gt; Muster &gt; Unternehmen &gt;
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
                    Erbt aus: Unternehmen = {tenantBreakConfig.bsSlotFirstLongDayMinutes} Min ({(
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
                    Erbt aus: Unternehmen = {tenantBreakConfig.bsSlotSecondLongDayMinutes} Min ({(
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
                    Erbt aus: Unternehmen = {tenantBreakConfig.bsSlotShortDayMinutes} Min ({(
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
                    Erbt aus: Unternehmen = {tenantBreakConfig.bsSlotBlockWeekMinutes} Min ({(
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
      {:else if tab === "urlaub"}
        <UrlaubTab
          {employeeId}
          year={vacYear}
          entitlement={vacationEntitlement}
          canEdit={canEditVacation}
          bind:changes={vacationChanges}
        />
      {:else if tab === "salons"}
        <!-- ── Salons (Issue #86, AC-86-5) ────────────────────────────────── -->
        <SalonAssignmentsSection {employeeId} canEdit={rights.canUpdate} />
      {:else if tab === "zugang"}
        {#if employee}
          <ZugangTab
            {employee}
            {rights}
            {canReadRoles}
            salons={$salonContext.salons}
            salonsLoaded={$salonContext.loaded}
            onRemoved={() => goto("/admin/employees")}
          />
        {/if}
      {/if}
    {/snippet}
  </PageTabs>

  <!-- Phase 103 plan 04 — 3-step retroactive BS-pattern wizard, replacing the plan-01
       tracer's single-step confirm dialog. Mounted only once a preview is loaded, so
       the wizard never renders against an empty/placeholder preview object. -->
  {#if retroPreview}
    <RetroactiveBSWizard
      bind:open={retroOpen}
      preview={retroPreview}
      onConfirm={handleRetroConfirm}
      onClose={handleRetroClose}
    />
  {/if}
{/if}

<style>
  /* ── Loading / error states ─────────────────────────────────────────────── */
  .page-loading,
  .page-error {
    padding: var(--s-6);
    color: var(--text-2);
    font-size: 14px;
  }

  .page-error {
    color: var(--bad);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .form-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .form-input {
    height: 38px;
    padding: 0 var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    color: var(--text);
    font-size: 14px;
  }

  .form-input:focus {
    outline: none;
    border-color: var(--brand);
  }

  /* Phase 107 (issue #94, human-verify follow-up) — this scoped block redeclares
     background/color for .form-input above, which ties the CSS
     specificity of app.css's shared `.form-input:disabled` recipe (both are a
     single class + pseudo-class). Svelte's per-component style injection then
     wins that tie, silently defeating the global disabled treatment for every
     background/color property it also sets — only `cursor: not-allowed` survived,
     which is invisible until hover. Re-assert the exact same shared recipe here
     so a disabled field on this page reads visibly quieter, not just non-hoverable. */
  .form-input:disabled {
    background: var(--sunk);
    color: var(--text-2);
    cursor: not-allowed;
  }

  .form-hint {
    font-size: 12px;
    color: var(--text-2);
    margin-top: var(--s-1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--r-control);
    font-size: 11px;
    font-weight: 600;
  }

  /* ── Schedule type picker ───────────────────────────────────────────────── */
  /* The BS-mode picker of the pattern editor (the contract form that used it moved to VertragTab). */
  .schedule-type-picker {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .stp-btn {
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--sunk);
    color: var(--text-2);
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

  /* ── Weekday chips ──────────────────────────────────────────────────────── */

  /* ── Input suffix ───────────────────────────────────────────────────────── */

  /* ── Form row / extra row ───────────────────────────────────────────────── */

  /* ── Callout ────────────────────────────────────────────────────────────── */
  .callout {
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-control);
    background: var(--sunk);
    border: 1px solid var(--line);
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
    color: var(--ok);
    font-weight: 500;
  }

  /* ── Toggle ─────────────────────────────────────────────────────────────── */

  /* ── Orphan shifts overlay (inline, not modal) ──────────────────────────── */

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
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
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
    color: var(--text-2);
    min-width: 9rem;
  }

  .bs-pattern-value {
    font-size: 0.9375rem;
    color: var(--text);
    font-family: var(--font-ui);
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
    border-bottom: 1px solid var(--line);
    padding-bottom: var(--s-2);
  }

  /* button-shaped chip variant — keeps .chip recipe + adds button reset */
  .chip-button {
    cursor: pointer;
    border: 1px solid transparent;
    background: var(--card);
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
    color: var(--text-2);
  }

  .bs-state-select {
    max-width: 16rem;
  }

  /* v1.7.4 hotfix — BS-mode picker now reuses the .schedule-type-picker /
     .stp-btn recipe from the Arbeitszeitmodell widget for visual consistency
     within the Arbeitszeit tab. Only the help-text helper remains scoped. */
  .bs-mode-help {
    margin: 0 0 0 9rem;
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
    color: var(--text-2);
    font-family: var(--font-ui);
  }

  .bs-clear-btn {
    font-size: 0.8125rem;
    color: var(--text-2);
    padding: 0.25rem 0.625rem;
    min-height: unset;
    height: 2rem;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
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
    border-top: 1px solid var(--line);
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
