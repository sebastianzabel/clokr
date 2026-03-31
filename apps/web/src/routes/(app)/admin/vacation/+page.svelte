<script lang="ts">
  import { run, self } from "svelte/legacy";

  import { onMount } from "svelte";
  import { api } from "$api/client";

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

  // Mitarbeiter-Modal
  let empModal: EmployeeRow | null = $state(null);
  let eType: "FIXED_WEEKLY" | "MONTHLY_HOURS" = $state("FIXED_WEEKLY");
  let eMonthlyHours: number = $state(0);
  let eMon = $state(8),
    eTue = $state(8),
    eWed = $state(8),
    eThu = $state(8),
    eFri = $state(8),
    eSat = $state(0),
    eSun = $state(0);
  let eThreshold = $state(60);
  let ePayout = $state(false);
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
      christmasEveRule = (cfg as any).christmasEveRule ?? "NORMAL";
      holidayRulesValidFromYear = (cfg as any).holidayRulesValidFromYear ?? 2026;
      newYearsEveRule = (cfg as any).newYearsEveRule ?? "NORMAL";
      vacationLeadTimeDays = (cfg as any).vacationLeadTimeDays ?? 0;
      vacationMaxAdvanceMonths = (cfg as any).vacationMaxAdvanceMonths ?? 0;
      halfDayAllowed = (cfg as any).halfDayAllowed ?? true;
      sickSelfReport = (cfg as any).sickSelfReport ?? true;
      sickNoteRequiredAfterDays = (cfg as any).sickNoteRequiredAfterDays ?? 3;
      autoCalcPartTimeVacation = (cfg as any).autoCalcPartTimeVacation ?? true;
      fullTimeWorkDaysPerWeek = (cfg as any).fullTimeWorkDaysPerWeek ?? 5;
      const maxNegMinutes = (cfg as any).maxNegativeBalanceMinutes;
      if (maxNegMinutes != null) {
        maxNegEnabled = true;
        maxNegHours = maxNegMinutes / 60;
      }
      enforceMinVacation = (cfg as any).enforceMinVacation ?? true;
      carryOverRequiresReason = (cfg as any).carryOverRequiresReason ?? true;
      vacationReminderStartMonth = (cfg as any).vacationReminderStartMonth ?? 10;
      reminderPendingEnabled = (cfg as any).reminderPendingLeaveEnabled ?? true;
      reminderPendingHours = (cfg as any).reminderPendingLeaveHours ?? 48;
      reminderUpcomingEnabled = (cfg as any).reminderUpcomingAbsenceEnabled ?? true;
      reminderUpcomingDays = (cfg as any).reminderUpcomingAbsenceDays ?? 3;

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
        mondayHours: eType === "FIXED_WEEKLY" ? eMon : 0,
        tuesdayHours: eType === "FIXED_WEEKLY" ? eTue : 0,
        wednesdayHours: eType === "FIXED_WEEKLY" ? eWed : 0,
        thursdayHours: eType === "FIXED_WEEKLY" ? eThu : 0,
        fridayHours: eType === "FIXED_WEEKLY" ? eFri : 0,
        saturdayHours: eType === "FIXED_WEEKLY" ? eSat : 0,
        sundayHours: eType === "FIXED_WEEKLY" ? eSun : 0,
        overtimeThreshold: eThreshold,
        allowOvertimePayout: ePayout,
        validFrom: eValidFrom,
      });

      if (eVacTotal !== null) {
        await api.put(`/settings/vacation/${empModal.id}`, {
          year: eVacYear,
          totalDays: eVacTotal,
          carriedOverDays: eVacCarried,
          carryOverDeadline: eVacDeadline || null,
        });
      }

      employees = employees.map((e: any) =>
        e.id === empModal!.id ? { ...e, workSchedule: updated } : e,
      );
      closeEmpModal();
    } catch (e: unknown) {
      eError = e instanceof Error ? e.message : "Fehler";
    } finally {
      eSaving = false;
    }
  }
</script>

<svelte:head>
  <title>Urlaub & Zeiten – Clokr</title>
</svelte:head>

{#if loading}
  <div class="card card-body" style="height:220px;"></div>
{:else if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{:else}
  <!-- ── Globale Vorgaben ───────────────────────────────────────────────────── -->

  <!-- Card 1: Arbeitszeit + Überstunden -->
  <details class="section-group" open>
    <summary class="section-group-header">Arbeitszeit & Überstunden</summary>
    <div class="settings-section">
      <h3 class="section-title">Wöchentliche Arbeitszeit</h3>
      <p class="text-muted section-desc">Standard-Stunden pro Wochentag für alle Mitarbeiter.</p>

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
            <span class="input-suffix text-muted">Stunden</span>
          </div>
          <p class="form-hint text-muted">Ab diesem Saldo: Kritisch-Warnung.</p>
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
  <details class="section-group" open>
    <summary class="section-group-header">Urlaubsanspruch</summary>
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
            <span class="input-suffix text-muted">Tage</span>
          </div>
          <p class="form-hint text-muted">
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
            <select id="g-co-month" bind:value={gCarryOverMonth} class="form-input co-month-select" aria-label="Monat des Verfalls">
              {#each MONTHS as m, i}
                <option value={i + 1}>{m}</option>
              {/each}
            </select>
            <span class="text-muted" style="font-size:0.875rem">des Folgejahres</span>
          </div>
        </div>
      </div>
    </div>
  </details>

  <!-- Card 3: Compliance + Pausen -->
  <details class="section-group">
    <summary class="section-group-header">Compliance & Pausen</summary>
    <div class="settings-section">
      <h3 class="section-title">Compliance</h3>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">ArbZG-Verstöße anzeigen</span>
          <p class="form-hint text-muted">
            Prüft Höchstarbeitszeit, Pausen und Ruhezeiten (§§ 3-5 ArbZG).
          </p>
        </div>
        <label class="switch">
          <input type="checkbox" aria-label="ArbZG-Verstöße anzeigen" bind:checked={gArbzgEnabled} />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>

    <hr class="settings-divider" />

    <!-- Pausen -->
    <div class="settings-section">
      <h3 class="section-title">Pausen</h3>
      <p class="text-muted section-desc">
        Automatische Pausenberechnung nach Arbeitszeitgesetz (§ 4 ArbZG).
      </p>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-row-label">Automatische Pausen</span>
          <p class="form-hint text-muted">
            Nach 6h werden 30 Min., nach 9h werden 45 Min. Pause automatisch eingetragen.
          </p>
        </div>
        <label class="switch">
          <input type="checkbox" aria-label="Automatische Pausen aktivieren" bind:checked={gAutoBreak} />
          <span class="switch-slider"></span>
        </label>
      </div>

      {#if gAutoBreak}
        <div class="form-group" style="margin-top: 1rem;">
          <label class="form-label" for="g-break-start">Standard-Pausenbeginn</label>
          <input
            id="g-break-start"
            type="time"
            bind:value={gDefaultBreakStart}
            class="form-input"
            style="max-width: 140px;"
          />
          <p class="form-hint text-muted">Wird als Vorauswahl im Erfassungsformular verwendet.</p>
        </div>
      {/if}
    </div>
  </details>

  <!-- Card 4: Benachrichtigungen -->
  <details class="section-group">
    <summary class="section-group-header">Benachrichtigungen</summary>
    <div class="settings-section">
      <h3 class="section-title">Benachrichtigungen</h3>
      <p class="text-muted section-desc">
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
            <span class="input-suffix text-muted">Stunden</span>
          </div>
          <p class="form-hint text-muted">
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
            <span class="input-suffix text-muted">Tagen</span>
          </div>
          <p class="form-hint text-muted">
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
            <span class="input-suffix text-muted">Stunden</span>
          </div>
          <p class="form-hint text-muted">
            Offene Einträge ohne Ausstempeln werden nach dieser Zeit als ungültig markiert und
            müssen manuell korrigiert werden. 0 = deaktiviert.
          </p>
        </div>
      </div>
    </div>
  </details>

  <!-- Card 5: Abwesenheiten & Sonderregelungen -->
  <details class="section-group">
    <summary class="section-group-header">Abwesenheiten & Sonderregelungen</summary>
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
          <p class="form-hint text-muted">
            {#if christmasEveRule === "NORMAL" && newYearsEveRule === "NORMAL"}
              Aktuell keine Sonderregelung aktiv.
            {:else if christmasEveRule !== "NORMAL" && newYearsEveRule !== "NORMAL"}
              Heiligabend ({christmasEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"}) und
              Silvester ({newYearsEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"}) gelten
              ab {holidayRulesValidFromYear}. Für frühere Jahre gelten beide als normaler
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
          <p class="form-hint text-muted">0 = keine Vorlaufzeit. Gilt nicht für Krankmeldungen.</p>
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
          <p class="form-hint text-muted">0 = unbegrenzt.</p>
        </div>
      </div>
      <label class="form-label toggle-label" style="margin-top:0.75rem">
        <input type="checkbox" bind:checked={halfDayAllowed} />
        Halbe Tage erlauben
      </label>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Krankmeldungen</h3>
      <label class="form-label toggle-label">
        <input type="checkbox" bind:checked={sickSelfReport} />
        Mitarbeiter dürfen Krankmeldung selbst eintragen
      </label>
      <div class="inline-settings" style="margin-top:0.75rem">
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
          <p class="form-hint text-muted">§ 5 EFZG — Standard: 3 Tage.</p>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Teilzeit-Urlaub</h3>
      <label class="form-label toggle-label">
        <input type="checkbox" bind:checked={autoCalcPartTimeVacation} />
        Automatische Pro-Rata-Berechnung (BUrlG)
      </label>
      {#if autoCalcPartTimeVacation}
        <div class="inline-settings" style="margin-top:0.75rem">
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

    <div class="settings-section">
      <h3 class="section-title">Urlaubsübertrag & Mindesturlaub (§ 7 BUrlG)</h3>
      <label class="form-label toggle-label">
        <input type="checkbox" bind:checked={enforceMinVacation} />
        Gesetzlichen Mindesturlaub durchsetzen (Warnung wenn nicht genommen)
      </label>
      <label class="form-label toggle-label" style="margin-top:0.5rem">
        <input type="checkbox" bind:checked={carryOverRequiresReason} />
        Übertrag ins Folgejahr erfordert Begründung (Krankheit, betriebliche Gründe)
      </label>
      <div class="inline-settings" style="margin-top:0.75rem">
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
          <p class="form-hint text-muted">
            Ab diesem Monat werden MA über verfallenden Urlaub erinnert (Hinweispflicht EuGH
            C-684/16).
          </p>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Max. Minusstunden</h3>
      <label class="form-label toggle-label">
        <input type="checkbox" bind:checked={maxNegEnabled} />
        Limit für negatives Überstundensaldo
      </label>
      {#if maxNegEnabled}
        <div class="inline-settings" style="margin-top:0.75rem">
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
    <div class="settings-section">
      <h3 class="section-title">Automatische Erinnerungen</h3>
      <label class="form-label toggle-label">
        <input type="checkbox" bind:checked={reminderPendingEnabled} />
        Offene Urlaubsanträge — Manager erinnern
      </label>
      {#if reminderPendingEnabled}
        <div class="inline-settings" style="margin-top:0.5rem">
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
      <label class="form-label toggle-label" style="margin-top:0.75rem">
        <input type="checkbox" bind:checked={reminderUpcomingEnabled} />
        Bevorstehende Abwesenheiten — Mitarbeiter erinnern
      </label>
      {#if reminderUpcomingEnabled}
        <div class="inline-settings" style="margin-top:0.5rem">
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

  {#if gError}
    <div class="alert alert-error" role="alert" style="margin:0.75rem 0 0;">
      <span>⚠</span><span>{gError}</span>
    </div>
  {/if}
  <div class="apply-existing-row" style="margin: 1rem 0 0;">
    <label class="form-label toggle-label">
      <input type="checkbox" bind:checked={gApplyToExisting} />
      Auch auf bestehende Mitarbeiter anwenden
    </label>
    <p class="form-hint text-muted" style="margin: 0.25rem 0 0 1.5rem;">
      Erstellt neue Schedule-Versionen ab heute für alle MA mit festem Wochenmodell. Minijobber und
      MA mit individuellen Einstellungen bleiben unverändert.
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

  <!-- ── Pro-Mitarbeiter ────────────────────────────────────────────────────── -->
  {#if employees.length > 0}
    <div class="section-group">
      <h3>Arbeitszeit & Urlaub pro Mitarbeiter</h3>
      <p class="text-muted" style="font-size: 0.875rem; margin-bottom: 1rem;">
        Individuelle Abweichungen von der globalen Vorgabe
      </p>

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
            {#each employees as emp}
              {@const s = emp.workSchedule}
              <tr>
                <td class="text-muted font-mono">{emp.employeeNumber}</td>
                <td class="font-medium">{emp.firstName} {emp.lastName}</td>
                {#if s?.type === "MONTHLY_HOURS"}
                  <td class="font-mono text-center" colspan="7">
                    <span class="badge badge-blue">{Number(s.monthlyHours).toFixed(1)} h/Monat</span
                    >
                  </td>
                {:else}
                  <td class="font-mono text-center">{s ? Number(s.mondayHours).toFixed(1) : "—"}</td
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
                  <td class="font-mono text-center">{s ? Number(s.fridayHours).toFixed(1) : "—"}</td
                  >
                  <td class="font-mono text-center"
                    >{s ? Number(s.saturdayHours).toFixed(1) : "—"}</td
                  >
                  <td class="font-mono text-center">{s ? Number(s.sundayHours).toFixed(1) : "—"}</td
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
                    <span class="badge badge-gray">Global</span>
                  {/if}
                </td>
                <td class="font-mono">{s ? Number(s.overtimeThreshold).toFixed(0) + " h" : "—"}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" onclick={() => openEmpModal(emp)}>
                    Bearbeiten
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
{/if}

<!-- ── Mitarbeiter-Modal ────────────────────────────────────────────────────── -->
{#if empModal}
  <div class="modal-backdrop" onclick={self(closeEmpModal)} role="presentation">
    <div class="modal-card card" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2>Einstellungen: {empModal.firstName} {empModal.lastName}</h2>
        <button class="btn-icon modal-close" onclick={closeEmpModal} aria-label="Schließen"
          >✕</button
        >
      </div>

      <div class="modal-body">
        {#if eError}
          <div class="alert alert-error" role="alert" style="margin-bottom:1rem;">
            <span>⚠</span><span>{eError}</span>
          </div>
        {/if}

        <h3 class="modal-section-heading">Arbeitszeit</h3>

        <div class="form-group" style="margin-bottom:1rem;">
          <label class="form-label" for="e-type">Arbeitszeitmodell</label>
          <select id="e-type" bind:value={eType} class="form-input" style="max-width:240px;">
            <option value="FIXED_WEEKLY">Feste Wochentage</option>
            <option value="MONTHLY_HOURS">Monatsstunden</option>
          </select>
        </div>

        {#if eType === "MONTHLY_HOURS"}
          <div class="form-group" style="margin-bottom:1.25rem;">
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
              <span class="input-suffix text-muted">Stunden</span>
            </div>
            <p class="form-hint text-muted">
              Keine festen Wochentage – Soll wird monatlich berechnet.
            </p>
          </div>
        {:else}
          <p class="text-muted" style="font-size:0.875rem;margin-bottom:1rem;">
            Wochenstunden werden automatisch aus den Tagen summiert.
          </p>

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

        <div class="extra-row" style="margin-top:1rem;">
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
              <span class="input-suffix text-muted">Stunden</span>
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

        <div class="form-group" style="margin-top:1rem;">
          <label class="form-label" for="e-valid-from">Gültig ab</label>
          <input
            id="e-valid-from"
            type="date"
            bind:value={eValidFrom}
            class="form-input"
            style="max-width:180px;"
          />
        </div>

        <hr class="modal-divider" />
        <h3 class="modal-section-heading">Urlaubsanspruch {eVacYear}</h3>

        {#if eVacLoading}
          <p class="text-muted" style="font-size:0.875rem;">Lade…</p>
        {:else}
          <p class="form-hint text-muted" style="margin-bottom:0.875rem;">
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
                <span class="input-suffix text-muted">Tage</span>
              </div>
              <p class="form-hint text-muted">
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
                <span class="input-suffix text-muted">Tage</span>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="e-vac-deadline">Resturlaub verfällt am</label>
              <input
                id="e-vac-deadline"
                type="date"
                bind:value={eVacDeadline}
                class="form-input"
                style="max-width:180px;"
              />
              <p class="form-hint text-muted">Leer lassen für globale Einstellung</p>
            </div>
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeEmpModal} disabled={eSaving}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveEmployee} disabled={eSaving}>
          {eSaving ? "Speichern…" : "Speichern"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .section-group {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 0;
    margin-bottom: 1.5rem;
    overflow: hidden;
  }
  .section-group-header {
    font-size: 1.0625rem;
    font-weight: 700;
    padding: 1rem 1.75rem;
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--color-text-heading);
    user-select: none;
    transition: background 0.15s;
  }
  .section-group-header:hover {
    background: var(--color-bg-subtle);
  }
  .section-group-header::after {
    content: "▸";
    font-size: 0.875rem;
    color: var(--color-text-muted);
    transition: transform 0.2s;
  }
  .section-group[open] > .section-group-header::after {
    transform: rotate(90deg);
  }
  .section-group-header::-webkit-details-marker {
    display: none;
  }
  .section-group > h3 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    padding: 1.5rem 1.75rem 0.75rem;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .section-group > .text-muted {
    padding: 0 1.75rem;
  }
  .section-group > .table-wrapper {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .settings-card {
    padding: 0;
    margin-bottom: 2rem;
  }

  .settings-section {
    padding: 1.5rem 1.75rem;
  }

  .settings-divider {
    border: none;
    border-top: 1px solid var(--color-border-subtle);
    margin: 0;
  }

  .section-title {
    font-size: 1.0625rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--color-text-heading);
  }

  .section-desc {
    font-size: 0.875rem;
    margin-bottom: 1.25rem;
  }

  .inline-settings {
    display: flex;
    gap: 2.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .section-label {
    margin: 2rem 0 0.875rem;
  }
  .section-label h2 {
    font-size: 1.0625rem;
    font-weight: 600;
  }
  .section-label p {
    font-size: 0.9375rem;
    margin-top: 0.125rem;
  }

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
    border-left: 1px solid var(--gray-200);
    padding-left: 0.75rem;
    margin-left: 0.25rem;
  }

  .weekly-total {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-brand);
    font-family: var(--font-mono);
    line-height: 2.1;
  }

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
    font-size: 0.875rem;
    white-space: nowrap;
  }
  .form-hint {
    font-size: 0.8125rem;
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
    accent-color: var(--color-brand);
  }

  .carryover-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Toggle switch */
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
    color: var(--color-text);
  }

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
    background-color: var(--gray-300);
    border-radius: 26px;
    transition: background-color 0.2s;
  }

  .switch-slider::before {
    content: "";
    position: absolute;
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .switch input:checked + .switch-slider {
    background-color: var(--color-brand);
  }

  .switch input:checked + .switch-slider::before {
    transform: translateX(22px);
  }
  .co-day-input {
    width: 64px;
    text-align: center;
  }
  .co-month-select {
    width: 140px;
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--gray-200);
  }

  .saved-hint {
    color: var(--color-green, #16a34a);
    font-weight: 500;
    font-size: 0.9375rem;
  }

  .text-center {
    text-align: center;
  }
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8125rem;
  }

  /* Modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  .modal-card {
    width: 100%;
    max-width: 580px;
    max-height: 90vh;
    overflow-y: auto;
    padding: 0;
    overflow-x: hidden;
    animation: modal-in 0.18s ease;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem 1rem;
    border-bottom: 1px solid var(--gray-200);
    position: sticky;
    top: 0;
    background: #fff;
    z-index: 1;
  }

  .modal-header h2 {
    font-size: 1.0625rem;
    font-weight: 600;
    margin: 0;
  }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    font-size: 1rem;
    color: var(--color-text-muted);
  }

  .modal-body {
    padding: 1.25rem 1.5rem;
  }

  .modal-section-heading {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.5rem;
  }

  .modal-divider {
    border: none;
    border-top: 1px solid var(--color-border-subtle);
    margin: 1.5rem 0 1rem;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.625rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--gray-200);
    background: var(--gray-50, #f9fafb);
    position: sticky;
    bottom: 0;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }
  .alert-error {
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.2rem 0.6rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .badge-gray {
    background: #f3f4f6;
    color: #6b7280;
  }
</style>
