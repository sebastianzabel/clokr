<script lang="ts">
  // Issue #612 (D-612-5, ADD-2, P-06, P-07, P-15, UI-SPEC "Tab Urlaub & Abwesenheit") - the vacation
  // table of the period (one calendar year at a time, with the Verfall column and the notice
  // button) and the absence statistics by kind. Pattern 3: every figure is the server's; this
  // component formats days and dates and sums nothing. It owns no URL, no navigation and no API
  // client: the page hands in the person link, the click handler and the notice call.
  import { untrack } from "svelte";
  import ApprovalRow from "$components/ui/ApprovalRow.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";
  import { fmtDateDe, fmtDateShortDe, fmtDaysDe } from "$lib/reports/period-format";
  import type {
    PeriodAbsence,
    PeriodVacationRow,
    PeriodVacationYear,
  } from "$lib/reports/period-report";
  import { initialsOf } from "$lib/reports/period-table";
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
    /** A click on a name link, a list row or a row cell; the page intercepts a plain left click. */
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
  let narrow = $state(false);
  let chosenYear = $state<number | null>(null);

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
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize));

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

  // One string, so the separators survive the template's whitespace collapsing.
  function listLine(row: PeriodVacationRow): string {
    return `Anspruch ${fmtDaysDe(row.entitlementDays ?? 0)} · Genommen ${fmtDaysDe(row.takenDays ?? 0)} · Genehmigt ${fmtDaysDe(row.approvedUpcomingDays ?? 0)} · Beantragt ${fmtDaysDe(row.pendingDays ?? 0)}`;
  }

  const anyAtRisk = $derived(yearRows.some((r) => !r.missingEntitlement && atRisk(r) > 0));

  function verfallLine(row: PeriodVacationRow): string {
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

  // The whole row opens the person; the name link and any button keep their own behaviour.
  function onRowClick(e: MouseEvent, row: PeriodVacationRow) {
    const target = e.target as Element | null;
    if (target?.closest("a, button")) return;
    if (personHref(row.employeeId) === null) return;
    onOpenPerson(e, row.employeeId);
  }

  function personCount(n: number): string {
    return `${n} ${n === 1 ? "Person" : "Personen"}`;
  }

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
  <span class="verfall-line">{verfallLine(row)}</span>
  {#if notice !== null}<span class="verfall-sub">{notice}</span>{/if}
  {#if canSendNotice(row)}
    <button
      type="button"
      class="btn btn-ghost xs"
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
{/snippet}

{#snippet listFigures(row: PeriodVacationRow)}
  {@const risk = atRisk(row)}
  <span class="vac-list-meta">
    {#if row.missingEntitlement}
      <span class="badge badge-yellow">kein Anspruch hinterlegt</span>
    {:else}
      <span>{listLine(row)}</span>
      {#if risk > 0}
        <span class="chip chip-warn"
          >Verfall {fmtDaysDe(risk)} T.{row.carryOverDeadline
            ? ` bis ${fmtDateShortDe(row.carryOverDeadline)}`
            : ""}</span
        >
      {/if}
    {/if}
  </span>
{/snippet}

<Card animate>
  <CardHeader
    title="Urlaubsübersicht"
    sub={activeYear === null ? undefined : `Urlaubsjahr ${activeYear}`}
  >
    {#snippet actions()}
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
    {/snippet}
  </CardHeader>

  {#if loading}
    <span class="sr-only">Lade Urlaubsübersicht…</span>
  {/if}

  {#if filterActive}
    <p class="form-hint" data-testid="vacation-salon-note">
      {SALON_PERIOD_END_PERSONS_NOTE} · {PERSON_VALUES_NOT_SPLIT_LABEL}
    </p>
  {/if}

  {#if vacation === null}
    {#if loading}
      <div class="vac-skeleton" data-testid="vacation-skeleton" aria-busy="true">
        {#each Array.from({ length: 5 }, (_, i) => i) as i (i)}
          <div class="skeleton skeleton-text"></div>
        {/each}
      </div>
    {/if}
  {:else if yearRows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In Ihrer Reichweite war im gewählten Zeitraum niemand beschäftigt. Wählen Sie oben einen anderen Zeitraum."
    />
  {:else}
    {#if anyAtRisk}
      <div class="callout" data-testid="vacation-eugh-callout">
        <p>
          Hinweispflicht: Mitarbeiter müssen gemäß EuGH C-684/16 ausdrücklich auf verfallenden
          Urlaub hingewiesen werden. Ohne dokumentierten Hinweis verfällt der Urlaub <strong
            >nicht</strong
          >.
        </p>
      </div>
    {/if}

    <div class="filter-bar">
      <input
        type="search"
        class="form-input filter-search"
        placeholder="Name oder Personalnummer"
        aria-label="Person suchen"
        bind:value={search}
      />
      <span class="filter-count" data-testid="vacation-count">{personCount(visible.length)}</span>
    </div>

    {#if visible.length === 0}
      <EmptyState
        icon="search"
        title="Keine Treffer"
        description={`Keine Person passt zu „${search.trim()}“.`}
        actionLabel="Suche zurücksetzen"
        onaction={() => (search = "")}
      />
    {:else if narrow}
      <ul class="vac-list" role="list">
        {#each pageRows as row (row.employeeId)}
          {@const id = row.entitlementId ?? ""}
          <li>
            {#if canSendNotice(row)}
              <ApprovalRow
                avatar={initialsOf(row.employeeName)}
                name={row.employeeName}
                primaryHref={personHref(row.employeeId) ?? undefined}
                primaryLabel={`${row.employeeName} – Personenansicht öffnen`}
                onPrimaryClick={(e) => onOpenPerson(e, row.employeeId)}
                dates={`Rest ${fmtDaysDe(row.remainingDays ?? 0)} T.`}
              >
                {#snippet metaContent()}{@render listFigures(row)}{/snippet}
                {#snippet actions()}
                  <button
                    type="button"
                    class="btn btn-ghost xs vac-notify-touch"
                    aria-label={`Hinweis senden an ${row.employeeName}`}
                    disabled={busy[id]}
                    onclick={() => notify(row)}
                  >
                    {#if busy[id]}<Spinner size={12} />{/if}
                    Hinweis senden
                  </button>
                {/snippet}
              </ApprovalRow>
            {:else}
              <ApprovalRow
                avatar={initialsOf(row.employeeName)}
                name={row.employeeName}
                primaryHref={personHref(row.employeeId) ?? undefined}
                primaryLabel={`${row.employeeName} – Personenansicht öffnen`}
                onPrimaryClick={(e) => onOpenPerson(e, row.employeeId)}
                dates={row.missingEntitlement
                  ? DASH
                  : `Rest ${fmtDaysDe(row.remainingDays ?? 0)} T.`}
              >
                {#snippet metaContent()}{@render listFigures(row)}{/snippet}
              </ApprovalRow>
            {/if}
            {#if messages[id]}
              <p class="vac-status" role="status">{messages[id]}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <div class="table-scroll">
        <table class="data-table data-table--compact vac-table">
          <caption class="sr-only">Urlaub je Person, Urlaubsjahr {activeYear}</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              {#each VACATION_YEAR_COLUMNS as label (label)}
                <th scope="col" class="num">{label}</th>
              {/each}
              <th scope="col">Verfall</th>
            </tr>
          </thead>
          <tbody>
            {#each pageRows as row (row.employeeId)}
              {@const href = personHref(row.employeeId)}
              <!-- The keyboard path is the name link; the row click is a pointer convenience. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <tr class="vac-row" onclick={(e) => onRowClick(e, row)}>
                <th scope="row" class="vac-person">
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
                </th>
                {#if row.missingEntitlement}
                  <td colspan={FIGURE_COLUMNS + 1}>
                    <span class="badge badge-yellow">kein Anspruch hinterlegt</span>
                  </td>
                {:else}
                  {#each figures(row) as value, i (i)}
                    <td class="num" class:strong={i === FIGURE_COLUMNS - 1}>{value}</td>
                  {/each}
                  <td class="vac-verfall">
                    <div class="verfall-cell">{@render verfallBody(row)}</div>
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="form-hint">
        Alle Werte in Arbeitstagen. Verfügbar = Anspruch + wirksamer Übertrag. Resturlaub =
        Verfügbar − Genommen − Genehmigt. Beantragte Tage werden nicht abgezogen.
      </p>
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
</Card>

<Card animate>
  <CardHeader title="Abwesenheiten nach Art" sub={periodLabel} />

  {#if absences === null}
    {#if loading}
      <div class="vac-skeleton" aria-busy="true">
        {#each Array.from({ length: 3 }, (_, i) => i) as i (i)}
          <div class="skeleton skeleton-text"></div>
        {/each}
      </div>
    {/if}
  {:else if shownAbsences.length === 0}
    <p class="vac-empty">Keine Abwesenheiten im Zeitraum.</p>
  {:else}
    <div class="table-scroll">
      <table class="data-table data-table--compact abs-table">
        <caption class="sr-only">Abwesenheiten nach Art, {periodLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Art</th>
            <th scope="col" class="num">Personen</th>
            <th scope="col" class="num">Tage</th>
          </tr>
        </thead>
        <tbody>
          {#each shownAbsences as a (a.code)}
            {@const entry = kindEntry(a.code)}
            <tr>
              <td>
                <span
                  class="type-dot"
                  style={`--type-color: var(${entry?.colorVar ?? "--leave-type-default"})`}
                ></span>
                {kindLabel(a)}
              </td>
              <td class="num">{a.personCount}</td>
              <td class="num">{fmtDaysDe(a.totalDays)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

<style>
  .vac-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .vac-empty {
    margin: 0;
    font-size: 15px;
    color: var(--text-muted);
  }

  .vac-table .num,
  .abs-table .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .vac-table .num.strong {
    font-weight: 600;
    color: var(--text);
  }

  .vac-table th {
    white-space: normal;
  }

  .vac-row {
    cursor: pointer;
  }

  /* A person the drill-down cannot show has a plain name and no pointer. */
  .vac-row:has(span.vac-person-link) {
    cursor: default;
  }

  .vac-person {
    min-width: 160px;
    max-width: 240px;
    text-align: left;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .vac-person-link {
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

  .vac-person-link:hover {
    text-decoration: underline;
  }

  .verfall-sub {
    display: block;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .vac-verfall {
    min-width: 170px;
  }

  /* Issue #442: the layout of the action cell lives on the inner wrapper, never on the td itself,
     so the cell keeps display: table-cell and lines up with the rest of the row. */
  .verfall-cell {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
  }

  .verfall-line {
    font-size: 15px;
    font-variant-numeric: tabular-nums;
  }

  .vac-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .vac-list-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
  }

  .vac-status {
    margin: var(--s-1) 0 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .type-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: var(--s-2);
    border-radius: 50%;
    background: var(--type-color, var(--leave-type-default));
  }

  .abs-table {
    max-width: 480px;
  }

  /* The notice button of the narrow list is a touch target (the list replaces the table at 960px). */
  .vac-notify-touch {
    min-height: 44px;
  }
</style>
