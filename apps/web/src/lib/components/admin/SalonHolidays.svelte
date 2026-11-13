<!--
  SalonHolidays - the „Feiertage“ section of the salon detail page (Issue #579, rebuilt on the
  blocks of #843 by Issue #854).

  Reads `GET /holidays?salonId&year` (the merged calendar of ONE salon: statutory holidays are
  computed from the salon's Bundesland and read-only, manual rows are `PublicHoliday` entries) and
  writes through `POST /holidays` (salonId, date, name) and `DELETE /holidays/:id`. The component
  computes no holiday itself and decides nothing about access: `canManage` only hides the controls,
  the API refuses a write without `holiday:manage` on its own.

  Every holiday write acts at once and acknowledges itself with a toast: adding goes through a
  Dialog, removing through a ConfirmDialog (docs/ADMIN_STRUCTURE.md §3.2.1: a list action saves
  instantly, there is no section button).

  Props:
    salonId   - the salon whose calendar is shown
    canManage - show the add and remove controls (presentation only)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  /** One item of `GET /holidays`; `isManual` separates the two lists, the id is real only if manual. */
  export type SalonHolidayDto = {
    id: string;
    date: string;
    name: string;
    isManual: boolean;
  };

  interface Props {
    salonId: string;
    canManage: boolean;
  }

  let { salonId, canManage }: Props = $props();

  const thisYear = new Date().getFullYear();
  const YEARS = [thisYear - 1, thisYear, thisYear + 1, thisYear + 2];

  let year = $state(thisYear);
  let items: SalonHolidayDto[] = $state([]);
  let loading = $state(true);
  let loadError = $state("");

  let addOpen = $state(false);
  let newDate = $state<string | null>(null);
  let newName = $state("");
  let formError = $state("");
  let adding = $state(false);

  let removeTarget: SalonHolidayDto | null = $state(null);
  let removeOpen = $state(false);

  const statutory = $derived(items.filter((h) => !h.isManual));
  const manual = $derived(items.filter((h) => h.isManual));

  const manualColumns = $derived<DataTableColumn[]>([
    { key: "date", label: "Datum" },
    { key: "name", label: "Bezeichnung", primary: true },
    ...(canManage ? [{ key: "actions", label: "Aktion", align: "end" as const }] : []),
  ]);
  const statutoryColumns: DataTableColumn[] = [
    { key: "date", label: "Datum" },
    { key: "name", label: "Bezeichnung", primary: true },
  ];

  const dateFormat = new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });

  /** Formats the calendar day `YYYY-MM-DD` without a time zone shift. */
  function formatDay(day: string): string {
    return dateFormat.format(new Date(`${day}T00:00:00Z`));
  }

  async function load() {
    loading = true;
    loadError = "";
    try {
      items = await api.get<SalonHolidayDto[]>(`/holidays?salonId=${salonId}&year=${year}`);
    } catch (err) {
      items = [];
      loadError =
        err instanceof ApiError && err.status === 404
          ? "Salon nicht gefunden."
          : "Die Feiertage konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function changeYear(event: Event) {
    year = Number((event.currentTarget as HTMLSelectElement).value);
    void load();
  }

  function openAdd() {
    newDate = null;
    newName = "";
    formError = "";
    addOpen = true;
  }

  // Runs inside the Dialog's submit: a client-side refusal keeps the dialog open with its text.
  async function addHoliday() {
    const name = newName.trim();
    if (!newDate) {
      formError = "Bitte wähle ein Datum.";
      return;
    }
    if (!newDate.startsWith(`${year}-`)) {
      formError = `Das Datum muss im Jahr ${year} liegen.`;
      return;
    }
    if (!name) {
      formError = "Bitte gib eine Bezeichnung ein.";
      return;
    }
    if (name.length > 100) {
      formError = "Die Bezeichnung darf höchstens 100 Zeichen lang sein.";
      return;
    }
    formError = "";
    adding = true;
    try {
      await api.post("/holidays", { salonId, date: newDate, name });
      toasts.success("Feiertag hinzugefügt.");
      addOpen = false;
      await load();
    } catch (err) {
      // A refusal of the API (e.g. a second holiday on the same day) is shown as the server worded it.
      if (err instanceof ApiError && (err.status === 409 || err.status === 400)) {
        formError = err.message;
      } else {
        toasts.error(err instanceof Error ? err.message : "Hinzufügen fehlgeschlagen.");
      }
    } finally {
      adding = false;
    }
  }

  function askRemove(holiday: SalonHolidayDto) {
    removeTarget = holiday;
    removeOpen = true;
  }

  // Runs inside ConfirmDialog: a refusal toasts the server's text and is rethrown, so the dialog
  // swallows it and stays open.
  async function removeHoliday() {
    if (!removeTarget) return;
    try {
      await api.delete(`/holidays/${removeTarget.id}`);
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Entfernen fehlgeschlagen.");
      throw err;
    }
    toasts.success("Feiertag entfernt.");
    await load();
  }
</script>

<section class="settings-group" aria-labelledby="salon-holidays-title">
  <h2 class="settings-group-title" id="salon-holidays-title">Feiertage</h2>
  <Note tone="info"
    >Die gesetzlichen Feiertage ergeben sich aus dem Bundesland des Salons. Hier pflegst du
    zusätzliche Feiertage, die nur für diesen Salon gelten.</Note
  >

  <div class="sh-bar">
    <div class="sh-year">
      <FormField label="Jahr">
        {#snippet field({ id, describedBy, invalid })}
          <select
            {id}
            class="form-input"
            value={String(year)}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
            onchange={changeYear}
          >
            {#each YEARS as option (option)}
              <option value={String(option)}>{option}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    </div>
    {#if canManage}
      <button type="button" class="btn btn-primary" onclick={openAdd}>Feiertag hinzufügen</button>
    {/if}
  </div>

  {#if loading}
    <Skeleton shape="row" count={3} />
  {:else if loadError}
    <div role="alert"><Note tone="bad">{loadError}</Note></div>
  {:else}
    <h3 class="sh-heading">Zusätzliche Feiertage dieses Salons</h3>
    {#if manual.length === 0}
      <EmptyState
        icon="calendar"
        title="Noch keine eigenen Feiertage"
        description="Für {year} sind keine zusätzlichen Feiertage eingetragen."
      />
    {:else}
      <DataTable
        columns={manualColumns}
        rows={manual}
        rowKey={(holiday) => holiday.id}
        caption="Zusätzliche Feiertage {year}"
      >
        {#snippet cell(holiday, column)}
          {#if column.key === "date"}
            {formatDay(holiday.date)}
          {:else if column.key === "actions"}
            <button
              type="button"
              class="btn btn-ghost btn-sm btn-danger"
              aria-label="Feiertag {holiday.name} am {formatDay(holiday.date)} entfernen"
              onclick={() => askRemove(holiday)}
            >
              Entfernen
            </button>
          {:else}
            {holiday.name}
          {/if}
        {/snippet}
      </DataTable>
    {/if}

    <h3 class="sh-heading">Gesetzliche Feiertage und Firmenregeln</h3>
    {#if statutory.length === 0}
      <EmptyState
        icon="calendar"
        title="Keine gesetzlichen Feiertage"
        description="Für {year} gibt es keine gesetzlichen Feiertage."
      />
    {:else}
      <DataTable
        columns={statutoryColumns}
        rows={statutory}
        rowKey={(holiday) => holiday.id}
        caption="Gesetzliche Feiertage {year}"
      >
        {#snippet cell(holiday, column)}
          {#if column.key === "date"}
            {formatDay(holiday.date)}
          {:else}
            {holiday.name}
          {/if}
        {/snippet}
      </DataTable>
    {/if}
  {/if}
</section>

<Dialog bind:open={addOpen} title="Feiertag hinzufügen">
  <form
    id="salon-holiday-form"
    class="sh-form"
    onsubmit={(event) => {
      event.preventDefault();
      void addHoliday();
    }}
  >
    <FormField label="Datum" required>
      {#snippet field({ id, describedBy, invalid })}
        <DatePicker
          bind:value={newDate}
          label="Datum"
          min="{year}-01-01"
          max="{year}-12-31"
          {id}
          {describedBy}
          invalid={invalid || Boolean(formError)}
        />
      {/snippet}
    </FormField>
    <FormField label="Bezeichnung" required>
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          type="text"
          maxlength={100}
          bind:value={newName}
          aria-invalid={invalid || formError ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>
    {#if formError}
      <div role="alert"><Note tone="bad">{formError}</Note></div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (addOpen = false)}>
      Abbrechen
    </button>
    <button type="submit" form="salon-holiday-form" class="btn btn-primary" disabled={adding}>
      {adding ? "Hinzufügen …" : "Hinzufügen"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={removeOpen}
  title="Feiertag entfernen?"
  description={removeTarget
    ? `„${removeTarget.name}“ am ${formatDay(removeTarget.date)} wird für diesen Salon entfernt. Die Salden werden rückwirkend neu berechnet, abgeschlossene Monate bleiben unverändert.`
    : ""}
  confirmLabel="Entfernen"
  danger
  onConfirm={removeHoliday}
/>

<style>
  .sh-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--s-3);
  }

  .sh-year {
    min-width: 8rem;
  }

  .sh-heading {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .sh-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
