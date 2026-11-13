<script lang="ts">
  // Issue #612 (D-612-4, ADD-4, UI-SPEC "Person drill-down") - one person of the period: the four
  // figures, the closing saldo, the month series of the SAME answer, the vacation line, the day
  // list of the selected month and the person documents. Pattern 3: every figure is the server's;
  // the month names come from the server's year/month, never from a stored period start.
  // Rebuilt on the blocks for Issue #854: a Dialog, a KpiStrip, a DataTable for the months and one
  // for the days (cards below 760 px of container width), Chips. The DATEV file of one person is
  // not started here any more (D-854-22, AC-7): a link opens Daten > Export with the person, the
  // year and the month preselected.
  //
  // The component owns no URL, no navigation and no API client. The page injects the day-list
  // loader, which it only reaches through this component - and this component calls it only with
  // `canTimeEntryRead` (T-612-20): without the right there is no request, just one hint line.
  import { untrack } from "svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte";
  import { absenceEntryText, personAbsenceEntries } from "$lib/reports/absence-table"; // Issue #713
  import { fmtDaysDe, fmtHoursDe, monthNameDe } from "$lib/reports/period-format";
  import type {
    DayEntry,
    PeriodMonth,
    PeriodRow,
    PeriodVacationRow,
    YearMonth,
  } from "$lib/reports/period-report";
  import { withheldReason } from "$lib/reports/period-table";
  import { exportHref } from "$lib/export/export-centre"; // D-854-22: the one export page
  import { forecastLabel } from "$lib/saldo/forecast-label"; // Issue #588 (amendment 7)
  import { monthStatusLabel } from "$lib/saldo/month-status"; // Issue #598: one status wording
  import { isTravelRow, travelRouteLabel } from "$lib/time-entries/travel-entry-form";
  import { fmtMin } from "$lib/utils/format-minutes";

  interface Props {
    /** Two-way bindable open state (Escape, backdrop and „Schließen“ clear it). */
    open: boolean;
    row: PeriodRow | null;
    /** The person's row of the Urlaub table of the period-end year, if any. */
    vacationRow: PeriodVacationRow | null;
    periodLabel: string;
    /** time-entry:read - without it the day list is never requested. */
    canTimeEntryRead: boolean;
    /** report:export - the Stundennachweis and the link to the DATEV export of the person. */
    canReportExport: boolean;
    /** Salon options are shown (#64): the day list gets a Salon column. */
    showSalonColumn: boolean;
    loadDayEntries: (employeeId: string, fromDay: string, toDay: string) => Promise<DayEntry[]>;
    onDownloadPdf: (month: YearMonth) => void | Promise<void>;
    /** Called once when the dialog went from open to closed. */
    onClose: () => void;
  }

  let {
    open = $bindable(),
    row,
    vacationRow,
    periodLabel,
    canTimeEntryRead,
    canReportExport,
    showSalonColumn,
    loadDayEntries,
    onDownloadPdf,
    onClose,
  }: Props = $props();

  const DASH = "—";
  const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;

  // ── Close ────────────────────────────────────────────────────────────────────────

  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      if (wasOpen && !isOpen) onClose();
      wasOpen = isOpen;
    });
  });

  // ── The month series ─────────────────────────────────────────────────────────────

  const months = $derived(row?.months ?? []);
  let selectedIndex = $state(0);

  // A new person or a new period starts at the last month of the series.
  $effect(() => {
    const key = `${row?.employeeId ?? ""}|${months.map((m) => `${m.year}-${m.month}`).join(",")}`;
    void key;
    untrack(() => {
      selectedIndex = Math.max(0, months.length - 1);
    });
  });

  const selected = $derived<PeriodMonth | null>(months[selectedIndex] ?? null);
  const selectedName = $derived(selected ? monthNameDe(selected.year, selected.month) : "");
  // Issue #713: the person's non-zero absence counts of the period, from the server's row.
  const absenceEntries = $derived(row ? personAbsenceEntries(row) : []);

  function hours(min: number | null, signed: boolean): string {
    return min === null ? DASH : fmtHoursDe(min, { signed });
  }

  // Issue #598: the month's status is worded like on Zeiten and Konto (closed or open); a month
  // without a Soll keeps that remark, it is a fact about the figures, not a status.
  function monthStatus(m: PeriodMonth): { label: string; tone: "ok" | "neutral"; noSoll: boolean } {
    return {
      label: monthStatusLabel(m.confirmed),
      tone: m.confirmed ? "ok" : "neutral",
      noSoll: !m.labelled,
    };
  }

  // DataTable's row type is a string-keyed record; the interfaces of the period answer have no index
  // signature, so the shown rows carry the intersection.
  type MonthRow = PeriodMonth & Record<string, unknown>;
  type DayRow = DayEntry & Record<string, unknown>;

  const stats = $derived.by((): KpiItem[] => {
    if (row === null) return [];
    return [
      { label: "Soll", value: hours(row.expectedMinutes, false) },
      { label: "Ist", value: hours(row.workedMinutes, false) },
      { label: "Saldo Zeitraum", value: hours(row.balanceMinutes, true) },
      { label: "Saldo am Ende", value: hours(row.closingBalanceMinutes, true) },
    ];
  });

  const monthColumns: DataTableColumn[] = [
    { key: "month", label: "Monat", primary: true },
    { key: "soll", label: "Soll (h)", align: "end" },
    { key: "ist", label: "Ist (h)", align: "end" },
    { key: "saldo", label: "Saldo (h)", align: "end" },
    { key: "status", label: "Status" },
  ];

  const dayColumns = $derived<DataTableColumn[]>([
    { key: "date", label: "Datum", primary: true },
    { key: "time", label: "Von–Bis" },
    { key: "break", label: "Pause", align: "end" },
    { key: "work", label: "Arbeitszeit", align: "end" },
    ...(showSalonColumn ? [{ key: "salon", label: "Salon" }] : []),
  ]);

  // ── The closing saldo (P-13) ─────────────────────────────────────────────────────

  const closing = $derived(row?.closingBalanceMinutes ?? null);
  const lastMonthConfirmed = $derived(
    row !== null && row.months.length > 0 && row.months[row.months.length - 1].confirmed,
  );
  const canSplit = $derived(
    row !== null &&
      row.closingConfirmedMinutes !== null &&
      row.closingOpenMinutes !== null &&
      !lastMonthConfirmed,
  );
  // Which words the forecast when the server cannot split it: the months of the period that are
  // not confirmed, after a closed month or not (the one forecast-label rule).
  const singleForecastLabel = $derived(
    row === null
      ? ""
      : forecastLabel(row.monthCount - row.confirmedMonthCount, row.confirmedMonthCount > 0),
  );

  // ── The day list of the selected month (only with time-entry:read) ───────────────

  let entries = $state<DayEntry[]>([]);
  let dayState = $state<"idle" | "loading" | "error" | "ready">("idle");
  let dayGeneration = 0; // plain: only the latest read may apply its answer
  let reloadTick = $state(0);

  function pad(n: number): string {
    return String(n).padStart(2, "0");
  }

  $effect(() => {
    void reloadTick;
    const person = row?.employeeId ?? null;
    const m = selected;
    const wanted = open && canTimeEntryRead && person !== null && m !== null;
    if (!wanted) {
      dayGeneration++;
      untrack(() => {
        dayState = "idle";
        entries = [];
      });
      return;
    }
    const from = `${m.year}-${pad(m.month)}-01`;
    const to = `${m.year}-${pad(m.month)}-${pad(new Date(m.year, m.month, 0).getDate())}`;
    const generation = ++dayGeneration;
    untrack(() => {
      dayState = "loading";
      entries = [];
      loadDayEntries(person, from, to)
        .then((answer) => {
          if (generation !== dayGeneration) return;
          entries = answer;
          dayState = "ready";
        })
        .catch(() => {
          if (generation !== dayGeneration) return;
          dayState = "error";
        });
    });
  });

  // The API serves a `@db.Date` as an ISO timestamp ("2026-11-02T00:00:00.000Z"); the calendar day is
  // its first ten characters (the UTC date part, as Prisma stores it).
  function calendarDay(date: string): string {
    return date.slice(0, 10);
  }

  function dayLabel(date: string): string {
    const [y, m, d] = calendarDay(date).split("-").map(Number);
    return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${pad(d)}.${pad(m)}.`;
  }

  function clock(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function span(e: DayEntry): string {
    return `${clock(e.startTime)}–${clock(e.endTime)}`;
  }

  function salonText(e: DayEntry): string {
    return isTravelRow(e) ? `Fahrt: ${travelRouteLabel(e)}` : (e.salonName ?? "");
  }

  function workText(e: DayEntry): string {
    return e.endTime === null || e.workingMinutes == null ? DASH : fmtMin(e.workingMinutes);
  }

  // The date is printed on the first entry of a day only.
  const firstOfDayIds = $derived(
    new Set(
      entries
        .filter((e, i) => i === 0 || calendarDay(entries[i - 1].date) !== calendarDay(e.date))
        .map((e) => e.id),
    ),
  );

  // Issue #594: every day of the list opens that day in Team-Zeiten (the same page and reach as the
  // month link below; the list itself is only rendered with time-entry:read).
  function dayHref(date: string): string {
    return row
      ? `/team/time-entries?employeeId=${encodeURIComponent(row.employeeId)}&date=${calendarDay(date)}`
      : "";
  }

  const teamHref = $derived(
    row && selected
      ? `/team/time-entries?employeeId=${encodeURIComponent(row.employeeId)}&date=${selected.year}-${pad(selected.month)}-01`
      : "",
  );

  // ── The person documents ─────────────────────────────────────────────────────────

  let pdfBusy = $state(false);

  async function downloadPdf() {
    if (!selected) return;
    const target: YearMonth = { year: selected.year, month: selected.month };
    pdfBusy = true;
    try {
      await onDownloadPdf(target);
    } finally {
      pdfBusy = false;
    }
  }

  // D-854-22: the DATEV file of the person is made on Daten > Export; the link carries the choice.
  const datevHref = $derived(
    row && selected
      ? exportHref({ personId: row.employeeId, year: selected.year, month: selected.month })
      : "",
  );
</script>

{#snippet footerButtons()}
  <button type="button" class="btn btn-ghost" data-autofocus onclick={() => (open = false)}
    >Schließen</button
  >
  {#if canReportExport && selected && row}
    <a
      class="btn btn-outline sm"
      href={datevHref}
      aria-label="DATEV für diese Person: {selectedName} für {row.employeeName} im Export öffnen"
      >DATEV für diese Person</a
    >
    <button
      type="button"
      class="btn btn-outline sm"
      disabled={pdfBusy}
      aria-label="Stundennachweis {selectedName} für {row.employeeName} (PDF)"
      onclick={downloadPdf}
    >
      {#if pdfBusy}<Spinner size={13} />{/if}
      Stundennachweis (PDF)
    </button>
  {/if}
{/snippet}

{#snippet monthCell(m: MonthRow, column: DataTableColumn)}
  {#if column.key === "month"}
    {@const index = months.findIndex((x) => x.year === m.year && x.month === m.month)}
    <button
      type="button"
      class="drill-month-btn"
      aria-pressed={index === selectedIndex}
      onclick={() => (selectedIndex = index)}>{monthNameDe(m.year, m.month)}</button
    >
  {:else if column.key === "soll"}
    <span title={m.expectedMinutes === null && row ? withheldReason(row) : undefined}
      >{hours(m.expectedMinutes, false)}</span
    >
  {:else if column.key === "ist"}
    {hours(m.workedMinutes, false)}
  {:else if column.key === "saldo"}
    <span title={m.balanceMinutes === null && row ? withheldReason(row) : undefined}
      >{hours(m.balanceMinutes, true)}</span
    >
  {:else if column.key === "status"}
    {@const status = monthStatus(m)}
    <Chip tone={status.tone}>{status.label}</Chip>
    {#if status.noSoll}<span class="drill-sub">ohne Soll</span>{/if}
  {/if}
{/snippet}

{#snippet dayCell(e: DayRow, column: DataTableColumn)}
  {#if column.key === "date"}
    {#if firstOfDayIds.has(e.id)}<a class="drill-link" href={dayHref(e.date)}>{dayLabel(e.date)}</a
      >{:else}<span class="drill-repeat"></span>{/if}
  {:else if column.key === "time"}
    {span(e)}
    {#if e.endTime === null}<Chip tone="neutral">läuft</Chip>{/if}
    {#if e.isInvalid}
      <Chip tone="warn" title={e.invalidReason ?? undefined}>zählt nicht</Chip>
    {/if}
  {:else if column.key === "break"}
    {fmtMin(e.breakMinutes)}
  {:else if column.key === "work"}
    {workText(e)}
  {:else if column.key === "salon"}
    {salonText(e)}
  {/if}
{/snippet}

<Dialog
  bind:open
  eyebrow="Personenansicht"
  title={row?.employeeName ?? ""}
  size="wide"
  footer={footerButtons}
>
  {#if row}
    <div class="drill">
      <p class="drill-sub">Personalnr. {row.employeeNumber} · {periodLabel}</p>

      <KpiStrip items={stats} ariaLabel="Zahlen der Person im Zeitraum" />

      {#if closing !== null}
        <div class="drill-saldo">
          {#if canSplit}
            <SaldoAnzeige
              variant="expanded"
              label="Saldo am Ende"
              confirmedMinutes={row.closingConfirmedMinutes ?? 0}
              openMonthMinutes={row.closingOpenMinutes}
              hasClosedMonth={true}
              unconfirmedMonths={row.unconfirmedMonths}
            />
          {:else if lastMonthConfirmed}
            <SaldoAnzeige
              variant="expanded"
              label="Saldo am Ende"
              saldoMinutes={closing}
              isLocked={true}
            />
          {:else}
            <SaldoAnzeige
              variant="expanded"
              label="Saldo am Ende · {singleForecastLabel}"
              saldoMinutes={closing}
            />
          {/if}
        </div>
      {/if}

      <section class="drill-section" aria-labelledby="drill-months">
        <h3 id="drill-months" class="settings-group-title">Monate</h3>
        <DataTable
          columns={monthColumns}
          rows={months as MonthRow[]}
          rowKey={(m) => `${m.year}-${m.month}`}
          cell={monthCell}
          caption={`Monate, ${periodLabel}`}
        />
      </section>

      {#if vacationRow}
        <section class="drill-section" aria-labelledby="drill-vacation">
          <h3 id="drill-vacation" class="settings-group-title">Urlaub</h3>
          {#if vacationRow.missingEntitlement}
            <p class="drill-sub">Urlaubsjahr {vacationRow.year}: kein Anspruch hinterlegt</p>
          {:else}
            <p class="drill-sub">
              Urlaubsjahr {vacationRow.year}: Anspruch {fmtDaysDe(vacationRow.entitlementDays ?? 0)} ·
              Genommen {fmtDaysDe(vacationRow.takenDays ?? 0)} · Genehmigt {fmtDaysDe(
                vacationRow.approvedUpcomingDays ?? 0,
              )} · Resturlaub {fmtDaysDe(vacationRow.remainingDays ?? 0)}
            </p>
          {/if}
        </section>
      {/if}

      <!-- Issue #713 (AC-713-5, D-07): counts per kind and unit, never a date; no right beyond the
           row itself is needed, so the section does not depend on the day list's permission. -->
      <section class="drill-section" aria-labelledby="drill-absences">
        <h3 id="drill-absences" class="settings-group-title">Abwesenheiten</h3>
        {#if absenceEntries.length === 0}
          <p class="drill-sub">Keine Abwesenheiten im Zeitraum.</p>
        {:else}
          <ul class="drill-absence-list">
            {#each absenceEntries as entry (entry.label)}
              <li>{absenceEntryText(entry)}</li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if selected}
        <section class="drill-section" aria-labelledby="drill-days">
          <h3 id="drill-days" class="settings-group-title">Tage im {selectedName}</h3>
          {#if !canTimeEntryRead}
            <p class="drill-sub">Die Tagesliste ist nur mit Leserecht auf Zeiteinträge sichtbar.</p>
          {:else if dayState === "loading" || dayState === "idle"}
            <Skeleton shape="block" height="8rem" />
          {:else if dayState === "error"}
            <div class="drill-error" role="alert">
              <p>Die Einträge konnten nicht geladen werden.</p>
              <button type="button" class="btn btn-outline sm" onclick={() => reloadTick++}
                >Erneut laden</button
              >
            </div>
          {:else if entries.length === 0}
            <p class="drill-sub">Keine Einträge in diesem Monat.</p>
          {:else}
            <div class="drill-days">
              <DataTable
                columns={dayColumns}
                rows={entries as DayRow[]}
                rowKey={(e) => e.id}
                rowTestId={(e) => `drill-day-${e.id}`}
                cell={dayCell}
                caption={`Tage im ${selectedName}`}
              />
            </div>
          {/if}
          {#if canTimeEntryRead}
            <a class="drill-link" href={teamHref}>In Team-Zeiten öffnen</a>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</Dialog>

<style>
  .drill {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    font-size: var(--fs-base);
  }

  .drill-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  /* The info tooltip of the saldo is positioned from its trigger, which on a phone sits near the
     right edge of the modal: its 280 px panel then ends beyond the modal, which clips it. Below
     641 px the panel hangs from this block instead and spans its width (found by the 390/360 px
     matrix of reports-period.spec.ts). */
  @media (max-width: 640px) {
    .drill-saldo {
      position: relative;
    }

    .drill-saldo :global(.saldo-info-wrap) {
      position: static;
    }

    .drill-saldo :global(.saldo-tooltip) {
      left: 0;
      right: 0;
      width: auto;
      max-width: none;
    }
  }

  .drill-sub {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-2);
  }

  .drill-absence-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    line-height: 1.4;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .drill-month-btn {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    padding: 0;
    font: inherit;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }

  /* The selected month reads in the brand colour with an underline (the state is also aria-pressed). */
  .drill-month-btn[aria-pressed="true"] {
    color: var(--brand);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .drill-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
  }

  .drill-error p {
    margin: 0;
  }

  .drill-link {
    display: inline-block;
    margin-top: var(--s-2);
    font-size: var(--fs-base);
    color: var(--brand);
  }

  /* A second entry of a day has no date: in the card layout its empty title cell is dropped. */
  @container (max-width: 759.98px) {
    .drill-days :global(td.dt-primary-cell:has(.drill-repeat)) {
      display: none;
    }
  }

  @media (pointer: coarse) {
    .drill-month-btn {
      min-height: 44px;
    }
  }
</style>
