<!--
  VertragTab - the contract half of the „Vertrag“ tab of the employee detail (Issue #854, plan 854-21):

    Arbeitszeitmodell                the work schedule: model, hours, overtime rules and „Gültig ab“
    Vertragsverlauf                  every contract version as a timeline (GET /settings/work/:id/history)
    Übliche Arbeitstage nachtragen   the Nachtrag of the SHIFT_BASED Angabe on stored rows (#481)

  Owner review (#854): the layout follows the prototype - „Arbeitszeitmodell“ as segments, the hours as a
  seven-column day grid with a tinted sum row, „Gültig ab“ next to the warning threshold, the history as
  quiet rows (Gültig / Geplant, and the unsaved change as „Entwurf“) and the SaveBar at the end.

  A contract CHANGE starts on the first of a month (`MONTH_FIRST_ERROR`): „Gültig ab“ is a choice of
  months (month-firsts only) that defaults to the next month-first, so the change succeeds on the first
  try and no other day can be picked (AC-5). The group has ONE SaveBar and one PUT; value and effective day are
  one decision (N-04). The server stays the authority for every refusal and its text is shown as it comes
  (`MONTH_FIRST_ERROR`, `WEEKLY_HOURS_MISMATCH` #848, the usualWorkDays rule #481); the 409 with pending
  shifts opens a dialog (the choice follows the `shift:plan` right, the preview is redacted by the API).
  The Minijob hint is advisory (D-854-08) and never blocks. The per-person overrides of the former
  Arbeitszeit tab (Pausendauer, Phorest, Berufsschule) are the `children` the page renders below.

  The baseline is read once on purpose: the snapshot is the group's own afterwards, and a reload of the
  `schedule` prop must not discard what was typed.

  Props:
    employeeId        the person
    schedule          the stored work schedule, or null when it could not be read
    employee          the SAVED record (classification feeds the Minijob hint)
    canEdit           contract:update (fields read-only without it; the API enforces it)
    canDiscardShifts  shift:plan (the „Stornieren“ choice of the pending-shift dialog)
    changes           bindable, the number of unsaved changes (the page sums it into markUnsaved)
    onSaved           called with the saved schedule
    today             the calendar day the default „Gültig ab“ counts from (default: the local day)
    children          the override groups rendered after the contract groups (same column, same gap)
-->
<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Chip from "$components/ui/Chip.svelte";
  import DayGrid from "$components/ui/DayGrid.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import OvertimeModeField from "$lib/components/schedule/OvertimeModeField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import { monthFirstOptions, nextMonthFirst } from "$lib/employees/contract-start";
  import {
    MODEL_LABELS,
    contractExtent,
    contractHistoryRows,
    contractStatus,
    type ContractHistoryInput,
  } from "$lib/employees/contract-history";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import { minijobHint, minijobHintText } from "$lib/employees/minijob";
  import {
    CONTRACT_KEYS,
    SCHEDULE_TYPES,
    SCHEDULE_TYPE_HELP,
    buildSchedulePayload,
    contractErrors,
    contractValuesOf,
    germanDay,
    plannedWeeklyHours,
    type ContractSchedule,
    type ContractValues,
    type PendingShiftChoice,
    type ScheduleType,
  } from "$lib/employees/vertrag-form";
  import { countChanges, sectionErrors } from "$lib/settings/section-state";
  import {
    buildUsualWorkDaysBackfillPayload,
    shiftContractsMissingUsualWorkDays,
    usualWorkDaysShortfall,
    type ContractHistoryRow,
  } from "$lib/utils/work-schedule";

  interface Props {
    employeeId: string;
    schedule: ContractSchedule | null;
    employee: { classification?: string | null };
    canEdit: boolean;
    canDiscardShifts: boolean;
    changes?: number;
    onSaved?: (schedule: ContractSchedule) => void;
    today?: string;
    /** The hire day (stored instant or ISO day): the oldest month „Gültig ab“ offers. */
    hireDate?: string | null;
    /** The per-person override groups the page renders below the contract (plan 854-22). */
    children?: Snippet;
  }

  // `changes` is write-only here: the page reads it through `bind:changes`.
  let {
    employeeId,
    schedule,
    employee,
    canEdit,
    canDiscardShifts,
    // eslint-disable-next-line no-useless-assignment
    changes = $bindable(),
    onSaved,
    today: todayProp,
    hireDate,
    children,
  }: Props = $props();

  const todayIso = untrack(() => todayProp ?? localCalendarDay());
  const defaultValidFrom = nextMonthFirst(todayIso);

  let snapshot = $state<ContractValues>(
    untrack(() => $state.snapshot(contractValuesOf(schedule, defaultValidFrom)) as ContractValues),
  );
  let values = $state<ContractValues>(
    untrack(() => $state.snapshot(contractValuesOf(schedule, defaultValidFrom)) as ContractValues),
  );
  let saving = $state(false);
  // The server's refusal of the last save, shown as its text until the next attempt.
  let saveError = $state("");

  const changeCount = $derived(countChanges(snapshot, values, CONTRACT_KEYS));
  $effect(() => {
    changes = changeCount;
  });

  const liveErrors = $derived(contractErrors(values));
  // An invalid value can only exist after an edit, so the messages show once the group has one.
  const shown = $derived(changeCount > 0 ? liveErrors : {});

  const type = $derived(values.type);
  // „Gültig ab“ is a choice of months (owner review #854): only month-firsts can be picked, from the
  // first month-first after the hire day to two years ahead; the stored snapshot value is always offered.
  const validFromOptions = $derived(
    monthFirstOptions({ today: todayIso, earliest: hireDate, include: snapshot.validFrom }),
  );

  const minijob = $derived(
    minijobHint({
      classification: employee.classification ?? "",
      scheduleType: values.type,
      weeklyHours: plannedWeeklyHours(values),
      monthlyHours: values.monthlyHours,
      validFrom: values.validFrom,
    }),
  );

  function snapshotOfValues(): ContractValues {
    return $state.snapshot(values) as ContractValues;
  }

  function discard() {
    values = $state.snapshot(snapshot) as ContractValues;
    saveError = "";
  }

  function onTypeChange(next: string) {
    values.type = next as ScheduleType;
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  interface OrphanShiftPreview {
    date: string;
    startTime: string;
    endTime: string;
  }

  let orphanOpen = $state(false);
  let orphanPendingCount = $state(0);
  let orphanPreview = $state<OrphanShiftPreview[]>([]);

  const orphanTypeLabel = $derived(
    SCHEDULE_TYPES.find((option) => option.value === values.type)?.label ?? values.type,
  );

  async function save(choice?: PendingShiftChoice) {
    if (Object.values(liveErrors).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    saveError = "";
    try {
      const saved = await api.put<ContractSchedule>(
        `/settings/work/${employeeId}`,
        buildSchedulePayload(values, choice),
      );
      snapshot = snapshotOfValues();
      toasts.success(`Vertrag gespeichert · gilt ab ${germanDay(values.validFrom)}`);
      void loadHistory();
      onSaved?.(saved);
    } catch (err) {
      const e = err as { status?: number; data?: { code?: string } };
      if (e?.status === 409 && e?.data?.code === "ORPHAN_SHIFTS_PENDING") {
        const data = (
          err as { data?: { pendingShifts?: number; shiftPreview?: OrphanShiftPreview[] } }
        ).data;
        orphanPendingCount = data?.pendingShifts ?? 0;
        orphanPreview = data?.shiftPreview ?? [];
        orphanOpen = true;
      } else {
        saveError = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
      }
    } finally {
      saving = false;
    }
  }

  async function orphanKeep() {
    orphanOpen = false;
    await save({ keepOrphanShifts: true });
  }

  async function orphanCancel() {
    orphanOpen = false;
    await save({ cancelOrphanShifts: true });
  }

  /** Back out of the switch: the model returns to the one the pending shifts belong to. */
  function orphanAbort() {
    orphanOpen = false;
    values.type = "SHIFT_BASED";
  }

  // ── History ──────────────────────────────────────────────────────────────────

  let history = $state<ContractHistoryInput[]>([]);
  const timeline = $derived(
    contractHistoryRows(history).map((row) => {
      const status = contractStatus(row, todayIso);
      return {
        row,
        status,
        // The running version reads „seit …“, every other one „ab …“; an end day „bis …“.
        when: `${status === "CURRENT" ? "seit" : "ab"} ${germanDay(row.startDay)}`,
        until: row.endDay ? `bis ${germanDay(row.endDay)}` : null,
      };
    }),
  );

  // The unsaved contract as the top row of the history (prototype „Entwurf“): what a save would add.
  const draft = $derived(
    canEdit && changeCount > 0
      ? {
          when: values.validFrom ? `ab ${germanDay(values.validFrom)}` : "ab –",
          model: MODEL_LABELS[values.type] ?? values.type,
          extent: contractExtent({
            type: values.type,
            weeklyHours: plannedWeeklyHours(values),
            monthlyHours: values.monthlyHours,
            contractWorkDaysPerWeek: values.contractWorkDays,
          }),
        }
      : null,
  );

  async function loadHistory() {
    try {
      history = await api.get<ContractHistoryInput[]>(`/settings/work/${employeeId}/history`);
    } catch {
      // Without contract:read (or on any error) the sections simply stay hidden.
      history = [];
    }
  }

  onMount(() => {
    void loadHistory();
  });

  // ── Nachtrag of the übliche Arbeitstage (Issue #481 R6/R7) ───────────────────

  let backfillSelection = $state<Record<string, number[]>>({});
  let backfillSaving = $state(false);
  let backfillError = $state("");

  const missingUsual = $derived(shiftContractsMissingUsualWorkDays(history));
  // The SaveBar counts the rows the person ticked something for; a short row is an error of it.
  const backfillChanges = $derived(
    missingUsual.filter((row) => (backfillSelection[row.id]?.length ?? 0) > 0).length,
  );
  const backfillErrors = $derived(
    missingUsual.filter(
      (row) =>
        usualWorkDaysShortfall(
          backfillSelection[row.id] ?? [],
          row.contractWorkDaysPerWeek ?? null,
        ) > 0,
    ).length,
  );

  function contractValidFromLabel(row: ContractHistoryRow): string {
    return germanDay(String(row.validFrom).slice(0, 10));
  }

  function shortfallMessage(row: ContractHistoryRow): string | undefined {
    return usualWorkDaysShortfall(
      backfillSelection[row.id] ?? [],
      row.contractWorkDaysPerWeek ?? null,
    ) > 0
      ? `Bitte kreuze mindestens ${row.contractWorkDaysPerWeek} Tage an – so viele Arbeitstage hat der Vertrag.`
      : undefined;
  }

  async function saveUsualWorkDaysBackfill() {
    backfillSaving = true;
    backfillError = "";
    const errors: string[] = [];
    let saved = 0;
    let currentRowFilled: number[] | null = null;
    for (const row of missingUsual) {
      const selection = backfillSelection[row.id] ?? [];
      if (selection.length === 0) continue;
      try {
        const updated = await api.patch<ContractHistoryRow>(
          `/settings/work/${employeeId}/usual-work-days`,
          buildUsualWorkDaysBackfillPayload(row.id, selection),
        );
        saved++;
        if (row.id === schedule?.id) currentRowFilled = updated.usualWorkDays ?? selection;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
        errors.push(`Vertrag gültig ab ${contractValidFromLabel(row)}: ${message}`);
      }
    }
    await loadHistory();
    backfillSelection = {};
    // Keep the contract form in step when the current row was filled - only while it holds no unsaved
    // edits of its own, so nothing the person typed is overwritten.
    if (currentRowFilled && changeCount === 0) {
      values.usualWorkDays = [...currentRowFilled];
      snapshot = snapshotOfValues();
    }
    backfillError = errors.join(" ");
    if (saved > 0) toasts.success("Übliche Arbeitstage gespeichert.");
    backfillSaving = false;
  }

  function discardBackfill() {
    backfillSelection = {};
    backfillError = "";
  }

  function setBackfill(rowId: string, days: number[]) {
    backfillSelection = { ...backfillSelection, [rowId]: days };
  }

  /** The preview day of a pending shift: an ISO day reads German, anything else as it came. */
  function previewDay(date: string): string {
    return germanDay(date.slice(0, 10));
  }
</script>

<div class="vertrag-tab detail-form">
  <section class="settings-group vt-section" id="vertrag-aktuell" aria-labelledby="vt-model-title">
    <h2 class="settings-group-title" id="vt-model-title">Arbeitszeitmodell</h2>

    {#if saveError}
      <div role="alert" data-testid="vertrag-save-error">
        <Note tone="bad">{saveError}</Note>
      </div>
    {/if}

    <div class="vt-model">
      <div class="vt-model-scroll">
        <SegmentedControl
          name="vertrag-model"
          ariaLabel="Arbeitszeitmodell"
          options={SCHEDULE_TYPES.map((option) => ({ value: option.value, label: option.label }))}
          value={values.type}
          onchange={onTypeChange}
          disabled={!canEdit}
        />
      </div>
      <p class="vt-help">{SCHEDULE_TYPE_HELP[type]}</p>
    </div>

    {#if type === "FIXED_SCHEDULE"}
      <DayGrid
        bind:value={values.days}
        label="Wochenstunden je Tag"
        step={0.5}
        disabled={!canEdit}
        sumTestId="vertrag-workdays-derived"
      />
    {:else if type === "FLEXTIME"}
      <div class="vt-pair">
        <FormField
          label="Wochenstunden-Soll"
          help="Stunden pro Woche, frei auf die Arbeitstage verteilt."
          error={shown.weeklyHours}
        >
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="0"
              max="60"
              step="0.25"
              bind:value={values.weeklyHours}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>
      <WeekdayPicker
        bind:value={values.workDays}
        legend="Arbeitstage"
        help="Die vertraglich festgelegten Arbeitstage steuern Urlaubsverbrauch und Soll-Verteilung."
        disabled={!canEdit}
        testidPrefix="vertrag-workday"
      />
      <div class="vt-pair">
        <FormField label="Kernzeitbeginn (optional)">
          {#snippet field({ id, describedBy })}
            <input
              {id}
              class="form-input"
              type="time"
              bind:value={values.coreStart}
              disabled={!canEdit}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <FormField label="Kernzeitende (optional)">
          {#snippet field({ id, describedBy })}
            <input
              {id}
              class="form-input"
              type="time"
              bind:value={values.coreEnd}
              disabled={!canEdit}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>
      <WeekdayPicker
        bind:value={values.coreDays}
        legend="Kerntage (optional)"
        help="Nur zur Information – wirkt sich weder auf das Soll noch auf den Urlaub aus. Leer lassen für reine Gleitzeit ohne Kernzeit."
        disabled={!canEdit}
        testidPrefix="vertrag-core-day"
      />
    {:else if type === "MONTHLY_HOURS"}
      <div class="vt-pair">
        <FormField
          label="Stunden pro Monat"
          help="Das Soll wird monatlich berechnet, es gibt keine Tagesziele. Leer oder 0: die Zeiten werden nur erfasst."
          error={shown.monthlyHours}
        >
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="0"
              max="999"
              step="0.5"
              bind:value={values.monthlyHours}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <OvertimeModeField
          type={values.type}
          monthlyHours={values.monthlyHours}
          value={values.overtimeMode}
          onchange={(mode) => (values.overtimeMode = mode)}
          disabled={!canEdit}
        />
      </div>
      <WeekdayPicker
        bind:value={values.monthlyWorkDays}
        legend="Arbeitstage"
        help="Die vertraglich festgelegten Arbeitstage steuern Urlaubsverbrauch und Urlaubsanspruch."
        disabled={!canEdit}
        testidPrefix="vertrag-workday"
      />
    {:else}
      <div class="vt-pair">
        <FormField
          label="Wochenstunden-Soll"
          help="Der Schichtplan ist führend; das Soll wird wöchentlich als Gesamtstunden erfasst."
          required
          error={shown.weeklyHours}
        >
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="1"
              max="60"
              step="0.5"
              bind:value={values.weeklyHours}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
        <FormField
          label="Arbeitstage pro Woche"
          help="Vertragliche Anzahl Arbeitstage pro Woche. Welche Wochentage das konkret sind, bestimmt der Schichtplan – nicht dieses Feld."
          error={shown.contractWorkDays}
        >
          {#snippet field({ id, describedBy, invalid })}
            <input
              {id}
              class="form-input"
              type="number"
              min="1"
              max="7"
              step="1"
              bind:value={values.contractWorkDays}
              disabled={!canEdit}
              aria-invalid={invalid ? "true" : undefined}
              aria-describedby={describedBy}
            />
          {/snippet}
        </FormField>
      </div>
      <WeekdayPicker
        bind:value={values.usualWorkDays}
        legend="Übliche Arbeitstage (Pflicht)"
        help="Pflicht bei Schichtbetrieb: mindestens so viele Tage wie Arbeitstage pro Woche. In angebrochenen Urlaubswochen zählen nur Urlaubstage an diesen Wochentagen; eine volle Urlaubswoche kostet immer die vertraglichen Arbeitstage."
        error={shown.usualWorkDays}
        disabled={!canEdit}
        testidPrefix="vertrag-usual-workday"
      />
    {/if}

    <div class="vt-pair">
      <FormField
        label="Gültig ab"
        required
        help="Vertragswechsel gelten ab dem Monatsersten."
        error={shown.validFrom}
      >
        {#snippet field({ id, describedBy, invalid })}
          <select
            {id}
            class="form-input"
            bind:value={values.validFrom}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          >
            {#each validFromOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
      <FormField
        label="Überstunden-Warnschwelle"
        help="Stunden, ab denen das Überstundenkonto eine Warnung zeigt."
        error={shown.overtimeThreshold}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="0"
            max="500"
            bind:value={values.overtimeThreshold}
            disabled={!canEdit}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    <ToggleField
      bind:checked={values.allowOvertimePayout}
      label="Überstunden-Auszahlung erlaubt"
      help="Gesperrt: Überstunden können nur als Freizeit ausgeglichen werden."
      disabled={!canEdit}
    />

    {#if minijob}
      <Note tone="warn">{minijobHintText(minijob, "save")}</Note>
    {/if}
  </section>

  {#if timeline.length > 0 || draft}
    <section class="settings-group vt-section" aria-labelledby="vt-history-title">
      <h2 class="settings-group-title" id="vt-history-title">Vertragsverlauf</h2>
      <ul class="vt-history" data-testid="contract-history" aria-label="Vertragsverlauf">
        {#if draft}
          <li class="vt-history-row vt-history-row--draft" data-testid="contract-history-draft">
            <span class="vt-history-when">{draft.when}</span>
            <span class="vt-history-what"><strong>{draft.model}</strong> · {draft.extent}</span>
            <Chip tone="brand">Entwurf</Chip>
          </li>
        {/if}
        {#each timeline as item (item.row.id)}
          <li class="vt-history-row">
            <span class="vt-history-when">{item.when}</span>
            <span class="vt-history-what">
              <strong>{item.row.model}</strong> · {item.row.extent}{#if item.until}<span
                  class="vt-history-until"
                >
                  · {item.until}</span
                >{/if}
            </span>
            {#if item.status === "CURRENT"}
              <Chip tone="ok">Gültig</Chip>
            {:else if item.status === "PLANNED"}
              <Chip tone="info">Geplant</Chip>
            {:else}
              <span aria-hidden="true"></span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <!-- The contract's SaveBar closes the tab's contract part, after the history (prototype): the draft
       row above shows what the save would add. -->
  {#if canEdit && changeCount > 0}
    <div class="vt-savebar">
      <SaveBar
        changes={changeCount}
        errors={sectionErrors(shown)}
        {saving}
        saveLabel="Vertrag speichern"
        onSave={() => save()}
        onDiscard={discard}
      />
    </div>
  {/if}

  {#if missingUsual.length > 0}
    <SettingsGroup
      id="vertrag-nachtrag"
      title="Übliche Arbeitstage nachtragen"
      description="Schichtbetrieb-Verträge ohne Angabe"
      changes={canEdit ? backfillChanges : 0}
      errors={backfillErrors}
      saving={backfillSaving}
      saveLabel="Übliche Arbeitstage speichern"
      onSave={saveUsualWorkDaysBackfill}
      onDiscard={discardBackfill}
    >
      <Note tone="info">
        Für diese Verträge fehlen die üblichen Arbeitstage. Ohne Angabe zählt in angebrochenen
        Urlaubswochen jeder beantragte Tag von Montag bis Samstag als Urlaubstag. Die Angabe wird im
        bestehenden Vertragsdatensatz gespeichert – es entsteht kein neuer Vertrag. Bereits
        genehmigte Anträge werden dadurch nicht automatisch neu berechnet.
      </Note>
      {#if backfillError}
        <div role="alert">
          <Note tone="bad">{backfillError}</Note>
        </div>
      {/if}
      {#each missingUsual as row (row.id)}
        <WeekdayPicker
          bind:value={() => backfillSelection[row.id] ?? [], (days) => setBackfill(row.id, days)}
          legend={`Vertrag gültig ab ${contractValidFromLabel(row)} · ${row.contractWorkDaysPerWeek ?? "–"} Tage/Woche`}
          error={shortfallMessage(row)}
          disabled={!canEdit}
          testidPrefix={`nachtrag-${row.id}`}
        />
      {/each}
    </SettingsGroup>
  {/if}

  {@render children?.()}
</div>

<Dialog
  bind:open={orphanOpen}
  title="Geplante Schichten vorhanden"
  onOpenChange={(open) => {
    if (!open) orphanAbort();
  }}
>
  <p>
    Beim Wechsel auf <strong>{orphanTypeLabel}</strong>
    {orphanPendingCount === 1
      ? "ist 1 geplante Schicht"
      : `sind ${orphanPendingCount} geplante Schichten`}
    noch in der Datenbank.
  </p>
  {#if orphanPreview.length > 0}
    <ul class="vt-orphan-list" aria-label="Geplante Schichten">
      {#each orphanPreview as shift (shift.date)}
        <li>
          <span class="vt-orphan-date">{previewDay(shift.date)}</span>
          <span>{shift.startTime} – {shift.endTime}</span>
        </li>
      {/each}
      {#if orphanPendingCount > orphanPreview.length}
        <li class="vt-orphan-more">… und {orphanPendingCount - orphanPreview.length} weitere</li>
      {/if}
    </ul>
  {/if}
  <p class="vt-orphan-question">Was soll mit den zukünftigen Schichten passieren?</p>
  {#if !canDiscardShifts}
    <Note tone="info">
      Zum Verwerfen von Schichten ist das Recht zur Schichtplanung erforderlich. Bitte die
      Schichtplanung darum, die Schichten zu verwerfen, oder wähle „Behalten“.
    </Note>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={orphanAbort} disabled={saving}>
      Abbrechen
    </button>
    <button type="button" class="btn btn-secondary" onclick={orphanKeep} disabled={saving}>
      Behalten
    </button>
    {#if canDiscardShifts}
      <button type="button" class="btn btn-danger" onclick={orphanCancel} disabled={saving}>
        Stornieren
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* The SaveBar sits right under the history, without a hairline of its own. */
  .vertrag-tab > .vt-savebar:not(:first-child) {
    margin-top: var(--s-4);
    padding-top: 0;
    border-top: 0;
  }

  /* The wrapper (not the bar inside it) sticks to the bottom of the view while the tab is in it. */
  .vt-savebar {
    position: sticky;
    bottom: 0;
    z-index: 1;
  }

  .vt-model {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }

  /* Four labelled segments are wider than a phone: scroll inside the field instead of the page. */
  .vt-model-scroll {
    max-width: 100%;
    overflow-x: auto;
  }

  .vt-help {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  /* Two fields side by side (prototype form row), one column on a phone. */
  .vt-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--s-4);
  }

  @container (min-width: 520px) {
    .vt-pair {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  /* Quiet history rows: start day, model and extent, status chip. */
  .vt-history {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .vt-history-row {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2) 0;
    border-top: 1px solid var(--line);
    font-size: var(--fs-base);
  }

  .vt-history-row:first-child {
    border-top: 0;
  }

  .vt-history-when {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .vt-history-what {
    min-width: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .vt-history-until {
    color: var(--text-2);
  }

  .vt-orphan-list {
    list-style: none;
    margin: var(--s-3) 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    overflow: hidden;
  }

  .vt-orphan-list li {
    display: flex;
    gap: var(--s-4);
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-sm);
  }

  .vt-orphan-list li:last-child {
    border-bottom: 0;
  }

  .vt-orphan-date {
    font-weight: 600;
  }

  .vt-orphan-more {
    color: var(--text-2);
  }

  .vt-orphan-question {
    font-weight: 600;
  }
</style>
