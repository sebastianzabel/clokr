<!--
  SupportContracts - the contract history of one employee under a support access (Issue #93,
  D-05(3), AC-93-9). Pure rendering of the schedule columns, newest first as the API sends them.

  The seven day-hours columns are authoritative only for a fixed schedule (CLAUDE.md "Schedule
  Types"); for every other contract type they are a legacy flag, so the card says so and still shows
  the stored values - nothing is corrected or hidden. Labels are keyed by control values
  (`support-labels`); an unknown value is shown raw. A card has no horizontal scroll: the facts are a
  wrapping grid, the day hours a seven-column table that fits a phone.
-->
<script lang="ts">
  import { formatOperatorDate } from "$lib/operator/labels";
  import {
    OVERTIME_MODE_LABELS,
    SCHEDULE_TYPE_LABELS,
    formatMinutes,
    formatWeekdays,
    labelFor,
  } from "$lib/operator/support-labels";
  import type { SupportContract } from "$lib/operator/types";

  interface Props {
    contracts: SupportContract[];
  }

  let { contracts }: Props = $props();

  const DAY_COLUMNS = [
    { key: "monday", label: "Mo" },
    { key: "tuesday", label: "Di" },
    { key: "wednesday", label: "Mi" },
    { key: "thursday", label: "Do" },
    { key: "friday", label: "Fr" },
    { key: "saturday", label: "Sa" },
    { key: "sunday", label: "So" },
  ] as const;

  /** A number as stored, with the German decimal comma; a missing one is a dash. */
  function figure(value: number | null): string {
    return value === null ? "–" : String(value).replace(".", ",");
  }

  function coreTime(contract: SupportContract): string {
    if (contract.coreStart === null || contract.coreEnd === null) return "–";
    const days = contract.coreDays.length > 0 ? ` (${formatWeekdays(contract.coreDays)})` : "";
    return `${contract.coreStart} – ${contract.coreEnd}${days}`;
  }
</script>

<div data-testid="op-support-contracts">
  {#if contracts.length === 0}
    <p class="empty">Keine Verträge hinterlegt.</p>
  {:else}
    <ul class="cards">
      {#each contracts as contract (contract.id)}
        <li class="contract" data-testid={`op-support-contract-row-${contract.id}`}>
          <h3 class="contract-title">
            <span class="text">{labelFor(SCHEDULE_TYPE_LABELS, contract.type)}</span>
            <span class="since">gültig ab {formatOperatorDate(contract.validFrom)}</span>
          </h3>

          <dl class="facts">
            <div>
              <dt>Wochenstunden</dt>
              <dd>{figure(contract.weeklyHours)}</dd>
            </div>
            <div>
              <dt>Monatsstunden</dt>
              <dd>{figure(contract.monthlyHours)}</dd>
            </div>
            <div>
              <dt>Arbeitstage</dt>
              <dd>{formatWeekdays(contract.workDays)}</dd>
            </div>
            <div>
              <dt>Vertragstage je Woche</dt>
              <dd>{contract.contractWorkDaysPerWeek ?? "–"}</dd>
            </div>
            <div>
              <dt>Übliche Arbeitstage</dt>
              <dd>
                {contract.usualWorkDays.length > 0
                  ? formatWeekdays(contract.usualWorkDays)
                  : "keine Angabe"}
              </dd>
            </div>
            <div>
              <dt>Überstunden-Modus</dt>
              <dd class="text">{labelFor(OVERTIME_MODE_LABELS, contract.overtimeMode)}</dd>
            </div>
            <div>
              <dt>Schwelle</dt>
              <dd>{figure(contract.overtimeThreshold)} Std.</dd>
            </div>
            <div>
              <dt>Auszahlung</dt>
              <dd>{contract.allowOvertimePayout ? "Ja" : "Nein"}</dd>
            </div>
            <div>
              <dt>Minus-Grenze</dt>
              <dd>
                {contract.maxNegativeBalanceMinutes === null
                  ? "Mandanten-Standard"
                  : formatMinutes(contract.maxNegativeBalanceMinutes)}
              </dd>
            </div>
            <div>
              <dt>Kernzeit</dt>
              <dd>{coreTime(contract)}</dd>
            </div>
          </dl>

          <div class="dayhours">
            <table class="day-table">
              <caption>Tagesstunden</caption>
              <thead>
                <tr>
                  {#each DAY_COLUMNS as day (day.key)}
                    <th scope="col">{day.label}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {#each DAY_COLUMNS as day (day.key)}
                    <td>{figure(contract.dayHours[day.key])}</td>
                  {/each}
                </tr>
              </tbody>
            </table>
            {#if contract.type !== "FIXED_SCHEDULE"}
              <p class="note" data-testid={`op-support-contract-dayhours-note-${contract.id}`}>
                Tagesstunden sind nur bei festen Arbeitszeiten verbindlich.
              </p>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Not `.card` / `.card-title`: those are global recipes of app.css (a muted 11 px caps title). */
  .contract {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
  }

  .contract-title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 16px;
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .since {
    font-size: 13px;
    font-weight: 400;
    color: var(--text-muted);
  }

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
    gap: 12px 24px;
    margin: 0;
  }

  .facts div {
    min-width: 0;
  }

  .facts dt {
    font-size: 13px;
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .dayhours {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .day-table {
    width: 100%;
    max-width: 420px;
    border-collapse: collapse;
    table-layout: fixed;
    font-variant-numeric: tabular-nums;
  }

  .day-table caption {
    padding-bottom: 4px;
    text-align: left;
    font-size: 13px;
    color: var(--text-muted);
  }

  .day-table th,
  .day-table td {
    padding: 4px;
    text-align: center;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }

  .day-table th {
    font-weight: 600;
    color: var(--text-muted);
  }

  .note {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }
</style>
