<!--
  SalonHolidays - the „Feiertage“ section of the salon detail page (Issue #579).

  Reads `GET /holidays?salonId&year` (the merged calendar of ONE salon: statutory holidays are
  computed from the salon's Bundesland and read-only, manual rows are `PublicHoliday` entries) and
  writes through `POST /holidays` (salonId, date, name) and `DELETE /holidays/:id`. The component
  computes no holiday itself and decides nothing about access: `canManage` only hides the controls,
  the API refuses a write without `holiday:manage` on its own.

  Props:
    salonId   - the salon whose calendar is shown
    canManage - show the add form and the remove buttons (presentation only)
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "$api/client";
  import { toasts } from "$stores/toast";
  import Section from "$lib/components/admin/Section.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  /** One item of `GET /holidays`; `isManual` separates the two lists, the id is real only if manual. */
  export interface SalonHolidayDto {
    id: string;
    date: string;
    name: string;
    isManual: boolean;
  }

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

  let newDate = $state("");
  let newName = $state("");
  let formError = $state("");
  let adding = $state(false);

  let removeTarget: SalonHolidayDto | null = $state(null);
  let removeOpen = $state(false);

  const statutory = $derived(items.filter((h) => !h.isManual));
  const manual = $derived(items.filter((h) => h.isManual));

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
    formError = "";
    newDate = "";
    void load();
  }

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
    if (manual.some((h) => h.date === newDate)) {
      formError = "An diesem Tag gibt es bereits einen manuellen Feiertag.";
      return;
    }
    formError = "";
    adding = true;
    try {
      await api.post("/holidays", { salonId, date: newDate, name });
      toasts.success("Feiertag hinzugefügt.");
      newDate = "";
      newName = "";
      await load();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Hinzufügen fehlgeschlagen.");
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

<Section
  title="Feiertage"
  sub="Die gesetzlichen Feiertage ergeben sich aus dem Bundesland des Salons. Hier pflegst du zusätzliche Feiertage, die nur für diesen Salon gelten."
>
  <div class="sh-year">
    <label class="form-label" for="salon-holidays-year">Jahr</label>
    <select
      id="salon-holidays-year"
      class="form-input sh-year-select"
      value={String(year)}
      onchange={changeYear}
    >
      {#each YEARS as option (option)}
        <option value={String(option)}>{option}</option>
      {/each}
    </select>
  </div>

  {#if loading}
    <p class="sh-note" role="status">Laden…</p>
  {:else if loadError}
    <div class="callout error" role="alert">{loadError}</div>
  {:else}
    <h3 class="sh-heading">Zusätzliche Feiertage dieses Salons</h3>
    {#if manual.length === 0}
      <p class="sh-note">Für {year} sind keine zusätzlichen Feiertage eingetragen.</p>
    {:else}
      <ul class="sh-list" aria-label="Zusätzliche Feiertage {year}">
        {#each manual as holiday (holiday.id)}
          <li class="sh-item">
            <span class="sh-date">{formatDay(holiday.date)}</span>
            <span class="sh-name">{holiday.name}</span>
            {#if canManage}
              <button
                type="button"
                class="btn btn-ghost btn-sm btn-danger"
                aria-label="Feiertag {holiday.name} am {formatDay(holiday.date)} entfernen"
                onclick={() => askRemove(holiday)}
              >
                Entfernen
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if canManage}
      <form
        class="sh-add"
        onsubmit={(event) => {
          event.preventDefault();
          void addHoliday();
        }}
      >
        <div class="form-group">
          <label class="form-label" for="salon-holiday-date">Datum</label>
          <input
            id="salon-holiday-date"
            class="form-input"
            type="date"
            bind:value={newDate}
            min="{year}-01-01"
            max="{year}-12-31"
            aria-invalid={formError ? "true" : undefined}
            aria-describedby={formError ? "salon-holiday-error" : undefined}
          />
        </div>
        <div class="form-group sh-add-name">
          <label class="form-label" for="salon-holiday-name">Bezeichnung</label>
          <input
            id="salon-holiday-name"
            class="form-input"
            type="text"
            maxlength={100}
            bind:value={newName}
            aria-invalid={formError ? "true" : undefined}
            aria-describedby={formError ? "salon-holiday-error" : undefined}
          />
        </div>
        <button type="submit" class="btn btn-primary btn-sm" disabled={adding}>
          {adding ? "Hinzufügen …" : "Feiertag hinzufügen"}
        </button>
      </form>
      {#if formError}
        <p class="form-error" id="salon-holiday-error">{formError}</p>
      {/if}
    {/if}

    <h3 class="sh-heading">Gesetzliche Feiertage und Firmenregeln</h3>
    {#if statutory.length === 0}
      <p class="sh-note">Für {year} gibt es keine gesetzlichen Feiertage.</p>
    {:else}
      <ul class="sh-list" aria-label="Gesetzliche Feiertage {year}">
        {#each statutory as holiday (holiday.id)}
          <li class="sh-item">
            <span class="sh-date">{formatDay(holiday.date)}</span>
            <span class="sh-name">{holiday.name}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

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
</Section>

<style>
  .sh-year {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    margin-bottom: var(--s-4);
  }

  .sh-year-select {
    width: auto;
  }

  .sh-heading {
    margin: var(--s-4) 0 var(--s-2);
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }

  .sh-note {
    color: var(--text-muted);
    font-size: 14px;
  }

  .sh-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .sh-item {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  .sh-date {
    flex: 0 0 9.5rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .sh-name {
    flex: 1 1 auto;
    min-width: 0;
  }

  .sh-add {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--s-3);
    margin-top: var(--s-4);
  }

  .sh-add-name {
    flex: 1 1 14rem;
  }

  @media (max-width: 480px) {
    .sh-item {
      flex-wrap: wrap;
      gap: var(--s-2);
    }

    .sh-date {
      flex-basis: 100%;
    }
  }
</style>
