<!--
  RetroWindowSection - „Rückwirkende Einträge“ of Regeln › Arbeitszeit & Verträge (Issue #854):
  how many days back employees may edit their own time entries without an approved request. Moved
  from the System page; one SaveBar sends the single key `retroEntryWindowDays` (registry section
  `arbeitszeit-rueckwirkend`) to `PUT /settings/work` (#878).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    RETRO_WINDOW_MAX,
    RETRO_WINDOW_MIN,
    messageCount,
    retroFrom,
    retroMessages,
    retroWire,
    type RetroField,
    type RetroValues,
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

  let snapshot = $state<RetroValues>(untrack(() => retroFrom(config)));
  let values = $state<RetroValues>(untrack(() => retroFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-rueckwirkend").keys as readonly RetroField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(retroMessages(values));
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
      const wire = retroWire(values);
      await api.put(
        "/settings/work",
        pickSection(
          wire as Record<string, unknown>,
          settingsSection("arbeitszeit-rueckwirkend").keys,
        ),
      );
      values.retroEntryWindowDays = wire.retroEntryWindowDays as number;
      snapshot = $state.snapshot(values);
      toasts.success("Rückwirkende Einträge gespeichert.");
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
  title="Rückwirkende Einträge"
  description="Frist für die eigenständige Bearbeitung vergangener Zeiteinträge."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Frist speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Selbstbearbeitungsfenster (Tage)"
    help="Mitarbeitende können Einträge bis zu so vielen Tagen rückwirkend selbst bearbeiten. Ältere Einträge brauchen einen Antrag, den ein Manager genehmigt. Gesetzlicher Referenzwert (ArbZG-Referentenentwurf 2023): 7 Tage. Standard: 10 Tage."
    error={messages.retroEntryWindowDays}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min={RETRO_WINDOW_MIN}
        max={RETRO_WINDOW_MAX}
        step="1"
        bind:value={values.retroEntryWindowDays}
        disabled={!canEdit || saving}
        data-testid="arbeitszeit-rueckwirkend-days"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
</SettingsGroup>
