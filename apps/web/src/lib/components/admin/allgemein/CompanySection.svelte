<!--
  CompanySection - „Unternehmen & Region“ of System › Allgemein (Issue #854, D-854-03): the company name, the
  default Bundesland for new salons and the time zone. One SaveBar sends exactly the three keys of the
  registry section `allgemein-unternehmen` to `PUT /settings/work` (#878). The Bundesland of a salon is set
  on the salon itself (#390, #71); the value here is only what a NEW salon inherits.

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
  import Note from "$components/ui/Note.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    FEDERAL_STATES,
    TENANT_NAME_MAX,
    TIMEZONES,
    companyFrom,
    companyMessages,
    companyWire,
    messageCount,
    type CompanyConfig,
    type CompanyField,
    type CompanyValues,
  } from "$lib/settings/allgemein";

  interface Props {
    config: CompanyConfig;
    canEdit?: boolean;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, canEdit = true, changes = $bindable(0) }: Props = $props();

  let snapshot = $state<CompanyValues>(untrack(() => companyFrom(config)));
  let values = $state<CompanyValues>(untrack(() => companyFrom(config)));
  let saving = $state(false);

  const keys = settingsSection("allgemein-unternehmen").keys as readonly CompanyField[];
  const changeCount = $derived(countChanges(snapshot, values, keys));
  const messages = $derived(companyMessages(values));
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
      const wire = companyWire(values);
      await api.put(
        "/settings/work",
        pickSection(wire as Record<string, unknown>, settingsSection("allgemein-unternehmen").keys),
      );
      values.tenantName = wire.tenantName as string;
      snapshot = $state.snapshot(values);
      toasts.success("Unternehmen und Region gespeichert.");
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
  id="unternehmen"
  title="Unternehmen & Region"
  description="Name, Bundesland-Vorgabe und Zeitzone des Unternehmens."
  changes={changeCount}
  errors={errorCount}
  {saving}
  saveLabel="Unternehmen speichern"
  onSave={save}
  onDiscard={discard}
>
  <FormField
    label="Firmenname"
    help="Wird in PDF-Exporten als Überschrift verwendet."
    error={messages.tenantName}
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        maxlength={TENANT_NAME_MAX}
        placeholder="Name des Unternehmens"
        bind:value={values.tenantName}
        disabled={!canEdit || saving}
        data-testid="admin-system-region-tenantName"
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
      />
    {/snippet}
  </FormField>

  <Note tone="info">
    Vorgabe für neu angelegte Salons. Feiertage richten sich nach dem Bundesland des jeweiligen
    Salons (<a href="/verwalten/salons">Verwalten › Salons</a>).
  </Note>

  <FormField label="Bundesland">
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input"
        bind:value={values.federalState}
        disabled={!canEdit || saving}
        data-testid="admin-system-region-federalState"
        aria-describedby={describedBy}
      >
        {#each FEDERAL_STATES as state (state.value)}
          <option value={state.value}>{state.label}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>

  <FormField label="Zeitzone" help="Zuordnung von Zeitstempeln zu Tagen.">
    {#snippet field({ id, describedBy })}
      <select
        {id}
        class="form-input"
        bind:value={values.timezone}
        disabled={!canEdit || saving}
        data-testid="admin-system-region-timezone"
        aria-describedby={describedBy}
      >
        {#each TIMEZONES as tz (tz)}
          <option value={tz}>{tz}</option>
        {/each}
      </select>
    {/snippet}
  </FormField>
</SettingsGroup>
