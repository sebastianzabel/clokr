<script lang="ts">
  // Issue #854 (plan 854-26, D-854-10) - months x status of one year plus the per-person list of the
  // month in view, both as DataTables. Presentation only: which month is in view, what a click does
  // and every write belong to the page; nothing here talks to the API.
  //
  // Day lists (Issue #86, D-02): the dates come from `$lib/month-close/day-lists`, which prints the
  // server's COUNT when the reader may not see the dates (`dayDetailsWithheld`). An emptied list is
  // never rendered as "no gaps".
  import { tick } from "svelte";
  import Chip, { type ChipTone } from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Note from "$components/ui/Note.svelte";
  import {
    breakFindingHintFor,
    gapCountOf,
    karenzOverrunCountOf,
    karenzOverrunTitle,
    missingDaysText,
  } from "$lib/month-close/day-lists";
  import { exitLabel } from "$lib/month-close/exit-label";
  import type { EmployeeStatus, MonthStatus } from "$lib/month-close/types";
  import { MONTH_STATUS_LABEL } from "$lib/saldo/month-status"; // Issue #598: one status wording

  interface Props {
    year: number;
    /** Every month of the year (the "blocked by" reason looks at the months before). */
    months: MonthStatus[];
    /** The months after the status filter. */
    visibleMonths: MonthStatus[];
    /** True when `visibleMonths` is empty because of the filter. */
    filtered?: boolean;
    onResetFilters?: () => void;
    /** The month whose persons are shown, or null. */
    selectedMonth: number | null;
    /** The month whose "Abschließen" button is offered (the first one still open). */
    firstActionableMonth: number | null;
    employees: EmployeeStatus[];
    detailLoading: boolean;
    /** A month-wide close is running: every close button waits. */
    busy: boolean;
    closingEmployee: string | null;
    unlocking: string | null;
    onSelectMonth: (month: number) => void;
    onCloseMonth: (month: number) => void;
    onCloseEmployee: (employeeId: string, month: number) => void;
    onUnlockEmployee: (employeeId: string, month: number) => void;
  }

  let {
    year,
    months,
    visibleMonths,
    filtered = false,
    onResetFilters,
    selectedMonth,
    firstActionableMonth,
    employees,
    detailLoading,
    busy,
    closingEmployee,
    unlocking,
    onSelectMonth,
    onCloseMonth,
    onCloseEmployee,
    onUnlockEmployee,
  }: Props = $props();

  const NOT_OPENABLE = ["future", "no_data"];

  const STATUS_LABELS: Record<string, string> = {
    closed: MONTH_STATUS_LABEL.CLOSED,
    partial: "Teilweise",
    ready: "Bereit",
    open: MONTH_STATUS_LABEL.OPEN,
    blocked: "Blockiert",
    future: "Zukunft",
    no_data: "Keine Daten",
  };

  const STATUS_TONES: Record<string, ChipTone> = {
    closed: "ok",
    ready: "brand",
    partial: "warn",
    blocked: "warn",
  };

  function statusLabel(status: string): string {
    return STATUS_LABELS[status] ?? status;
  }

  function statusTone(status: string): ChipTone {
    return STATUS_TONES[status] ?? "neutral";
  }

  function shortenName(name: string): string {
    const parts = name.split(" ");
    if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
    return name;
  }

  function reasonText(ms: MonthStatus): string {
    if (ms.status === "closed" || ms.status === "future") return "–";
    if (ms.status === "no_data") return "Keine Erfassung in diesem Zeitraum";
    if (ms.status === "blocked") {
      const prev = months.find(
        (p) => p.month < ms.month && p.status !== "closed" && p.status !== "future",
      );
      return prev ? `${prev.name} noch offen` : "Vorheriger Monat noch offen";
    }
    if (ms.status === "open" && ms.missing && ms.missing.length > 0) {
      return ms.missing
        .map((m) => `${shortenName(m.employeeName)}: ${missingDaysText(m, { short: true })}`)
        .join("; ");
    }
    if (ms.status === "partial") return `${ms.closedCount} von ${ms.totalCount} abgeschlossen`;
    if (ms.status === "ready") return "Alle Mitarbeiter bereit";
    return "–";
  }

  const monthColumns: DataTableColumn[] = [
    { key: "name", label: "Monat", primary: true },
    { key: "status", label: "Status" },
    { key: "reason", label: "Grund" },
    { key: "action", label: "Aktion", align: "end" },
  ];

  const personColumns: DataTableColumn[] = [
    { key: "employeeName", label: "Name", primary: true },
    { key: "employeeNumber", label: "Personalnummer" },
    { key: "status", label: "Status" },
    { key: "missing", label: "Fehlende Tage" },
    { key: "action", label: "Aktion", align: "end" },
  ];

  const selected = $derived(months.find((m) => m.month === selectedMonth) ?? null);

  // The persons list opens below the months: bring it into view (a phone shows the months as cards).
  let detailSection: HTMLElement | undefined = $state();
  $effect(() => {
    if (selectedMonth === null) return;
    void tick().then(() => detailSection?.scrollIntoView?.({ block: "nearest" }));
  });

  function openMonth(ms: MonthStatus) {
    if (NOT_OPENABLE.includes(ms.status)) return;
    onSelectMonth(ms.month);
  }
</script>

<section class="settings-group" aria-labelledby="mst-months-title">
  <h2 class="settings-group-title" id="mst-months-title">Monate {year}</h2>
  <p class="settings-group-desc">Wähle einen Monat, um die Personen und ihren Stand zu sehen.</p>
  <DataTable
    columns={monthColumns}
    rows={visibleMonths}
    rowKey={(ms) => ms.month}
    rowTestId={(ms) => `month-close-row-${ms.month}`}
    onRowClick={openMonth}
    {filtered}
    {onResetFilters}
    caption={`Monate ${year} mit Status und Grund`}
  >
    {#snippet cell(ms, column)}
      {#if column.key === "name"}
        <span class="mst-month">
          <span class="mst-chevron" aria-hidden="true"
            >{selectedMonth === ms.month ? "▾" : NOT_OPENABLE.includes(ms.status) ? "" : "▸"}</span
          >
          {ms.name}
          {year}
        </span>
      {:else if column.key === "status"}
        <Chip tone={statusTone(ms.status)}>
          {statusLabel(ms.status)} ({ms.closedCount}/{ms.totalCount})
        </Chip>
      {:else if column.key === "reason"}
        <span class="mst-reason">{reasonText(ms)}</span>
      {:else if (ms.status === "ready" || ms.status === "partial" || ms.status === "open") && ms.month === firstActionableMonth}
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={busy}
          onclick={() => onCloseMonth(ms.month)}
          data-testid={`month-close-row-${ms.month}-trigger`}
        >
          Abschließen
        </button>
      {:else if ms.status === "closed"}
        <span class="mst-none" data-testid={`month-close-row-${ms.month}-locked`}>–</span>
      {:else}
        <span class="mst-none">–</span>
      {/if}
    {/snippet}
  </DataTable>
</section>

{#if selected}
  <section
    class="settings-group"
    aria-labelledby="mst-persons-title"
    data-testid="month-close-detail"
    bind:this={detailSection}
  >
    <h2 class="settings-group-title" id="mst-persons-title">
      {selected.name}
      {year}: Personen
    </h2>
    {#if selected.status === "ready"}
      <Note tone="warn">
        Endgültiger Abschluss: Mit dem Abschluss werden alle Zeiteinträge dieses Monats gesperrt und
        das Audit-Log fortgeschrieben. Änderungen sind danach nur noch durch Storno-Buchungen
        möglich.
      </Note>
    {/if}
    <DataTable
      columns={personColumns}
      rows={employees}
      rowKey={(emp) => emp.employeeId}
      rowTestId={(emp) => `month-close-person-${emp.employeeId}`}
      loading={detailLoading}
      caption={`Personen im ${selected.name} ${year} mit Status und fehlenden Tagen`}
    >
      {#snippet cell(emp, column)}
        {#if column.key === "employeeName"}
          {emp.employeeName}
          {#if exitLabel(emp.exitDate)}
            <Chip tone="neutral">{exitLabel(emp.exitDate)}</Chip>
          {/if}
        {:else if column.key === "employeeNumber"}
          {emp.employeeNumber}
        {:else if column.key === "status"}
          <span class="mst-chips">
            {#if emp.status === "closed"}
              <Chip tone="ok">{MONTH_STATUS_LABEL.CLOSED}</Chip>
            {:else if emp.status === "ready"}
              <Chip tone="brand">Bereit</Chip>
            {:else}
              <Chip tone="neutral">Fehlend</Chip>
            {/if}
            {#if karenzOverrunCountOf(emp) > 0}
              <span data-testid="karenz-overrun-hint">
                <Chip tone="warn" title={karenzOverrunTitle(emp)}>
                  Attest fehlt ({karenzOverrunCountOf(emp)})
                </Chip>
              </span>
            {/if}
            <!-- Issue #80 (D-09b) / #511 (D-12): display-only chip, no control -->
            {#if breakFindingHintFor(emp)}
              {@const hint = breakFindingHintFor(emp)}
              <span data-testid="break-finding-hint">
                <Chip tone="warn" title={hint?.title}>{hint?.label}</Chip>
              </span>
            {/if}
          </span>
        {:else if column.key === "missing"}
          {#if gapCountOf(emp) > 0}
            <span class="mst-gaps">{missingDaysText(emp)}</span>
            {#if !emp.dayDetailsWithheld}
              <span class="mst-gap-count">({gapCountOf(emp)})</span>
            {/if}
          {:else}
            <span class="mst-none">–</span>
          {/if}
        {:else if selectedMonth !== null && (emp.status === "ready" || emp.status === "missing")}
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={closingEmployee === emp.employeeId || busy}
            onclick={() => onCloseEmployee(emp.employeeId, selectedMonth)}
          >
            Abschließen
          </button>
        {:else if selectedMonth !== null && emp.status === "closed"}
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            disabled={unlocking === emp.employeeId}
            onclick={() => onUnlockEmployee(emp.employeeId, selectedMonth)}
          >
            Entsperren
          </button>
        {/if}
      {/snippet}
    </DataTable>
  </section>
{/if}

<style>
  .mst-month {
    font-weight: 500;
  }

  .mst-chevron {
    display: inline-block;
    width: 1em;
    color: var(--text-2);
  }

  /* The table keeps values on one line; a reason with several names may wrap inside its cell. */
  .mst-reason {
    display: inline-block;
    max-width: 44ch;
    white-space: normal;
    color: var(--text-2);
    font-size: var(--fs-sm);
  }

  .mst-none {
    color: var(--text-3);
  }

  .mst-chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    align-items: center;
  }

  .mst-gaps {
    color: var(--bad);
    font-size: var(--fs-sm);
  }

  .mst-gap-count {
    margin-left: var(--s-1);
    color: var(--text-2);
    font-size: var(--fs-sm);
  }
</style>
