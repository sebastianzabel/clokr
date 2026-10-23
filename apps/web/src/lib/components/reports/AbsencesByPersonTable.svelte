<script lang="ts">
  // Issue #713 (D-03, D-08, D-10) - the card „Abwesenheiten je Person“ of the tab „Urlaub &
  // Abwesenheit“: one row per person of the period answer, one column per absence kind (Krank and
  // Kinderkrank apart), searchable, sortable and paged, a list instead of the table at 960 px and
  // below. Pattern 3: every figure is the server's `rows[].absence`, formatted here and never
  // summed; the decisions live in `$lib/reports/absence-table`. A column that is 0 for every row of
  // the whole answer is not rendered. It owns no URL and no navigation: the page hands in the
  // person link and decides what a click does.
  import { untrack } from "svelte";
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import {
    ABSENCE_UNIT_HINT,
    absenceListLine,
    hiddenAbsenceColumns,
    nextAbsenceSort,
    sortAbsenceRows,
    visibleAbsenceColumns,
    type AbsenceSortKey,
  } from "$lib/reports/absence-table";
  import { fmtDaysDe } from "$lib/reports/period-format";
  import type { PeriodRow } from "$lib/reports/period-report";
  import { filterPeriodRows, initialsOf, type SortDir } from "$lib/reports/period-table";
  import {
    PERSON_VALUES_NOT_SPLIT_LABEL,
    SALON_PERIOD_END_PERSONS_NOTE,
  } from "$lib/salons/page-scope";

  interface Props {
    /** The `rows` of the period answer; null until the first answer. */
    rows: PeriodRow[] | null;
    /** A request is in flight; without rows this renders the skeleton. */
    loading: boolean;
    /** The period label shown under the heading and in the table caption. */
    periodLabel: string;
    /**
     * A salon filter applies: the rows are the Stammsalon persons at the period end with whole
     * values (#714); only the note appears, columns and values stay the same (D-08).
     */
    filterActive: boolean;
    /** The drill-down URL of a person (the name link's `href`; opens in a new tab too). */
    personHref: (row: PeriodRow) => string;
    /** A click on a name link, a list row or a row cell; the page intercepts a plain left click. */
    onOpenPerson: (event: MouseEvent, row: PeriodRow) => void;
  }

  let { rows, loading, periodLabel, filterActive, personHref, onOpenPerson }: Props = $props();

  let search = $state("");
  let sort = $state<{ key: AbsenceSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  let page = $state(1);
  let pageSize = $state(25);
  let narrow = $state(false);

  // The list replaces the table at the app's chrome breakpoint (ADD-6).
  $effect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 960px)");
    narrow = query.matches;
    const onChange = (e: { matches: boolean }) => {
      narrow = e.matches;
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  const all = $derived(rows ?? []);
  // Which columns exist is decided over the WHOLE answer - never per page or per search.
  const columns = $derived(visibleAbsenceColumns(all));
  const hiddenKinds = $derived(hiddenAbsenceColumns(all));
  const visible = $derived(sortAbsenceRows(filterPeriodRows(all, search), sort.key, sort.dir));
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize));

  // Search and sort apply to all rows before paging; a change returns to page 1.
  $effect(() => {
    void search;
    void sort;
    untrack(() => {
      page = 1;
    });
  });

  const mobileSorts = $derived([
    { value: "name:asc", label: "Name (A–Z)" },
    { value: "name:desc", label: "Name (Z–A)" },
    ...columns.map((c) => ({ value: `${c.code}:desc`, label: `${c.label} (meiste zuerst)` })),
  ]);

  function onMobileSort(value: string) {
    const [key, dir] = value.split(":") as [AbsenceSortKey, SortDir];
    sort = { key, dir };
  }

  function ariaSort(key: AbsenceSortKey): "ascending" | "descending" | "none" {
    if (sort.key !== key) return "none";
    return sort.dir === "asc" ? "ascending" : "descending";
  }

  // The whole row opens the person; the name link and any button keep their own behaviour.
  function onRowClick(e: MouseEvent, row: PeriodRow) {
    const target = e.target as Element | null;
    if (target?.closest("a, button")) return;
    onOpenPerson(e, row);
  }

  function personCount(n: number): string {
    return `${n} ${n === 1 ? "Person" : "Personen"}`;
  }

  function resetSearch() {
    search = "";
  }
</script>

<Card animate>
  <CardHeader title="Abwesenheiten je Person" sub={periodLabel} />

  {#if filterActive}
    <p class="form-hint" data-testid="absence-salon-note">
      {SALON_PERIOD_END_PERSONS_NOTE} · {PERSON_VALUES_NOT_SPLIT_LABEL}
    </p>
  {/if}

  {#if rows === null}
    {#if loading}
      <div class="abp-skeleton" data-testid="absence-skeleton" aria-busy="true">
        {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}
          <div class="skeleton skeleton-text"></div>
        {/each}
      </div>
      <span class="sr-only">Abwesenheiten werden geladen…</span>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In deiner Reichweite war im gewählten Zeitraum niemand beschäftigt. Wähle oben einen anderen Zeitraum."
    />
  {:else if columns.length === 0}
    <p class="abp-empty">Keine Abwesenheiten im Zeitraum.</p>
  {:else}
    <div class="filter-bar">
      <input
        type="search"
        class="form-input filter-search"
        placeholder="Name oder Personalnummer"
        aria-label="Person suchen"
        bind:value={search}
      />
      {#if narrow}
        <select
          class="form-input"
          aria-label="Sortieren nach"
          value={`${sort.key}:${sort.dir}`}
          onchange={(e) => onMobileSort(e.currentTarget.value)}
        >
          {#each mobileSorts as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      {/if}
      <span class="filter-count" data-testid="absence-count">{personCount(visible.length)}</span>
    </div>

    {#if visible.length === 0}
      <EmptyState
        icon="search"
        title="Keine Treffer"
        description={`Keine Person passt zu „${search.trim()}“.`}
        actionLabel="Suche zurücksetzen"
        onaction={resetSearch}
      />
    {:else if narrow}
      <ul class="abp-list" role="list">
        {#each pageRows as row (row.employeeId)}
          <li>
            <ApprovalRow
              avatar={initialsOf(row.employeeName)}
              name={row.employeeName}
              primaryHref={personHref(row)}
              primaryLabel={`${row.employeeName} – Personenansicht öffnen`}
              onPrimaryClick={(e) => onOpenPerson(e, row)}
              dates={absenceListLine(row, columns)}
            />
          </li>
        {/each}
      </ul>
    {:else}
      <div class="table-scroll">
        <table class="data-table data-table--compact abp-table">
          <caption class="sr-only">Abwesenheiten je Person, {periodLabel}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                class="sortable"
                class:sorted={sort.key === "name"}
                aria-sort={ariaSort("name")}
              >
                <button
                  type="button"
                  class="abp-sort-btn"
                  onclick={() => (sort = nextAbsenceSort(sort, "name"))}
                >
                  Person
                  {#if sort.key === "name"}
                    <span class="sort-indicator" aria-hidden="true"
                      >{sort.dir === "asc" ? "▲" : "▼"}</span
                    >
                  {/if}
                </button>
              </th>
              {#each columns as col (col.code)}
                <th
                  scope="col"
                  class="sortable num"
                  class:sorted={sort.key === col.code}
                  aria-sort={ariaSort(col.code)}
                >
                  <button
                    type="button"
                    class="abp-sort-btn"
                    onclick={() => (sort = nextAbsenceSort(sort, col.code))}
                  >
                    {col.header}
                    {#if sort.key === col.code}
                      <span class="sort-indicator" aria-hidden="true"
                        >{sort.dir === "asc" ? "▲" : "▼"}</span
                      >
                    {/if}
                  </button>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each pageRows as row (row.employeeId)}
              <!-- The keyboard path is the name link; the row click is a pointer convenience. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <tr class="abp-row" onclick={(e) => onRowClick(e, row)}>
                <th scope="row" class="abp-person">
                  <a
                    class="abp-person-link"
                    href={personHref(row)}
                    data-sveltekit-noscroll
                    title={row.employeeName}
                    onclick={(e) => onOpenPerson(e, row)}>{row.employeeName}</a
                  >
                  <span class="abp-sub">{row.employeeNumber}</span>
                </th>
                {#each columns as col (col.code)}
                  <td class="num">{fmtDaysDe(row.absence[col.code])}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if visible.length > 0}
      <Pagination
        total={visible.length}
        bind:page
        bind:pageSize
        pageSizeOptions={[25, 50, 100]}
        labelSingular="Person"
        labelPlural="Personen"
      />
    {/if}

    <p class="form-hint" data-testid="absence-unit-hint">{ABSENCE_UNIT_HINT}</p>
    {#if hiddenKinds.length > 0}
      <p class="form-hint" data-testid="absence-hidden-hint">
        Ohne Einträge im Zeitraum: {hiddenKinds.map((c) => c.label).join(", ")}
      </p>
    {/if}
  {/if}
</Card>

<style>
  .abp-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .abp-empty {
    margin: 0;
    font-size: 15px;
    color: var(--text-muted);
  }

  .abp-table .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .abp-table th {
    white-space: normal;
  }

  /* The sort control is a button inside the header cell: reset it to the cell's own look. */
  .abp-sort-btn {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    padding: 0;
    width: 100%;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    text-align: inherit;
    cursor: pointer;
  }

  .abp-row {
    cursor: pointer;
  }

  .abp-person {
    min-width: 160px;
    max-width: 240px;
    text-align: left;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .abp-person-link {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
    text-decoration: none;
  }

  .abp-person-link:hover {
    text-decoration: underline;
  }

  .abp-sub {
    display: block;
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .abp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  @media (pointer: coarse) {
    .abp-sort-btn {
      min-height: 44px;
    }
  }
</style>
