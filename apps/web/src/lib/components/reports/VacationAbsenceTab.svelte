<script lang="ts">
  // Issue #612 (D-612-5, ADD-2, P-06, P-07, P-15, UI-SPEC "Tab Urlaub & Abwesenheit") - the vacation
  // table of the period (one calendar year at a time, with the Verfall column and the notice
  // button) and the absence statistics by kind. Rebuilt on the blocks for Issue #854: two sections
  // with a DataTable each (cards below 760 px of container width), a TableToolbar over the vacation
  // table, Chips and a Note. Pattern 3: every figure is the server's; this component formats days
  // and dates and sums nothing. It owns no URL, no navigation and no API client: the page hands in
  // the person link, the click handler and the notice call.
  import { untrack } from "svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import { leaveTypeColor } from "$lib/leave/leave-colors";
  import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";
  import { fmtDateDe, fmtDaysDe } from "$lib/reports/period-format";
  import type {
    PeriodAbsence,
    PeriodVacationRow,
    PeriodVacationYear,
  } from "$lib/reports/period-report";
  import { VACATION_YEAR_COLUMNS } from "$lib/reports/vacation-columns"; // Issue #617
  import {
    PERSON_VALUES_NOT_SPLIT_LABEL,
    SALON_PERIOD_END_PERSONS_NOTE,
  } from "$lib/salons/page-scope";

  interface Props {
    /** The `vacation` block of the period answer; null until the first answer. */
    vacation: { year: number; asOf: string; years: PeriodVacationYear[] } | null;
    /** The `absences` of the period answer; null until the first answer. */
    absences: PeriodAbsence[] | null;
    /** A salon filter applies: persons by Stammsalon at the period end, whole personal values (#714). */
    filterActive: boolean;
    /** A request is in flight. */
    loading: boolean;
    /** Today as `YYYY-MM-DD` - the gate of „Hinweis senden“ (a deadline of today or later). */
    today: string;
    /** report:notify - the notice button. */
    canNotify: boolean;
    /** The period label (captions). */
    periodLabel: string;
    /**
     * The drill-down URL of a person (the name link's `href`; opens in a new tab too), or null for
     * a person the drill-down cannot show (no row in the period answer): a plain name then.
     */
    personHref: (employeeId: string) => string | null;
    /** A click on a name link; the page intercepts a plain left click. */
    onOpenPerson: (event: MouseEvent, employeeId: string) => void;
    /** Sends the carry-over notice of one entitlement (`POST /reports/carryover-warn`). */
    onNotify: (entitlementId: string) => Promise<{ warned: number; skippedDedup: number }>;
  }

  let {
    vacation,
    absences,
    filterActive,
    loading,
    today,
    canNotify,
    periodLabel,
    personHref,
    onOpenPerson,
    onNotify,
  }: Props = $props();

  const DASH = "—";
  // Issue #713: the two sick kinds are the ones counted in calendar days and are two lines by code
  // (own illness / child sickness). The label carries the unit, so no bare display name appears;
  // the leave type table names the request types „Krankmeldung“ and „Kinderkrank“.
  const CALENDAR_DAY_LABELS: Partial<Record<PeriodAbsence["code"], string>> = {
    SICK: "Krank (Kalendertage)",
    SICK_CHILD: "Kinderkrank (Kalendertage)",
  };
  const FIGURE_COLUMNS = VACATION_YEAR_COLUMNS.length;

  let search = $state("");
  let page = $state(1);
  let pageSize = $state(25);
  let chosenYear = $state<number | null>(null);

  // ── The vacation year ──────────────────────────────────────────────────────────────

  const years = $derived(vacation?.years ?? []);
  // The year of the period end unless the reader chose the other year of a two-year period.
  const activeYear = $derived(
    chosenYear !== null && years.some((y) => y.year === chosenYear)
      ? chosenYear
      : (vacation?.year ?? null),
  );
  const yearRows = $derived(years.find((y) => y.year === activeYear)?.rows ?? []);

  const query = $derived(search.trim().toLocaleLowerCase("de"));
  const visible = $derived(
    yearRows
      .filter(
        (r) =>
          query === "" ||
          r.employeeName.toLocaleLowerCase("de").includes(query) ||
          r.employeeNumber.toLocaleLowerCase("de").includes(query),
      )
      .sort(
        (a, b) =>
          a.employeeName.localeCompare(b.employeeName, "de") ||
          a.employeeId.localeCompare(b.employeeId),
      ),
  );
  // DataTable's row type is a string-keyed record; the interfaces of the period answer have no index
  // signature, so the shown rows carry the intersection.
  type VacRow = PeriodVacationRow & Record<string, unknown>;
  type KindRow = PeriodAbsence & Record<string, unknown>;
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize) as VacRow[]);

  // A search, another year or a new answer returns to page 1.
  $effect(() => {
    void search;
    void activeYear;
    void vacation;
    untrack(() => {
      page = 1;
    });
  });

  // ── Cells (the #451 properties: effective carry-over, at-risk days, each with a fallback) ────

  function carry(row: PeriodVacationRow): number {
    return row.carriedOverEffectiveDays ?? row.carriedOverDays ?? 0;
  }

  function available(row: PeriodVacationRow): number {
    return row.availableDays ?? (row.entitlementDays ?? 0) + carry(row);
  }

  function atRisk(row: PeriodVacationRow): number {
    return row.atRiskDays ?? row.carriedOverDays ?? 0;
  }

  function figures(row: PeriodVacationRow): string[] {
    return [
      fmtDaysDe(row.entitlementDays ?? 0),
      fmtDaysDe(carry(row)),
      fmtDaysDe(available(row)),
      fmtDaysDe(row.takenDays ?? 0),
      fmtDaysDe(row.approvedUpcomingDays ?? 0),
      fmtDaysDe(row.pendingDays ?? 0),
      fmtDaysDe(row.remainingDays ?? 0),
    ];
  }

  const anyAtRisk = $derived(yearRows.some((r) => !r.missingEntitlement && atRisk(r) > 0));
  // Issue #940: a carry-over past its deadline that still counts (no Hinweis, EuGH C-684/16).
  const kept = (row: PeriodVacationRow) => row.carryOverKeptWithoutNoticeDays ?? 0;
  const anyKept = $derived(yearRows.some((r) => !r.missingEntitlement && kept(r) > 0));

  function verfallLine(row: PeriodVacationRow): string {
    if (kept(row) > 0 && row.carryOverDeadline) {
      return `Frist ${fmtDateDe(row.carryOverDeadline)} vorbei, ohne Hinweis kein Verfall`;
    }
    const days = atRisk(row);
    if (days <= 0) return DASH;
    return row.carryOverDeadline
      ? `${fmtDaysDe(days)} T. bis ${fmtDateDe(row.carryOverDeadline)}`
      : `${fmtDaysDe(days)} T.`;
  }

  // The newest notice as a calendar day of the browser (an instant arrives from the server).
  function localDay(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Notices sent from this page since the answer was read: shown without a re-read.
  let sentNow = $state<Record<string, boolean>>({});

  function noticeLine(row: PeriodVacationRow): string | null {
    const id = row.entitlementId;
    if (id !== null && sentNow[id]) return `Hinweis am ${fmtDateDe(today)}`;
    if (row.lastWarningSentAt) return `Hinweis am ${fmtDateDe(localDay(row.lastWarningSentAt))}`;
    return atRisk(row) > 0 ? "Noch kein Hinweis" : null;
  }

  // The button is offered for an at-risk entitlement whose deadline has not passed (T-612-25).
  function canSendNotice(row: PeriodVacationRow): boolean {
    return (
      canNotify &&
      !row.missingEntitlement &&
      row.entitlementId !== null &&
      atRisk(row) > 0 &&
      row.carryOverDeadline !== null &&
      row.carryOverDeadline >= today
    );
  }

  let busy = $state<Record<string, boolean>>({});
  let messages = $state<Record<string, string>>({});

  async function notify(row: PeriodVacationRow) {
    const id = row.entitlementId;
    if (id === null) return;
    busy = { ...busy, [id]: true };
    messages = { ...messages, [id]: "" };
    try {
      const res = await onNotify(id);
      if (res.warned > 0) {
        sentNow = { ...sentNow, [id]: true };
        messages = { ...messages, [id]: "Hinweis gesendet" };
      } else {
        messages = { ...messages, [id]: "Hinweis wurde heute schon gesendet" };
      }
    } catch {
      messages = { ...messages, [id]: "Hinweis konnte nicht gesendet werden." };
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  const vacationColumns: DataTableColumn[] = [
    { key: "name", label: "Person", primary: true },
    ...VACATION_YEAR_COLUMNS.map((label, i) => ({
      key: `figure-${i}`,
      label,
      align: "end" as const,
    })),
    { key: "verfall", label: "Verfall" },
  ];

  const kindColumns: DataTableColumn[] = [
    { key: "kind", label: "Art", primary: true },
    { key: "personCount", label: "Personen", align: "end" },
    { key: "totalDays", label: "Tage", align: "end" },
  ];

  // ── The absence statistics (P-07) ──────────────────────────────────────────────────

  // Kinds are found by CODE (leave-type identity guard); the label is display only.
  function kindEntry(code: PeriodAbsence["code"]) {
    return LEAVE_TYPES.find((t) => t.code === code);
  }

  function kindLabel(a: PeriodAbsence): string {
    const calendarLabel = CALENDAR_DAY_LABELS[a.code];
    if (calendarLabel !== undefined) return calendarLabel;
    return `${kindEntry(a.code)?.label ?? a.code} (Arbeitstage)`;
  }

  // Issue #714: the server's list is shown as it is, also under a salon filter - the listed persons
  // are the Stammsalon circle and every figure is a whole personal value.
  const shownAbsences = $derived(absences ?? []);
</script>

{#snippet verfallBody(row: PeriodVacationRow)}
  {@const notice = noticeLine(row)}
  {@const id = row.entitlementId ?? ""}
  <div class="verfall-cell">
    <span class="verfall-line">{verfallLine(row)}</span>
    {#if notice !== null}<span class="verfall-sub">{notice}</span>{/if}
    {#if canSendNotice(row)}
      <button
        type="button"
        class="btn btn-ghost xs vac-notify"
        aria-label={`Hinweis senden an ${row.employeeName}`}
        disabled={busy[id]}
        onclick={() => notify(row)}
      >
        {#if busy[id]}<Spinner size={12} />{/if}
        Hinweis senden
      </button>
    {/if}
    {#if messages[id]}
      <span class="verfall-sub" role="status">{messages[id]}</span>
    {/if}
  </div>
{/snippet}

{#snippet vacationCell(row: VacRow, column: DataTableColumn)}
  {#if column.key === "name"}
    {@const href = personHref(row.employeeId)}
    <span class="vac-person">
      {#if href !== null}
        <a
          class="vac-person-link"
          {href}
          data-sveltekit-noscroll
          title={row.employeeName}
          onclick={(e) => onOpenPerson(e, row.employeeId)}>{row.employeeName}</a
        >
      {:else}
        <span class="vac-person-link" title={row.employeeName}>{row.employeeName}</span>
      {/if}
      <span class="verfall-sub">{row.employeeNumber}</span>
    </span>
  {:else if row.missingEntitlement}
    <!-- A person without an entitlement has no figures: the first figure cell says so, the rest dash. -->
    {#if column.key === "figure-0"}
      <Chip tone="warn">kein Anspruch hinterlegt</Chip>
    {:else}
      {DASH}
    {/if}
  {:else if column.key === "verfall"}
    {@render verfallBody(row)}
  {:else}
    {@const index = Number(column.key.replace("figure-", ""))}
    <span class:strong={index === FIGURE_COLUMNS - 1}>{figures(row)[index]}</span>
  {/if}
{/snippet}

{#snippet kindCell(row: KindRow, column: DataTableColumn)}
  {#if column.key === "kind"}
    <span class="type-dot" style={`--type-color: var(${leaveTypeColor(row.code).fill})`}></span>
    {kindLabel(row)}
  {:else if column.key === "personCount"}
    {row.personCount}
  {:else}
    {fmtDaysDe(row.totalDays)}
  {/if}
{/snippet}

<section class="settings-group" aria-labelledby="vacation-overview-title">
  <div class="vac-head">
    <div>
      <h2 class="settings-group-title" id="vacation-overview-title">Urlaubsübersicht</h2>
      {#if activeYear !== null}
        <p class="settings-group-desc vac-label">Urlaubsjahr {activeYear}</p>
      {/if}
    </div>
    {#if years.length > 1 && activeYear !== null}
      <SegmentedControl
        size="sm"
        name="reports-vacation-year"
        ariaLabel="Urlaubsjahr"
        options={years.map((y) => ({ value: String(y.year), label: String(y.year) }))}
        value={String(activeYear)}
        onchange={(v) => {
          chosenYear = Number(v);
        }}
      />
    {/if}
  </div>

  <!-- #843 D-843-07: a refresh over an existing answer announces itself through the Skeleton, not text -->
  {#if loading && vacation !== null}
    <Skeleton inline width={8} />
  {/if}

  {#if filterActive}
    <div data-testid="vacation-salon-note">
      <Note tone="brand">{SALON_PERIOD_END_PERSONS_NOTE} · {PERSON_VALUES_NOT_SPLIT_LABEL}</Note>
    </div>
  {/if}

  {#if vacation === null}
    {#if loading}
      <div data-testid="vacation-skeleton">
        <Skeleton shape="row" count={3} />
      </div>
    {/if}
  {:else if yearRows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In deiner Reichweite war im gewählten Zeitraum niemand beschäftigt. Wähl oben einen anderen Zeitraum."
    />
  {:else}
    {#if anyAtRisk || anyKept}
      <div data-testid="vacation-eugh-callout">
        <Note tone="warn">
          Hinweispflicht: Mitarbeiter müssen gemäß EuGH C-684/16 ausdrücklich auf verfallenden
          Urlaub hingewiesen werden. Ohne dokumentierten Hinweis verfällt der Urlaub <strong
            >nicht</strong
          >.
        </Note>
      </div>
    {/if}

    <DataTable
      columns={vacationColumns}
      rows={pageRows}
      rowKey={(row) => row.employeeId}
      rowTestId={(row) => `vac-row-${row.employeeId}`}
      cell={vacationCell}
      filtered={search.trim() !== ""}
      onResetFilters={() => (search = "")}
      caption={`Urlaub je Person, Urlaubsjahr ${activeYear}`}
    >
      {#snippet toolbar()}
        <TableToolbar
          bind:query={search}
          count={visible.length}
          total={yearRows.length}
          searchLabel="Name oder Personalnummer suchen"
          onReset={() => (search = "")}
        />
      {/snippet}
    </DataTable>

    {#if visible.length > 0}
      <p class="settings-group-desc vac-hint">
        Alle Werte in Arbeitstagen. Verfügbar = Anspruch + wirksamer Übertrag. Resturlaub =
        Verfügbar − Genommen − Genehmigt. Beantragte Tage werden nicht abgezogen.
      </p>
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
</section>

<section class="settings-group" aria-labelledby="absence-kinds-title">
  <div>
    <h2 class="settings-group-title" id="absence-kinds-title">Abwesenheiten nach Art</h2>
    <p class="settings-group-desc vac-label">{periodLabel}</p>
  </div>

  {#if absences === null}
    {#if loading}
      <Skeleton shape="row" count={3} />
    {/if}
  {:else if shownAbsences.length === 0}
    <EmptyState icon="inbox" title="Keine Abwesenheiten im Zeitraum." />
  {:else}
    <div class="abs-table" data-testid="absence-kinds">
      <DataTable
        columns={kindColumns}
        rows={shownAbsences as KindRow[]}
        rowKey={(row) => row.code}
        cell={kindCell}
        caption={`Abwesenheiten nach Art, ${periodLabel}`}
      />
    </div>
  {/if}
</section>

<style>
  .vac-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
  }

  .vac-label {
    margin-top: var(--s-1);
  }

  .vac-hint {
    margin-top: 0;
  }

  .strong {
    font-weight: 600;
    color: var(--text);
  }

  .vac-person {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    min-width: 160px;
    max-width: 240px;
    padding-block: var(--s-1);
  }

  /* A long name wraps instead of ending in an ellipsis (see TimesAccountsTable). */
  .vac-person-link {
    display: block;
    max-width: 100%;
    overflow-wrap: anywhere;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
    text-decoration: none;
  }

  a.vac-person-link:hover {
    text-decoration: underline;
  }

  .verfall-sub {
    display: block;
    font-size: var(--fs-sm);
    line-height: 1.4;
    font-weight: 400;
    color: var(--text-2);
  }

  /* Issue #442: the layout of the action cell lives on the inner wrapper, never on the td itself,
     so the cell keeps display: table-cell and lines up with the rest of the row. */
  .verfall-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    min-width: 170px;
    padding-block: var(--s-1);
    font-weight: 400;
  }

  .verfall-line {
    font-variant-numeric: tabular-nums;
  }

  .type-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: var(--s-2);
    border-radius: 50%;
    background: var(--type-color, currentColor);
  }

  /* The notice button is a touch target in the card layout. */
  @container (max-width: 759.98px) {
    .vac-person {
      max-width: 100%;
    }

    .verfall-cell {
      align-items: flex-end;
      min-width: 0;
    }

    .vac-notify {
      min-height: 44px;
    }
  }
</style>
