<!--
  ComplianceSection - „ArbZG-Prüfung“ of Regeln › Arbeitszeit & Verträge (Issue #854): whether Clokr
  shows violations of the Arbeitszeitgesetz. Moved from the Urlaub page; one SaveBar sends the single
  key `arbzgEnabled` (registry section `arbeitszeit-compliance`) to `PUT /settings/work` (#878).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    complianceFrom,
    complianceWire,
    type ComplianceField,
    type ComplianceValues,
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

  let snapshot = $state<ComplianceValues>(untrack(() => complianceFrom(config)));
  let values = $state<ComplianceValues>(untrack(() => complianceFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("arbeitszeit-compliance").keys as readonly ComplianceField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));

  $effect(() => {
    changes = changeCount;
  });

  async function save() {
    saving = true;
    try {
      await api.put(
        "/settings/work",
        pickSection(
          complianceWire(values) as Record<string, unknown>,
          settingsSection("arbeitszeit-compliance").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("ArbZG-Prüfung gespeichert.");
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
  id="arbzg"
  title="ArbZG-Prüfung"
  description="Arbeitszeitgesetz: Höchstarbeitszeit, Pausenpflicht und Ruhezeiten."
  changes={changeCount}
  errors={0}
  {saving}
  saveLabel="Prüfung speichern"
  onSave={save}
  onDiscard={discard}
>
  <ToggleField
    bind:checked={values.arbzgEnabled}
    label="ArbZG-Verstöße anzeigen"
    help="Prüft Höchstarbeitszeit, Pausen und Ruhezeiten (§§ 3-5 ArbZG). Die automatischen Pausen stellst du im Abschnitt „Pausen“ ein."
    disabled={!canEdit || saving}
    testid="arbeitszeit-compliance-enabled"
  />
</SettingsGroup>
