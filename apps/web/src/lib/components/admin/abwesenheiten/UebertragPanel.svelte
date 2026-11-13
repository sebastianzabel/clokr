<!--
  UebertragPanel - the „Übertrag“ tab of Verwalten › Regeln › Abwesenheiten (Issue #854, D-854-03): the
  carry-over deadline and reason rule (§ 7 BUrlG) and the warnings about expiring leave (Hinweispflicht,
  EuGH C-684/16). Two sections, each with its own SaveBar and its own registry keys
  (`abwesenheiten-uebertrag`, `abwesenheiten-verfallswarnung`), saved to `PUT /settings/work` (#878).
  docs/burlg-carryover.md explains the settings.

  Props:
    config  - the loaded `GET /settings/work` answer
    changes - bindable, the number of unsaved changes of both sections (the page sums it into markUnsaved)
    onSaved - called with the saved values after a successful save of the deadline, so the overview follows
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    MONTHS,
    REMINDER_MONTHS,
    THRESHOLD_MAX,
    THRESHOLD_MIN,
    clampDayToMonth,
    maxDayOfMonth,
    messageCount,
    uebertragFrom,
    uebertragMessages,
    uebertragWire,
    verfallFrom,
    verfallMessages,
    verfallWire,
    type AbwesenheitenConfig,
    type UebertragField,
    type UebertragValues,
    type VerfallField,
    type VerfallValues,
  } from "$lib/settings/abwesenheiten";

  interface Props {
    config: AbwesenheitenConfig;
    changes?: number;
    onSaved?: (saved: Partial<AbwesenheitenConfig>) => void;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, changes = $bindable(0), onSaved }: Props = $props();

  // ── Übertrag ins neue Jahr ───────────────────────────────────────────────────────────────────
  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let uebertragSnapshot = $state<UebertragValues>(untrack(() => uebertragFrom(config)));
  let uebertrag = $state<UebertragValues>(untrack(() => uebertragFrom(config)));
  let uebertragSaving = $state(false);
  const uebertragChanges = $derived(
    countChanges(
      uebertragSnapshot,
      uebertrag,
      settingsSection("abwesenheiten-uebertrag").keys as readonly UebertragField[],
    ),
  );
  const uebertragMsg = $derived(uebertragMessages(uebertrag));
  const maxDay = $derived(maxDayOfMonth(uebertrag.carryOverDeadlineMonth));

  // A month with fewer days lowers a day that would not exist in it (never raises one).
  function onMonthChange() {
    uebertrag.carryOverDeadlineDay = clampDayToMonth(
      uebertrag.carryOverDeadlineDay,
      uebertrag.carryOverDeadlineMonth,
    );
  }

  async function saveUebertrag() {
    if (messageCount(uebertragMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    uebertragSaving = true;
    try {
      const wire = uebertragWire(uebertrag) as Record<string, unknown>;
      await api.put(
        "/settings/work",
        pickSection(wire, settingsSection("abwesenheiten-uebertrag").keys),
      );
      uebertragSnapshot = $state.snapshot(uebertrag);
      onSaved?.(
        pickSection(
          wire,
          settingsSection("abwesenheiten-uebertrag").keys,
        ) as Partial<AbwesenheitenConfig>,
      );
      toasts.success("Übertrag gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      uebertragSaving = false;
    }
  }

  function discardUebertrag() {
    uebertrag = $state.snapshot(uebertragSnapshot);
  }

  // ── Warnung vor Verfall ──────────────────────────────────────────────────────────────────────
  let verfallSnapshot = $state<VerfallValues>(untrack(() => verfallFrom(config)));
  let verfall = $state<VerfallValues>(untrack(() => verfallFrom(config)));
  let verfallSaving = $state(false);
  const verfallChanges = $derived(
    countChanges(
      verfallSnapshot,
      verfall,
      settingsSection("abwesenheiten-verfallswarnung").keys as readonly VerfallField[],
    ),
  );
  const verfallMsg = $derived(verfallMessages(verfall));

  async function saveVerfall() {
    if (messageCount(verfallMsg) > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    verfallSaving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          verfallWire(verfall) as Record<string, unknown>,
          settingsSection("abwesenheiten-verfallswarnung").keys,
        ),
      );
      verfallSnapshot = $state.snapshot(verfall);
      toasts.success("Verfallswarnung gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      verfallSaving = false;
    }
  }

  function discardVerfall() {
    verfall = $state.snapshot(verfallSnapshot);
  }

  $effect(() => {
    changes = uebertragChanges + verfallChanges;
  });
</script>

<SettingsGroup
  title="Übertrag ins neue Jahr"
  description="Bis wann Resturlaub genommen werden kann und ob ein Übertrag eine Begründung braucht (§ 7 BUrlG)."
  changes={uebertragChanges}
  errors={messageCount(uebertragMsg)}
  saving={uebertragSaving}
  saveLabel="Übertrag speichern"
  onSave={saveUebertrag}
  onDiscard={discardUebertrag}
>
  <FormField
    label="Resturlaub verfällt am"
    help="Der Tag im Folgejahr, an dem nicht genommener Resturlaub des Vorjahres verfällt."
    error={uebertragMsg.carryOverDeadlineDay}
  >
    {#snippet field({ id, describedBy, invalid })}
      <div class="ue-deadline">
        <input
          {id}
          class="form-input ue-day"
          type="number"
          min="1"
          max={maxDay}
          step="1"
          bind:value={uebertrag.carryOverDeadlineDay}
          disabled={uebertragSaving}
          data-testid="abwesenheiten-uebertrag-day"
          aria-label="Tag des Verfalls"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
        <span class="ue-dot" aria-hidden="true">.</span>
        <select
          class="form-input ue-month"
          bind:value={uebertrag.carryOverDeadlineMonth}
          onchange={onMonthChange}
          disabled={uebertragSaving}
          data-testid="abwesenheiten-uebertrag-month"
          aria-label="Monat des Verfalls"
        >
          {#each MONTHS as month, index (index)}
            <option value={index + 1}>{month}</option>
          {/each}
        </select>
        <span class="ue-suffix">des Folgejahres</span>
      </div>
    {/snippet}
  </FormField>
  <ToggleField
    bind:checked={uebertrag.carryOverRequiresReason}
    label="Übertrag ins Folgejahr erfordert eine Begründung"
    help="Zum Beispiel Krankheit oder betriebliche Gründe."
    disabled={uebertragSaving}
    testid="abwesenheiten-uebertrag-reason"
  />
</SettingsGroup>

<SettingsGroup
  title="Warnung vor Verfall"
  description="Hinweispflicht: Mitarbeitende werden rechtzeitig an verfallenden Urlaub erinnert (EuGH C-684/16)."
  changes={verfallChanges}
  errors={messageCount(verfallMsg)}
  saving={verfallSaving}
  saveLabel="Verfallswarnung speichern"
  onSave={saveVerfall}
  onDiscard={discardVerfall}
>
  <FormField
    label="Erinnerung ab Monat"
    help="Ab diesem Monat werden Mitarbeitende an verfallenden Urlaub erinnert."
  >
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input ue-month"
        bind:value={verfall.vacationReminderStartMonth}
        disabled={verfallSaving}
        data-testid="abwesenheiten-verfall-month"
        aria-describedby={describedBy}
      >
        {#each REMINDER_MONTHS as month (month.value)}
          <option value={month.value}>{month.label}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>
  <ToggleField
    bind:checked={verfall.carryoverWarningEnabled}
    label="Hinweise automatisch versenden"
    help="Täglich um 06:00 Uhr."
    disabled={verfallSaving}
    testid="abwesenheiten-verfall-enabled"
  />
  <FormField
    label="Schwellwerte (Tage vor Verfall)"
    help={`Liste mit Komma getrennt (Tage ${THRESHOLD_MIN} bis ${THRESHOLD_MAX}). Jeder Schwellwert löst genau einen Hinweis aus. Beispiel: 60, 30, 14, 7 warnt 60, 30, 14 und 7 Tage vor Verfall.`}
    error={verfallMsg.carryoverWarningThresholds}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        placeholder="60, 30, 14, 7"
        bind:value={verfall.carryoverWarningThresholds}
        disabled={verfallSaving || !verfall.carryoverWarningEnabled}
        data-testid="abwesenheiten-verfall-thresholds"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
</SettingsGroup>

<style>
  .ue-deadline {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }

  .ue-day {
    width: 5rem;
    text-align: center;
  }

  .ue-month {
    width: 10rem;
  }

  .ue-dot,
  .ue-suffix {
    color: var(--text-2);
    font-size: var(--fs-base);
  }
</style>
