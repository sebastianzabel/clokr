<script lang="ts">
  // Issue #613 (AC-613-5): persons who have left and whose exit month is not closed yet. Their final
  // saldo stays visible here until a manager closes that month. The server chose the rows, their
  // order and their bound; this component displays them and says how many are not shown.
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte";
  import {
    exitDateLabel,
    exitedMoreCount,
    type ExitedOverviewRow,
  } from "$lib/reports/overtime-overview-sections";

  interface Props {
    rows: ExitedOverviewRow[];
    /** All exited persons with an open final saldo in the caller's reach (may exceed `rows`). */
    total: number;
  }

  let { rows, total }: Props = $props();

  let more = $derived(exitedMoreCount(total, rows.length));
</script>

{#if rows.length > 0 || total > 0}
  <section class="exited-section" data-testid="exited-final-saldo">
    <h3 class="exited-title">Ausgetreten, offener Endsaldo ({total})</h3>
    <p class="exited-hint">
      Der Endsaldo ist bestätigt, sobald der Austrittsmonat abgeschlossen ist.
    </p>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Mitarbeiter</th>
            <th>Nr.</th>
            <th>Austritt am</th>
            <th class="numeric">Saldo (h)</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td>{row.name}</td>
              <td>{row.employeeNumber}</td>
              <td data-testid="exit-date">{exitDateLabel(row.exitDate)}</td>
              <td class="numeric">
                {#if row.confirmedMinutes !== undefined}
                  <SaldoAnzeige
                    variant="compact"
                    confirmedMinutes={row.confirmedMinutes}
                    openMonthMinutes={row.openMonthMinutes ?? null}
                    hasClosedMonth={row.hasClosedMonth ?? false}
                    rosterIncomplete={row.rosterIncomplete}
                  />
                {:else}
                  <SaldoAnzeige
                    variant="compact"
                    saldoMinutes={Math.round(row.balanceHours * 60)}
                  />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if more > 0}
      <p class="exited-more" data-testid="exited-more">und {more} weitere</p>
    {/if}
  </section>
{/if}

<style>
  .exited-section {
    margin-top: 1.5rem;
  }

  .exited-title {
    margin: 0 0 0.25rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .exited-hint,
  .exited-more {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .exited-more {
    margin: 0.75rem 0 0;
  }

  .numeric {
    text-align: right;
  }
</style>
