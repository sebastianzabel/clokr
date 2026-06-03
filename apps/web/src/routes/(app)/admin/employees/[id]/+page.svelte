<script lang="ts">
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
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
    user?: {
      role: Role;
      email: string;
      isActive: boolean;
      lastLoginAt?: string | null;
    } | null;
  }

  // Phase 65 — Tenant defaults consumed for placeholder display (D-08)
  interface TenantBreakConfig {
    defaultBreakOver6h?: number;
    defaultBreakOver9h?: number;
  }

  // Phase 67 (BERSCH-15) — Vocational-school pattern row returned by
  // GET /api/v1/employees/:id/vocational-school-pattern
  // Source: apps/api/src/routes/vocational-school-pattern.ts lines 62-66
  interface VocationalSchoolPattern {
    id: string;
    employeeId: string;
    dayOfWeek: number | null; // 0=Mo..6=So (DE convention)
    blockWeeks: number[]; // ISO week numbers; empty array when only dayOfWeek set
    blockYear: number | null;
    validFrom: string; // "YYYY-MM-DD"
    validUntil: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  }

  // Phase 67 Plan 02 (BERSCH-15) — Local editor draft. NEVER sent to the API as-is;
  // the _key field is for {#each} keyed iteration only. On Save we serialise to the
  // API's putPatternsSchema (apps/api/src/routes/vocational-school-pattern.ts lines 10-31).
  interface BSPatternDraft {
    _key: string;
    dayOfWeek: number | null;
    blockWeeks: number[];
    blockYear: number | null;
    validFrom: string; // "YYYY-MM-DD"
    validUntil: string | null;
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
        bsPatterns = bsRes.value.map((p) => ({
          _key: p.id,
          dayOfWeek: p.dayOfWeek,
          blockWeeks: [...p.blockWeeks],
          blockYear: p.blockYear,
          validFrom: p.validFrom,
          validUntil: p.validUntil,
        }));
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
    eMonWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.mondayHours) > 0 : true;
    eTueWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.tuesdayHours) > 0 : true;
    eWedWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.wednesdayHours) > 0 : true;
    eThuWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.thursdayHours) > 0 : true;
    eFriWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.fridayHours) > 0 : true;
    eSatWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.saturdayHours) > 0 : false;
    eSunWd = sched?.type === "MONTHLY_HOURS" ? Number(sched.sundayHours) > 0 : false;
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

  // Phase 65 — One-click JArbSchG-Vorschlag (D-06)
  function applyAzubiSuggestion() {
    eBreakOver6hOverride = "30";
    eBreakOver9hOverride = "60";
  }

  // ── BS-Pattern editor helpers (Phase 67 Plan 02, BERSCH-15) ───────────────

  const BS_WEEKDAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

  function bsAddPattern() {
    bsNewKeyCounter += 1;
    bsPatterns = [
      ...bsPatterns,
      {
        _key: `new-${bsNewKeyCounter}`,
        dayOfWeek: null,
        blockWeeks: [],
        blockYear: null,
        validFrom: new Date().toISOString().slice(0, 10), // today (D-default per CONTEXT)
        validUntil: null,
      },
    ];
  }

  function bsRemovePattern(key: string) {
    bsPatterns = bsPatterns.filter((p) => p._key !== key);
  }

  function bsToggleDayOfWeek(key: string, idx: number) {
    // Only ONE dayOfWeek per row (Int? schema). Clicking active chip clears, clicking
    // another chip moves selection. Matches CONTEXT.md "Day-of-week input" decision.
    bsPatterns = bsPatterns.map((p) =>
      p._key === key ? { ...p, dayOfWeek: p.dayOfWeek === idx ? null : idx } : p,
    );
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

  // Client-side validation mirroring apps/api/src/routes/vocational-school-pattern.ts
  // Returns an error string for the first invalid row, or "" if all rows pass.
  function bsValidationError(): string {
    for (let i = 0; i < bsPatterns.length; i++) {
      const p = bsPatterns[i];
      if (p.dayOfWeek == null && p.blockWeeks.length === 0) {
        return `Zeile ${i + 1}: Entweder Wochentag oder Block-Wochen muss gesetzt sein`;
      }
      if (p.blockWeeks.length > 0 && p.blockYear == null) {
        return `Zeile ${i + 1}: Jahr ist erforderlich wenn Block-Wochen gesetzt sind`;
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
      const payload = {
        patterns: bsPatterns.map((p) => ({
          dayOfWeek: p.dayOfWeek,
          blockWeeks: p.blockWeeks,
          blockYear: p.blockYear,
          validFrom: p.validFrom,
          validUntil: p.validUntil,
        })),
      };
      const res = await api.put<{ patterns: VocationalSchoolPattern[] }>(
        `/employees/${employee.id}/vocational-school-pattern`,
        payload,
      );
      // Reflect persisted rows back into the draft so newly-created rows get their server id
      // as the _key (replacing the synthetic "new-{n}"). This stabilises the {#each} key.
      bsPatterns = res.patterns.map((p) => ({
        _key: p.id,
        dayOfWeek: p.dayOfWeek,
        blockWeeks: [...p.blockWeeks],
        blockYear: p.blockYear,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
      }));
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

                    <!-- dayOfWeek chip-row (toggle, single-select) -->
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">Wochentag:</span>
                      <div class="bs-chip-row">
                        {#each BS_WEEKDAY_LABELS as label, didx (label)}
                          <button
                            type="button"
                            class="chip chip-button"
                            class:chip-brand={p.dayOfWeek === didx}
                            onclick={() => bsToggleDayOfWeek(p._key, didx)}
                            disabled={bsPatternsSaving}
                          >
                            {label}
                          </button>
                        {/each}
                      </div>
                    </div>

                    <!-- blockWeeks chip-grid 1..53 (toggle, multi-select) -->
                    <div class="bs-pattern-row">
                      <span class="bs-pattern-label">Block-Wochen:</span>
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

                    <!-- Year picker (only when at least one block-week is selected) -->
                    {#if p.blockWeeks.length > 0}
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
        {/if}
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
        <Section
          title="Pausendauer (Optional)"
          sub="Überschreibt Tenant-Standard für diesen Mitarbeiter. Leer = Standard verwenden."
        >
          {#snippet footer()}
            <button class="btn btn-primary" onclick={savePausendauer} disabled={pausendauerSaving}>
              {pausendauerSaving ? "Speichern…" : "Speichern"}
            </button>
            {#if pausendauerSaved}<span class="saved-hint">Gespeichert</span>{/if}
          {/snippet}

          {#if pausendauerError}
            <div class="callout error">{pausendauerError}</div>
          {/if}

          {#if isAzubiUnder18}
            <!-- JArbSchG §9 info pill (recommendation, not violation — uses .alert-info per app.css) -->
            <div class="alert alert-info" role="status" style="margin-bottom: 1rem;">
              <span>ℹ️</span><span>Azubi unter 18 — JArbSchG §9 Empfehlung</span>
            </div>
            {#if showAzubiSuggestionButton}
              <div style="margin-bottom: 1rem;">
                <button type="button" class="btn btn-secondary" onclick={applyAzubiSuggestion}
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
            />
            <p class="form-hint text-muted">ArbZG-Minimum: 45 Min</p>
          </div>
        </Section>

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
</style>
