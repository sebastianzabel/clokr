<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
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
    { id: "antraege", label: "Anträge & Krankheit" },
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
    defaultVacationDays: number;
    defaultApprenticeVacationDays?: number | string;
    carryOverDeadlineDay: number;
    carryOverDeadlineMonth: number;
    federalState: string;
    // Optional extended fields returned by /settings/work
    availabilityEnabled?: boolean;
    autoBreakEnabled?: boolean;
    defaultBreakStart?: string;
    christmasEveRule?: string;
    holidayRulesValidFromYear?: number;
    newYearsEveRule?: string;
    vacationLeadTimeDays?: number;
    vacationMaxAdvanceMonths?: number;
    halfDayAllowed?: boolean;
    leavePlanDeadlineLocksWishes?: boolean;
    sickSelfReport?: boolean;
    sickNoteRequiredAfterDays?: number;
    autoCalcPartTimeVacation?: boolean;
    fullTimeWorkDaysPerWeek?: number;
    enforceMinVacation?: boolean;
    carryOverRequiresReason?: boolean;
    vacationReminderStartMonth?: number;
    carryoverWarningEnabled?: boolean;
    carryoverWarningThresholds?: number[];
  }

  let loading = $state(true);
  let error = $state("");

  // Global
  let gVacationDays = $state(30);
  // Issue #482: the Azubi-Standard — a calculation input for apprentices without an own value
  // (resolveVacationBaseDays()), also the create-dialog pre-fill suggestion (#435 D-03).
  let gApprenticeVacationDays = $state(20);
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
  // Phase 49.4: Verfügbarkeits-System toggle moved to /admin/system (Features card).
  // Issue #854 (plan 854-07): the working-time defaults (hours per weekday, overtime threshold and payout,
  // the bulk apply to existing contracts), the ArbZG check, the open-entries limit and the negative-balance
  // limit moved to Regeln › Arbeitszeit & Verträge.

  // Abwesenheits-Konfiguration
  let christmasEveRule = $state("NORMAL");
  let newYearsEveRule = $state("NORMAL");
  let holidayRulesValidFromYear = $state(new Date().getFullYear());
  let vacationLeadTimeDays = $state(0);
  let vacationMaxAdvanceMonths = $state(0);
  let halfDayAllowed = $state(true);
  let leavePlanDeadlineLocksWishes = $state(false);
  let sickSelfReport = $state(true);
  /**
   * Mirrors normalizeKarenzDays() in apps/api/src/contexts/absence/find-karenz-overrun-days.ts:
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
  // Erinnerungen: the clock-out, missing-entries, pending-leave and upcoming-absence reminders moved to
  // Regeln › Benachrichtigungen & E-Mail, the shift reminders to Regeln › Dienstplan › Einstellungen (Issue #854).
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
      gCarryOverDay,
      gCarryOverMonth,
      gVacationDays,
      gApprenticeVacationDays,
      christmasEveRule,
      newYearsEveRule,
      holidayRulesValidFromYear,
      vacationLeadTimeDays,
      vacationMaxAdvanceMonths,
      halfDayAllowed,
      leavePlanDeadlineLocksWishes,
      sickSelfReport,
      sickNoteRequiredAfterDays,
      autoCalcPartTimeVacation,
      fullTimeWorkDaysPerWeek,
      enforceMinVacation,
      carryOverRequiresReason,
      vacationReminderStartMonth,
      carryoverWarningEnabled,
      carryoverWarningThresholdsText,
    ) !== globalSnapshot,
  );

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
      gVacationDays = Number(cfg.defaultVacationDays) || 30;
      gApprenticeVacationDays = Number(cfg.defaultApprenticeVacationDays) || 20;
      gCarryOverDay = cfg.carryOverDeadlineDay ?? 31;
      gCarryOverMonth = cfg.carryOverDeadlineMonth ?? 3;
      // v1.6.5: autoBreakEnabled + defaultBreakStart are managed on /admin/system → Arbeitszeit.

      // Leave/overtime config
      christmasEveRule = cfg.christmasEveRule ?? "NORMAL";
      holidayRulesValidFromYear = cfg.holidayRulesValidFromYear ?? 2026;
      newYearsEveRule = cfg.newYearsEveRule ?? "NORMAL";
      vacationLeadTimeDays = cfg.vacationLeadTimeDays ?? 0;
      vacationMaxAdvanceMonths = cfg.vacationMaxAdvanceMonths ?? 0;
      halfDayAllowed = cfg.halfDayAllowed ?? true;
      leavePlanDeadlineLocksWishes = cfg.leavePlanDeadlineLocksWishes ?? false;
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
      enforceMinVacation = cfg.enforceMinVacation ?? true;
      carryOverRequiresReason = cfg.carryOverRequiresReason ?? true;
      vacationReminderStartMonth = cfg.vacationReminderStartMonth ?? 10;
      carryoverWarningEnabled = cfg.carryoverWarningEnabled ?? true;
      const thresholds = cfg.carryoverWarningThresholds ?? [60, 30, 14, 7];
      carryoverWarningThresholdsText = thresholds.join(", ");
      globalSnapshot = snap(
        gCarryOverDay,
        gCarryOverMonth,
        gVacationDays,
        gApprenticeVacationDays,
        christmasEveRule,
        newYearsEveRule,
        holidayRulesValidFromYear,
        vacationLeadTimeDays,
        vacationMaxAdvanceMonths,
        halfDayAllowed,
        leavePlanDeadlineLocksWishes,
        sickSelfReport,
        sickNoteRequiredAfterDays,
        autoCalcPartTimeVacation,
        fullTimeWorkDaysPerWeek,
        enforceMinVacation,
        carryOverRequiresReason,
        vacationReminderStartMonth,
        carryoverWarningEnabled,
        carryoverWarningThresholdsText,
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
        carryOverDeadlineDay: gCarryOverDay,
        carryOverDeadlineMonth: gCarryOverMonth,
        defaultVacationDays: gVacationDays,
        defaultApprenticeVacationDays: gApprenticeVacationDays,
        // v1.6.5: autoBreakEnabled + defaultBreakStart are owned by Regeln › Arbeitszeit & Verträge
        // (as are the default hours, the overtime threshold, arbzgEnabled, autoDeleteOpenHours and the
        // bulk apply since Issue #854) and intentionally not sent from this page to avoid clobbering.
        christmasEveRule,
        newYearsEveRule,
        holidayRulesValidFromYear,
        vacationLeadTimeDays,
        vacationMaxAdvanceMonths,
        halfDayAllowed,
        leavePlanDeadlineLocksWishes,
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
      });
      // availabilityEnabled lives on Regeln › Dienstplan › Einstellungen (Issue #854).
      gSaved = true;
      globalSnapshot = snap(
        gCarryOverDay,
        gCarryOverMonth,
        gVacationDays,
        gApprenticeVacationDays,
        christmasEveRule,
        newYearsEveRule,
        holidayRulesValidFromYear,
        vacationLeadTimeDays,
        vacationMaxAdvanceMonths,
        halfDayAllowed,
        leavePlanDeadlineLocksWishes,
        sickSelfReport,
        sickNoteRequiredAfterDays,
        autoCalcPartTimeVacation,
        fullTimeWorkDaysPerWeek,
        enforceMinVacation,
        carryOverRequiresReason,
        vacationReminderStartMonth,
        carryoverWarningEnabled,
        carryoverWarningThresholdsText,
      ); // Phase 109 — section is clean again
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
  <title>{pageLabel("/admin/vacation")} – Clokr</title>
</svelte:head>

<SectionStack
  eyebrow="Verwalten"
  title={pageLabel("/admin/vacation")}
  sub="Einstellungen, Sonderurlaubsregeln und Übersicht für das ganze Unternehmen"
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
      <Section title="Übersicht" sub="Eckdaten für das ganze Unternehmen auf einen Blick">
        <div class="vac-kpi-grid">
          <KPIStat label="Jahresurlaub (Standard)" value={String(gVacationDays)} unit="T" />
          <KPIStat label="Resturlaub verfällt am" value={kpiCarryOverLabel} />
        </div>
        <div class="vac-callout">
          <strong>Für einzelne Personen:</strong> Individuelle Urlaubs- und Arbeitszeiteinstellungen
          verwaltest du auf der
          <a href="/admin/employees">Detailseite der Person</a>.
        </div>
      </Section>
    {:else if currentTab === "standards"}
      <!-- ── Tab: Standards (Arbeitszeit + Urlaubsanspruch) ─────────────── -->
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

            <!-- Issue #482: the Azubi-Standard (calculation input + create-dialog pre-fill) -->
            <div class="form-group">
              <label class="form-label" for="g-apprentice-vac-days"
                >Urlaubstage Azubis (Basis 5-Tage-Woche)</label
              >
              <div class="input-suffix-wrap">
                <input
                  id="g-apprentice-vac-days"
                  type="number"
                  min="20"
                  max="365"
                  step="0.5"
                  bind:value={gApprenticeVacationDays}
                  class="form-input threshold-input"
                />
                <span class="input-suffix">Tage</span>
              </div>
              <p class="form-hint">
                Gilt für Auszubildende ohne eigenen Wert unter „Urlaubstage pro Jahr“ und wird beim
                Anlegen vorgeschlagen. Wirkt auf künftig angelegte Urlaubsjahre; bestehende
                Ansprüche bleiben unverändert. Mindestens 20 Tage (§ 3 BUrlG); Jugendliche erhalten
                automatisch den höheren Mindesturlaub nach § 19 JArbSchG.
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
          <label class="form-label toggle-label spaced-top-sm">
            <input type="checkbox" bind:checked={leavePlanDeadlineLocksWishes} />
            Frist sperrt eigene Änderungen
          </label>
          <p class="form-hint">
            Ist eine Planungsfrist gesetzt, können Mitarbeitende ihre eigenen Wünsche danach nicht
            mehr ändern. Planungsberechtigte können weiter ändern.
          </p>
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
                Ab diesem Monat werden Mitarbeitende an verfallenden Urlaub erinnert (Hinweispflicht
                EuGH C-684/16).
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
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: 10px 16px;
    font-size: 0.875rem;
    color: var(--text-2);
  }

  .vac-callout a {
    color: var(--brand);
    font-weight: 600;
    text-decoration: underline;
  }

  /* ── Loading skeleton ───────────────────────────────────────────────────── */
  .vac-skeleton {
    height: 80px;
    background: var(--sunk);
    border-radius: var(--r-control);
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
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 12px;
  }

  /* ── Settings inner sections ────────────────────────────────────────────── */
  .settings-section {
    padding: 22px 24px;
  }

  .settings-divider {
    border: none;
    border-top: 1px solid var(--line);
    margin: 0;
  }

  .inline-settings {
    display: flex;
    gap: 2.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }

  /* ── Day input grid ─────────────────────────────────────────────────────── */

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
    color: var(--text-2);
    white-space: nowrap;
  }

  .form-hint {
    font-size: 0.8125rem;
    color: var(--text-2);
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
    background-color: var(--line-2);
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
    background-color: var(--card);
    border-radius: 50%;
    transition: transform 0.2s var(--ease-out);
    box-shadow: var(--shadow);
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

  .saved-hint {
    color: var(--ok);
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
    color: var(--text-2);
    border-bottom: 2px solid var(--line);
  }
  .sl-table td {
    padding: 0.75rem;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .sl-row {
    cursor: pointer;
  }
  .sl-row:hover td {
    background: var(--sunk);
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
    background: var(--sunk);
    color: var(--text-2);
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
    background: var(--text-3);
  }
  .sl-status-dot.active {
    background: var(--ok);
  }
  .sl-status-dot.deactivated {
    background: var(--text-3);
  }
  .sl-actions-cell {
    text-align: right;
    white-space: nowrap;
  }
  .sl-skel {
    height: 200px;
    border-radius: var(--r-control);
  }

  /* ── Save bar (sticky bottom, visible across config tabs) ───────────────── */
  .vac-save-bar {
    position: sticky;
    bottom: 0;
    z-index: 5;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 16px 24px;
    margin-top: var(--s-4);
    box-shadow: var(--shadow);
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
  .vac-save-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
</style>
