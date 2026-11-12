<!--
  BetriebsurlaubPanel - the „Betriebsurlaub“ tab of Verwalten › Regeln › Abwesenheiten (Issue #854, rebuilt on
  the blocks of #843; the data and the endpoints are those of the pre-#854 list). A management section without
  configuration keys of its own (registry section `abwesenheiten-betriebsurlaub`).

  Loads `GET /company-shutdowns?year=` itself, the first time the tab is shown and again when the year changes.
  Writes are `POST /company-shutdowns` (a Dialog) and `DELETE /company-shutdowns/:id` (behind a ConfirmDialog);
  each acts at once and answers with a toast (docs/ADMIN_STRUCTURE.md §3.2.1: a list action saves instantly,
  there is no section button). A row opens the shutdown's detail sub-route, where period, notes and exceptions
  are edited. The API refuses a write in a locked month; its text is shown as the server worded it.

  Props:
    active - true while the tab is the selected one
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import ToggleField from "$lib/components/admin/settings/ToggleField.svelte";
  import {
    createShutdownBody,
    dayCountLabel,
    exceptionCountLabel,
    formatShutdownDate,
    shutdownFormMessage,
    shutdownYears,
    type CompanyShutdown,
  } from "$lib/settings/betriebsurlaub";

  interface Props {
    active: boolean;
  }

  let { active }: Props = $props();

  const columns: DataTableColumn[] = [
    { key: "name", label: "Bezeichnung", primary: true },
    { key: "period", label: "Zeitraum" },
    { key: "deduction", label: "Urlaubskonto" },
    { key: "exceptions", label: "Ausnahmen" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  const years = shutdownYears(new Date().getFullYear());
  let filterYear = $state(String(new Date().getFullYear()));

  let shutdowns = $state<CompanyShutdown[]>([]);
  let loading = $state(false);
  let loadError = $state("");
  let loaded = false;

  async function loadShutdowns() {
    loading = true;
    loadError = "";
    try {
      shutdowns = await api.get<CompanyShutdown[]>(`/company-shutdowns?year=${filterYear}`);
    } catch (err) {
      console.error(err);
      loadError = "Der Betriebsurlaub konnte nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  // Lazy load on the first visit of the tab.
  $effect(() => {
    if (active && !loaded) {
      loaded = true;
      void loadShutdowns();
    }
  });

  // ── Create ────────────────────────────────────────────────────
  let createOpen = $state(false);
  let name = $state("");
  let startDate = $state("");
  let endDate = $state("");
  let deductsFromVacation = $state(true);
  let notes = $state("");
  let formError = $state("");
  let saving = $state(false);

  function openCreate() {
    name = "";
    startDate = "";
    endDate = "";
    deductsFromVacation = true;
    notes = "";
    formError = "";
    createOpen = true;
  }

  // Runs inside the Dialog's form: a refusal keeps the dialog open with its text.
  async function saveNew() {
    const message = shutdownFormMessage({ name, startDate, endDate });
    if (message !== null) {
      formError = message;
      return;
    }
    saving = true;
    formError = "";
    try {
      const created = await api.post<CompanyShutdown>(
        "/company-shutdowns",
        createShutdownBody({ name, startDate, endDate, deductsFromVacation, notes }),
      );
      toasts.success("Betriebsurlaub angelegt.");
      createOpen = false;
      await goto(`/verwalten/regeln/betriebsurlaub/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        formError = err.message;
      } else {
        toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
      }
    } finally {
      saving = false;
    }
  }

  // ── Delete ────────────────────────────────────────────────────
  let deleteConfirm = $state<{ open: boolean; id: string | null; name: string }>({
    open: false,
    id: null,
    name: "",
  });

  function askDelete(shutdown: CompanyShutdown) {
    deleteConfirm = { open: true, id: shutdown.id, name: shutdown.name };
  }

  async function confirmDelete() {
    if (!deleteConfirm.id) return;
    try {
      await api.delete(`/company-shutdowns/${deleteConfirm.id}`);
      toasts.success("Betriebsurlaub gelöscht.");
      await loadShutdowns();
    } catch {
      toasts.error(
        "Betriebsurlaub konnte nicht gelöscht werden. Lade die Seite neu und versuche es noch einmal.",
      );
    }
  }

  function open(shutdown: CompanyShutdown) {
    void goto(`/verwalten/regeln/betriebsurlaub/${shutdown.id}`);
  }
</script>

<section class="settings-group" aria-labelledby="abwesenheiten-betriebsurlaub-title">
  <h2 class="settings-group-title" id="abwesenheiten-betriebsurlaub-title">Betriebsurlaub</h2>
  <p class="settings-group-desc">
    Zeiträume, in denen der ganze Betrieb geschlossen hat. Ein Betriebsurlaub kann vom Urlaubskonto
    abgezogen werden; einzelne Mitarbeitende nimmst du in der Ansicht des Betriebsurlaubs aus.
  </p>

  <div class="bu-bar">
    <FormField label="Jahr">
      {#snippet field({ id, describedBy })}
        <select
          {id}
          class="form-input bu-year"
          bind:value={filterYear}
          onchange={loadShutdowns}
          aria-describedby={describedBy}
          data-testid="abwesenheiten-betriebsurlaub-year"
        >
          {#each years as year (year)}
            <option value={year}>{year}</option>
          {/each}
        </select>
      {/snippet}
    </FormField>
    <button type="button" class="btn btn-primary" onclick={openCreate}>
      Betriebsurlaub anlegen
    </button>
  </div>

  {#if loadError}
    <ErrorState message={loadError} onRetry={loadShutdowns} retrying={loading} />
  {:else if loading && shutdowns.length === 0}
    <Skeleton shape="card" count={1} lines={4} />
  {:else if shutdowns.length === 0}
    <EmptyState
      icon="calendar"
      title="Keine Betriebsurlaube"
      description={`Für ${filterYear} ist kein Betriebsurlaub angelegt.`}
      actionLabel="Ersten Betriebsurlaub anlegen"
      onaction={openCreate}
    />
  {:else}
    <DataTable
      {columns}
      rows={shutdowns}
      rowKey={(row) => row.id}
      onRowClick={open}
      caption={`Betriebsurlaub ${filterYear} mit Zeitraum, Urlaubskonto und Ausnahmen`}
    >
      {#snippet cell(row, column)}
        {#if column.key === "period"}
          {formatShutdownDate(row.startDate)} – {formatShutdownDate(row.endDate)}
          <span class="bu-days">{dayCountLabel(row.startDate, row.endDate)}</span>
        {:else if column.key === "deduction"}
          <Chip tone={row.deductsFromVacation ? "warn" : "neutral"}>
            {row.deductsFromVacation ? "Zieht vom Urlaubskonto ab" : "Kein Urlaubsabzug"}
          </Chip>
        {:else if column.key === "exceptions"}
          {#if row.exceptions.length > 0}
            <Chip tone="info">{exceptionCountLabel(row.exceptions.length)}</Chip>
          {:else}
            –
          {/if}
        {:else if column.key === "actions"}
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-danger"
            onclick={() => askDelete(row)}
          >
            Löschen
          </button>
        {:else}
          {row.name}
          {#if row.notes}
            <span class="bu-notes">{row.notes}</span>
          {/if}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</section>

<Dialog bind:open={createOpen} title="Betriebsurlaub anlegen">
  <form
    id="company-shutdown-form"
    novalidate
    class="bu-form"
    onsubmit={(event) => {
      event.preventDefault();
      void saveNew();
    }}
  >
    <FormField label="Bezeichnung" required>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={200}
          placeholder="z. B. Weihnachtsschließung 2026"
          bind:value={name}
          data-testid="abwesenheiten-betriebsurlaub-name"
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    <div class="bu-dates">
      <FormField label="Startdatum" required>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="date"
            bind:value={startDate}
            data-testid="abwesenheiten-betriebsurlaub-start"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Enddatum" required>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="date"
            bind:value={endDate}
            data-testid="abwesenheiten-betriebsurlaub-end"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    <ToggleField
      bind:checked={deductsFromVacation}
      label="Vom Urlaubskonto abziehen"
      help="Der Betriebsurlaub wird automatisch vom Jahresurlaub der Mitarbeitenden abgezogen, außer bei Ausnahmen."
      testid="abwesenheiten-betriebsurlaub-deducts"
    />
    <FormField label="Notiz">
      {#snippet field({ id, describedBy })}
        <textarea
          {id}
          class="form-input"
          rows="2"
          placeholder="Interne Anmerkung (optional)"
          bind:value={notes}
          data-testid="abwesenheiten-betriebsurlaub-notes"
          aria-describedby={describedBy}
        ></textarea>
      {/snippet}
    </FormField>
    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (createOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="company-shutdown-form" class="btn btn-primary" disabled={saving}>
      {saving ? "Speichern …" : "Anlegen"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={deleteConfirm.open}
  title="Betriebsurlaub löschen?"
  description={`„${deleteConfirm.name}“ wird entfernt. Diese Aktion kann nicht rückgängig gemacht werden.`}
  confirmLabel="Löschen"
  danger
  onConfirm={confirmDelete}
/>

<style>
  .bu-bar {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin-bottom: var(--s-3);
  }

  .bu-year {
    width: auto;
    min-width: 6rem;
  }

  .bu-days {
    margin-left: var(--s-2);
    color: var(--text-2);
  }

  .bu-notes {
    display: block;
    margin-top: var(--s-1);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .bu-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .bu-dates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--s-4);
  }
</style>
