<!--
  BreakBlockSection - „Offene Pausenbefunde“ of Regeln › Monatsabschluss (Issue #854, D-854-03, D-854-25):
  whether the Monatsabschluss is blocked while days with an unconfirmed break exist. Moved from the System
  page; one SaveBar sends the single key `blockMonthCloseOnUnconfirmedBreak` (registry section
  `monatsabschluss-pausen`) to `PUT /settings/work` (#878).

  The switch only takes effect while the Pausen-Bestätigung is on. That switch lives on Regeln › Arbeitszeit
  & Verträge; here it is READ ONLY (`config.enforceBreakConfirmation`, never sent) and explained with a link
  to the Pausen section, so nobody has to know the dependency by heart.

  Props:
    config  - the loaded `GET /settings/work` answer
    canEdit - presentation only; the server's 403 stays the authority
    changes - bindable, the number of unsaved changes (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Note from "$components/ui/Note.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    breakBlockFrom,
    breakBlockWire,
    breakConfirmationOn,
    type BreakBlockField,
    type BreakBlockValues,
    type ClosingConfig,
  } from "$lib/settings/monatsabschluss";

  interface Props {
    config: ClosingConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<BreakBlockValues>(untrack(() => breakBlockFrom(config)));
  let values = $state<BreakBlockValues>(untrack(() => breakBlockFrom(config)));
  let saving = $state(false);

  // Read once, like the baseline: the Pausen-Bestätigung is saved on another page.
  const confirmationOn = untrack(() => breakConfirmationOn(config));
  const breaksHref = "/verwalten/regeln/arbeitszeit#pausen";
  const breaksLabel = pageLabel("/verwalten/regeln/arbeitszeit");

  const keys = settingsSection("monatsabschluss-pausen").keys as readonly BreakBlockField[];
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
          breakBlockWire(values) as Record<string, unknown>,
          settingsSection("monatsabschluss-pausen").keys,
        ),
      );
      snapshot = $state.snapshot(values);
      toasts.success("Offene Pausenbefunde gespeichert.");
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
  title="Offene Pausenbefunde"
  description="Ob ein Monat abgeschlossen werden kann, solange Tage mit unbestätigten Pausen offen sind."
  changes={changeCount}
  errors={0}
  {saving}
  saveLabel="Einstellung speichern"
  onSave={save}
  onDiscard={discard}
>
  <Note tone="info">
    {#if confirmationOn}
      Die Pausen-Bestätigung ist eingeschaltet. Du stellst sie unter
      <a href={breaksHref}>{breaksLabel}</a> ein.
    {:else}
      Die Pausen-Bestätigung ist ausgeschaltet, deshalb wirkt diese Einstellung noch nicht. Schalte
      sie unter <a href={breaksHref}>{breaksLabel}</a> ein.
    {/if}
  </Note>

  <ToggleField
    bind:checked={values.blockMonthCloseOnUnconfirmedBreak}
    label="Abschluss bei offenen Pausenbefunden sperren"
    help="Ist das ausgeschaltet, erscheint bei offenen Pausenbefunden nur eine Warnung."
    disabled={!canEdit || saving || !confirmationOn}
    testid="monatsabschluss-blockMonthCloseOnUnconfirmedBreak"
  />
</SettingsGroup>
