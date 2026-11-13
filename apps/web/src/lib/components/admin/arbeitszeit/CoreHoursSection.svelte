<!--
  CoreHoursSection - „Gleitzeit“ of Regeln › Arbeitszeit & Verträge (Issue #854): the company's
  default core time, a pre-fill for new Gleitzeit contracts. Moved from the System page; one SaveBar
  sends the three keys of the registry section `arbeitszeit-gleitzeit` to `PUT /settings/work` (#878).
  An empty time sends null (no company default).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    coreHoursFrom,
    coreHoursMessages,
    coreHoursWire,
    messageCount,
    type CoreHoursField,
    type CoreHoursValues,
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

  let snapshot = $state<CoreHoursValues>(untrack(() => coreHoursFrom(config)));
  let values = $state<CoreHoursValues>(untrack(() => coreHoursFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-gleitzeit").keys as readonly CoreHoursField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(coreHoursMessages(values));
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
        "/settings/work",
        pickSection(
          coreHoursWire(values) as Record<string, unknown>,
          settingsSection("arbeitszeit-gleitzeit").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Kernzeit gespeichert.");
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
  title="Gleitzeit"
  description="Standard-Kernzeit für neue Gleitzeit-Verträge. Beim Anlegen wird sie vorbelegt und lässt sich pro Person überschreiben."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Kernzeit speichern"
  onSave={save}
  onDiscard={discard}
>
  <div class="core-times">
    <FormField label="Kernzeitbeginn" error={messages.defaultCoreStart}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="time"
          bind:value={values.defaultCoreStart}
          disabled={!canEdit || saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <FormField label="Kernzeitende" error={messages.defaultCoreEnd}>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="time"
          bind:value={values.defaultCoreEnd}
          disabled={!canEdit || saving}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
  </div>

  <WeekdayPicker
    bind:value={values.defaultCoreDays}
    legend="Standard-Kernzeit-Tage"
    help="Lass alles leer, wenn es keine Vorgabe für das Unternehmen geben soll. Mitarbeitende mit Gleitzeit starten dann ohne vorausgewählte Kernzeit."
    disabled={!canEdit || saving}
    testidPrefix="arbeitszeit-gleitzeit-tag"
  />
</SettingsGroup>

<style>
  .core-times {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--s-3);
  }
</style>
