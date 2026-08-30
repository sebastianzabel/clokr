<script lang="ts">
  import { run } from "svelte/legacy";

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { markUnsaved } from "$stores/unsaved";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Pagination from "$components/ui/Pagination.svelte";

  // ── Tabs (Phase 58: tabbed config layout) ──────────────────────────────────
  const TABS = [
    { id: "uebersicht", label: "Übersicht" },
    { id: "standards", label: "Standards" },
    { id: "arbzg", label: "ArbZG" },
    { id: "antraege", label: "Anträge & Krankheit" },
    { id: "erinnerungen", label: "Erinnerungen" },
    { id: "sonderurlaub", label: "Sonderurlaub" },
  ];
  let activeTab = $state<string>("uebersicht");

  // ── Sonderurlaub (merged from /admin/special-leave) ────────────────────────
  interface SpecialLeaveRule {
    id: string;
    name: string;
    reason: string | null;
    defaultDays: number;
    isStatutory: boolean;
    requiresProof: boolean;
    isActive: boolean;
  }
  let slRules: SpecialLeaveRule[] = $state([]);
  let slLoading = $state(false);
  let slPage = $state(1);
  let slPageSize = $state(10);
  let slPagedRules = $derived(slRules.slice((slPage - 1) * slPageSize, slPage * slPageSize));

  // Sonderurlaub — create modal
  let slShowCreate = $state(false);
  let slCreateName = $state("");
  let slCreateReason = $state("");
  let slCreateDays = $state(1);
  let slCreateProof = $state(false);
  let slCreating = $state(false);

  // Sonderurlaub — edit modal (replaces the deleted /[id] route)
  let slShowEdit = $state(false);
  let slEditId = $state("");
  let slEditName = $state("");
  let slEditReason = $state("");
  let slEditDays = $state(1);
  let slEditProof = $state(false);
  let slEditActive = $state(true);
  let slEditStatutory = $state(false);
  let slSaving = $state(false);

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
    availabilityEnabled?: boolean;
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
    carryoverWarningEnabled?: boolean;
    carryoverWarningThresholds?: number[];
    reminderPendingLeaveEnabled?: boolean;
    reminderPendingLeaveHours?: number;
    reminderUpcomingAbsenceEnabled?: boolean;
    reminderUpcomingAbsenceDays?: number;
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
  // Phase 49.4: Verfügbarkeits-System toggle moved to /admin/system (Features card).
  // v1.6.5: autoBreakEnabled + defaultBreakStart moved to /admin/system → Arbeitszeit.
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
  /**
   * Mirrors normalizeKarenzDays() in apps/api/src/utils/find-karenz-overrun-days.ts:
   * § 5 Abs. 1 EFZG ("länger als drei Kalendertage") caps the threshold at 3; null/undefined
   * (cleared input, or a tenant that never set it) falls back to the default 3.
   */
  function clampKarenzDays(raw: number | null | undefined): number {
    if (raw === null || raw === undefined || Number.isNaN(Number(raw))) return 3;
    return Math.min(3, Math.max(0, Math.trunc(Number(raw))));
  }

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
  // BUrlG § 7 Hinweispflicht (Phase 44)
  let carryoverWarningEnabled = $state(true);
  let carryoverWarningThresholdsText = $state("60, 30, 14, 7");

  let gMaxDay = $derived(MONTH_MAX_DAYS[gCarryOverMonth - 1] ?? 31);
  run(() => {
    gCarryOverDay = gMaxDay;
  });

  let gWeekly = $derived(gMon + gTue + gWed + gThu + gFri + gSat + gSun);

  // KPI helpers
  let kpiCarryOverLabel = $derived(`${gCarryOverDay}. ${MONTHS[gCarryOverMonth - 1]}`);

  // ── Unsaved-marker tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ───────────
  // One snapshot for the whole page, because exactly one button (saveGlobal) commits it.
  // Snapshot comparison rather than per-field oninput flags: it is three lines total instead
  // of one per input, and undoing an edit by hand clears the marker again, which a per-field
  // flag cannot do. Instant-save controls are deliberately NOT in the snapshot — they are
  // never "unsaved".
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let globalSnapshot = $state("");
  let globalDirty = $derived(
    snap(
      gMon,
      gTue,
      gWed,
      gThu,
      gFri,
      gSat,
      gSun,
      gThreshold,
      gPayout,
      gCarryOverDay,
      gCarryOverMonth,
      gVacationDays,
      gArbzgEnabled,
      gClockOutHours,
      gMissingDays,
      gAutoInvalidateHours,
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
      carryoverWarningEnabled,
      carryoverWarningThresholdsText,
      reminderPendingHours,
      reminderUpcomingDays,
      reminderPendingEnabled,
      reminderUpcomingEnabled,
      maxNegEnabled,
      maxNegHours,
    ) !== globalSnapshot,
  );
  // gWeekly is NOT included — it's a $derived of gMon..gSun (:192), already covered.
  // gApplyToExisting is NOT included — it's not a persisted value but a modifier of the next
  // save, which saveGlobal itself resets to false on success (:320). A marker for it would
  // claim an unsaved setting that does not exist.

  // Gate the registration on "the baseline has been taken" (WR-01). The snapshot starts as ""
  // and only gets its real value at the end of onMount's try, so globalDirty reads true until
  // then. Registering that would arm the navigation guard on a page that has no form yet —
  // permanently so if the load throws, since the snapshot assignment is then never reached and
  // the page renders nothing but an error banner (no visible marker to explain the dialog).
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-vacation", snapshotsReady && globalDirty);
    return () => markUnsaved("admin-vacation", false);
  });

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
      // v1.6.5: autoBreakEnabled + defaultBreakStart are managed on /admin/system → Arbeitszeit.
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
      // Phase 104 review (WR-08): 104-08 narrowed the API range from 1-30 to 0-3 and
      // deliberately did NOT migrate legacy rows (Revisionssicherheit) — they are clamped on
      // the READ path by normalizeKarenzDays(). This form is a read path too: without the
      // same clamp a tenant still carrying e.g. 14 loaded 14 into the input and the next save
      // of ANY setting on this page was rejected with the global "Validierungsfehler", with no
      // hint which of ~40 fields caused it.
      sickNoteRequiredAfterDays = clampKarenzDays(cfg.sickNoteRequiredAfterDays);
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
      carryoverWarningEnabled = cfg.carryoverWarningEnabled ?? true;
      const thresholds = cfg.carryoverWarningThresholds ?? [60, 30, 14, 7];
      carryoverWarningThresholdsText = thresholds.join(", ");
      reminderPendingEnabled = cfg.reminderPendingLeaveEnabled ?? true;
      reminderPendingHours = cfg.reminderPendingLeaveHours ?? 48;
      reminderUpcomingEnabled = cfg.reminderUpcomingAbsenceEnabled ?? true;
      reminderUpcomingDays = cfg.reminderUpcomingAbsenceDays ?? 3;
      globalSnapshot = snap(
        gMon,
        gTue,
        gWed,
        gThu,
        gFri,
        gSat,
        gSun,
        gThreshold,
        gPayout,
        gCarryOverDay,
        gCarryOverMonth,
        gVacationDays,
        gArbzgEnabled,
        gClockOutHours,
        gMissingDays,
        gAutoInvalidateHours,
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
        carryoverWarningEnabled,
        carryoverWarningThresholdsText,
        reminderPendingHours,
        reminderUpcomingDays,
        reminderPendingEnabled,
        reminderUpcomingEnabled,
        maxNegEnabled,
        maxNegHours,
      );
      snapshotsReady = true;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  });

  function parseThresholdsInput(text: string): number[] {
    // "60, 30, 14, 7" → [60, 30, 14, 7]. Filter out invalid entries, dedupe, sort desc.
    const tokens = text
      .split(/[,;\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const seen = new Set<number>();
    for (const tok of tokens) {
      const n = parseInt(tok, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 365) seen.add(n);
    }
    return Array.from(seen).sort((a, b) => b - a);
  }

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
        // v1.6.5: autoBreakEnabled + defaultBreakStart are owned by /admin/system →
        // Arbeitszeit and intentionally not sent from this page to avoid clobbering.
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
        // Clamped again on the way out: clearing the number input makes Svelte's bind:value
        // yield null, and the API field is .optional() (not .nullable()).
        sickNoteRequiredAfterDays: clampKarenzDays(sickNoteRequiredAfterDays),
        autoCalcPartTimeVacation,
        fullTimeWorkDaysPerWeek,
        enforceMinVacation,
        carryOverRequiresReason,
        vacationReminderStartMonth,
        carryoverWarningEnabled,
        carryoverWarningThresholds: parseThresholdsInput(carryoverWarningThresholdsText),
        reminderPendingLeaveHours: reminderPendingHours,
        reminderUpcomingAbsenceDays: reminderUpcomingDays,
        reminderPendingLeaveEnabled: reminderPendingEnabled,
        reminderUpcomingAbsenceEnabled: reminderUpcomingEnabled,
      });
      // Save max negative via security endpoint
      await api.put("/settings/security", {
        maxNegativeBalanceMinutes: maxNegEnabled ? Math.round(maxNegHours * 60) : null,
      });
      // Phase 49.4: availabilityEnabled toggle moved to /admin/system Features card.
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

  // ── Sonderurlaub: list + CRUD ──────────────────────────────────────────────
  async function loadSLRules() {
    slLoading = true;
    try {
      slRules = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
    } catch {
      toasts.error("Fehler beim Laden der Sonderurlaubsregeln");
    } finally {
      slLoading = false;
    }
  }

  // Lazy-load Sonderurlaub on first visit to that tab (saves a request if the
  // user never opens it).
  let slLoaded = false;
  $effect(() => {
    if (activeTab === "sonderurlaub" && !slLoaded) {
      slLoaded = true;
      loadSLRules();
    }
  });

  function openSLCreate() {
    slCreateName = "";
    slCreateReason = "";
    slCreateDays = 1;
    slCreateProof = false;
    slShowCreate = true;
  }

  async function saveSLCreate() {
    if (!slCreateName.trim()) return;
    slCreating = true;
    try {
      await api.post("/special-leave/rules", {
        name: slCreateName.trim(),
        reason: slCreateReason.trim() || undefined,
        defaultDays: slCreateDays,
        requiresProof: slCreateProof,
      });
      slShowCreate = false;
      await loadSLRules();
      toasts.success("Regel erstellt");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      slCreating = false;
    }
  }

  function openSLEdit(rule: SpecialLeaveRule) {
    slEditId = rule.id;
    slEditName = rule.name;
    slEditReason = rule.reason ?? "";
    slEditDays = Number(rule.defaultDays);
    slEditProof = rule.requiresProof;
    slEditActive = rule.isActive;
    slEditStatutory = rule.isStatutory;
    slShowEdit = true;
  }

  async function saveSLEdit() {
    slSaving = true;
    try {
      await api.put(`/special-leave/rules/${slEditId}`, {
        name: slEditStatutory ? undefined : slEditName.trim() || undefined,
        reason: slEditReason.trim() || null,
        defaultDays: slEditDays,
        requiresProof: slEditProof,
        isActive: slEditActive,
      });
      slShowEdit = false;
      await loadSLRules();
      toasts.success("Regel aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      slSaving = false;
    }
  }
</script>

<svelte:head>
  <title>Urlaubsverwaltung – Clokr</title>
</svelte:head>

<SectionStack
  eyebrow="Personal"
  title="Urlaubsverwaltung"
  sub="Globale Einstellungen, Sonderurlaubsregeln und Tenant-Übersicht"
  tabs={TABS}
  bind:activeTab
  animate
>
  {#snippet tabContent(currentTab)}
    {#if loading}
      <div class="vac-skeleton"></div>
    {:else if error}
      <div class="alert alert-error" role="alert">
        <span>&#9888;</span><span>{error}</span>
      </div>
    {:else if currentTab === "uebersicht"}
      <!-- ── Tab: Übersicht ──────────────────────────────────────────────── -->
      <Section title="Übersicht" sub="Tenant-weite Eckdaten auf einen Blick">
        <div class="vac-kpi-grid">
          <KPIStat label="Jahresurlaub (Standard)" value={String(gVacationDays)} unit="T" />
          <KPIStat label="Wochenstunden (Standard)" value={gWeekly.toFixed(1)} unit="h" />
          <KPIStat label="Resturlaub verfällt am" value={kpiCarryOverLabel} />
          <KPIStat label="Überstunden-Warnschwelle" value={String(gThreshold)} unit="h" />
        </div>
        <div class="vac-callout">
          <strong>Per-MA Konfiguration:</strong> Individuelle Urlaubs- und Arbeitszeiteinstellungen
          pro Mitarbeiter verwalten Sie in der
          <a href="/admin/employees">Mitarbeiter-Detailseite</a>.
        </div>
      </Section>
    {:else if currentTab === "standards"}
      <!-- ── Tab: Standards (Arbeitszeit + Urlaubsanspruch) ─────────────── -->
      <Section title="Arbeitszeit & Überstunden" sub="Standard-Stunden und Überstundenregelungen">
        <div class="settings-section">
          <h3 class="section-inner-title">Wöchentliche Arbeitszeit</h3>
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
              <span class="day-label form-label">&#x3a3;/Wo</span>
              <span class="weekly-total">{gWeekly.toFixed(1)}&thinsp;h</span>
            </div>
          </div>
        </div>

        <hr class="settings-divider" />

        <div class="settings-section">
          <h3 class="section-inner-title">Überstunden</h3>

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
      </Section>

      <!-- ── Section 3: Urlaubsanspruch ───────────────────────────────────── -->
      <Section title="Urlaubsanspruch" sub="Jahresurlaub und Resturlaub-Verfall">
        <div class="settings-section">
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
                Teilzeit anteilig (4-Tage-Woche &rarr; {Math.round((gVacationDays * 4) / 5)} Tage).
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
      </Section>
    {:else if currentTab === "arbzg"}
      <!-- ── Tab: ArbZG ─────────────────────────────────────────────────── -->
      <Section
        title="ArbZG — Compliance"
        sub="Arbeitszeitgesetz — Höchstarbeitszeit & Pausenpflicht"
      >
        <div class="settings-section">
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
          <p class="form-hint text-muted" style="margin-top: 1rem;">
            Hinweis: Die Einstellung „Pausen automatisch abziehen" (§ 4 ArbZG) ist nach System →
            Allgemein → Arbeitszeit umgezogen.
          </p>
        </div>
      </Section>
    {:else if currentTab === "erinnerungen"}
      <!-- ── Tab: Erinnerungen ──────────────────────────────────────────── -->
      <Section
        title="Benachrichtigungen"
        sub="Erinnerungen bei fehlenden oder offenen Zeiteinträgen"
      >
        <div class="settings-section">
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
      </Section>
    {:else if currentTab === "antraege"}
      <!-- ── Tab: Anträge & Krankheit ───────────────────────────────────── -->
      <Section
        title="Abwesenheiten & Sonderregelungen"
        sub="BUrlG · EFZG — Urlaubs- und Krankmeldungsregeln"
      >
        <div class="settings-section">
          <h3 class="section-inner-title">Heiligabend & Silvester</h3>
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
                  und Silvester ({newYearsEveRule === "HALF_DAY"
                    ? "halber Tag"
                    : "ganzer Tag frei"}) gelten ab {holidayRulesValidFromYear}. Für frühere Jahre
                  gelten beide als normaler Arbeitstag.
                {:else if christmasEveRule !== "NORMAL"}
                  Heiligabend ({christmasEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"})
                  gilt ab {holidayRulesValidFromYear}. Für frühere Jahre gilt der Tag als normaler
                  Arbeitstag.
                {:else}
                  Silvester ({newYearsEveRule === "HALF_DAY" ? "halber Tag" : "ganzer Tag frei"})
                  gilt ab {holidayRulesValidFromYear}. Für frühere Jahre gilt der Tag als normaler
                  Arbeitstag.
                {/if}
              </p>
            </div>
          </div>
        </div>

        <hr class="settings-divider" />

        <div class="settings-section">
          <h3 class="section-inner-title">Urlaubsanträge</h3>
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
          <h3 class="section-inner-title">Krankmeldungen</h3>
          <label class="form-label toggle-label">
            <input type="checkbox" bind:checked={sickSelfReport} />
            Mitarbeiter dürfen Krankmeldung selbst eintragen
          </label>
          <div class="inline-settings spaced-top-sm">
            <div class="form-group">
              <label class="form-label" for="sick-note-days">AU-Pflicht nach (Kalendertagen)</label>
              <input
                id="sick-note-days"
                type="number"
                min="0"
                max="3"
                bind:value={sickNoteRequiredAfterDays}
                class="form-input"
              />
              <p class="form-hint">
                § 5 Abs. 1 EFZG — „länger als drei Kalendertage". Standard: 3. 0 = ab dem ersten
                Tag. Gilt nur für die Nachweis-Dokumentation. Auf die Urlaubsgutschrift bei
                Krankheit im Urlaub (§ 9 BUrlG) hat dieser Wert keinen Einfluss — dort ist immer ein
                ärztliches Zeugnis erforderlich.
              </p>
            </div>
          </div>
        </div>

        <hr class="settings-divider" />

        <div class="settings-section">
          <h3 class="section-inner-title">Teilzeit-Urlaub</h3>
          <label class="form-label toggle-label">
            <input type="checkbox" bind:checked={autoCalcPartTimeVacation} />
            Automatische Pro-Rata-Berechnung (<span translate="no">BUrlG</span>)
          </label>
          {#if autoCalcPartTimeVacation}
            <div class="inline-settings spaced-top-sm">
              <div class="form-group">
                <label class="form-label" for="ft-days">Vollzeit-Arbeitstage/Woche</label>
                <select id="ft-days" bind:value={fullTimeWorkDaysPerWeek} class="form-input">
                  <option value={5}>5 Tage (Mo&ndash;Fr)</option>
                  <option value={6}>6 Tage (Mo&ndash;Sa)</option>
                </select>
              </div>
            </div>
          {/if}
        </div>

        <hr class="settings-divider" />

        <div class="settings-section">
          <h3 class="section-inner-title">
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

          <hr class="settings-divider spaced-top-sm" />

          <h4 class="carryover-subtitle">Hinweispflicht — Verfall-Warnungen</h4>
          <label class="form-label toggle-label">
            <input type="checkbox" bind:checked={carryoverWarningEnabled} />
            Hinweise automatisch versenden (täglich um 06:00)
          </label>
          <div class="inline-settings spaced-top-sm">
            <div class="form-group">
              <label class="form-label" for="carryover-thresholds">
                Schwellwerte (Tage vor Verfall)
              </label>
              <input
                id="carryover-thresholds"
                type="text"
                class="form-input"
                placeholder="60, 30, 14, 7"
                bind:value={carryoverWarningThresholdsText}
                disabled={!carryoverWarningEnabled}
              />
              <p class="form-hint">
                Komma-separierte Liste (Tage 1&ndash;365). Jede Schwelle löst genau einen Hinweis
                aus. Beispiel: <code>60, 30, 14, 7</code> warnt 60, 30, 14 und 7 Tage vor Verfall.
              </p>
            </div>
          </div>
        </div>

        <hr class="settings-divider" />

        <div class="settings-section">
          <h3 class="section-inner-title">Max. Minusstunden</h3>
          <label class="form-label toggle-label">
            <input type="checkbox" bind:checked={maxNegEnabled} />
            Limit für negatives Überstundensaldo
          </label>
          <p class="form-hint">
            Ohne aktivierten Wert gilt beim Überstundenausgleich-Antrag eine Toleranz von 0 Std. —
            der Antrag darf das bestätigte Guthaben nicht ins Minus ziehen.
          </p>
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
          <h3 class="section-inner-title">Automatische Erinnerungen</h3>
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
      </Section>
    {:else if currentTab === "sonderurlaub"}
      <!-- ── Tab: Sonderurlaub (merged from /admin/special-leave) ───────── -->
      <Section
        title="Sonderurlaubs-Regeln"
        sub="Gesetzliche Anlässe (§ 616 BGB) werden automatisch angelegt. Tage und Nachweispflicht können angepasst, zusätzliche betriebliche Anlässe hinzugefügt werden."
      >
        {#snippet footer()}
          <button class="btn btn-primary btn-sm" onclick={openSLCreate}>+ Neue Regel</button>
        {/snippet}

        {#if slLoading}
          <div class="vac-skeleton sl-skel"></div>
        {:else if slRules.length === 0}
          <p class="text-muted">Keine Regeln vorhanden.</p>
        {:else}
          <div class="sl-table-wrap">
            <table class="sl-table">
              <thead>
                <tr>
                  <th>Anlass</th>
                  <th>Tage</th>
                  <th>Nachweis</th>
                  <th>Art</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {#each slPagedRules as rule (rule.id)}
                  <tr
                    class:sl-inactive={!rule.isActive}
                    class="sl-row"
                    onclick={() => openSLEdit(rule)}
                  >
                    <td>
                      <strong>{rule.name}</strong>
                      {#if rule.reason}
                        <br /><span class="sl-text-sm text-muted">{rule.reason}</span>
                      {/if}
                    </td>
                    <td>{Number(rule.defaultDays)}</td>
                    <td>{rule.requiresProof ? "Ja" : "Nein"}</td>
                    <td>
                      <span
                        class="sl-badge"
                        class:sl-badge-statutory={rule.isStatutory}
                        class:sl-badge-custom={!rule.isStatutory}
                      >
                        {rule.isStatutory ? "Gesetzlich" : "Betrieblich"}
                      </span>
                    </td>
                    <td>
                      <span
                        class="sl-status-dot"
                        class:active={rule.isActive}
                        class:deactivated={!rule.isActive}
                      ></span>
                      {rule.isActive ? "Aktiv" : "Deaktiviert"}
                    </td>
                    <td class="sl-actions-cell">
                      <button
                        class="btn btn-ghost btn-sm"
                        onclick={(e) => {
                          e.stopPropagation();
                          openSLEdit(rule);
                        }}
                      >
                        Bearbeiten
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <Pagination total={slRules.length} bind:page={slPage} bind:pageSize={slPageSize} />
          </div>
        {/if}
      </Section>
    {/if}
  {/snippet}
</SectionStack>

<!-- ── Sticky save bar (applies to all settings tabs) ────────────────────── -->
<!-- Phase 109 (D-11): also shown on "Übersicht"/"Sonderurlaub" while something is unsaved —
     without this, an admin who edits on "Standards" and switches to "Übersicht" has an
     unsaved change with no marker anywhere and no way to save it, and then gets a navigation
     dialog with nothing on screen explaining it. Same defect class as WR-01, one tab away. -->
{#if !loading && !error && (globalDirty || (activeTab !== "sonderurlaub" && activeTab !== "uebersicht"))}
  <div class="vac-save-bar" role="region" aria-label="Globale Vorgaben speichern">
    {#if gError}
      <div class="alert alert-error" role="alert">
        <span>&#9888;</span><span>{gError}</span>
      </div>
    {/if}
    <div class="vac-save-row">
      <label class="form-label toggle-label vac-apply-existing">
        <input type="checkbox" bind:checked={gApplyToExisting} />
        Auch auf bestehende Mitarbeiter anwenden
      </label>
      <div class="vac-save-actions">
        {#if globalDirty}
          <span class="unsaved-hint" role="status">Nicht gespeichert</span>
        {/if}
        {#if gSaved}
          <span class="saved-hint">&#10003; Gespeichert</span>
        {/if}
        <button class="btn btn-primary" onclick={saveGlobal} disabled={gSaving}>
          {gSaving ? "Speichern…" : "Globale Vorgaben speichern"}
        </button>
      </div>
    </div>
    <p class="form-hint vac-save-hint">
      Erstellt neue Schedule-Versionen ab heute für alle MA mit festem Wochenmodell, wenn aktiviert.
      Minijobber und MA mit individuellen Einstellungen bleiben unverändert.
    </p>
  </div>
{/if}

<!-- ── Sonderurlaub: Create Modal ────────────────────────────────────────── -->
<Modal bind:open={slShowCreate} eyebrow="Neue Regel" title="Sonderurlaubsregel anlegen">
  <div class="form-group">
    <label class="form-label" for="sl-cr-name">Anlass</label>
    <input
      id="sl-cr-name"
      class="form-input"
      bind:value={slCreateName}
      placeholder="z. B. Ehrenamtlicher Einsatz"
    />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-cr-reason">Beschreibung</label>
    <input
      id="sl-cr-reason"
      class="form-input"
      bind:value={slCreateReason}
      placeholder="Optional"
    />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-cr-days">Tage</label>
    <input
      id="sl-cr-days"
      type="number"
      class="form-input"
      min="0.5"
      max="30"
      step="0.5"
      bind:value={slCreateDays}
    />
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Nachweis erforderlich</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slCreateProof} />
      <span class="switch-slider"></span>
    </label>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (slShowCreate = false)}>Abbrechen</button>
    <button
      class="btn btn-primary"
      onclick={saveSLCreate}
      disabled={slCreating || !slCreateName.trim()}
    >
      {slCreating ? "Erstellen…" : "Erstellen"}
    </button>
  {/snippet}
</Modal>

<!-- ── Sonderurlaub: Edit Modal ──────────────────────────────────────────── -->
<Modal
  bind:open={slShowEdit}
  eyebrow={slEditStatutory ? "Gesetzliche Regel" : "Betriebliche Regel"}
  title={slEditName || "Sonderurlaubsregel"}
>
  <div class="form-group">
    <label class="form-label" for="sl-ed-name">Anlass</label>
    <input id="sl-ed-name" class="form-input" bind:value={slEditName} disabled={slEditStatutory} />
    {#if slEditStatutory}
      <p class="form-hint">Name gesetzlicher Regeln kann nicht geändert werden.</p>
    {/if}
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-ed-reason">Beschreibung</label>
    <input id="sl-ed-reason" class="form-input" bind:value={slEditReason} />
  </div>
  <div class="form-group">
    <label class="form-label" for="sl-ed-days">Anzahl Tage</label>
    <input
      id="sl-ed-days"
      type="number"
      class="form-input"
      min="0.5"
      max="30"
      step="0.5"
      bind:value={slEditDays}
    />
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Nachweis erforderlich</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slEditProof} />
      <span class="switch-slider"></span>
    </label>
  </div>
  <div class="toggle-row">
    <span class="toggle-row-label">Aktiv</span>
    <label class="switch">
      <input type="checkbox" bind:checked={slEditActive} />
      <span class="switch-slider"></span>
    </label>
  </div>
  {#snippet footer()}
    <button class="btn btn-ghost" onclick={() => (slShowEdit = false)}>Abbrechen</button>
    <button class="btn btn-primary" onclick={saveSLEdit} disabled={slSaving}>
      {slSaving ? "Speichern…" : "Speichern"}
    </button>
  {/snippet}
</Modal>

<style>
  /* ── Übersicht KPI grid ────────────────────────────────────────────────── */
  .vac-kpi-grid {
    display: flex;
    align-items: flex-end;
    gap: 32px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  /* ── Per-MA callout pointer ─────────────────────────────────────────────── */
  .vac-callout {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 10px 16px;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .vac-callout a {
    color: var(--brand);
    font-weight: 600;
    text-decoration: underline;
  }

  /* ── Loading skeleton ───────────────────────────────────────────────────── */
  .vac-skeleton {
    height: 80px;
    background: var(--bg-subtle);
    border-radius: var(--r-md);
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  /* ── Carry-over warning sub-section ────────────────────────────────────── */
  .carryover-subtitle {
    margin: 12px 0 8px;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  /* ── Inner section headers (nested within a Section card) ───────────────── */
  .section-inner-title {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 12px;
  }

  /* ── Settings inner sections ────────────────────────────────────────────── */
  .settings-section {
    padding: 22px 24px;
  }

  .settings-divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0;
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

  /* ── Footer (save bar) ──────────────────────────────────────────────────── */
  .apply-existing-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .apply-existing-hint {
    margin: 0.25rem 0 0 1.5rem;
  }

  .saved-hint {
    color: var(--good);
    font-weight: 500;
    font-size: 0.9375rem;
  }

  .spaced-top-xs {
    margin-top: 8px;
  }

  .spaced-top-sm {
    margin-top: 12px;
  }

  @media (max-width: 720px) {
    .inline-settings {
      gap: 1.25rem;
    }

    .vac-kpi-grid {
      gap: 18px;
    }
  }

  /* ── Sonderurlaub table (in-tab list with edit modal) ───────────────────── */
  .sl-table-wrap {
    overflow-x: auto;
  }
  .sl-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .sl-table th {
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--border);
  }
  .sl-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .sl-row {
    cursor: pointer;
  }
  .sl-row:hover td {
    background: var(--bg-subtle);
  }
  .sl-inactive td {
    opacity: 0.5;
  }
  .sl-text-sm {
    font-size: 0.8125rem;
  }
  .sl-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .sl-badge-statutory {
    background: var(--bg-subtle);
    color: var(--text-muted);
  }
  .sl-badge-custom {
    background: var(--brand-soft);
    color: var(--brand);
  }
  .sl-status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.25rem;
    background: var(--text-faint);
  }
  .sl-status-dot.active {
    background: var(--good);
  }
  .sl-status-dot.deactivated {
    background: var(--text-faint);
  }
  .sl-actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .sl-skel {
    height: 200px;
    border-radius: var(--r-md);
  }

  /* ── Save bar (sticky bottom, visible across config tabs) ───────────────── */
  .vac-save-bar {
    position: sticky;
    bottom: 0;
    z-index: 5;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 16px 24px;
    margin-top: var(--s-4);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vac-save-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .vac-apply-existing {
    margin: 0;
  }
  .vac-save-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .vac-save-hint {
    margin: 0;
  }
</style>
