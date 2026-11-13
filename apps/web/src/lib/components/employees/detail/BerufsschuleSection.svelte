<!--
  BerufsschuleSection - the Berufsschule overrides of the „Vertrag“ tab of the employee detail (Issue
  #854, plan 854-22), shown for an Azubi only. Two groups, each with its own snapshot and SaveBar:

    Berufsschultage              the person's patterns (weekly day(s) or block weeks, validity, Schul-
                                 ferien, Bundesland, per-pattern Zeitgutschrift slots), replaced as a
                                 whole by one `PUT /employees/:id/vocational-school-pattern`; after a
                                 save that touches the past, the retroactive wizard (Phase 103)
    Zeitgutschrift Berufsschule  the person's own four slot minutes, `PATCH /employees/:id` with
                                 exactly those keys (Phase 76.36); empty = inherit

  Hierarchy of a slot: Person > Muster > Unternehmen > Tages-Soll; an empty field says where it
  inherits from. Retroactive changes are the API's business: the wizard shows what would change, the
  locked-month refusals and the per-day overrides are unchanged, and nothing is applied before the
  person confirms. A refusal of the server is shown as its text.

  The patterns are read here (the section is mounted for an Azubi only, so no other person pays the
  request); the baseline is each group's own afterwards.

  Props:
    employeeId       the person
    employee         the SAVED record (the four slot minutes)
    tenant           the company defaults the inheritance hint names, or null
    dailySollMin     the person's daily Soll in minutes (lowest layer), or null
    canManagePattern vocational-school:manage (patterns read-only without it; the API enforces it)
    canEditSlots     employee:update (slots read-only without it)
    changes          bindable, the number of unsaved changes of both groups
    onSlotsSaved     called with the slot keys a PATCH wrote
    today            the calendar day a new pattern starts on and the retro check counts from
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import RetroactiveBSWizard from "$lib/components/vocational-school/RetroactiveBSWizard.svelte";
  import {
    shouldOfferRetroactiveRun,
    type RetroactivePreview,
  } from "$lib/components/vocational-school/retroactive";
  import {
    FEDERAL_STATE_OPTIONS,
    draftOf,
    fromPickerDays,
    hasRetroactiveRow,
    newDraft,
    patternChangeCount,
    patternMessages,
    patternsBody,
    patternsErrorCount,
    toPickerDays,
    withBlockWeekToggled,
    withMode,
    type FederalState,
    type PatternDraft,
    type PatternMode,
    type StoredPattern,
  } from "$lib/employees/bs-patterns";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import {
    BS_BLOCK_BOUNDS,
    BS_DAILY_BOUNDS,
    BS_SLOT_KEYS,
    bsSlotMessages,
    bsSlotValuesOf,
    inheritedFrom,
    overCreditNotice,
    slotHours,
    type BsSlotKey,
    type BsSlotValues,
    type OverrideEmployee,
    type OverrideTenant,
    type SlotLayers,
  } from "$lib/employees/overrides-form";
  import { countChanges, pickSection, sectionErrors } from "$lib/settings/section-state";

  interface Props {
    employeeId: string;
    employee: OverrideEmployee;
    tenant: OverrideTenant | null;
    dailySollMin: number | null;
    canManagePattern: boolean;
    canEditSlots: boolean;
    changes?: number;
    onSlotsSaved?: (written: Partial<OverrideEmployee>) => void;
    today?: string;
  }

  // `changes` is write-only here: the page reads it through `bind:changes`.
  let {
    employeeId,
    employee,
    tenant,
    dailySollMin,
    canManagePattern,
    canEditSlots,
    // eslint-disable-next-line no-useless-assignment
    changes = $bindable(),
    onSlotsSaved,
    today: todayProp,
  }: Props = $props();

  const todayIso = untrack(() => todayProp ?? localCalendarDay());
  const currentYear = Number(todayIso.slice(0, 4));

  // ── Berufsschultage (the patterns) ───────────────────────────────────────────

  let loaded = $state(false);
  let loadError = $state("");
  let saved = $state<PatternDraft[]>([]);
  let drafts = $state<PatternDraft[]>([]);
  let savingPatterns = $state(false);
  let patternError = $state("");
  let newKeyCounter = 0;

  const patternChanges = $derived(patternChangeCount(saved, drafts));
  // An invalid value can only exist after an edit, so the messages show once the group has one.
  const showMessages = $derived(patternChanges > 0);
  const messages = $derived(drafts.map((draft) => patternMessages(draft)));
  const patternErrors = $derived(showMessages ? patternsErrorCount(drafts) : 0);

  const MODE_OPTIONS = [
    { value: "weekly", label: "Wöchentlicher Berufsschultag" },
    { value: "block", label: "Blockunterricht" },
  ];
  const WEEKS = Array.from({ length: 53 }, (_, i) => i + 1);

  function load(rows: StoredPattern[]) {
    const next = rows.map(draftOf);
    saved = $state.snapshot(next) as PatternDraft[];
    drafts = next;
  }

  onMount(async () => {
    try {
      load(await api.get<StoredPattern[]>(`/employees/${employeeId}/vocational-school-pattern`));
    } catch {
      loadError = "Berufsschultage konnten nicht geladen werden.";
    } finally {
      loaded = true;
    }
  });

  function addPattern() {
    newKeyCounter += 1;
    drafts = [...drafts, newDraft(newKeyCounter, todayIso)];
  }

  function removePattern(key: string) {
    drafts = drafts.filter((draft) => draft.key !== key);
  }

  function setMode(index: number, mode: string) {
    drafts[index] = withMode(drafts[index], mode as PatternMode);
  }

  function toggleWeek(index: number, week: number) {
    drafts[index] = withBlockWeekToggled(drafts[index], week, currentYear);
  }

  function clearWeeks(index: number) {
    drafts[index] = { ...drafts[index], blockWeeks: [], blockYear: null };
  }

  function discardPatterns() {
    drafts = $state.snapshot(saved) as PatternDraft[];
    patternError = "";
  }

  // The retroactive wizard (Phase 103): mounted once a preview is loaded, so it never renders
  // against a placeholder. The wizard owns its pending guard and its error display.
  let retroPreview = $state<RetroactivePreview | null>(null);
  let retroOpen = $state(false);

  async function confirmRetro(overrideDates: string[]): Promise<RetroactivePreview> {
    return api.post<RetroactivePreview>("/vocational-school/retroactive-apply", {
      employeeId,
      overrideDates,
    });
  }

  function closeRetro() {
    retroOpen = false;
    retroPreview = null;
  }

  async function savePatterns() {
    if (patternsErrorCount(drafts) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingPatterns = true;
    patternError = "";
    try {
      const answer = await api.put<{ patterns: StoredPattern[] }>(
        `/employees/${employeeId}/vocational-school-pattern`,
        patternsBody($state.snapshot(drafts) as PatternDraft[]),
      );
      // The persisted rows replace the drafts, so new rows get their server id as the key.
      load(answer.patterns);
      newKeyCounter = 0;
      toasts.success("Berufsschultage gespeichert", 2000);

      // Phase 103 (D-01): the retroactive check is a non-blocking follow-up. The save above already
      // succeeded and is reported as such whatever happens here; it only probes the API when a
      // saved row starts strictly before today, so a purely forward change opens no dialog.
      if (hasRetroactiveRow(drafts, todayIso)) {
        try {
          const preview = await api.get<RetroactivePreview>(
            `/vocational-school/retroactive-preview?employeeId=${employeeId}`,
          );
          retroPreview = preview;
          if (shouldOfferRetroactiveRun(preview)) retroOpen = true;
        } catch (err) {
          // A failing preview must NEVER surface as a failed save.
          toasts.error(
            err instanceof Error
              ? err.message
              : "Rückwirkende Prüfung konnte nicht geladen werden.",
            4000,
          );
        }
      }
    } catch (err) {
      patternError =
        err instanceof Error ? err.message : "Berufsschultage konnten nicht gespeichert werden.";
      toasts.error(patternError, 4000);
    } finally {
      savingPatterns = false;
    }
  }

  // ── Zeitgutschrift Berufsschule (the person's slots) ─────────────────────────

  interface SlotField {
    key: BsSlotKey;
    label: string;
    name: string;
    bounds: typeof BS_DAILY_BOUNDS;
    block: boolean;
    testid: string;
  }

  const SLOT_FIELDS: SlotField[] = [
    {
      key: "bsSlotFirstLongDayMinutes",
      label: "1. Berufsschul-Langtag (Minuten)",
      name: "1. Langtag",
      bounds: BS_DAILY_BOUNDS,
      block: false,
      testid: "first-long",
    },
    {
      key: "bsSlotSecondLongDayMinutes",
      label: "2. Berufsschul-Langtag (Minuten)",
      name: "2. Langtag",
      bounds: BS_DAILY_BOUNDS,
      block: false,
      testid: "second-long",
    },
    {
      key: "bsSlotShortDayMinutes",
      label: "Berufsschul-Kurztag (Minuten)",
      name: "Kurztag",
      bounds: BS_DAILY_BOUNDS,
      block: false,
      testid: "short-day",
    },
    {
      key: "bsSlotBlockWeekMinutes",
      label: "Blockunterricht-Woche (Minuten)",
      name: "Blockunterricht-Woche",
      bounds: BS_BLOCK_BOUNDS,
      block: true,
      testid: "block-week",
    },
  ];

  let slotSnapshot = $state<BsSlotValues>(
    untrack(() => $state.snapshot(bsSlotValuesOf(employee)) as BsSlotValues),
  );
  let slots = $state<BsSlotValues>(
    untrack(() => $state.snapshot(bsSlotValuesOf(employee)) as BsSlotValues),
  );
  let savingSlots = $state(false);
  let slotError = $state("");

  const slotChanges = $derived(countChanges(slotSnapshot, slots, BS_SLOT_KEYS));
  const slotShown = $derived(slotChanges > 0 ? bsSlotMessages(slots) : {});

  /** The saved pattern's value of a slot: the first pattern, the Muster layer of the hierarchy. */
  function layersOf(key: BsSlotKey): SlotLayers {
    return {
      pattern: saved[0]?.[key] ?? null,
      tenant: tenant?.[key] ?? null,
      dailySoll: dailySollMin,
    };
  }

  const overCredit = $derived(
    overCreditNotice(
      slots.bsSlotSecondLongDayMinutes,
      slots.bsSlotFirstLongDayMinutes,
      layersOf("bsSlotFirstLongDayMinutes"),
    ),
  );

  async function saveSlots() {
    if (Object.values(slotShown).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingSlots = true;
    slotError = "";
    try {
      const body = pickSection($state.snapshot(slots) as BsSlotValues, BS_SLOT_KEYS);
      await api.patch(`/employees/${employeeId}`, body);
      slotSnapshot = $state.snapshot(slots) as BsSlotValues;
      toasts.success("Zeitgutschrift Berufsschule gespeichert.");
      onSlotsSaved?.(body);
    } catch (err) {
      slotError = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
    } finally {
      savingSlots = false;
    }
  }

  function discardSlots() {
    slots = $state.snapshot(slotSnapshot) as BsSlotValues;
    slotError = "";
  }

  $effect(() => {
    changes = patternChanges + slotChanges;
  });
  // A section that goes away (the person stops being an Azubi) must not leave its count behind.
  onDestroy(() => {
    changes = 0;
  });

  function federalStateOf(value: string): FederalState | null {
    return value === "" ? null : (value as FederalState);
  }
</script>

<SettingsGroup
  id="vertrag-berufsschultage"
  title="Berufsschultage"
  description="Wiederkehrende Berufsschultage und Block-Wochen für die Freistellung nach § 15 BBiG."
  changes={canManagePattern ? patternChanges : 0}
  errors={patternErrors}
  saving={savingPatterns}
  saveLabel="Berufsschultage speichern"
  onSave={savePatterns}
  onDiscard={discardPatterns}
>
  {#if !loaded}
    <Skeleton shape="row" />
  {:else}
    {#if loadError}
      <div role="alert"><Note tone="bad">{loadError}</Note></div>
    {/if}
    {#if patternError}
      <div role="alert"><Note tone="bad">{patternError}</Note></div>
    {/if}

    {#if drafts.length === 0 && !loadError}
      <p class="bs-empty">Keine Berufsschultage eingerichtet.</p>
    {/if}

    {#each drafts as draft, index (draft.key)}
      {@const shown = showMessages ? messages[index] : undefined}
      <fieldset class="bs-pattern" data-testid="bs-pattern-row">
        <legend class="bs-pattern-legend">Muster {index + 1}</legend>

        <SegmentedControl
          options={MODE_OPTIONS}
          value={draft.mode}
          name={`bs-mode-${draft.key}`}
          ariaLabel="Berufsschul-Modus"
          disabled={!canManagePattern || savingPatterns}
          onchange={(mode) => setMode(index, mode)}
        />

        {#if draft.mode === "weekly"}
          <WeekdayPicker
            bind:value={
              () => toPickerDays(draft.daysOfWeek),
              (days) => (draft.daysOfWeek = fromPickerDays(days))
            }
            legend="Wochentage"
            help="Wähle die Wochentage, an denen die Person zur Berufsschule geht."
            error={shown?.days}
            disabled={!canManagePattern || savingPatterns}
          />
        {:else}
          <div class="bs-weeks">
            <div class="bs-weeks-head">
              <span class="bs-weeks-label">
                Block-Wochen{draft.blockWeeks.length > 0 ? ` (${draft.blockWeeks.length})` : ""}
              </span>
              {#if draft.blockWeeks.length > 0 && canManagePattern}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onclick={() => clearWeeks(index)}
                  disabled={savingPatterns}
                >
                  Alle abwählen
                </button>
              {/if}
            </div>
            <div class="bs-week-grid" role="group" aria-label="Block-Wochen">
              {#each WEEKS as week (week)}
                <button
                  type="button"
                  class="bs-week"
                  class:bs-week--on={draft.blockWeeks.includes(week)}
                  aria-pressed={draft.blockWeeks.includes(week)}
                  aria-label={`Kalenderwoche ${week}`}
                  disabled={!canManagePattern || savingPatterns}
                  onclick={() => toggleWeek(index, week)}
                >
                  {week}
                </button>
              {/each}
            </div>
            {#if shown?.weeks}
              <p class="bs-error">{shown.weeks}</p>
            {/if}
            <p class="bs-help">
              Markiere die Kalenderwochen mit Blockunterricht. Jeder Tag dieser Wochen zählt dann
              als Berufsschultag.
            </p>
          </div>
          <FormField label="Jahr" error={shown?.year}>
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                class="form-input bs-number"
                type="number"
                min={currentYear - 2}
                max={currentYear + 2}
                step="1"
                bind:value={draft.blockYear}
                data-testid="bs-block-year"
                disabled={!canManagePattern || savingPatterns}
                aria-invalid={invalid ? "true" : undefined}
                aria-describedby={describedBy}
              />
            {/snippet}
          </FormField>
        {/if}

        <div class="bs-row">
          <FormField label="Gültig ab" required error={shown?.validFrom}>
            {#snippet field({ id, describedBy, invalid })}
              <DatePicker
                bind:value={() => draft.validFrom, (value) => (draft.validFrom = value ?? "")}
                label="Gültig ab"
                disabled={!canManagePattern || savingPatterns}
                {id}
                {describedBy}
                {invalid}
              />
            {/snippet}
          </FormField>
          <FormField label="Gültig bis" help="Leer = unbefristet." error={shown?.validUntil}>
            {#snippet field({ id, describedBy, invalid })}
              <DatePicker
                bind:value={draft.validUntil}
                label="Gültig bis"
                disabled={!canManagePattern || savingPatterns}
                {id}
                {describedBy}
                {invalid}
              />
            {/snippet}
          </FormField>
        </div>

        <ToggleField
          bind:checked={draft.respectSchoolHolidays}
          label="Schulferien beachten"
          help="Pflegeschulen und Berufsakademien: ausschalten."
          disabled={!canManagePattern || savingPatterns}
        />

        <FormField
          label="Bundesland der Berufsschule"
          help="Nur bei Pendlern mit Schule in einem anderen Bundesland."
        >
          {#snippet field({ id, describedBy })}
            <select
              {id}
              class="form-input"
              value={draft.federalStateOverride ?? ""}
              onchange={(event) =>
                (draft.federalStateOverride = federalStateOf(event.currentTarget.value))}
              disabled={!canManagePattern || savingPatterns}
              aria-describedby={describedBy}
            >
              <option value="">Wie Unternehmen (Standard)</option>
              {#each FEDERAL_STATE_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>

        <details class="bs-slots" open={SLOT_FIELDS.some((slot) => draft[slot.key] !== null)}>
          <summary>Zeitgutschrift für dieses Muster (optional)</summary>
          <p class="bs-help">
            Leer = Wert aus den Einstellungen des Unternehmens bzw. dem Tages-Soll. Tages-Slots: {BS_DAILY_BOUNDS.min}–{BS_DAILY_BOUNDS.max}
            Min (4–10 h). Blockunterricht-Woche: {BS_BLOCK_BOUNDS.min}–{BS_BLOCK_BOUNDS.max} Min (20–50
            h). Änderungen wirken nur auf offene und künftige Monate.
          </p>
          {#each SLOT_FIELDS as slot (slot.key)}
            <FormField
              label={slot.label}
              help={draft[slot.key] === null
                ? slot.block
                  ? "Leer: Wochenstunden-Soll der Person."
                  : "Leer: Tages-Soll der Person."
                : slotHours(draft[slot.key])}
              error={shown?.slots[slot.key]}
            >
              {#snippet field({ id, describedBy, invalid })}
                <input
                  {id}
                  class="form-input bs-number"
                  type="number"
                  min={slot.bounds.min}
                  max={slot.bounds.max}
                  step="1"
                  bind:value={draft[slot.key]}
                  disabled={!canManagePattern || savingPatterns}
                  aria-invalid={invalid ? "true" : undefined}
                  aria-describedby={describedBy}
                />
              {/snippet}
            </FormField>
          {/each}
        </details>

        {#if canManagePattern}
          <div>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onclick={() => removePattern(draft.key)}
              disabled={savingPatterns}
              aria-label={`Muster ${index + 1} entfernen`}
            >
              Muster entfernen
            </button>
          </div>
        {/if}
      </fieldset>
    {/each}

    {#if canManagePattern}
      <div>
        <button
          type="button"
          class="btn btn-secondary"
          onclick={addPattern}
          disabled={savingPatterns}
        >
          Berufsschultag hinzufügen
        </button>
      </div>
    {/if}
  {/if}
</SettingsGroup>

<SettingsGroup
  id="vertrag-zeitgutschrift"
  title="Zeitgutschrift Berufsschule"
  description="Überschreibt Muster- und Unternehmensvorgabe für diese Person (Person › Muster › Unternehmen › Tages-Soll). Leer = Wert aus der nächsten Ebene."
  changes={canEditSlots ? slotChanges : 0}
  errors={sectionErrors(slotShown)}
  saving={savingSlots}
  saveLabel="Zeitgutschrift speichern"
  onSave={saveSlots}
  onDiscard={discardSlots}
>
  <p class="bs-help">
    Tages-Slots: {BS_DAILY_BOUNDS.min}–{BS_DAILY_BOUNDS.max} Min ({BS_DAILY_BOUNDS.min /
      60}–{BS_DAILY_BOUNDS.max / 60} h). Blockunterricht-Woche: {BS_BLOCK_BOUNDS.min}–{BS_BLOCK_BOUNDS.max}
    Min ({BS_BLOCK_BOUNDS.min / 60}–{BS_BLOCK_BOUNDS.max / 60} h).
  </p>

  {#if slotError}
    <div role="alert" data-testid="bs-slot-error"><Note tone="bad">{slotError}</Note></div>
  {/if}
  {#if overCredit}
    <div role="alert" data-testid="bs-slot-over-credit"><Note tone="warn">{overCredit}</Note></div>
  {/if}

  {#each SLOT_FIELDS as slot (slot.key)}
    <FormField
      label={slot.label}
      help={slots[slot.key] === null
        ? inheritedFrom(layersOf(slot.key), slot.block)
        : slotHours(slots[slot.key])}
      error={slotShown[slot.key]}
    >
      {#snippet field({ id, describedBy, invalid })}
        <div class="bs-field-row">
          <input
            {id}
            class="form-input bs-number"
            type="number"
            min={slot.bounds.min}
            max={slot.bounds.max}
            step="1"
            bind:value={slots[slot.key]}
            placeholder="Leer = erben"
            disabled={!canEditSlots || savingSlots}
            data-testid={`bs-slot-${slot.testid}`}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
          {#if slots[slot.key] !== null && canEditSlots}
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={savingSlots}
              onclick={() => (slots[slot.key] = null)}
              aria-label={`${slot.name} leeren und erben`}
            >
              Leeren
            </button>
          {/if}
        </div>
      {/snippet}
    </FormField>
  {/each}
</SettingsGroup>

<!-- Phase 103: the 3-step retroactive wizard; mounted only once a preview is loaded. -->
{#if retroPreview}
  <RetroactiveBSWizard
    bind:open={retroOpen}
    preview={retroPreview}
    onConfirm={confirmRetro}
    onClose={closeRetro}
  />
{/if}

<style>
  .bs-empty,
  .bs-help {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-2);
  }

  .bs-pattern {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
    margin: 0;
    padding: var(--s-4);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
  }

  .bs-pattern-legend {
    padding: 0 var(--s-2);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .bs-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: var(--s-4);
  }

  .bs-number {
    max-width: 12rem;
  }

  .bs-field-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }

  .bs-weeks {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .bs-weeks-head {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }

  .bs-weeks-label {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .bs-week-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(2.5rem, 1fr));
    gap: var(--s-1);
  }

  .bs-week {
    min-height: var(--h-control);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    font-size: var(--fs-sm);
    color: var(--text);
    cursor: pointer;
  }

  .bs-week--on {
    border-color: var(--brand);
    background: var(--brand-soft);
  }

  .bs-week:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .bs-error {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--bad);
  }

  .bs-slots {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .bs-slots > summary {
    cursor: pointer;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .bs-slots[open] > summary {
    margin-bottom: var(--s-3);
  }
</style>
