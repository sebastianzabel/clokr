<!--
  BreaksSection - „Pausen“ of Verwalten › Regeln › Arbeitszeit & Verträge (Issue #854, D-854-03):
  the automatic break deduction (§ 4 ArbZG), its start time and durations, and the confirmation of
  automatically entered breaks. Moved here from the System page; one SaveBar sends exactly the five
  keys of the registry section `arbeitszeit-pausen` to `PUT /settings/work` (#878). The switch for
  blocking the Monatsabschluss stays with the Monatsabschluss settings.

  Props:
    config  - the loaded `GET /settings/work` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
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
    BREAK_OVER_6H_MAX,
    BREAK_OVER_6H_MIN,
    BREAK_OVER_9H_MAX,
    BREAK_OVER_9H_MIN,
    breaksFrom,
    breaksMessages,
    breaksWire,
    messageCount,
    type BreaksField,
    type BreaksValues,
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

  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let snapshot = $state<BreaksValues>(untrack(() => breaksFrom(config)));
  let values = $state<BreaksValues>(untrack(() => breaksFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-pausen").keys as readonly BreaksField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(breaksMessages(values));
  const errorCount = $derived(messageCount(messages));

  $effect(() => {
    changes = changeCount;
  });

  async function save() {
    if (errorCount > 0) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    saving = true;
    try {
      const wire = breaksWire(values);
      await api.put(
        "/settings/work",
        pickSection(wire as Record<string, unknown>, settingsSection("arbeitszeit-pausen").keys),
      );
      // The minutes are stored as whole numbers; show what was stored.
      values.defaultBreakOver6h = wire.defaultBreakOver6h as number;
      values.defaultBreakOver9h = wire.defaultBreakOver9h as number;
      snapshot = $state.snapshot(values);
      toasts.success("Pausen gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      saving = false;
    }
  }

  function discard() {
    values = $state.snapshot(snapshot);
  }
</script>

<SettingsGroup
  title="Pausen"
  description="Pflichtpausen nach § 4 ArbZG: mehr als 6 Stunden Arbeit brauchen mindestens 30 Minuten Pause, mehr als 9 Stunden mindestens 45 Minuten."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Pausen speichern"
  onSave={save}
  onDiscard={discard}
>
  <ToggleField
    bind:checked={values.autoBreakEnabled}
    label="Pausen automatisch abziehen"
    help="Beim Ausstempeln legt Clokr die Pflichtpause automatisch als Pausen-Eintrag an und zieht sie von der gestempelten Zeit ab. Das wirkt auf neue Einträge ab dem Speichern."
    disabled={!canEdit || saving}
    testid="arbeitszeit-pausen-autoBreakEnabled"
  />

  {#if values.autoBreakEnabled}
    <FormField
      label="Standard-Pausenbeginn"
      help="Ab dieser Uhrzeit legt Clokr die automatische Pause. Liegt sie außerhalb des gestempelten Zeitraums, fällt Clokr auf die Tagesmitte zurück."
      error={messages.defaultBreakStart}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="time"
          bind:value={values.defaultBreakStart}
          disabled={!canEdit || saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
  {/if}

  <!-- Both durations are always editable, so the defaults can be prepared before the automatic
       deduction is switched on. -->
  <FormField
    label="Pause ab 6 Stunden (Minuten)"
    help={`ArbZG-Minimum: ${BREAK_OVER_6H_MIN} Minuten.`}
    error={messages.defaultBreakOver6h}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={BREAK_OVER_6H_MIN}
        max={BREAK_OVER_6H_MAX}
        step="1"
        bind:value={values.defaultBreakOver6h}
        disabled={!canEdit || saving}
        data-testid="arbeitszeit-pausen-over6h"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <FormField
    label="Pause ab 9 Stunden (Minuten)"
    help={`ArbZG-Minimum: ${BREAK_OVER_9H_MIN} Minuten.`}
    error={messages.defaultBreakOver9h}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={BREAK_OVER_9H_MIN}
        max={BREAK_OVER_9H_MAX}
        step="1"
        bind:value={values.defaultBreakOver9h}
        disabled={!canEdit || saving}
        data-testid="arbeitszeit-pausen-over9h"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <ToggleField
    bind:checked={values.enforceBreakConfirmation}
    label="Pausen-Bestätigung erforderlich"
    help="Mitarbeitende bestätigen automatisch eingetragene Pflichtpausen, passen sie an oder kennzeichnen den Tag als „durchgearbeitet“. Standard: aus."
    disabled={!canEdit || saving}
    testid="arbeitszeit-pausen-enforceBreakConfirmation"
  />
</SettingsGroup>
