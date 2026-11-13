<!--
  SupportMonthView - one employee's month as the operator sees it under a support access (Issue #93,
  D-05(2), AC-93-9). Pure rendering of the minimised DTO: the month figures with their closed state,
  the time entries with breaks and markers, the day breaks, the leave requests and the absences.

  Every label is keyed by the control value the API sends (`support-labels`); an unknown value is shown
  raw. A deleted entry stays in the list, muted and badged, because support traces vanished entries.
  Times are shown in the browser's zone together with the day (D-03). The tables are DataTable blocks
  (Issue #899): a card list below 760 px of container width, so a phone never scrolls sideways.
-->
<script lang="ts">
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import {
    formatOperatorDay,
    formatOperatorDayRange,
    formatOperatorTime,
  } from "$lib/operator/labels";
  import {
    ABSENCE_SOURCE_LABELS,
    BREAK_STATUS_LABELS,
    EMPLOYEE_STATUS_LABELS,
    ENTRY_SOURCE_LABELS,
    ENTRY_TYPE_LABELS,
    FIGURES_BASIS_LABELS,
    FIGURES_UNAVAILABLE_LABELS,
    INVALID_REASON_LABELS,
    LEAVE_STATUS_LABELS,
    LEAVE_TYPE_LABELS,
    employeeStatusBadgeClass,
    formatDays,
    formatMinutes,
    formatSignedMinutes,
    labelFor,
  } from "$lib/operator/support-labels";
  import type { SupportEmployeeMonth, SupportMonthEntry } from "$lib/operator/types";

  interface Props {
    month: SupportEmployeeMonth;
  }

  let { month }: Props = $props();

  const person = $derived(month.employee);

  const ENTRY_COLUMNS: DataTableColumn[] = [
    { key: "date", label: "Datum", primary: true },
    { key: "startTime", label: "Beginn" },
    { key: "endTime", label: "Ende" },
    { key: "breaks", label: "Pausen" },
    { key: "breakStatus", label: "Pausenstatus" },
    { key: "salon", label: "Salon" },
    { key: "type", label: "Art" },
    { key: "source", label: "Quelle" },
    { key: "marks", label: "Markierungen" },
  ];
  const DAY_BREAK_COLUMNS: DataTableColumn[] = [
    { key: "date", label: "Datum", primary: true },
    { key: "pause", label: "Pause" },
  ];
  const LEAVE_COLUMNS: DataTableColumn[] = [
    { key: "typeName", label: "Art", primary: true },
    { key: "status", label: "Status" },
    { key: "period", label: "Zeitraum" },
    { key: "days", label: "Tage" },
  ];
  const ABSENCE_COLUMNS: DataTableColumn[] = [
    { key: "type", label: "Art", primary: true },
    { key: "period", label: "Zeitraum" },
    { key: "source", label: "Herkunft" },
  ];

  function timeRange(startTime: string, endTime: string): string {
    return `${formatOperatorTime(startTime)} – ${formatOperatorTime(endTime)}`;
  }

  /** The invalid badge: the reason code's label, the raw code when unknown, plain without a code. */
  function invalidText(entry: SupportMonthEntry): string {
    return entry.invalidReasonCode === null
      ? "ungültig"
      : `ungültig: ${labelFor(INVALID_REASON_LABELS, entry.invalidReasonCode)}`;
  }
</script>

<div class="month" data-testid="op-support-month">
  <div class="person">
    <h2 class="person-name">{person.lastName}, {person.firstName}</h2>
    <span class="mono" data-testid="op-support-month-number">{person.employeeNumber}</span>
    <span
      class={`badge mark ${employeeStatusBadgeClass(person.status)}`}
      data-testid="op-support-month-status"
      data-state={person.status}>{labelFor(EMPLOYEE_STATUS_LABELS, person.status)}</span
    >
  </div>

  <Section title="Monatswerte" animate>
    <div data-testid="op-support-figures">
      {#if month.figures}
        <dl class="facts">
          <dt>Soll</dt>
          <dd data-testid="op-support-figure-expected">
            {formatMinutes(month.figures.expectedMinutes)}
          </dd>
          <dt>Ist</dt>
          <dd data-testid="op-support-figure-worked">
            {formatMinutes(month.figures.workedMinutes)}
          </dd>
          <dt>Saldo</dt>
          <dd data-testid="op-support-figure-balance">
            {formatSignedMinutes(month.figures.balanceMinutes)}
          </dd>
          <dt>Stand</dt>
          <dd data-testid="op-support-figure-basis">
            {labelFor(FIGURES_BASIS_LABELS, month.figures.basis)}
          </dd>
        </dl>
        {#if month.snapshot}
          <p
            class="closed"
            data-testid="op-support-month-closed"
            data-closed={String(month.snapshot.confirmed)}
          >
            {month.snapshot.confirmed ? "Monat abgeschlossen" : "Monat offen"}
          </p>
        {/if}
      {:else}
        <p class="empty" data-testid="op-support-figures-unavailable">
          Monatswerte nicht verfügbar{#if month.figuresUnavailableReason}.
            {labelFor(FIGURES_UNAVAILABLE_LABELS, month.figuresUnavailableReason)}{/if}
        </p>
      {/if}
    </div>
  </Section>

  <Section title="Zeiteinträge" sub="Uhrzeiten in der Zeitzone dieses Browsers" animate>
    <div data-testid="op-support-entries">
      {#if month.entries.length === 0}
        <p class="empty">Keine Zeiteinträge in diesem Monat.</p>
      {:else}
        <div data-testid="op-support-entries-table">
          <DataTable
            caption="Zeiteinträge des Monats"
            columns={ENTRY_COLUMNS}
            rows={month.entries}
            rowKey={(entry) => entry.id}
            rowTestId={(entry) => `op-support-entry-row-${entry.id}`}
            rowClass={(entry) => (entry.deleted ? "deleted" : undefined)}
            rowAttrs={(entry) => ({
              "data-deleted": String(entry.deleted),
              "data-invalid": String(entry.isInvalid),
              "data-locked": String(entry.isLocked),
            })}
          >
            {#snippet cell(entry, column)}
              {#if column.key === "date"}
                {formatOperatorDay(entry.date)}
              {:else if column.key === "startTime"}
                {formatOperatorTime(entry.startTime)}
              {:else if column.key === "endTime"}
                {entry.endTime ? formatOperatorTime(entry.endTime) : "offen"}
              {:else if column.key === "breaks"}
                {#if entry.breaks.length > 0}
                  <ul class="breaks">
                    {#each entry.breaks as item, index (index)}
                      <li data-break>{timeRange(item.startTime, item.endTime)}</li>
                    {/each}
                  </ul>
                  <span class="minutes">{entry.breakMinutes} Min.</span>
                {:else if entry.breakMinutes > 0}
                  <span class="minutes">{entry.breakMinutes} Min.</span>
                {:else}
                  –
                {/if}
              {:else if column.key === "breakStatus"}
                {labelFor(BREAK_STATUS_LABELS, entry.breakStatus)}
              {:else if column.key === "salon"}
                <span class="text">{entry.salon.name}</span>
              {:else if column.key === "type"}
                {labelFor(ENTRY_TYPE_LABELS, entry.type)}
              {:else if column.key === "source"}
                {labelFor(ENTRY_SOURCE_LABELS, entry.source)}
              {:else}
                <span class="marks">
                  {#if entry.isInvalid}
                    <span class="badge badge-red mark">{invalidText(entry)}</span>
                  {/if}
                  {#if entry.deleted}
                    <span class="badge badge-gray">gelöscht</span>
                  {/if}
                  {#if entry.isLocked}
                    <span class="badge badge-blue mark">gesperrt</span>
                  {/if}
                </span>
              {/if}
            {/snippet}
          </DataTable>
        </div>
      {/if}
    </div>
  </Section>

  <Section title="Tagespausen" sub="Pausen zwischen zwei Einträgen" animate>
    <div data-testid="op-support-daybreaks">
      {#if month.dayBreaks.length === 0}
        <p class="empty">Keine Tagespausen in diesem Monat.</p>
      {:else}
        <DataTable
          caption="Tagespausen des Monats"
          columns={DAY_BREAK_COLUMNS}
          rows={month.dayBreaks}
          rowKey={(item) => item.id}
          rowTestId={(item) => `op-support-daybreak-row-${item.id}`}
        >
          {#snippet cell(item, column)}
            {#if column.key === "date"}
              {formatOperatorDay(item.date)}
            {:else}
              {timeRange(item.startTime, item.endTime)}
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </div>
  </Section>

  <Section title="Anträge" sub="Beantragte Abwesenheiten wie Urlaub oder Krankheit" animate>
    <div data-testid="op-support-leave">
      {#if month.leaveRequests.length === 0}
        <p class="empty">Keine Anträge in diesem Monat.</p>
      {:else}
        <DataTable
          caption="Anträge des Monats"
          columns={LEAVE_COLUMNS}
          rows={month.leaveRequests}
          rowKey={(request) => request.id}
          rowTestId={(request) => `op-support-leave-row-${request.id}`}
        >
          {#snippet cell(request, column)}
            {#if column.key === "typeName"}
              <span class="text">{request.typeName}</span>
            {:else if column.key === "status"}
              {labelFor(LEAVE_STATUS_LABELS, request.status)}
            {:else if column.key === "period"}
              {formatOperatorDayRange(request.startDate, request.endDate)}
              {#if request.halfDay}<span class="badge badge-gray">halber Tag</span>{/if}
            {:else}
              {formatDays(request.days)}
              {#if request.daysProvisional === true}
                <span class="badge badge-yellow mark">vorläufig</span>
              {/if}
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </div>
  </Section>

  <Section title="Abwesenheiten" sub="Angeordnete Abwesenheiten wie Berufsschule" animate>
    <div data-testid="op-support-absences">
      {#if month.absences.length === 0}
        <p class="empty">Keine Abwesenheiten in diesem Monat.</p>
      {:else}
        <DataTable
          caption="Abwesenheiten des Monats"
          columns={ABSENCE_COLUMNS}
          rows={month.absences}
          rowKey={(absence) => absence.id}
          rowTestId={(absence) => `op-support-absence-row-${absence.id}`}
        >
          {#snippet cell(absence, column)}
            {#if column.key === "type"}
              {labelFor(LEAVE_TYPE_LABELS, absence.type)}
            {:else if column.key === "period"}
              {formatOperatorDayRange(absence.startDate, absence.endDate)}
              {#if absence.halfDay}<span class="badge badge-gray">halber Tag</span>{/if}
            {:else}
              {labelFor(ABSENCE_SOURCE_LABELS, absence.source)}
            {/if}
          {/snippet}
        </DataTable>
      {/if}
    </div>
  </Section>
</div>

<style>
  .month {
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
  }

  .person {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
  }

  .person-name {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .mono {
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--text-2);
  }

  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-2);
  }

  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 24px;
    margin: 0;
  }

  .facts dt {
    color: var(--text-2);
  }

  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .closed {
    margin: 16px 0 0;
    font-size: 13px;
    color: var(--text-2);
  }

  .text {
    display: inline-block;
    white-space: normal;
    overflow-wrap: anywhere;
    min-width: 0;
    /* A very long unbroken salon name wraps inside its own column instead of squeezing the other columns
       and pushing the marks out of the table wrapper (measured at 1440 px with a 100-character name). */
    max-width: 24ch;
  }

  .breaks {
    margin: 0;
    padding: 0;
    list-style: none;
    font-variant-numeric: tabular-nums;
  }

  .minutes {
    color: var(--text-2);
    font-size: 13px;
  }

  /* The flex row lives in a wrapper: a table cell must stay a table cell, or its row border breaks. */
  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  /* An unknown reason code is shown raw and may be long: the badge wraps instead of widening the column. */
  .marks .badge {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  /* The tinted text of .badge-red / -yellow / -blue misses 4.5:1 on its own tint (13 px text; dark
     mode worst): the label takes the body text colour, the tint and border still carry the meaning. */
  .mark {
    color: var(--text);
  }

  /* A deleted entry stays in the list but reads as no longer valid (the row class comes from the
     DataTable `rowClass`, so it is styled globally). */
  .month :global(tr.deleted td) {
    color: var(--text-2);
  }
</style>
