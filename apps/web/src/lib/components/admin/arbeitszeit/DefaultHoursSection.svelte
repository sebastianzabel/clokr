<!--
  DefaultHoursSection - „Standard-Arbeitszeit“ of Regeln › Arbeitszeit & Verträge (Issue #854): the
  company's default hours per weekday with their live sum, the overtime warning threshold and the
  overtime payout switch. Moved from the Urlaub page; one SaveBar sends exactly the keys of the
  registry section `arbeitszeit-standard` to `PUT /settings/work` (#878).

  Applying the defaults to EXISTING contracts stays the guarded two-step of Issue #568 (§ 3 NachwG,
  AC-2): the button „Auf bestehende Verträge anwenden“ opens `BulkApplyDialog`, which shows the
  server's preview (candidates, fingerprint, allowed effective dates); only its confirmation saves the
  defaults together with the server's selection. The effective date is the one the server offered —
  nothing is computed here, and nothing is applied without the confirmation. A plain save never
  touches an existing contract.

  Props:
    config  - the loaded `GET /settings/work` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import { fetchBulkApplyPreview, type BulkApplySelection } from "$lib/api/bulk-apply";
  import { formatDateDe } from "$lib/admin/bulk-apply-format";
  import BulkApplyDialog from "$lib/components/admin/BulkApplyDialog.svelte";
  import DayGrid from "$components/ui/DayGrid.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    DEFAULT_HOURS_COMPARABLE_KEYS,
    OVERTIME_THRESHOLD_MAX,
    OVERTIME_THRESHOLD_MIN,
    defaultHoursComparable,
    defaultHoursFrom,
    defaultHoursMessages,
    defaultHoursWire,
    messageCount,
    type DefaultHoursValues,
    type WorkConfig,
  } from "$lib/settings/arbeitszeit";

  interface Props {
    config: WorkConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<DefaultHoursValues>(untrack(() => defaultHoursFrom(config)));
  let values = $state<DefaultHoursValues>(untrack(() => defaultHoursFrom(config)));
  let saving = $state(false);
  let bulkOpen = $state(false);

  const changeCount = $derived(
    countChanges(
      defaultHoursComparable(snapshot),
      defaultHoursComparable(values),
      DEFAULT_HOURS_COMPARABLE_KEYS,
    ),
  );
  const messages = $derived(defaultHoursMessages(values));
  const errorCount = $derived(messageCount(messages));

  $effect(() => {
    changes = changeCount;
  });

  /** Sends the defaults, with the server's selection when the bulk apply was confirmed; throws on failure. */
  async function persist(bulk: BulkApplySelection | null): Promise<void> {
    const answer = await api.put<{ appliedCount?: number } | undefined>(
      "/settings/work",
      pickSection(defaultHoursWire(values, bulk), settingsSection("arbeitszeit-standard").keys),
    );
    snapshot = $state.snapshot(values);
    if (bulk !== null) {
      const count = answer?.appliedCount ?? bulk.applyEmployeeIds.length;
      toasts.success(
        `${count} ${count === 1 ? "Vertrag" : "Verträge"} ab ${formatDateDe(bulk.effectiveFrom)} angepasst`,
      );
    }
  }

  async function save() {
    if (errorCount > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      await persist(null);
      toasts.success("Standard-Arbeitszeit gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = $state.snapshot(snapshot);
  }

  // The preview classifies against the form's proposed working time; the effective date comes from the
  // server's allowed list, never from a browser-side date rule.
  function loadPreview(effectiveFrom?: string) {
    const wire = defaultHoursWire(values, null);
    return fetchBulkApplyPreview({
      defaultWeeklyHours: wire.defaultWeeklyHours as number,
      defaultMondayHours: wire.defaultMondayHours as number,
      defaultTuesdayHours: wire.defaultTuesdayHours as number,
      defaultWednesdayHours: wire.defaultWednesdayHours as number,
      defaultThursdayHours: wire.defaultThursdayHours as number,
      defaultFridayHours: wire.defaultFridayHours as number,
      defaultSaturdayHours: wire.defaultSaturdayHours as number,
      defaultSundayHours: wire.defaultSundayHours as number,
      overtimeThreshold: wire.overtimeThreshold as number,
      allowOvertimePayout: wire.allowOvertimePayout as boolean,
      effectiveFrom,
    });
  }

  /** The dialog's confirmation: save the defaults together with the selection. */
  async function confirmBulk(selection: BulkApplySelection) {
    await persist(selection);
  }

  /** Nothing is affected: save the defaults alone (the dialog offers this instead of an empty apply). */
  async function saveDefaultsOnly() {
    await persist(null);
    toasts.success("Standard-Arbeitszeit gespeichert.");
  }
</script>

<SettingsGroup
  title="Standard-Arbeitszeit"
  description="Standard-Stunden pro Wochentag und die Überstunden-Regeln für alle im Unternehmen. Neue Verträge starten mit diesen Werten."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Standard-Arbeitszeit speichern"
  onSave={save}
  onDiscard={discard}
>
  <div data-testid="arbeitszeit-standard-days">
    <DayGrid bind:value={values.days} label="Wochenstunden je Tag" disabled={!canEdit || saving} />
    {#if messages.defaultWeeklyHours}
      <p class="ds-error" role="alert">{messages.defaultWeeklyHours}</p>
    {/if}
  </div>

  <FormField
    label="Warnschwelle für Überstunden (Stunden)"
    help="Ab diesem Saldo erscheint die kritische Warnung."
    error={messages.overtimeThreshold}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={OVERTIME_THRESHOLD_MIN}
        max={OVERTIME_THRESHOLD_MAX}
        step="1"
        bind:value={values.overtimeThreshold}
        disabled={!canEdit || saving}
        data-testid="arbeitszeit-standard-threshold"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <ToggleField
    bind:checked={values.allowOvertimePayout}
    label="Auszahlung von Überstunden erlauben"
    help="Aus: Überstunden werden nur mit Freizeit ausgeglichen."
    disabled={!canEdit || saving}
    testid="arbeitszeit-standard-payout"
  />

  {#if canEdit}
    <div class="ds-bulk">
      <p class="ds-bulk-help">
        Bestehende Verträge ändern sich nicht von allein. Mit der Vorschau wählst du aus, welche
        Verträge die neuen Werte bekommen. Die Änderung gilt frühestens ab dem nächsten
        Monatsersten, nie rückwirkend.
      </p>
      <div>
        <button
          type="button"
          class="btn btn-secondary"
          disabled={saving || errorCount > 0}
          onclick={() => (bulkOpen = true)}
          data-testid="arbeitszeit-standard-bulk"
        >
          Auf bestehende Verträge anwenden
        </button>
      </div>
    </div>
  {/if}
</SettingsGroup>

<BulkApplyDialog
  bind:open={bulkOpen}
  {loadPreview}
  onConfirm={confirmBulk}
  onSaveDefaultsOnly={saveDefaultsOnly}
/>

<style>
  .ds-error {
    margin: var(--s-1) 0 0;
    font-size: var(--fs-sm);
    color: var(--bad);
  }

  .ds-bulk {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .ds-bulk-help {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-2);
  }
</style>
