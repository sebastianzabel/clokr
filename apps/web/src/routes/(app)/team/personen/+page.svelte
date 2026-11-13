<script lang="ts">
  // Issue #853 (D-853-14, D-853-18, D-853-19) - Team › Personen: the read-only team directory for leaders,
  // drawn after the prototype's Personen screen. A page created by #853 (no route file to reroute). The data
  // is exactly `GET /employees`: the server narrows the list to the caller's reach (#547) and names each
  // person's Stammsalon and stored roles; this page decides nothing about either. No saldo column (owner
  // review): the saldo stays in the person view of Team › Zeiten and in the reports. Read-only: no write call, no
  // e-mail column, no edit actions (Verwalten › Personen does that). The header salon narrows the list
  // through `salonPageFilter` (#558), never the store's raw selection. Search, filters and sort live in the
  // URL (`urlState`); status, filter, sort and the count sentence come from `personen-model.ts`.
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mayOpenTeamPage } from "$lib/nav/team-nav";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import PersonenTable from "$lib/components/employees/PersonenTable.svelte";
  import type { DataTableSort } from "$components/ui/DataTable.svelte";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope";
  import { urlState } from "$lib/table/url-state";
  import { localCalendarDay } from "$lib/employees/employment-state";
  import {
    activeCount,
    activeCountSentence,
    filterPersonen,
    personenRows,
    sortPersonen,
    type PersonenEmployee,
    type PersonenSortKey,
  } from "$lib/team/personen-model";
  import { personenUrlSchema } from "$lib/team/personen-url-state";

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
      const list = await api.get<PersonenEmployee[]>(
        withSalonId("/employees?include=directory", pageSalonId),
      );
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

  // The Stammsalon filter is offered only with salon choice (#64 rule), over the salons the caller
  // reaches (the header's list); the header salon itself narrows the request (#558).
  const salonFilterOffered = $derived(showSalonOptions($salonContext) && pageSalonId === null);
  const salonOptions = $derived(
    salonFilterOffered
      ? $salonContext.salons.map((salon) => ({ value: salon.id, label: salon.name }))
      : null,
  );
  function onFilterChange(key: string, value: string) {
    if (key === "status") listUrl.write({ status: value === "aktiv" ? "aktiv" : "alle" });
    else if (key === "vertrag") listUrl.write({ vertrag: personenUrlSchema.vertrag.parse(value) });
    else if (key === "salon") listUrl.write({ salon: personenUrlSchema.salon.parse(value) });
  }
  // One URL write back to the default view (Status: Aktiv, no search, no Vertrag).
  function resetFilters() {
    filterSearch = "";
    listUrl.write({ q: "", status: "aktiv", vertrag: "", salon: "" });
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
  const salonNames = $derived(new Map($salonContext.salons.map((salon) => [salon.id, salon.name])));
  const allRows = $derived(personenRows(people, today, salonNames));
  const salonFilter = $derived(salonFilterOffered ? view.salon : "");
  const shownRows = $derived(
    sortPersonen(
      filterPersonen(allRows, {
        q: view.q,
        status: view.status,
        vertrag: view.vertrag,
        salon: salonFilter,
      }),
      { key: view.sort, dir: view.dir },
    ),
  );
  const filtersActive = $derived(
    view.q !== "" || view.status === "aktiv" || view.vertrag !== "" || salonFilter !== "",
  );
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
</script>

<svelte:head>
  <title>{pageLabel("/team/personen")} – Clokr</title>
</svelte:head>

<PageHead title={pageLabel("/team/personen")} sub={headSentence} />

<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />

{#if failed}
  <ErrorState onRetry={() => void load()} retrying={loading} />
{:else}
  <PersonenTable
    rows={shownRows}
    total={allRows.length}
    {loading}
    query={filterSearch}
    onQueryInput={onSearchInput}
    filter={{ status: view.status, vertrag: view.vertrag, salon: view.salon }}
    {salonOptions}
    {onFilterChange}
    onReset={resetFilters}
    filtered={filtersActive && allRows.length > 0}
    sort={tableSort}
    {onSort}
    rowTestIdPrefix="team-person"
    openHref={mayOpenZeiten ? (row) => zeitenHref(row.id) : undefined}
    openLabel={(row) => `Zeiten von ${row.name} öffnen`}
    onOpen={mayOpenZeiten ? (row) => goto(zeitenHref(row.id)) : undefined}
  />
{/if}
