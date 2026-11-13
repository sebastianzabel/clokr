<!--
  SonderurlaubPanel - the „Sonderurlaub“ tab of Verwalten › Regeln › Abwesenheiten (Issue #854, rebuilt on the
  blocks of #843; the data and the endpoints are those of the pre-#854 page). A management section without
  configuration keys of its own (registry section `abwesenheiten-sonderurlaub`).

  Loads `GET /special-leave/rules` itself, the first time the tab is shown (a person who never opens it costs no
  request). Writes are `POST /special-leave/rules` and `PUT /special-leave/rules/:id`; each acts at once and
  answers with a toast (docs/ADMIN_STRUCTURE.md §3.2.1: a list action saves instantly, there is no section
  button). A rule is created and edited in a Dialog; the name of a statutory rule (§ 616 BGB) cannot be changed.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    RULE_DAYS_MAX,
    RULE_DAYS_MIN,
    ruleDaysMessage,
    type SpecialLeaveRule,
  } from "$lib/settings/sonderurlaub";

  interface Props {
    active: boolean;
  }

  let { active }: Props = $props();

  const columns: DataTableColumn[] = [
    { key: "name", label: "Anlass", primary: true },
    { key: "days", label: "Tage" },
    { key: "proof", label: "Nachweis" },
    { key: "kind", label: "Art" },
    { key: "status", label: "Status" },
  ];

  let rules = $state<SpecialLeaveRule[]>([]);
  let loading = $state(false);
  let loadError = $state("");
  let loaded = false;

  async function loadRules() {
    loading = true;
    loadError = "";
    try {
      rules = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
    } catch (err) {
      console.error(err);
      loadError = "Die Sonderurlaubsregeln konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  // Lazy load on the first visit of the tab.
  $effect(() => {
    if (active && !loaded) {
      loaded = true;
      void loadRules();
    }
  });

  // ── Editor ────────────────────────────────────────────────────
  let editorOpen = $state(false);
  let editing = $state<SpecialLeaveRule | null>(null);
  let name = $state("");
  let reason = $state("");
  let days = $state<number | null>(1);
  let requiresProof = $state(false);
  let isActive = $state(true);
  let formError = $state("");
  let saving = $state(false);

  const statutory = $derived(editing?.isStatutory === true);

  function openCreate() {
    editing = null;
    name = "";
    reason = "";
    days = 1;
    requiresProof = false;
    isActive = true;
    formError = "";
    editorOpen = true;
  }

  function openEdit(rule: SpecialLeaveRule) {
    editing = rule;
    name = rule.name;
    reason = rule.reason ?? "";
    days = Number(rule.defaultDays);
    requiresProof = rule.requiresProof;
    isActive = rule.isActive;
    formError = "";
    editorOpen = true;
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function saveRule() {
    if (editing === null && !name.trim()) {
      formError = "Gib den Anlass an.";
      return;
    }
    const daysMessage = ruleDaysMessage(days);
    if (daysMessage !== null) {
      formError = daysMessage;
      return;
    }
    saving = true;
    formError = "";
    const creating = editing === null;
    try {
      if (editing === null) {
        await api.post("/special-leave/rules", {
          name: name.trim(),
          reason: reason.trim() || undefined,
          defaultDays: days,
          requiresProof,
        });
      } else {
        await api.put(`/special-leave/rules/${editing.id}`, {
          name: editing.isStatutory ? undefined : name.trim() || undefined,
          reason: reason.trim() || null,
          defaultDays: days,
          requiresProof,
          isActive,
        });
      }
      toasts.success(creating ? "Regel angelegt." : "Regel gespeichert.");
      editorOpen = false;
      editing = null;
      await loadRules();
    } catch (err) {
      // A refusal of the API is shown as the server worded it; anything else is a toast.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        formError = err.message;
      } else {
        toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
      }
    } finally {
      saving = false;
    }
  }
</script>

<section class="settings-group" aria-labelledby="abwesenheiten-sonderurlaub-title">
  <h2 class="settings-group-title" id="abwesenheiten-sonderurlaub-title">Sonderurlaubs-Regeln</h2>
  <p class="settings-group-desc">
    Gesetzliche Anlässe (§ 616 BGB) werden automatisch angelegt. Tage und Nachweispflicht kannst du
    anpassen und zusätzliche betriebliche Anlässe hinzufügen.
  </p>

  <div class="su-bar">
    <button type="button" class="btn btn-primary" onclick={openCreate}>Regel anlegen</button>
  </div>

  {#if loadError}
    <ErrorState message={loadError} onRetry={loadRules} retrying={loading} />
  {:else if loading && rules.length === 0}
    <Skeleton shape="card" count={1} lines={4} />
  {:else if rules.length === 0}
    <EmptyState
      icon="calendar"
      title="Noch keine Sonderurlaubsregeln"
      description="Lege einen betrieblichen Anlass an, z. B. einen ehrenamtlichen Einsatz."
    />
  {:else}
    <DataTable
      {columns}
      rows={rules}
      rowKey={(row) => row.id}
      onRowClick={openEdit}
      caption="Sonderurlaubsregeln mit Tagen, Nachweis, Art und Status"
    >
      {#snippet cell(row, column)}
        {#if column.key === "days"}
          {Number(row.defaultDays)}
        {:else if column.key === "proof"}
          {row.requiresProof ? "Ja" : "Nein"}
        {:else if column.key === "kind"}
          <Chip tone={row.isStatutory ? "neutral" : "brand"}>
            {row.isStatutory ? "Gesetzlich" : "Betrieblich"}
          </Chip>
        {:else if column.key === "status"}
          <Chip tone={row.isActive ? "ok" : "neutral"}>
            {row.isActive ? "Aktiv" : "Deaktiviert"}
          </Chip>
        {:else}
          {row.name}
          {#if row.reason}
            <span class="su-reason">{row.reason}</span>
          {/if}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<Dialog
  bind:open={editorOpen}
  title={editing === null
    ? "Sonderurlaubsregel anlegen"
    : statutory
      ? "Gesetzliche Regel bearbeiten"
      : "Betriebliche Regel bearbeiten"}
>
  <form
    id="special-leave-form"
    novalidate
    class="su-form"
    onsubmit={(event) => {
      event.preventDefault();
      void saveRule();
    }}
  >
    <FormField
      label="Anlass"
      required
      help={statutory ? "Der Name gesetzlicher Regeln kann nicht geändert werden." : undefined}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={100}
          placeholder="z. B. Ehrenamtlicher Einsatz"
          bind:value={name}
          disabled={statutory}
          data-testid="abwesenheiten-sonderurlaub-name"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <FormField label="Beschreibung">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={500}
          placeholder="Optional"
          bind:value={reason}
          data-testid="abwesenheiten-sonderurlaub-reason"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <FormField label="Anzahl Tage" required>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input su-days"
          type="number"
          min={RULE_DAYS_MIN}
          max={RULE_DAYS_MAX}
          step="0.5"
          bind:value={days}
          data-testid="abwesenheiten-sonderurlaub-days"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <ToggleField
      bind:checked={requiresProof}
      label="Nachweis erforderlich"
      testid="abwesenheiten-sonderurlaub-proof"
    />
    {#if editing !== null}
      <ToggleField
        bind:checked={isActive}
        label="Regel ist aktiv"
        help="Eine deaktivierte Regel steht bei neuen Anträgen nicht mehr zur Auswahl."
        testid="abwesenheiten-sonderurlaub-active"
      />
    {/if}
    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (editorOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="special-leave-form" class="btn btn-primary" disabled={saving}>
      {saving ? "Speichern …" : "Speichern"}
    </button>
  {/snippet}
</Dialog>

<style>
  .su-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }

  .su-reason {
    display: block;
    margin-top: var(--s-1);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .su-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .su-days {
    max-width: 9rem;
  }
</style>
