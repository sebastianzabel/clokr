<!--
  RetentionSection - „Aufbewahrung“ of Daten › Protokoll (Issue #854, D-854-21): how many years the data is
  kept before the annual deletion (the Stichtag run) anonymises it. One SaveBar sends exactly the one key of
  the registry section `protokoll-aufbewahrung` to `PUT /settings/work` (#878, §3.2.1: the period controls
  the annual deletion, so it is never an instant-save control). Moved from the former audit page.

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
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";

  interface RetentionConfig {
    dataRetentionYears?: number | null;
  }

  interface Props {
    config: RetentionConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  /** The offered periods; 10 years is the default (GoBD, § 147 AO), 2 years the legal minimum. */
  const OPTIONS = [
    { years: 10, label: "10 Jahre (GoBD)" },
    { years: 6, label: "6 Jahre (§ 41 EStG Lohnkonten)" },
    { years: 3, label: "3 Jahre" },
    { years: 2, label: "2 Jahre (Minimum § 16 ArbZG)" },
  ];

  type RetentionValues = { dataRetentionYears: number };
  const from = (c: RetentionConfig): RetentionValues => ({
    dataRetentionYears: c.dataRetentionYears ?? 10,
  });

  let snapshot = $state<RetentionValues>(untrack(() => from(config)));
  let values = $state<RetentionValues>(untrack(() => from(config)));
  let saving = $state(false);

  const keys = settingsSection("protokoll-aufbewahrung").keys as readonly (keyof RetentionValues)[];
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
          values as Record<string, unknown>,
          settingsSection("protokoll-aufbewahrung").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Aufbewahrungsfrist gespeichert.");
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
  id="aufbewahrung"
  title="Aufbewahrung"
  description="Wie lange Daten aufbewahrt werden. Standard sind 10 Jahre (GoBD, § 147 AO)."
  changes={changeCount}
  errors={0}
  {saving}
  saveLabel="Aufbewahrungsfrist speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Aufbewahrungsfrist"
    help="Nach Ablauf werden Daten automatisch anonymisiert. Aggregierte Salden bleiben erhalten. § 147 AO verlangt 10 Jahre für lohnrelevante Belege; kürzere Fristen sind nur erlaubt, wenn keine Buchungsbelege betroffen sind."
  >
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input"
        bind:value={values.dataRetentionYears}
        disabled={!canEdit || saving}
        data-testid="admin-audit-retention-years"
        aria-describedby={describedBy}
      >
        {#each OPTIONS as option (option.years)}
          <option value={option.years} translate="no">{option.label}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>
</SettingsGroup>
