<script lang="ts">
  // Issue #612 (D-612-4, ADD-4, UI-SPEC "Person drill-down") - one person of the period: the four
  // figures, the closing saldo, the month series of the SAME answer, the vacation line, the day
  // list of the selected month and the person documents. Pattern 3: every figure is the server's;
  // the month names come from the server's year/month, never from a stored period start.
  //
  // The component owns no URL, no navigation and no API client. The page injects the day-list
  // loader, which it only reaches through this component - and this component calls it only with
  // `canTimeEntryRead` (T-612-20): without the right there is no request, just one hint line.
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte";
  import { fmtDaysDe, fmtHoursDe, monthNameDe } from "$lib/reports/period-format";
  import type {
    DayEntry,
    PeriodMonth,
    PeriodRow,
    PeriodVacationRow,
    YearMonth,
  } from "$lib/reports/period-report";
  import { withheldReason } from "$lib/reports/period-table";
  import { forecastLabel } from "$lib/saldo/forecast-label"; // Issue #588 (amendment 7)
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
    /** report:export - the two person documents. */
    canReportExport: boolean;
    /** Salon options are shown (#64): the day list gets a Salon column. */
    showSalonColumn: boolean;
    loadDayEntries: (employeeId: string, fromDay: string, toDay: string) => Promise<DayEntry[]>;
    onDownloadPdf: (month: YearMonth) => void | Promise<void>;
    onDownloadDatev: (month: YearMonth) => void | Promise<void>;
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
    onDownloadDatev,
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

  function hours(min: number | null, signed: boolean): string {
    return min === null ? DASH : fmtHoursDe(min, { signed });
  }

  function monthStatus(m: PeriodMonth): { label: string; good: boolean } {
    if (!m.labelled) return { label: "ohne Soll", good: false };
    return m.confirmed ? { label: "Bestätigt", good: true } : { label: "Prognose", good: false };
  }

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
  let narrow = $state(false);

  $effect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 640px)");
    narrow = query.matches;
    const onChange = (e: { matches: boolean }) => {
      narrow = e.matches;
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

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

  function dayLabel(date: string): string {
    const [y, m, d] = date.split("-").map(Number);
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

  function firstOfDay(list: DayEntry[], i: number): boolean {
    return i === 0 || list[i - 1].date !== list[i].date;
  }

  const teamHref = $derived(
    row && selected
      ? `/team/time-entries?employeeId=${encodeURIComponent(row.employeeId)}&date=${selected.year}-${pad(selected.month)}-01`
      : "",
  );

  // ── The person documents ─────────────────────────────────────────────────────────

  let pdfBusy = $state(false);
  let datevBusy = $state(false);

  async function download(kind: "pdf" | "datev") {
    if (!selected) return;
    const target: YearMonth = { year: selected.year, month: selected.month };
    if (kind === "pdf") pdfBusy = true;
    else datevBusy = true;
    try {
      await (kind === "pdf" ? onDownloadPdf(target) : onDownloadDatev(target));
    } finally {
      if (kind === "pdf") pdfBusy = false;
      else datevBusy = false;
    }
  }
</script>

{#snippet footerButtons()}
  <button type="button" class="btn btn-ghost" data-autofocus onclick={() => (open = false)}
    >Schließen</button
  >
  {#if canReportExport && selected && row}
    <button
      type="button"
      class="btn btn-outline sm"
      disabled={datevBusy}
      aria-label="DATEV-Datei {selectedName} für {row.employeeName}"
      onclick={() => download("datev")}
    >
      {#if datevBusy}<Spinner size={13} />{/if}
      DATEV (Person)
    </button>
    <button
      type="button"
      class="btn btn-outline sm"
      disabled={pdfBusy}
      aria-label="Stundennachweis {selectedName} für {row.employeeName} (PDF)"
      onclick={() => download("pdf")}
    >
      {#if pdfBusy}<Spinner size={13} />{/if}
      Stundennachweis (PDF)
    </button>
  {/if}
{/snippet}

<Modal
  bind:open
  eyebrow="Personenansicht"
  title={row?.employeeName ?? ""}
  size="wide"
  footer={footerButtons}
>
  {#if row}
    <div class="drill">
      <p class="drill-sub">Personalnr. {row.employeeNumber} · {periodLabel}</p>

      <div class="drill-stats">
        <div class="mini-stat">
          <span class="label">Soll</span>
          <span class="value">{hours(row.expectedMinutes, false)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">Ist</span>
          <span class="value">{hours(row.workedMinutes, false)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">Saldo Zeitraum</span>
          <span class="value">{hours(row.balanceMinutes, true)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">Saldo am Ende</span>
          <span class="value">{hours(row.closingBalanceMinutes, true)}</span>
        </div>
      </div>

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

      <section aria-labelledby="drill-months">
        <h3 id="drill-months" class="drill-h">Monate</h3>
        <div class="table-wrap">
          <table class="data-table data-table--compact drill-table">
            <caption class="sr-only">Monate, {periodLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Monat</th>
                <th scope="col" class="num">Soll (h)</th>
                <th scope="col" class="num">Ist (h)</th>
                <th scope="col" class="num">Saldo (h)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each months as m, i (`${m.year}-${m.month}`)}
                {@const status = monthStatus(m)}
                <tr class:drill-selected={i === selectedIndex}>
                  <td>
                    <button
                      type="button"
                      class="drill-month-btn"
                      aria-pressed={i === selectedIndex}
                      onclick={() => (selectedIndex = i)}>{monthNameDe(m.year, m.month)}</button
                    >
                  </td>
                  <td
                    class="num"
                    title={m.expectedMinutes === null ? withheldReason(row) : undefined}
                    >{hours(m.expectedMinutes, false)}</td
                  >
                  <td class="num">{hours(m.workedMinutes, false)}</td>
                  <td
                    class="num"
                    title={m.balanceMinutes === null ? withheldReason(row) : undefined}
                    >{hours(m.balanceMinutes, true)}</td
                  >
                  <td>
                    <span class="chip" class:chip-good={status.good}>{status.label}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>

      {#if vacationRow}
        <section aria-labelledby="drill-vacation">
          <h3 id="drill-vacation" class="drill-h">Urlaub</h3>
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

      {#if selected}
        <section aria-labelledby="drill-days">
          <h3 id="drill-days" class="drill-h">Tage im {selectedName}</h3>
          {#if !canTimeEntryRead}
            <p class="drill-sub">Die Tagesliste ist nur mit Leserecht auf Zeiteinträge sichtbar.</p>
          {:else if dayState === "loading" || dayState === "idle"}
            <p class="drill-sub" aria-busy="true"><Spinner size={13} /> Wird geladen</p>
          {:else if dayState === "error"}
            <div class="drill-error" role="alert">
              <p>Die Einträge konnten nicht geladen werden.</p>
              <button type="button" class="btn btn-outline sm" onclick={() => reloadTick++}
                >Erneut laden</button
              >
            </div>
          {:else if entries.length === 0}
            <p class="drill-sub">Keine Einträge in diesem Monat.</p>
          {:else if narrow}
            <ul class="drill-day-list" aria-label="Tage im {selectedName}">
              {#each entries as e (e.id)}
                <li>
                  <span>
                    {dayLabel(e.date)} · {span(e)} · Pause {fmtMin(e.breakMinutes)} · {workText(e)} h
                  </span>
                  {#if e.endTime === null}<span class="chip">läuft</span>{/if}
                  {#if e.isInvalid}
                    <span class="chip" title={e.invalidReason ?? undefined}>zählt nicht</span>
                  {/if}
                  {#if showSalonColumn && salonText(e)}
                    <span class="drill-sub">{salonText(e)}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <div class="table-wrap">
              <table class="data-table data-table--compact drill-table">
                <caption class="sr-only">Tage im {selectedName}</caption>
                <thead>
                  <tr>
                    <th scope="col">Datum</th>
                    <th scope="col">Von–Bis</th>
                    <th scope="col" class="num">Pause</th>
                    <th scope="col" class="num">Arbeitszeit</th>
                    {#if showSalonColumn}<th scope="col">Salon</th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each entries as e, i (e.id)}
                    <tr>
                      <td>{firstOfDay(entries, i) ? dayLabel(e.date) : ""}</td>
                      <td>
                        {span(e)}
                        {#if e.endTime === null}<span class="chip">läuft</span>{/if}
                        {#if e.isInvalid}
                          <span class="chip" title={e.invalidReason ?? undefined}>zählt nicht</span>
                        {/if}
                      </td>
                      <td class="num">{fmtMin(e.breakMinutes)}</td>
                      <td class="num">{workText(e)}</td>
                      {#if showSalonColumn}<td>{salonText(e)}</td>{/if}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          {#if canTimeEntryRead}
            <a class="drill-link" href={teamHref}>In Team-Zeiten öffnen</a>
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .drill {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    font-size: 15px;
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
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .drill-h {
    margin: 0 0 var(--s-2);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }

  .drill-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-4);
  }

  @media (max-width: 640px) {
    .drill-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .drill-table .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .drill-selected {
    background: var(--bg-subtle);
    box-shadow: inset 2px 0 0 var(--brand-light);
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

  .drill-day-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .drill-day-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
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
    font-size: 13.5px;
    color: var(--brand);
  }

  @media (pointer: coarse) {
    .drill-month-btn {
      min-height: 44px;
    }
  }
</style>
