<!--
  GapsSection - „Monatsabschluss mit Lücken“ of Regeln › Monatsabschluss (Issue #854, D-854-03): whether a
  month with working days without any time entry may be closed. Moved from the System page; one SaveBar
  sends the single key `closeMonthWithGapsAllowed` (registry section `monatsabschluss-luecken`) to
  `PUT /settings/work` (#878). This gates the Monatsabschluss, so a failed save keeps the edit visible
  and says so instead of pretending it was stored.

  Props:
    config  - the loaded `GET /settings/work` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
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
    gapsFrom,
    gapsWire,
    type ClosingConfig,
    type GapsField,
    type GapsValues,
  } from "$lib/settings/monatsabschluss";

  interface Props {
    config: ClosingConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let snapshot = $state<GapsValues>(untrack(() => gapsFrom(config)));
  let values = $state<GapsValues>(untrack(() => gapsFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("monatsabschluss-luecken").keys as readonly GapsField[];
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
          gapsWire(values) as Record<string, unknown>,
          settingsSection("monatsabschluss-luecken").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Monatsabschluss mit Lücken gespeichert.");
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
  title="Monatsabschluss mit Lücken"
  description="Ob ein Monat abgeschlossen werden darf, obwohl an Arbeitstagen Zeiteinträge fehlen."
  changes={changeCount}
  errors={0}
  {saving}
  saveLabel="Einstellung speichern"
  onSave={save}
  onDiscard={discard}
>
  <ToggleField
    bind:checked={values.closeMonthWithGapsAllowed}
    label="Abschluss trotz fehlender Einträge erlauben"
    help="Ist das eingeschaltet, kannst du Monate auch abschließen, wenn Arbeitstage ohne Zeiterfassung vorliegen. Fehlende Tage zählen mit 0 Stunden gegen das volle Soll."
    disabled={!canEdit || saving}
    testid="monatsabschluss-closeMonthWithGapsAllowed"
  />
</SettingsGroup>
