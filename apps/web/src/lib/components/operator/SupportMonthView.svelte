<!--
  SupportMonthView - one employee's month as the operator sees it under a support access (Issue #93,
  D-05(2), AC-93-9). Pure rendering of the minimised DTO: the month figures with their closed state,
  the time entries with breaks and markers, the day breaks, the leave requests and the absences.

  Every label is keyed by the control value the API sends (`support-labels`); an unknown value is shown
  raw. A deleted entry stays in the list, muted and badged, because support traces vanished entries.
  Times are shown in the browser's zone together with the day (D-03). Tables switch to a stacked list
  below 640 px by CSS only (same markup), so a phone never scrolls sideways.
-->
<script lang="ts">
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
      class={`badge ${employeeStatusBadgeClass(person.status)}`}
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
        <div class="table-wrap">
          <table class="data-table stack-table" data-testid="op-support-entries-table">
            <caption class="sr-only">Zeiteinträge des Monats</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Beginn</th>
                <th scope="col">Ende</th>
                <th scope="col">Pausen</th>
                <th scope="col">Pausenstatus</th>
                <th scope="col">Salon</th>
                <th scope="col">Art</th>
                <th scope="col">Quelle</th>
                <th scope="col">Markierungen</th>
              </tr>
            </thead>
            <tbody>
              {#each month.entries as entry (entry.id)}
                <tr
                  class:deleted={entry.deleted}
                  data-testid={`op-support-entry-row-${entry.id}`}
                  data-deleted={String(entry.deleted)}
                  data-invalid={String(entry.isInvalid)}
                  data-locked={String(entry.isLocked)}
                >
                  <td class="cell-primary" data-label="Datum">{formatOperatorDay(entry.date)}</td>
                  <td data-label="Beginn">{formatOperatorTime(entry.startTime)}</td>
                  <td data-label="Ende">
                    {entry.endTime ? formatOperatorTime(entry.endTime) : "offen"}
                  </td>
                  <td data-label="Pausen">
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
                  </td>
                  <td data-label="Pausenstatus"
                    >{labelFor(BREAK_STATUS_LABELS, entry.breakStatus)}</td
                  >
                  <td data-label="Salon"><span class="text">{entry.salon.name}</span></td>
                  <td data-label="Art">{labelFor(ENTRY_TYPE_LABELS, entry.type)}</td>
                  <td data-label="Quelle">{labelFor(ENTRY_SOURCE_LABELS, entry.source)}</td>
                  <td class="cell-marks">
                    {#if entry.isInvalid}
                      <span class="badge badge-red">{invalidText(entry)}</span>
                    {/if}
                    {#if entry.deleted}
                      <span class="badge badge-gray">gelöscht</span>
                    {/if}
                    {#if entry.isLocked}
                      <span class="badge badge-blue">gesperrt</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </Section>

  <Section title="Tagespausen" sub="Pausen zwischen zwei Einträgen" animate>
    <div data-testid="op-support-daybreaks">
      {#if month.dayBreaks.length === 0}
        <p class="empty">Keine Tagespausen in diesem Monat.</p>
      {:else}
        <div class="table-wrap">
          <table class="data-table stack-table">
            <caption class="sr-only">Tagespausen des Monats</caption>
            <thead>
              <tr>
                <th scope="col">Datum</th>
                <th scope="col">Pause</th>
              </tr>
            </thead>
            <tbody>
              {#each month.dayBreaks as item (item.id)}
                <tr data-testid={`op-support-daybreak-row-${item.id}`}>
                  <td class="cell-primary" data-label="Datum">{formatOperatorDay(item.date)}</td>
                  <td data-label="Pause">{timeRange(item.startTime, item.endTime)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </Section>

  <Section title="Anträge" sub="Beantragte Abwesenheiten wie Urlaub oder Krankheit" animate>
    <div data-testid="op-support-leave">
      {#if month.leaveRequests.length === 0}
        <p class="empty">Keine Anträge in diesem Monat.</p>
      {:else}
        <div class="table-wrap">
          <table class="data-table stack-table">
            <caption class="sr-only">Anträge des Monats</caption>
            <thead>
              <tr>
                <th scope="col">Art</th>
                <th scope="col">Status</th>
                <th scope="col">Zeitraum</th>
                <th scope="col">Tage</th>
              </tr>
            </thead>
            <tbody>
              {#each month.leaveRequests as request (request.id)}
                <tr data-testid={`op-support-leave-row-${request.id}`}>
                  <td class="cell-primary" data-label="Art"
                    ><span class="text">{request.typeName}</span></td
                  >
                  <td data-label="Status">{labelFor(LEAVE_STATUS_LABELS, request.status)}</td>
                  <td data-label="Zeitraum">
                    {formatOperatorDayRange(request.startDate, request.endDate)}
                    {#if request.halfDay}<span class="badge badge-gray">halber Tag</span>{/if}
                  </td>
                  <td data-label="Tage">
                    {formatDays(request.days)}
                    {#if request.daysProvisional === true}
                      <span class="badge badge-yellow">vorläufig</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </Section>

  <Section title="Abwesenheiten" sub="Angeordnete Abwesenheiten wie Berufsschule" animate>
    <div data-testid="op-support-absences">
      {#if month.absences.length === 0}
        <p class="empty">Keine Abwesenheiten in diesem Monat.</p>
      {:else}
        <div class="table-wrap">
          <table class="data-table stack-table">
            <caption class="sr-only">Abwesenheiten des Monats</caption>
            <thead>
              <tr>
                <th scope="col">Art</th>
                <th scope="col">Zeitraum</th>
                <th scope="col">Herkunft</th>
              </tr>
            </thead>
            <tbody>
              {#each month.absences as absence (absence.id)}
                <tr data-testid={`op-support-absence-row-${absence.id}`}>
                  <td class="cell-primary" data-label="Art"
                    >{labelFor(LEAVE_TYPE_LABELS, absence.type)}</td
                  >
                  <td data-label="Zeitraum">
                    {formatOperatorDayRange(absence.startDate, absence.endDate)}
                    {#if absence.halfDay}<span class="badge badge-gray">halber Tag</span>{/if}
                  </td>
                  <td data-label="Herkunft">{labelFor(ABSENCE_SOURCE_LABELS, absence.source)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
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
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
  }

  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }

  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 24px;
    margin: 0;
  }

  .facts dt {
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .closed {
    margin: 16px 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .breaks {
    margin: 0;
    padding: 0;
    list-style: none;
    font-variant-numeric: tabular-nums;
  }

  .minutes {
    color: var(--text-muted);
    font-size: 13px;
  }

  .cell-marks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  /* A deleted entry stays in the list but reads as no longer valid. */
  tr.deleted td {
    color: var(--text-muted);
  }

  @media (min-width: 640px) and (max-width: 1023px) {
    .stack-table th,
    .stack-table td {
      padding-inline: 8px;
    }
  }

  @media (max-width: 639px) {
    .stack-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .stack-table,
    .stack-table tbody {
      display: block;
    }

    .stack-table tr {
      display: block;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .stack-table tbody tr:last-child {
      border-bottom: 0;
    }

    .stack-table td {
      display: block;
      padding: 0;
      border: 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .stack-table td + td {
      margin-top: 4px;
    }

    .stack-table td.cell-primary {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .stack-table td:not(.cell-primary):not(.cell-marks)::before {
      content: attr(data-label) ": ";
      font-weight: 600;
      color: var(--text-muted);
    }

    .cell-marks {
      margin-top: 8px;
    }
  }
</style>
