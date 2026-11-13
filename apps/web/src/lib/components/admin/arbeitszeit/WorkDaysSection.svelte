<!--
  WorkDaysSection - „Arbeitstage“ of Regeln › Arbeitszeit & Verträge (Issue #854): the company's
  standard workdays, a Mo…So choice. Moved from the System page (where the count of days was chosen);
  one SaveBar sends the single key `defaultWorkDays` (registry section `arbeitszeit-arbeitstage`) to
  `PUT /settings/work` (#878). The value stays the index array 0 = So … 6 = Sa.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import WeekdayPicker from "$lib/components/admin/settings/WeekdayPicker.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    messageCount,
    workDaysFrom,
    workDaysMessages,
    workDaysWire,
    type WorkConfig,
    type WorkDaysField,
    type WorkDaysValues,
  } from "$lib/settings/arbeitszeit";

  interface Props {
    config: WorkConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<WorkDaysValues>(untrack(() => workDaysFrom(config)));
  let values = $state<WorkDaysValues>(untrack(() => workDaysFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-arbeitstage").keys as readonly WorkDaysField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(workDaysMessages(values));
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
          workDaysWire(values) as Record<string, unknown>,
          settingsSection("arbeitszeit-arbeitstage").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Arbeitstage gespeichert.");
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
  title="Arbeitstage"
  description="Welche Wochentage bei euch Arbeitstage sind, unabhängig vom Arbeitszeitmodell."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Arbeitstage speichern"
  onSave={save}
  onDiscard={discard}
>
  <WeekdayPicker
    bind:value={values.defaultWorkDays}
    legend="Standard-Arbeitstage"
    help="Clokr nutzt sie für den Urlaubsverbrauch und die Pro-Rata-Berechnung, wenn der Vertrag einer Person keine eigenen Arbeitstage nennt."
    error={messages.defaultWorkDays}
    disabled={!canEdit || saving}
    testidPrefix="arbeitszeit-arbeitstage"
  />
</SettingsGroup>
