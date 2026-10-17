<script lang="ts">
  // Issue #612 (D-612-4, UI-SPEC "Tab Zeiten & Konten") - one row per person for the period:
  // Soll, Ist and the three saldo figures of the server's answer, searchable, sortable and paged,
  // a card list instead of the table at 960 px and below. Pattern 3: every figure is the server's
  // (minutes, formatted here); the team median comes from `$lib/reports/team-saldo` (#588 rule),
  // never from a sum of this component. It owns no URL and no navigation: the page hands in the
  // person link and decides what a click does.
  import { untrack, type Snippet } from "svelte";
  import Icon from "$components/Icon.svelte";
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import { fmtDateDe, fmtHoursDe } from "$lib/reports/period-format";
  import type { PeriodRow } from "$lib/reports/period-report";
  import {
    filterPeriodRows,
    hasSaldoFigures,
    initialsOf,
    nextSort,
    rowStatus,
    sortPeriodRows,
    withheldReason,
    type PeriodSortKey,
    type SortDir,
  } from "$lib/reports/period-table";
  import {
    TEAM_SALDO_EXCLUSION_LABEL,
    periodSaldoExclusion,
    periodSaldoFigures,
  } from "$lib/reports/team-saldo"; // Issue #588 (P-12): the one rule

  interface Props {
    /** The `rows` of the period answer; null until the first answer. */
    rows: PeriodRow[] | null;
    /** A request is in flight; without rows this renders the skeleton. */
    loading: boolean;
    /** The period label shown under the heading and in the table caption. */
    periodLabel: string;
    /** A salon filter applies: Soll and saldo are never split by salon, the status is empty. */
    filterActive: boolean;
    /** The drill-down URL of a person (the name link's `href`; opens in a new tab too). */
    personHref: (row: PeriodRow) => string;
    /** A click on a name link, a list row or a row cell; the page intercepts a plain left click. */
    onOpenPerson: (event: MouseEvent, row: PeriodRow) => void;
    /** Rendered after the pagination (the exited persons section). */
    exited?: Snippet;
  }

  let { rows, loading, periodLabel, filterActive, personHref, onOpenPerson, exited }: Props =
    $props();

  const DASH = "—";

  let search = $state("");
  let sort = $state<{ key: PeriodSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
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
  const showSaldo = $derived(hasSaldoFigures(all));
  const visible = $derived(sortPeriodRows(filterPeriodRows(all, search), sort.key, sort.dir));
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize));

  // Search and sort apply to all rows before paging; a change returns to page 1.
  $effect(() => {
    void search;
    void sort;
    untrack(() => {
      page = 1;
    });
  });

  // The team median of the closing saldi (P-12) and who is outside it. Only where saldo exists.
  const figures = $derived(periodSaldoFigures(all));
  const withoutRecording = $derived(
    figures.excluded.filter((e) => e.reason === "NO_RECORDED_TIME"),
  );
  const exclusionByPerson = $derived(
    new Map(figures.excluded.map((e) => [e.employeeId, e.reasonLabel])),
  );

  interface Column {
    key: PeriodSortKey;
    label: string;
  }
  const columns = $derived<Column[]>([
    { key: "name", label: "Person" },
    { key: "soll", label: "Soll (h)" },
    { key: "ist", label: "Ist (h)" },
    ...(showSaldo
      ? [
          { key: "opening" as const, label: "Saldo Beginn (h)" },
          { key: "balance" as const, label: "Saldo Zeitraum (h)" },
          { key: "closing" as const, label: "Saldo Ende (h)" },
        ]
      : []),
    { key: "status", label: "Status" },
  ]);

  const MOBILE_SORTS: ReadonlyArray<{ value: string; label: string }> = [
    { value: "name:asc", label: "Name (A–Z)" },
    { value: "name:desc", label: "Name (Z–A)" },
    { value: "closing:desc", label: "Saldo am Ende (höchster zuerst)" },
    { value: "closing:asc", label: "Saldo am Ende (niedrigster zuerst)" },
    { value: "ist:desc", label: "Ist (höchster zuerst)" },
  ];

  function onMobileSort(value: string) {
    const [key, dir] = value.split(":") as [PeriodSortKey, SortDir];
    sort = { key, dir };
  }

  function ariaSort(key: PeriodSortKey): "ascending" | "descending" | "none" {
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

  // One string, so the separators survive the template's whitespace collapsing.
  const medianText = $derived(
    `Median Saldo am Ende ${
      figures.medianMinutes === null ? DASH : fmtHoursDe(figures.medianMinutes, { signed: true })
    } h${
      withoutRecording.length > 0
        ? ` – ohne ${personCount(withoutRecording.length)} ohne Erfassung`
        : ""
    }`,
  );

  function resetSearch() {
    search = "";
  }

  function mobileLine(row: PeriodRow): string {
    const parts: string[] = [];
    if (row.expectedMinutes !== null) parts.push(`Soll ${fmtHoursDe(row.expectedMinutes)}`);
    parts.push(`Ist ${fmtHoursDe(row.workedMinutes)}`);
    if (row.balanceMinutes !== null) {
      parts.push(`Zeitraum ${fmtHoursDe(row.balanceMinutes, { signed: true })}`);
    }
    return parts.join(" · ");
  }
</script>

{#snippet figure(value: number | null, signed: boolean, row: PeriodRow)}
  {#if value === null}
    <span title={withheldReason(row)}>{DASH}</span><span class="sr-only">{withheldReason(row)}</span
    >
  {:else}
    {fmtHoursDe(value, { signed })}
  {/if}
{/snippet}

{#snippet statusChip(row: PeriodRow)}
  {#if filterActive}
    <span title="Nicht je Salon">{DASH}</span><span class="sr-only">Nicht je Salon</span>
  {:else}
    {@const status = rowStatus(row)}
    {#if status.kind === "confirmed"}
      <span class="chip chip-good">
        <Icon name="lock" size={11} />
        {status.label}
      </span>
    {:else if status.kind === "forecast"}
      <span class="chip"><span class="dot"></span> {status.label}</span>
      {#if status.detail}<span class="period-sub">{status.detail}</span>{/if}
    {:else}
      <span class="chip">{status.label}</span>
    {/if}
  {/if}
{/snippet}

<section class="card-animate period-section" data-testid="period-section" aria-busy={loading}>
  <div class="period-section-head">
    <div>
      <h2 class="period-h2">Zeiten &amp; Konten</h2>
      <p class="period-sub">{periodLabel}</p>
    </div>
    {#if rows !== null && rows.length > 0 && showSaldo}
      <p class="period-median" data-testid="period-median">{medianText}</p>
    {/if}
  </div>

  {#if rows === null}
    {#if loading}
      <div class="period-skeleton" data-testid="period-table-skeleton">
        {#each Array.from({ length: 5 }, (_, i) => i) as i (i)}
          <div class="skeleton skeleton-text"></div>
        {/each}
      </div>
      <span class="sr-only">Bericht wird geladen…</span>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In Ihrer Reichweite war im gewählten Zeitraum niemand beschäftigt. Wählen Sie oben einen anderen Zeitraum."
    />
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
          {#each MOBILE_SORTS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      {/if}
      <span class="filter-count" data-testid="period-count">{personCount(visible.length)}</span>
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
      <ul class="period-list" role="list">
        {#each pageRows as row (row.employeeId)}
          <li>
            <ApprovalRow
              avatar={initialsOf(row.employeeName)}
              name={row.employeeName}
              primaryHref={personHref(row)}
              primaryLabel={`${row.employeeName} – Personenansicht öffnen`}
              onPrimaryClick={(e) => onOpenPerson(e, row)}
              dates={row.closingBalanceMinutes === null
                ? DASH
                : `Ende ${fmtHoursDe(row.closingBalanceMinutes, { signed: true })} h`}
            >
              {#snippet metaContent()}
                <span class="period-list-meta">
                  {@render statusChip(row)}
                  <span>{mobileLine(row)}</span>
                </span>
              {/snippet}
            </ApprovalRow>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="table-wrap period-table-wrap">
        <table class="data-table data-table--compact period-table">
          <caption class="sr-only">Zeiten und Konten je Person, {periodLabel}</caption>
          <thead>
            <tr>
              {#each columns as col (col.key)}
                <th
                  scope="col"
                  class="sortable"
                  class:sorted={sort.key === col.key}
                  class:num={col.key !== "name" && col.key !== "status"}
                  aria-sort={ariaSort(col.key)}
                >
                  <button
                    type="button"
                    class="period-sort-btn"
                    onclick={() => (sort = nextSort(sort, col.key))}
                  >
                    {col.label}
                    {#if sort.key === col.key}
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
              {@const exclusion = showSaldo ? periodSaldoExclusion(row) : null}
              <!-- The keyboard path is the name link; the row click is a pointer convenience. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <tr class="period-row" onclick={(e) => onRowClick(e, row)}>
                <th scope="row" class="period-person">
                  <a
                    class="period-person-link"
                    href={personHref(row)}
                    data-sveltekit-noscroll
                    title={row.employeeName}
                    onclick={(e) => onOpenPerson(e, row)}>{row.employeeName}</a
                  >
                  <span class="period-sub">
                    {row.employeeNumber}{#if row.exitDay}
                      · ausgetreten am {fmtDateDe(row.exitDay)}{/if}
                  </span>
                  {#if exclusion !== null}
                    <span class="chip period-exclusion" title="Nicht im Median"
                      >{TEAM_SALDO_EXCLUSION_LABEL[exclusion]}</span
                    >
                  {/if}
                </th>
                <td class="num">{@render figure(row.expectedMinutes, false, row)}</td>
                <td class="num">{@render figure(row.workedMinutes, false, row)}</td>
                {#if showSaldo}
                  <td class="num">{@render figure(row.openingBalanceMinutes, true, row)}</td>
                  <td class="num">{@render figure(row.balanceMinutes, true, row)}</td>
                  <td class="num">{@render figure(row.closingBalanceMinutes, true, row)}</td>
                {/if}
                <td class="period-status">{@render statusChip(row)}</td>
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
  {/if}

  {@render exited?.()}
</section>

<style>
  .period-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .period-section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
  }

  .period-h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--text);
  }

  .period-sub {
    display: block;
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .period-median {
    margin: 0;
    font-size: 15px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .period-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .period-section :global(.filter-bar) {
    margin-bottom: 0;
  }

  /* The sticky reference is the page, not the wrapper: `.table-wrap` would clip it with
     overflow-x. The header sits below the topbar AND the period bar. */
  .period-table-wrap {
    overflow: visible;
  }

  .period-table thead tr {
    top: calc(var(--topbar-h) + var(--period-bar-h, 0px));
    background: var(--bg);
    box-shadow: inset 0 -1px 0 var(--border-strong);
  }

  .period-table th {
    white-space: normal;
  }

  .period-table .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* The sort control is a button inside the header cell: reset it to the cell's own look. */
  .period-sort-btn {
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

  .period-row {
    cursor: pointer;
  }

  .period-person {
    min-width: 160px;
    max-width: 240px;
    text-align: left;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .period-person-link {
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

  .period-person-link:hover {
    text-decoration: underline;
  }

  .period-exclusion {
    margin-top: var(--s-1);
  }

  .period-status {
    min-width: 140px;
  }

  .period-status .chip {
    white-space: normal;
  }

  .period-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .period-list-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
  }

  @media (pointer: coarse) {
    .period-sort-btn {
      min-height: 44px;
    }
  }
</style>
