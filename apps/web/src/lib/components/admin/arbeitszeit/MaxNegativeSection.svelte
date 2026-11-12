<!--
  MaxNegativeSection - „Überstunden“ of Regeln › Arbeitszeit & Verträge (Issue #854): the limit for a
  negative overtime balance. Moved from the Urlaub page, where it rode along as a second request of the
  page-wide save; here it has its own SaveBar and its own request — `PUT /settings/security` with the
  single key `maxNegativeBalanceMinutes` (registry section `arbeitszeit-ueberstunden`). The switch and
  the hours map to minutes or null as before.
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
    MAX_NEGATIVE_HOURS_MAX,
    MAX_NEGATIVE_HOURS_MIN,
    maxNegativeFrom,
    maxNegativeMessages,
    maxNegativeWire,
    messageCount,
    type MaxNegativeValues,
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

  let snapshot = $state<MaxNegativeValues>(untrack(() => maxNegativeFrom(config)));
  let values = $state<MaxNegativeValues>(untrack(() => maxNegativeFrom(config)));
  let saving = $state(false);

  // The comparison runs on what would be sent: with the limit off, the hours field is not a setting.
  const changeCount = $derived(
    countChanges(maxNegativeWire(snapshot), maxNegativeWire(values), ["maxNegativeBalanceMinutes"]),
  );
  const messages = $derived(maxNegativeMessages(values));
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
      await api.put(
        "/settings/security",
        pickSection(
          maxNegativeWire(values) as Record<string, unknown>,
          settingsSection("arbeitszeit-ueberstunden").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Überstunden-Limit gespeichert.");
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
  title="Überstunden"
  description="Wie weit das Überstundensaldo ins Minus gehen darf."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Limit speichern"
  onSave={save}
  onDiscard={discard}
>
  <ToggleField
    bind:checked={values.enabled}
    label="Limit für negatives Überstundensaldo"
    help="Ohne Limit gilt beim Überstundenausgleich-Antrag eine Toleranz von 0 Stunden: Der Antrag darf das bestätigte Guthaben nicht ins Minus ziehen."
    disabled={!canEdit || saving}
    testid="arbeitszeit-ueberstunden-enabled"
  />

  {#if values.enabled}
    <FormField label="Maximale Minusstunden (Stunden)" error={messages.hours}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="number"
          min={MAX_NEGATIVE_HOURS_MIN}
          max={MAX_NEGATIVE_HOURS_MAX}
          step="0.5"
          bind:value={values.hours}
          disabled={!canEdit || saving}
          data-testid="arbeitszeit-ueberstunden-hours"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
  {/if}
</SettingsGroup>
