<!--
  OpenEntriesSection - „Offene Einträge“ of Regeln › Arbeitszeit & Verträge (Issue #854): after how
  many hours an entry without a clock-out is marked invalid. It is a time-entry rule, not a
  notification, so it sits here and no longer on the Urlaub page's „Erinnerungen“. One SaveBar sends
  the single key `autoDeleteOpenHours` (registry section `arbeitszeit-offene-eintraege`) to
  `PUT /settings/work` (#878). The key keeps its legacy name; it invalidates, it never deletes.
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
    OPEN_ENTRIES_HOURS_MAX,
    messageCount,
    openEntriesFrom,
    openEntriesMessages,
    openEntriesWire,
    type OpenEntriesField,
    type OpenEntriesValues,
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

  let snapshot = $state<OpenEntriesValues>(untrack(() => openEntriesFrom(config)));
  let values = $state<OpenEntriesValues>(untrack(() => openEntriesFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-offene-eintraege").keys as readonly OpenEntriesField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(openEntriesMessages(values));
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
      const wire = openEntriesWire(values);
      await api.put(
        "/settings/work",
        pickSection(
          wire as Record<string, unknown>,
          settingsSection("arbeitszeit-offene-eintraege").keys,
        ),
      );
      values.autoDeleteOpenHours = wire.autoDeleteOpenHours as number;
      snapshot = $state.snapshot(values);
      toasts.success("Offene Einträge gespeichert.");
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
  title="Offene Einträge"
  description="Was mit Zeiteinträgen passiert, bei denen das Ausstempeln fehlt."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Frist speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Offene Einträge ungültig markieren nach (Stunden)"
    help="Einträge ohne Ausstempeln werden nach dieser Zeit als ungültig markiert und müssen manuell korrigiert werden. 0 schaltet das ab."
    error={messages.autoDeleteOpenHours}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="number"
        min="0"
        max={OPEN_ENTRIES_HOURS_MAX}
        step="1"
        bind:value={values.autoDeleteOpenHours}
        disabled={!canEdit || saving}
        data-testid="arbeitszeit-offene-eintraege-hours"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>
</SettingsGroup>
