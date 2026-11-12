<script lang="ts">
  // Issue #853 (D-853-14, D-853-18, D-853-19) - Team › Personen: the read-only team directory for leaders,
  // drawn after the prototype's Personen screen. A page created by #853 (no route file to reroute). The data
  // is exactly `GET /employees`: the server narrows the list to the caller's reach (#547) and masks the
  // saldo without `overtime:read`; this page decides nothing about either. Read-only: no write call, no
  // e-mail column, no edit actions (Verwalten › Personen does that). The header salon narrows the list
  // through `salonPageFilter` (#558), never the store's raw selection. Search, filters and sort live in the
  // URL (`urlState`); status, filter, sort and the count sentence come from `personen-model.ts`.
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenTeamPage } from "$lib/nav/team-nav";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import { avatarIndex, initialsOf } from "$components/ui/ListRow.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope";
  import { urlState } from "$lib/table/url-state";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import { scheduleModelLabel } from "$lib/employees/contract-history";
  import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";
  import {
    activeCount,
    activeCountSentence,
    filterPersonen,
    personenRows,
    sortPersonen,
    type PersonenEmployee,
    type PersonenSortKey,
  } from "$lib/team/personen-model";
  import { PERSONEN_VERTRAG_CODES, personenUrlSchema } from "$lib/team/personen-url-state";

  let people: PersonenEmployee[] = $state([]);
  let loading = $state(true);
  let failed = $state(false);
  let salonRejected = $state(false);

  // Waits for the salon context so the first request is already filtered; reloads when the header salon
  // changes. The effect reads primitive deriveds only.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  // Presentation only: the salon name of the head sentence is never compared or sent anywhere.
  const pageSalonName = $derived(
    pageSalonId === null
      ? null
      : ($salonContext.salons.find((salon) => salon.id === pageSalonId)?.name ?? null),
  );
  // Plain let: an older response never overwrites a newer one (not reactive on purpose).
  let generation = 0;

  async function load() {
    const current = ++generation;
    loading = true;
    failed = false;
    try {
      const list = await api.get<PersonenEmployee[]>(withSalonId("/employees", pageSalonId));
      if (current !== generation) return;
      people = list;
      salonRejected = false;
    } catch (e: unknown) {
      if (current !== generation) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: a calm text, no error state.
        people = [];
        salonRejected = true;
      } else {
        failed = true;
      }
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    untrack(() => {
      void load();
    });
  });

  // ── Table state in the URL (T-853-21) ───────────────────────────────────────
  // `filterSearch` is the toolbar's normalised input; the URL carries the parsed value. A fast typist
  // writes "a", "ab" before the first navigation lands - the echo of "a" must not overwrite the input,
  // so values written by this page are remembered until their echo comes back.
  const listUrl = urlState(personenUrlSchema);
  const view = $derived(listUrl.read());
  let filterSearch = $state(listUrl.read().q);
  let pendingEchoes: string[] = [];
  function onSearchInput(value: string) {
    filterSearch = value;
    const next = personenUrlSchema.q.parse(value);
    if (next === listUrl.read().q) return;
    pendingEchoes = [...pendingEchoes, next];
    listUrl.write({ q: next });
  }
  $effect(() => {
    const q = view.q;
    untrack(() => {
      const index = pendingEchoes.indexOf(q);
      if (index >= 0) {
        pendingEchoes = pendingEchoes.slice(index + 1);
        return;
      }
      // A change the page did not write itself (back/forward, a link): the input follows the URL.
      pendingEchoes = [];
      if (personenUrlSchema.q.parse(filterSearch) !== q) filterSearch = q;
    });
  });

  const toolbarFilters = $derived<ToolbarFilter[]>([
    {
      key: "status",
      label: "Status",
      options: [{ value: "aktiv", label: "Aktiv" }],
      value: view.status === "aktiv" ? "aktiv" : "",
    },
    {
      key: "vertrag",
      label: "Vertrag",
      options: PERSONEN_VERTRAG_CODES.map((code) => ({
        value: code,
        label: scheduleModelLabel(code),
      })),
      value: view.vertrag,
    },
  ]);
  function onFilterChange(key: string, value: string) {
    if (key === "status") listUrl.write({ status: value === "aktiv" ? "aktiv" : "alle" });
    else if (key === "vertrag") listUrl.write({ vertrag: personenUrlSchema.vertrag.parse(value) });
  }
  // One URL write back to the default view (Status: Aktiv, no search, no Vertrag).
  function resetFilters() {
    filterSearch = "";
    listUrl.write({ q: "", status: "aktiv", vertrag: "" });
  }

  const tableSort = $derived<DataTableSort>({ key: view.sort, dir: view.dir });
  // The cycle none -> asc -> desc -> none of a column head; „none“ is the default (name, ascending).
  function onSort(next: DataTableSort | null) {
    if (next === null) listUrl.write({ sort: "name", dir: "asc" });
    else listUrl.write({ sort: next.key as PersonenSortKey, dir: next.dir });
  }

  // ── Rows ────────────────────────────────────────────────────────────────────
  // Browser-local calendar day: the web has no tenant-local "today" helper.
  const today = localCalendarDay();
  const allRows = $derived(personenRows(people, today));
  const shownRows = $derived(
    sortPersonen(
      filterPersonen(allRows, { q: view.q, status: view.status, vertrag: view.vertrag }),
      { key: view.sort, dir: view.dir },
    ),
  );
  const filtersActive = $derived(view.q !== "" || view.status === "aktiv" || view.vertrag !== "");
  const headSentence = $derived(
    loading || failed || salonRejected
      ? undefined
      : activeCountSentence(activeCount(allRows), pageSalonName),
  );

  // A row leads to the person's Zeiten only for a caller who may open that page (T-853-22); Zeiten
  // re-validates the id against its own list and the API guards apply.
  const mayOpenZeiten = $derived(mayOpenTeamPage("/team/zeiten", $authStore.user));
  function zeitenHref(id: string): string {
    return `/team/zeiten?employeeId=${encodeURIComponent(id)}`;
  }

  // The saldo column exists only when the server sent a value for at least one row (no column of dashes).
  const showSaldo = $derived(allRows.some((row) => row.balanceMinutes !== null));

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Name", primary: true, sortable: true },
    { key: "vertrag", label: "Vertrag", sortable: true },
    { key: "stunden", label: "Std./Woche", sortable: true, align: "end" },
    ...(showSaldo ? [{ key: "saldo", label: "Saldo", sortable: true, align: "end" as const }] : []),
    { key: "status", label: "Status", sortable: true },
    ...(mayOpenZeiten ? [{ key: "open", label: "Zeiten", align: "end" as const }] : []),
  ]);
</script>

<svelte:head>
  <title>{pageLabel("/team/personen")} – Clokr</title>
</svelte:head>

<PageHead title={pageLabel("/team/personen")} sub={headSentence} />

<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />

{#if failed}
  <ErrorState onRetry={() => void load()} retrying={loading} />
{:else}
  <DataTable
    {columns}
    rows={shownRows}
    rowKey={(row) => row.id}
    rowTestId={(row) => `team-person-${row.id}`}
    sort={tableSort}
    {onSort}
    filtered={filtersActive && allRows.length > 0}
    onResetFilters={resetFilters}
    onRowClick={mayOpenZeiten ? (row) => goto(zeitenHref(row.id)) : undefined}
    {loading}
    caption="Personen"
  >
    {#snippet toolbar()}
      <TableToolbar
        bind:query={() => filterSearch, onSearchInput}
        count={shownRows.length}
        total={allRows.length}
        filters={toolbarFilters}
        {onFilterChange}
        onReset={resetFilters}
        searchLabel="Name oder Nummer"
      />
    {/snippet}
    {#snippet cell(row, column)}
      {#if column.key === "name"}
        <span class="p-name">
          <span
            class="p-avatar"
            style="--av: var(--a{avatarIndex(row.name)}); --av-t: var(--a{avatarIndex(row.name)}-t)"
            aria-hidden="true">{initialsOf(row.name)}</span
          >
          <span class="p-text">
            <span class="p-title">{row.name}</span>
            <span class="p-number">{row.number}</span>
          </span>
        </span>
      {:else if column.key === "vertrag"}
        {row.modelLabel}
      {:else if column.key === "stunden"}
        <span class="p-figure">
          {row.weeklyHours === null ? "–" : fmtMin(Math.round(row.weeklyHours * 60))}
        </span>
      {:else if column.key === "saldo"}
        <span class="p-figure">
          {row.balanceMinutes === null ? "–" : fmtBalance(row.balanceMinutes)}
        </span>
      {:else if column.key === "status"}
        <Chip tone={row.statusTone}>{row.statusLabel}</Chip>
      {:else if column.key === "open"}
        <a class="p-open" href={zeitenHref(row.id)} aria-label="Zeiten von {row.name} öffnen"
          >Öffnen</a
        >
      {/if}
    {/snippet}
  </DataTable>
{/if}

<style>
  .p-name {
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    min-width: 0;
  }

  .p-avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--av);
    color: var(--av-t);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .p-text {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
    text-align: start;
  }

  .p-title {
    font-weight: 600;
    color: var(--text);
  }

  .p-number {
    color: var(--text-3);
    font-size: var(--fs-xs);
    font-weight: 400;
  }

  .p-figure {
    font-variant-numeric: tabular-nums;
  }

  .p-open {
    color: var(--brand);
    font-weight: 600;
    text-decoration: none;
  }

  .p-open:hover {
    text-decoration: underline;
  }
</style>
