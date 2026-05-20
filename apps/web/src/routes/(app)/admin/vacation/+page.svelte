<script lang="ts">
  import { run } from "svelte/legacy";

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import Modal from "$components/ui/Modal.svelte";

  interface TenantConfig {
    defaultWeeklyHours: number;
    defaultMondayHours: number;
    defaultTuesdayHours: number;
    defaultWednesdayHours: number;
    defaultThursdayHours: number;
    defaultFridayHours: number;
    defaultSaturdayHours: number;
    defaultSundayHours: number;
    overtimeThreshold: number;
    allowOvertimePayout: boolean;
    defaultVacationDays: number;
    carryOverDeadlineDay: number;
    carryOverDeadlineMonth: number;
    federalState: string;
    clockOutReminderHours: number;
    missingEntriesDays: number;
    autoDeleteOpenHours: number;
    // Optional extended fields returned by /settings/work
    arbzgEnabled?: boolean;
    autoBreakEnabled?: boolean;
    defaultBreakStart?: string;
    christmasEveRule?: string;
    holidayRulesValidFromYear?: number;
    newYearsEveRule?: string;
    vacationLeadTimeDays?: number;
    vacationMaxAdvanceMonths?: number;
    halfDayAllowed?: boolean;
    sickSelfReport?: boolean;
    sickNoteRequiredAfterDays?: number;
    autoCalcPartTimeVacation?: boolean;
    fullTimeWorkDaysPerWeek?: number;
    maxNegativeBalanceMinutes?: number | null;
    enforceMinVacation?: boolean;
    carryOverRequiresReason?: boolean;
    vacationReminderStartMonth?: number;
    reminderPendingLeaveEnabled?: boolean;
    reminderPendingLeaveHours?: number;
    reminderUpcomingAbsenceEnabled?: boolean;
    reminderUpcomingAbsenceDays?: number;
  }

  interface WorkSchedule {
    type: "FIXED_WEEKLY" | "MONTHLY_HOURS";
    weeklyHours: number;
    monthlyHours: number | null;
    mondayHours: number;
    tuesdayHours: number;
    wednesdayHours: number;
    thursdayHours: number;
    fridayHours: number;
    saturdayHours: number;
    sundayHours: number;
    overtimeThreshold: number;
    allowOvertimePayout: boolean;
    validFrom: string;
    overtimeMode?: "CARRY_FORWARD" | "TRACK_ONLY";
  }

  interface EmployeeRow {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    email: string;
    workSchedule: WorkSchedule | null;
  }

  interface VacationEntitlement {
    year: number;
    totalDays: number | null;
    usedDays: number;
    carriedOverDays: number;
    carryOverDeadline: string | null;
  }

  let loading = $state(true);
  let error = $state("");

  // Global
  let gMon = $state(8),
    gTue = $state(8),
    gWed = $state(8),
    gThu = $state(8),
    gFri = $state(8),
    gSat = $state(0),
    gSun = $state(0);
  let gThreshold = $state(60);
  let gPayout = $state(false);
  let gVacationDays = $state(30);
  let gSaving = $state(false);
  let gSaved = $state(false);
  let gError = $state("");

  // Resturlaub-Verfall
  const MONTHS = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];
  const MONTH_MAX_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  let gCarryOverDay = $state(31);
  let gCarryOverMonth = $state(3);
  let gArbzgEnabled = $state(true);
  let gAutoBreak = $state(false);
  let gDefaultBreakStart = $state("12:00");
  let gApplyToExisting = $state(false);
  let gClockOutHours = $state(10);
  let gMissingDays = $state(7);
  let gAutoInvalidateHours = $state(14);

  // Abwesenheits-Konfiguration
  let christmasEveRule = $state("NORMAL");
  let newYearsEveRule = $state("NORMAL");
  let holidayRulesValidFromYear = $state(new Date().getFullYear());
  let vacationLeadTimeDays = $state(0);
  let vacationMaxAdvanceMonths = $state(0);
  let halfDayAllowed = $state(true);
  let sickSelfReport = $state(true);
  let sickNoteRequiredAfterDays = $state(3);
  let autoCalcPartTimeVacation = $state(true);
  let fullTimeWorkDaysPerWeek = $state(5);
  // Max Minusstunden
  let maxNegEnabled = $state(false);
  let maxNegHours = $state(20);
  // Erinnerungen
  let reminderPendingEnabled = $state(true);
  let reminderPendingHours = $state(48);
  let reminderUpcomingEnabled = $state(true);
  let reminderUpcomingDays = $state(3);
  // Carry-over / Mindesturlaub
  let enforceMinVacation = $state(true);
  let carryOverRequiresReason = $state(true);
  let vacationReminderStartMonth = $state(10);

  let gMaxDay = $derived(MONTH_MAX_DAYS[gCarryOverMonth - 1] ?? 31);
  run(() => {
    gCarryOverDay = gMaxDay;
  });

  // Mitarbeiter-Liste
  let employees: EmployeeRow[] = $state([]);

  // Pagination for employee list
  let vacPage = $state(1);
  let vacPageSize = $state(10);
  let pagedVacationEmployees = $derived(
    employees.slice((vacPage - 1) * vacPageSize, vacPage * vacPageSize),
  );

  // Mitarbeiter-Modal — Modal primitive owns Escape/backdrop/focus-trap.
  let empModal: EmployeeRow | null = $state(null);
  let empModalOpen = $state(false);
  let eType: "FIXED_WEEKLY" | "MONTHLY_HOURS" = $state("FIXED_WEEKLY");
  let eMonthlyHours: number = $state(0);
  let eMon = $state(8),
    eTue = $state(8),
    eWed = $state(8),
    eThu = $state(8),
    eFri = $state(8),
    eSat = $state(0),
    eSun = $state(0);
  let eMonWd = $state(true),
    eTueWd = $state(true),
    eWedWd = $state(true),
    eThuWd = $state(true),
    eFriWd = $state(true),
    eSatWd = $state(false),
    eSunWd = $state(false);
  let eThreshold = $state(60);
  let ePayout = $state(false);
  let eOvertimeMode: "CARRY_FORWARD" | "TRACK_ONLY" = $state("CARRY_FORWARD");
  let eValidFrom = $state(new Date().toISOString().split("T")[0]);
  let eSaving = $state(false);
  let eError = $state("");

  // Urlaubsanspruch im Modal
  let eVacYear = new Date().getFullYear();
  let eVacTotal: number | null = $state(null);
  let eVacCarried = $state(0);
  let eVacDeadline = $state("");
  let eVacLoading = $state(false);

  let gWeekly = $derived(gMon + gTue + gWed + gThu + gFri + gSat + gSun);
  let eWeekly = $derived(eMon + eTue + eWed + eThu + eFri + eSat + eSun);
  let eWorkingDays = $derived(
    [eMon, eTue, eWed, eThu, eFri, eSat, eSun].filter((h) => h > 0).length,
  );
  let eVacSuggestion = $derived(Math.round((gVacationDays * eWorkingDays) / 5));

  // KPI helpers (read-only summaries surfaced at top of page)
  let kpiCarryOverLabel = $derived(`${gCarryOverDay}. ${MONTHS[gCarryOverMonth - 1]}`);
  let kpiEmployeeCount = $derived(employees.length);
  let kpiCustomScheduleCount = $derived(employees.filter((e) => e.workSchedule).length);

  onMount(async () => {
    try {
      const cfg = await api.get<TenantConfig>("/settings/work");
      gMon = Number(cfg.defaultMondayHours);
      gTue = Number(cfg.defaultTuesdayHours);
      gWed = Number(cfg.defaultWednesdayHours);
      gThu = Number(cfg.defaultThursdayHours);
      gFri = Number(cfg.defaultFridayHours);
      gSat = Number(cfg.defaultSaturdayHours);
      gSun = Number(cfg.defaultSundayHours);
      gThreshold = Number(cfg.overtimeThreshold);
      gPayout = cfg.allowOvertimePayout;
      gVacationDays = Number(cfg.defaultVacationDays) || 30;
      gCarryOverDay = cfg.carryOverDeadlineDay ?? 31;
      gCarryOverMonth = cfg.carryOverDeadlineMonth ?? 3;
      gArbzgEnabled = cfg.arbzgEnabled ?? true;
      gAutoBreak = cfg.autoBreakEnabled ?? false;
      gDefaultBreakStart = cfg.defaultBreakStart ?? "12:00";
      gClockOutHours = cfg.clockOutReminderHours ?? 10;
      gMissingDays = cfg.missingEntriesDays ?? 7;
      gAutoInvalidateHours = cfg.autoDeleteOpenHours ?? 14;

      // Leave/overtime config
      christmasEveRule = cfg.christmasEveRule ?? "NORMAL";
      holidayRulesValidFromYear = cfg.holidayRulesValidFromYear ?? 2026;
      newYearsEveRule = cfg.newYearsEveRule ?? "NORMAL";
      vacationLeadTimeDays = cfg.vacationLeadTimeDays ?? 0;
      vacationMaxAdvanceMonths = cfg.vacationMaxAdvanceMonths ?? 0;
      halfDayAllowed = cfg.halfDayAllowed ?? true;
      sickSelfReport = cfg.sickSelfReport ?? true;
      sickNoteRequiredAfterDays = cfg.sickNoteRequiredAfterDays ?? 3;
      autoCalcPartTimeVacation = cfg.autoCalcPartTimeVacation ?? true;
      fullTimeWorkDaysPerWeek = cfg.fullTimeWorkDaysPerWeek ?? 5;
      const maxNegMinutes = cfg.maxNegativeBalanceMinutes;
      if (maxNegMinutes != null) {
        maxNegEnabled = true;
        maxNegHours = maxNegMinutes / 60;
      }
      enforceMinVacation = cfg.enforceMinVacation ?? true;
      carryOverRequiresReason = cfg.carryOverRequiresReason ?? true;
      vacationReminderStartMonth = cfg.vacationReminderStartMonth ?? 10;
      reminderPendingEnabled = cfg.reminderPendingLeaveEnabled ?? true;
      reminderPendingHours = cfg.reminderPendingLeaveHours ?? 48;
      reminderUpcomingEnabled = cfg.reminderUpcomingAbsenceEnabled ?? true;
      reminderUpcomingDays = cfg.reminderUpcomingAbsenceDays ?? 3;

      employees = await api.get<EmployeeRow[]>("/settings/employees");
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  });

  async function saveGlobal() {
    gSaving = true;
    gError = "";
    gSaved = false;
    try {
      await api.put("/settings/work", {
        defaultWeeklyHours: gWeekly,
        defaultMondayHours: gMon,
        defaultTuesdayHours: gTue,
        defaultWednesdayHours: gWed,
        defaultThursdayHours: gThu,
        defaultFridayHours: gFri,
        defaultSaturdayHours: gSat,
        defaultSundayHours: gSun,
        overtimeThreshold: gThreshold,
        allowOvertimePayout: gPayout,
        carryOverDeadlineDay: gCarryOverDay,
        carryOverDeadlineMonth: gCarryOverMonth,
        defaultVacationDays: gVacationDays,
        arbzgEnabled: gArbzgEnabled,
        autoBreakEnabled: gAutoBreak,
        defaultBreakStart: gAutoBreak ? gDefaultBreakStart : null,
        applyToExisting: gApplyToExisting,
        clockOutReminderHours: gClockOutHours,
        missingEntriesDays: gMissingDays,
        autoDeleteOpenHours: gAutoInvalidateHours,
        christmasEveRule,
        newYearsEveRule,
        holidayRulesValidFromYear,
        vacationLeadTimeDays,
        vacationMaxAdvanceMonths,
        halfDayAllowed,
        sickSelfReport,
        sickNoteRequiredAfterDays,
        autoCalcPartTimeVacation,
        fullTimeWorkDaysPerWeek,
        enforceMinVacation,
        carryOverRequiresReason,
        vacationReminderStartMonth,
        reminderPendingLeaveHours: reminderPendingHours,
        reminderUpcomingAbsenceDays: reminderUpcomingDays,
        reminderPendingLeaveEnabled: reminderPendingEnabled,
        reminderUpcomingAbsenceEnabled: reminderUpcomingEnabled,
      });
      // Save max negative via security endpoint
      await api.put("/settings/security", {
        maxNegativeBalanceMinutes: maxNegEnabled ? Math.round(maxNegHours * 60) : null,
      });
      // Reset nach Speichern
      gApplyToExisting = false;
      gSaved = true;
      setTimeout(() => (gSaved = false), 3000);
    } catch (e: unknown) {
      gError = e instanceof Error ? e.message : "Fehler";
    } finally {
      gSaving = false;
    }
  }

  async function openEmpModal(emp: EmployeeRow) {
    empModal = emp;
    empModalOpen = true;
    const s = emp.workSchedule;
    eType = s?.type ?? "FIXED_WEEKLY";
    eMonthlyHours = s?.monthlyHours ? Number(s.monthlyHours) : 0;
    eMon = s ? Number(s.mondayHours) : gMon;
    eTue = s ? Number(s.tuesdayHours) : gTue;
    eWed = s ? Number(s.wednesdayHours) : gWed;
    eThu = s ? Number(s.thursdayHours) : gThu;
    eFri = s ? Number(s.fridayHours) : gFri;
    eSat = s ? Number(s.saturdayHours) : gSat;
    eSun = s ? Number(s.sundayHours) : gSun;
    eThreshold = s ? Number(s.overtimeThreshold) : gThreshold;
    ePayout = s ? s.allowOvertimePayout : gPayout;
    eOvertimeMode = s?.overtimeMode ?? "CARRY_FORWARD";
    // Initialize weekday chip state for MONTHLY_HOURS
    if (eType === "MONTHLY_HOURS" && s) {
      eMonWd = Number(s.mondayHours) > 0;
      eTueWd = Number(s.tuesdayHours) > 0;
      eWedWd = Number(s.wednesdayHours) > 0;
      eThuWd = Number(s.thursdayHours) > 0;
      eFriWd = Number(s.fridayHours) > 0;
      eSatWd = Number(s.saturdayHours) > 0;
      eSunWd = Number(s.sundayHours) > 0;
    } else {
      // D-03: default Mon-Fri when switching to MONTHLY_HOURS or no prior schedule
      eMonWd = true;
      eTueWd = true;
      eWedWd = true;
      eThuWd = true;
      eFriWd = true;
      eSatWd = false;
      eSunWd = false;
    }
    eValidFrom = s ? s.validFrom.split("T")[0] : new Date().toISOString().split("T")[0];
    eError = "";

    eVacLoading = true;
    eVacTotal = null;
    eVacCarried = 0;
    eVacDeadline = "";
    try {
      const vac = await api.get<VacationEntitlement>(
        `/settings/vacation/${emp.id}?year=${eVacYear}`,
      );
      eVacTotal = vac.totalDays;
      eVacCarried = vac.carriedOverDays;
      eVacDeadline = vac.carryOverDeadline ? vac.carryOverDeadline.split("T")[0] : "";
    } catch {
      // kein Eintrag vorhanden
    } finally {
      eVacLoading = false;
    }
  }

  function closeEmpModal() {
    empModalOpen = false;
    empModal = null;
  }

  async function saveEmployee() {
    if (!empModal) return;
    eSaving = true;
    eError = "";
    try {
      const updated = await api.put<WorkSchedule>(`/settings/work/${empModal.id}`, {
        type: eType,
        weeklyHours: eType === "FIXED_WEEKLY" ? eWeekly : 0,
        monthlyHours: eType === "MONTHLY_HOURS" ? eMonthlyHours : null,
        mondayHours: eType === "FIXED_WEEKLY" ? eMon : eMonWd ? 1 : 0,
        tuesdayHours: eType === "FIXED_WEEKLY" ? eTue : eTueWd ? 1 : 0,
        wednesdayHours: eType === "FIXED_WEEKLY" ? eWed : eWedWd ? 1 : 0,
        thursdayHours: eType === "FIXED_WEEKLY" ? eThu : eThuWd ? 1 : 0,
        fridayHours: eType === "FIXED_WEEKLY" ? eFri : eFriWd ? 1 : 0,
        saturdayHours: eType === "FIXED_WEEKLY" ? eSat : eSatWd ? 1 : 0,
        sundayHours: eType === "FIXED_WEEKLY" ? eSun : eSunWd ? 1 : 0,
        overtimeThreshold: eThreshold,
        allowOvertimePayout: ePayout,
        overtimeMode: eType === "MONTHLY_HOURS" ? eOvertimeMode : "CARRY_FORWARD",
        validFrom: eValidFrom,
      });

      // Always persist vacation entitlement so admins can set carriedOverDays
      // even when "Urlaubstage gesamt" was left empty (the placeholder hint
      // tells admins to leave it blank for the auto value — honor that).
      await api.put(`/settings/vacation/${empModal.id}`, {
        year: eVacYear,
        totalDays: eVacTotal ?? eVacSuggestion,
        carriedOverDays: eVacCarried,
        carryOverDeadline: eVacDeadline || null,
      });

      employees = employees.map((e) =>
        e.id === empModal!.id ? { ...e, workSchedule: updated } : e,
      );
      closeEmpModal();
    } catch (e: unknown) {
      eError = e instanceof Error ? e.message : "Fehler";
    } finally {
      eSaving = false;
    }
  }

  // When Modal closes (Escape/backdrop while not saving), clear modal state.
  $effect(() => {
    if (!empModalOpen && !eSaving) {
      empModal = null;
      eError = "";
    }
  });
</script>

<svelte:head>
  <title>Urlaub & Zeiten – Clokr</title>
</svelte:head>

<section class="page">
  <PageHead
    eyebrow="Administration"
    title="Urlaub & Zeiten"
    accent="Zeiten"
    sub="Globale Vorgaben für Arbeitszeit, Überstunden, Urlaub und ArbZG-Compliance — sowie individuelle Anpassungen pro Mitarbeiter."
  />

  {#if loading}
    <div class="card card-animate" style="height:220px;"></div>
  {:else if error}
    <div class="alert alert-error card-animate" role="alert">
      <span>⚠</span><span>{error}</span>
    </div>
  {:else}
    <!-- ── KPI cluster ──────────────────────────────────────────────────── -->
    <Card animate class="kpi-card">
      <CardHeader title="Übersicht" sub="Globale Eckdaten auf einen Blick" />
      <div class="kpi-row">
        <KPIStat label="Jahresurlaub" value={String(gVacationDays)} unit="T" />
        <KPIStat label="Wochenstunden" value={gWeekly.toFixed(1)} unit="h" />
        <KPIStat label="Verfall Resturlaub" value={kpiCarryOverLabel} />
        <KPIStat
          label="Mitarbeiter"
          value={String(kpiEmployeeCount)}
          unit={kpiCustomScheduleCount > 0 ? `· ${kpiCustomScheduleCount} individuell` : undefined}
        />
      </div>
    </Card>

    <!-- ── Globale Vorgaben ───────────────────────────────────────────────── -->

    <!-- Card 1: Arbeitszeit + Überstunden -->
    <details class="card card-animate section-group" open>
      <summary class="section-group-header">
        <span class="section-group-eyebrow">Konfiguration</span>
        <span class="section-group-title">Arbeitszeit & Überstunden</span>
      </summary>
      <div class="settings-section">
        <h3 class="section-title">Wöchentliche Arbeitszeit</h3>
        <p class="section-desc">Standard-Stunden pro Wochentag für alle Mitarbeiter.</p>

        <div class="day-grid">
          <div class="day-input">
            <label class="day-label form-label" for="day-mo">Mo</label>
            <input
              id="day-mo"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gMon}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-di">Di</label>
            <input
              id="day-di"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gTue}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-mi">Mi</label>
            <input
              id="day-mi"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gWed}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-do">Do</label>
            <input
              id="day-do"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gThu}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-fr">Fr</label>
            <input
              id="day-fr"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gFri}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-sa">Sa</label>
            <input
              id="day-sa"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gSat}
              class="form-input day-field"
            />
          </div>
          <div class="day-input">
            <label class="day-label form-label" for="day-so">So</label>
            <input
              id="day-so"
              type="number"
              min="0"
              max="24"
              step="0.5"
              bind:value={gSun}
              class="form-input day-field"
            />
          </div>
          <div class="day-input total-col">
            <span class="day-label form-label">Σ/Wo</span>
            <span class="weekly-total">{gWeekly.toFixed(1)}&thinsp;h</span>
          </div>
        </div>
      </div>

      <hr class="settings-divider" />

      <!-- Überstunden -->
      <div class="settings-section">
        <h3 class="section-title">Überstunden</h3>

        <div class="inline-settings">
          <div class="form-group">
            <label class="form-label" for="g-threshold">Warnschwelle</label>
            <div class="input-suffix-wrap">
              <input
                id="g-threshold"
                type="number"
                min="1"
                max="500"
                step="1"
                bind:value={gThreshold}
                class="form-input threshold-input"
              />
              <span class="input-suffix">Stunden</span>
            </div>
            <p class="form-hint">Ab diesem Saldo: Kritisch-Warnung.</p>
          </div>

          <div class="form-group">
            <span class="form-label">Auszahlung</span>
            <label class="toggle-label">
              <input type="checkbox" bind:checked={gPayout} class="toggle-cb" />
              <span>{gPayout ? "Erlaubt" : "Gesperrt"}</span>
            </label>
          </div>
        </div>
      </div>
    </details>

    <!-- Card 2: Urlaubsanspruch -->
    <details class="card card-animate section-group" open>
      <summary class="section-group-header">
        <span class="section-group-eyebrow">Urlaub</span>
        <span class="section-group-title">Urlaubsanspruch</span>
      </summary>
      <div class="settings-section">
        <h3 class="section-title">Urlaubsanspruch</h3>

        <div class="inline-settings">
          <div class="form-group">
            <label class="form-label" for="g-vac-days">Jahresurlaub (Basis 5-Tage-Woche)</label>
            <div class="input-suffix-wrap">
              <input
                id="g-vac-days"
                type="number"
                min="1"
                max="365"
                step="1"
                bind:value={gVacationDays}
                class="form-input threshold-input"
              />
              <span class="input-suffix">Tage</span>
            </div>
            <p class="form-hint">
              Teilzeit anteilig (4-Tage-Woche → {Math.round((gVacationDays * 4) / 5)} Tage).
            </p>
          </div>

          <div class="form-group">
            <label class="form-label" for="g-co-day">Resturlaub verfällt am</label>
            <div class="carryover-row">
              <input
                id="g-co-day"
                type="number"
                min="1"
                max={gMaxDay}
                step="1"
                bind:value={gCarryOverDay}
                class="form-input co-day-input"
                aria-label="Tag des Verfalls"
              /><span class="text-muted">.</span>
              <select
                id="g-co-month"
                bind:value={gCarryOverMonth}
                class="form-input co-month-select"
                aria-label="Monat des Verfalls"
              >
                {#each MONTHS as m, i (i)}
                  <option value={i + 1}>{m}</option>
                {/each}
              </select>
              <span class="text-muted carryover-suffix">des Folgejahres</span>
            </div>
          </div>
        </div>
      </div>
    </details>

    <!-- Card 3: Compliance + Pausen -->
    <details class="card card-animate section-group">
      <summary class="section-group-header">
        <span class="section-group-eyebrow" translate="no">ArbZG</span>
        <span class="section-group-title">Compliance & Pausen</span>
      </summary>
      <div class="settings-section">
        <h3 class="section-title">Compliance</h3>

        <div class="toggle-row">
          <div class="toggle-info">
            <span class="toggle-row-label">ArbZG-Verstöße anzeigen</span>
            <p class="form-hint">
              Prüft Höchstarbeitszeit, Pausen und Ruhezeiten (<span translate="no"
                >§§ 3-5 ArbZG</span
              >).
            </p>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              aria-label="ArbZG-Verstöße anzeigen"
              bind:checked={gArbzgEnabled}
            />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>

      <hr class="settings-divider" />

      <!-- Pausen -->
      <div class="settings-section">
        <h3 class="section-title">Pausen</h3>
        <p class="section-desc">
          Automatische Pausenberechnung nach Arbeitszeitgesetz (<span translate="no">§ 4 ArbZG</span
          >).
        </p>

        <div class="toggle-row">
          <div class="toggle-info">
            <span class="toggle-row-label">Automatische Pausen</span>
            <p class="form-hint">
              Nach 6h werden 30 Min., nach 9h werden 45 Min. Pause automatisch eingetragen.
            </p>
          </div>
          <label class="switch">
            <input
              type="checkbox"
              aria-label="Automatische Pausen aktivieren"
              bind:checked={gAutoBreak}
            />
            <span class="switch-slider"></span>
          </label>
        </div>

        {#if gAutoBreak}
          <div class="form-group break-start-group">
            <label class="form-label" for="g-break-start">Standard-Pausenbeginn</label>
            <input
              id="g-break-start"
              type="time"
              bind:value={gDefaultBreakStart}
              class="form-input break-start-input"
            />
            <p class="form-hint">Wird als Vorauswahl im Erfassungsformular verwendet.</p>
          </div>
        {/if}
      </div>
    </details>

    <!-- Card 4: Benachrichtigungen -->
    <details class="card card-animate section-group">
      <summary class="section-group-header">
        <span class="section-group-eyebrow">Erinnerungen</span>
        <span class="section-group-title">Benachrichtigungen</span>
      </summary>
      <div class="settings-section">
        <h3 class="section-title">Benachrichtigungen</h3>
        <p class="section-desc">
          Automatische Erinnerungen bei fehlenden oder offenen Zeiteinträgen.
        </p>

        <div class="inline-settings">
          <div class="form-group">
            <label class="form-label" for="g-clockout-hours"
              >Erinnerung bei offener Stempelung nach</label
            >
            <div class="input-suffix-wrap">
              <input
                id="g-clockout-hours"
                type="number"
                min="1"
                max="48"
                step="1"
                bind:value={gClockOutHours}
                class="form-input threshold-input"
              />
              <span class="input-suffix">Stunden</span>
            </div>
            <p class="form-hint">
              Mitarbeiter werden erinnert, wenn sie länger als diese Zeit eingestempelt sind.
            </p>
          </div>

          <div class="form-group">
            <label class="form-label" for="g-missing-days"
              >Erinnerung bei fehlenden Einträgen nach</label
            >
            <div class="input-suffix-wrap">
              <input
                id="g-missing-days"
                type="number"
                min="1"
                max="90"
                step="1"
                bind:value={gMissingDays}
                class="form-input threshold-input"
              />
              <span class="input-suffix">Tagen</span>
            </div>
            <p class="form-hint">
              Mitarbeiter und Vorgesetzte werden benachrichtigt, wenn keine Zeiteinträge erfasst
              wurden.
            </p>
          </div>

          <div class="form-group">
            <label class="form-label" for="g-autoinvalidate-hours"
              >Auto-Invalidierung offener Einträge (Stunden, 0 = deaktiviert)</label
            >
            <div class="input-suffix-wrap">
              <input
                id="g-autoinvalidate-hours"
                type="number"
                min="0"
                max="168"
                step="1"
                bind:value={gAutoInvalidateHours}
                class="form-input threshold-input"
              />
              <span class="input-suffix">Stunden</span>
            </div>
            <p class="form-hint">
              Offene Einträge ohne Ausstempeln werden nach dieser Zeit als ungültig markiert und
              müssen manuell korrigiert werden. 0 = deaktiviert.
            </p>
          </div>
        </div>
      </div>
    </details>

    <!-- Card 5: Abwesenheiten & Sonderregelungen -->
    <details class="card card-animate section-group">
      <summary class="section-group-header">
        <span class="section-group-eyebrow" translate="no">BUrlG · EFZG</span>
        <span class="section-group-title">Abwesenheiten & Sonderregelungen</span>
      </summary>
      <div class="settings-section">
        <h3 class="section-title">Heiligabend & Silvester</h3>
        <div class="inline-settings">
          <div class="form-group">
            <label class="form-label" for="christmas-rule">Heiligabend (24.12.)</label>
            <select id="christmas-rule" bind:value={christmasEveRule} class="form-input">
              <option value="NORMAL">Normaler Arbeitstag</option>
              <option value="HALF_DAY">Halber Tag frei</option>
              <option value="FULL_DAY_OFF">Ganzer Tag frei</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="newyears-rule">Silvester (31.12.)</label>
            <select id="newyears-rule" bind:value={newYearsEveRule} class="form-input">
              <option value="NORMAL">Normaler Arbeitstag</option>
              <option value="HALF_DAY">Halber Tag frei</option>
              <option value="FULL_DAY_OFF">Ganzer Tag frei</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="holiday-valid-from">Gültig ab Jahr</label>
            <input
              id="holiday-valid-from"
              type="number"
              min="2020"
              max="2100"
              bind:value={holidayRulesValidFromYear}
              class="form-input"
            />
            <p class="form-hint">
              {#if christmasEveRule === "NORMAL" && newYearsEveRule === "NORMAL"}
                Aktuell keine Sonderregelung aktiv.
              {:else if christmasEveRule !== "NORMAL" && newYearsEveRule !== "NORMAL"}
                Heiligabend ({christmasEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"})
                und Silvester ({newYearsEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"})
                gelten ab {holidayRulesValidFromYear}. Für frühere Jahre gelten beide als normaler
                Arbeitstag.
              {:else if christmasEveRule !== "NORMAL"}
                Heiligabend ({christmasEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"})
                gilt ab {holidayRulesValidFromYear}. Für frühere Jahre gilt der Tag als normaler
                Arbeitstag.
              {:else}
                Silvester ({newYearsEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"}) gilt
                ab {holidayRulesValidFromYear}. Für frühere Jahre gilt der Tag als normaler
                Arbeitstag.
              {/if}
            </p>
          </div>
        </div>
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">Urlaubsanträge</h3>
        <div class="inline-settings">
          <div class="form-group">
            <label class="form-label" for="lead-time">Vorlaufzeit (Tage)</label>
            <input
              id="lead-time"
              type="number"
              min="0"
              max="365"
              bind:value={vacationLeadTimeDays}
              class="form-input"
            />
            <p class="form-hint">0 = keine Vorlaufzeit. Gilt nicht für Krankmeldungen.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="max-advance">Max. Vorausbuchung (Monate)</label>
            <input
              id="max-advance"
              type="number"
              min="0"
              max="24"
              bind:value={vacationMaxAdvanceMonths}
              class="form-input"
            />
            <p class="form-hint">0 = unbegrenzt.</p>
          </div>
        </div>
        <label class="form-label toggle-label spaced-top-sm">
          <input type="checkbox" bind:checked={halfDayAllowed} />
          Halbe Tage erlauben
        </label>
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">Krankmeldungen</h3>
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={sickSelfReport} />
          Mitarbeiter dürfen Krankmeldung selbst eintragen
        </label>
        <div class="inline-settings spaced-top-sm">
          <div class="form-group">
            <label class="form-label" for="sick-note-days">AU-Pflicht nach (Tagen)</label>
            <input
              id="sick-note-days"
              type="number"
              min="1"
              max="30"
              bind:value={sickNoteRequiredAfterDays}
              class="form-input"
            />
            <p class="form-hint">§ 5 EFZG — Standard: 3 Tage.</p>
          </div>
        </div>
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">Teilzeit-Urlaub</h3>
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={autoCalcPartTimeVacation} />
          Automatische Pro-Rata-Berechnung (<span translate="no">BUrlG</span>)
        </label>
        {#if autoCalcPartTimeVacation}
          <div class="inline-settings spaced-top-sm">
            <div class="form-group">
              <label class="form-label" for="ft-days">Vollzeit-Arbeitstage/Woche</label>
              <select id="ft-days" bind:value={fullTimeWorkDaysPerWeek} class="form-input">
                <option value={5}>5 Tage (Mo–Fr)</option>
                <option value={6}>6 Tage (Mo–Sa)</option>
              </select>
            </div>
          </div>
        {/if}
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">
          Urlaubsübertrag & Mindesturlaub (<span translate="no">§ 7 BUrlG</span>)
        </h3>
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={enforceMinVacation} />
          Gesetzlichen Mindesturlaub durchsetzen (Warnung wenn nicht genommen)
        </label>
        <label class="form-label toggle-label spaced-top-xs">
          <input type="checkbox" bind:checked={carryOverRequiresReason} />
          Übertrag ins Folgejahr erfordert Begründung (Krankheit, betriebliche Gründe)
        </label>
        <div class="inline-settings spaced-top-sm">
          <div class="form-group">
            <label class="form-label" for="vac-reminder-month">Verfall-Erinnerung ab Monat</label>
            <select
              id="vac-reminder-month"
              bind:value={vacationReminderStartMonth}
              class="form-input"
            >
              <option value={8}>August</option>
              <option value={9}>September</option>
              <option value={10}>Oktober</option>
              <option value={11}>November</option>
              <option value={12}>Dezember</option>
            </select>
            <p class="form-hint">
              Ab diesem Monat werden MA über verfallenden Urlaub erinnert (Hinweispflicht EuGH
              C-684/16).
            </p>
          </div>
        </div>
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">Max. Minusstunden</h3>
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={maxNegEnabled} />
          Limit für negatives Überstundensaldo
        </label>
        {#if maxNegEnabled}
          <div class="inline-settings spaced-top-sm">
            <div class="form-group">
              <label class="form-label" for="max-neg-hours">Max. Minusstunden (h)</label>
              <input
                id="max-neg-hours"
                type="number"
                min="1"
                max="999"
                step="0.5"
                bind:value={maxNegHours}
                class="form-input"
              />
            </div>
          </div>
        {/if}
      </div>

      <hr class="settings-divider" />

      <div class="settings-section">
        <h3 class="section-title">Automatische Erinnerungen</h3>
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={reminderPendingEnabled} />
          Offene Urlaubsanträge — Manager erinnern
        </label>
        {#if reminderPendingEnabled}
          <div class="inline-settings spaced-top-xs">
            <div class="form-group">
              <label class="form-label" for="rem-pending-h">Nach (Stunden)</label>
              <input
                id="rem-pending-h"
                type="number"
                min="1"
                max="720"
                bind:value={reminderPendingHours}
                class="form-input"
              />
            </div>
          </div>
        {/if}
        <label class="form-label toggle-label spaced-top-sm">
          <input type="checkbox" bind:checked={reminderUpcomingEnabled} />
          Bevorstehende Abwesenheiten — Mitarbeiter erinnern
        </label>
        {#if reminderUpcomingEnabled}
          <div class="inline-settings spaced-top-xs">
            <div class="form-group">
              <label class="form-label" for="rem-upcoming-d">Tage vorher</label>
              <input
                id="rem-upcoming-d"
                type="number"
                min="1"
                max="30"
                bind:value={reminderUpcomingDays}
                class="form-input"
              />
            </div>
          </div>
        {/if}
      </div>
    </details>

    <!-- Action bar: save global -->
    <div class="card card-animate action-card">
      {#if gError}
        <div class="alert alert-error" role="alert">
          <span>⚠</span><span>{gError}</span>
        </div>
      {/if}
      <div class="apply-existing-row">
        <label class="form-label toggle-label">
          <input type="checkbox" bind:checked={gApplyToExisting} />
          Auch auf bestehende Mitarbeiter anwenden
        </label>
        <p class="form-hint apply-existing-hint">
          Erstellt neue Schedule-Versionen ab heute für alle MA mit festem Wochenmodell. Minijobber
          und MA mit individuellen Einstellungen bleiben unverändert.
        </p>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" onclick={saveGlobal} disabled={gSaving}>
          {gSaving ? "Speichern…" : "Globale Vorgaben speichern"}
        </button>
        {#if gSaved}
          <span class="saved-hint">✓ Gespeichert</span>
        {/if}
      </div>
    </div>

    <!-- ── Pro-Mitarbeiter ─────────────────────────────────────────────── -->
    {#if employees.length > 0}
      <Card animate>
        <CardHeader title="Mitarbeiter" sub="Individuelle Abweichungen von der globalen Vorgabe" />

        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Mitarbeiter</th>
                <th class="text-center">Mo</th>
                <th class="text-center">Di</th>
                <th class="text-center">Mi</th>
                <th class="text-center">Do</th>
                <th class="text-center">Fr</th>
                <th class="text-center">Sa</th>
                <th class="text-center">So</th>
                <th class="text-center">Σ/Wo</th>
                <th>Schwelle</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each pagedVacationEmployees as emp (emp.id)}
                {@const s = emp.workSchedule}
                <tr>
                  <td class="text-muted font-mono">{emp.employeeNumber}</td>
                  <td class="font-medium">{emp.firstName} {emp.lastName}</td>
                  {#if s?.type === "MONTHLY_HOURS"}
                    <td class="font-mono text-center" colspan="7">
                      <span class="chip-brand">{Number(s.monthlyHours).toFixed(1)} h/Monat</span>
                    </td>
                  {:else}
                    <td class="font-mono text-center"
                      >{s ? Number(s.mondayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.tuesdayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.wednesdayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.thursdayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.fridayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.saturdayHours).toFixed(1) : "—"}</td
                    >
                    <td class="font-mono text-center"
                      >{s ? Number(s.sundayHours).toFixed(1) : "—"}</td
                    >
                  {/if}
                  <td class="font-mono text-center font-medium">
                    {#if s}
                      {#if s.type === "MONTHLY_HOURS"}
                        {Number(s.monthlyHours).toFixed(1)}&thinsp;h/Mo
                      {:else}
                        {Number(s.weeklyHours).toFixed(1)}&thinsp;h
                      {/if}
                    {:else}
                      <span class="chip-muted">Global</span>
                    {/if}
                  </td>
                  <td class="font-mono"
                    >{s ? Number(s.overtimeThreshold).toFixed(0) + " h" : "—"}</td
                  >
                  <td>
                    <button class="btn btn-ghost btn-sm" onclick={() => openEmpModal(emp)}>
                      Bearbeiten
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <Pagination total={employees.length} bind:page={vacPage} bind:pageSize={vacPageSize} />
        </div>
      </Card>
    {/if}
  {/if}
</section>

<!-- ── Mitarbeiter-Modal ────────────────────────────────────────────────────── -->
{#if empModal}
  <Modal
    bind:open={empModalOpen}
    eyebrow="Mitarbeiter"
    title={`Einstellungen: ${empModal.firstName} ${empModal.lastName}`}
  >
    {#if eError}
      <div class="alert alert-error modal-alert" role="alert">
        <span>⚠</span><span>{eError}</span>
      </div>
    {/if}

    <h3 class="modal-section-heading">Arbeitszeit</h3>

    <div class="form-group modal-form-group">
      <label class="form-label" for="e-type">Arbeitszeitmodell</label>
      <select id="e-type" bind:value={eType} class="form-input modal-select-md">
        <option value="FIXED_WEEKLY">Feste Wochentage</option>
        <option value="MONTHLY_HOURS">Monatsstunden</option>
      </select>
    </div>

    {#if eType === "MONTHLY_HOURS"}
      <div class="form-group modal-form-group">
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

      <div class="form-group modal-form-group">
        <label class="form-label" for="e-overtime-mode">Überstunden-Modus</label>
        <select id="e-overtime-mode" bind:value={eOvertimeMode} class="form-input modal-select-lg">
          <option value="CARRY_FORWARD">Übertragen (CARRY_FORWARD)</option>
          <option value="TRACK_ONLY">Nur erfassen (TRACK_ONLY)</option>
        </select>
        <p class="form-hint">
          Übertragen: Überstunden werden im Saldo angesammelt. Nur erfassen: Stunden werden
          dokumentiert, Saldo bleibt bei 0.
        </p>
      </div>

      <div class="form-group modal-form-group">
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
        <p class="form-hint">
          Wenn konfiguriert, wird ein tägliches Soll im Kalender angezeigt (Budget &divide;
          Arbeitstage im Monat).
        </p>
      </div>
    {:else}
      <p class="modal-help">Wochenstunden werden automatisch aus den Tagen summiert.</p>

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
          <span class="day-label form-label">Σ</span>
          <span class="weekly-total">{eWeekly.toFixed(1)}&thinsp;h</span>
        </div>
      </div>
    {/if}

    <div class="extra-row spaced-top-md">
      <div class="form-group">
        <label class="form-label" for="e-threshold">Warnschwelle</label>
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
        <span class="form-label">Auszahlung</span>
        <label class="toggle-label">
          <input type="checkbox" bind:checked={ePayout} class="toggle-cb" />
          <span>{ePayout ? "Erlaubt" : "Gesperrt"}</span>
        </label>
      </div>
    </div>

    <div class="form-group spaced-top-md">
      <label class="form-label" for="e-valid-from">Gültig ab</label>
      <input
        id="e-valid-from"
        type="date"
        bind:value={eValidFrom}
        class="form-input modal-input-sm"
      />
    </div>

    <hr class="modal-divider" />
    <h3 class="modal-section-heading">Urlaubsanspruch {eVacYear}</h3>

    {#if eVacLoading}
      <p class="modal-help">Lade…</p>
    {:else}
      <p class="form-hint modal-help-strong">
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
          <p class="form-hint">
            Leer lassen für automatischen Wert ({eVacSuggestion})
          </p>
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
          <input
            id="e-vac-deadline"
            type="date"
            bind:value={eVacDeadline}
            class="form-input modal-input-sm"
          />
          <p class="form-hint">Leer lassen für globale Einstellung</p>
        </div>
      </div>
    {/if}

    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeEmpModal} disabled={eSaving}>Abbrechen</button>
      <button class="btn btn-primary" onclick={saveEmployee} disabled={eSaving}>
        {eSaving ? "Speichern…" : "Speichern"}
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  /* .page wrapper is global (app.css) — no per-page padding/max-width override. */

  /* ── KPI card ───────────────────────────────────────────────────────────── */
  :global(.kpi-card .card-hd) {
    margin-bottom: 18px;
  }

  .kpi-row {
    display: flex;
    align-items: flex-end;
    gap: 32px;
    flex-wrap: wrap;
  }

  /* ── Collapsible section-group cards (details + summary) ───────────────── */
  .section-group {
    padding: 0;
    overflow: hidden;
  }
  .section-group-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 18px 24px;
    cursor: pointer;
    list-style: none;
    color: var(--text);
    user-select: none;
    transition: background 0.15s var(--ease-out);
    position: relative;
  }
  .section-group-header:hover {
    background: var(--bg-subtle);
  }
  .section-group-header::after {
    content: "›";
    position: absolute;
    top: 50%;
    right: 22px;
    transform: translateY(-50%);
    font-size: 22px;
    color: var(--text-muted);
    transition: transform 0.2s var(--ease-out);
    line-height: 1;
  }
  .section-group[open] > .section-group-header::after {
    transform: translateY(-50%) rotate(90deg);
  }
  .section-group-header::-webkit-details-marker {
    display: none;
  }
  .section-group-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 13px;
    color: var(--brand-light);
    letter-spacing: 0.02em;
  }
  .section-group-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.1;
    color: var(--text);
    letter-spacing: 0.005em;
  }

  .settings-section {
    padding: 22px 24px;
  }

  .settings-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0;
  }

  .section-title {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 12px;
  }

  .section-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: -4px 0 16px;
  }

  .inline-settings {
    display: flex;
    gap: 2.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }

  /* ── Day input grid ─────────────────────────────────────────────────────── */
  .day-grid {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: flex-end;
    margin-bottom: 1.25rem;
  }

  .day-input {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }

  .day-label {
    font-size: 0.6875rem !important;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 0 !important;
  }

  .day-field {
    width: 58px;
    text-align: center;
    padding: 0.375rem 0.25rem;
    font-size: 0.9375rem;
  }

  .total-col {
    border-left: 1px solid var(--border);
    padding-left: 0.75rem;
    margin-left: 0.25rem;
  }

  .weekly-total {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 22px;
    font-weight: 400;
    color: var(--brand-light);
    line-height: 2.1;
  }

  /* ── Form helpers ───────────────────────────────────────────────────────── */
  .extra-row {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .input-suffix-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .threshold-input {
    max-width: 100px;
  }
  .input-suffix {
    font-size: 0.8125rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .form-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
    margin-top: 0.375rem;
  }

  .toggle-cb {
    width: 16px;
    height: 16px;
    accent-color: var(--brand);
  }

  .carryover-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .carryover-suffix {
    font-size: 0.875rem;
  }

  /* Toggle row (text + switch) */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }

  .toggle-info {
    flex: 1;
  }

  .toggle-row-label {
    font-size: 1rem;
    font-weight: 500;
    color: var(--text);
  }

  /* iOS-style switch */
  .switch {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 26px;
    flex-shrink: 0;
  }

  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .switch-slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background-color: var(--border-strong);
    border-radius: 26px;
    transition: background-color 0.2s var(--ease-out);
  }

  .switch-slider::before {
    content: "";
    position: absolute;
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: var(--bg-card);
    border-radius: 50%;
    transition: transform 0.2s var(--ease-out);
    box-shadow: var(--shadow-sm);
  }

  .switch input:checked + .switch-slider {
    background-color: var(--brand);
  }

  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }

  /* Carry-over inputs */
  .co-day-input {
    width: 64px;
    text-align: center;
  }
  .co-month-select {
    width: 140px;
  }

  /* ── Action card (save bar) ────────────────────────────────────────────── */
  .action-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .apply-existing-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .apply-existing-hint {
    margin: 0.25rem 0 0 1.5rem;
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }

  .saved-hint {
    color: var(--good);
    font-weight: 500;
    font-size: 0.9375rem;
  }

  /* ── Misc utilities (page-scoped) ──────────────────────────────────────── */
  .text-center {
    text-align: center;
  }
  .btn-sm {
    padding: 6px 12px;
    font-size: 12.5px;
  }

  .break-start-group {
    margin-top: 16px;
  }
  .break-start-input {
    max-width: 140px;
  }

  .spaced-top-xs {
    margin-top: 8px;
  }
  .spaced-top-sm {
    margin-top: 12px;
  }
  .spaced-top-md {
    margin-top: 16px;
  }

  /* ── Chips (replace legacy badge-blue / badge-gray) ───────────────────── */
  .chip-brand {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: var(--r-pill);
    font-size: 11.5px;
    font-weight: 600;
    background: var(--brand-soft);
    color: var(--brand);
  }
  .chip-muted {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: var(--r-pill);
    font-size: 11.5px;
    font-weight: 600;
    background: var(--bg-subtle);
    color: var(--text-muted);
  }

  /* ── Modal body content helpers (Modal primitive owns chrome) ──────── */
  .modal-form-group {
    margin: 0;
  }

  .modal-select-md {
    max-width: 240px;
  }
  .modal-select-lg {
    max-width: 280px;
  }
  .modal-input-sm {
    max-width: 180px;
  }

  .modal-help {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin: 0 0 4px;
  }
  .modal-help-strong {
    margin-bottom: 14px;
  }

  .modal-alert {
    margin-bottom: 4px;
  }

  .modal-section-heading {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 0 0 4px;
  }

  .modal-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 12px 0 4px;
  }

  /* ── Weekday chips (modal) ─────────────────────────────────────────────── */
  .weekday-chips {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.375rem;
    margin-bottom: 0.375rem;
  }

  .wd-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.5rem;
    height: 2rem;
    padding: 0 0.625rem;
    border-radius: var(--r-pill);
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      background 0.15s var(--ease-out),
      color 0.15s var(--ease-out),
      border-color 0.15s var(--ease-out);
    border: 1.5px solid var(--border);
    background: transparent;
    color: var(--text-muted);
  }

  .wd-chip--active {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--text-on-brand);
  }

  .wd-chip:hover:not(.wd-chip--active) {
    border-color: var(--brand);
    color: var(--brand);
  }

  @media (max-width: 720px) {
    .page {
      padding: 20px 16px 60px;
    }
    .inline-settings {
      gap: 1.25rem;
    }
    .kpi-row {
      gap: 18px;
    }
  }
</style>
