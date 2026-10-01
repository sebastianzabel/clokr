<script lang="ts">
  // Phase 430 (D-12/D-13/D-14, Issue #430) — Wochenübersicht "Planungsbedarf".
  //
  // Read-only, week-pageable view: one row per SHIFT_BASED employee in scope, showing contract
  // days, this week's approved leave days (+ weekdays), other absences, days still to plan, and —
  // once shifts exist for that week — the planned count and the difference. Paging is by
  // weekStart alone, no artificial upper bound (owner: leave can be booked a year ahead).

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import PageHead from "$lib/components/layout/PageHead.svelte";

  interface PlanningRow {
    employeeId: string;
    name: string;
    contractDays: number;
    leaveDays: number;
    leaveWeekdays: string[];
    otherAbsenceDays: number;
    stillToPlan: number;
    plannedDays?: number;
    difference?: number;
  }

  interface PlanningOverviewResponse {
    weekStart: string;
    weekEnd: string;
    employees: PlanningRow[];
  }

  function mondayOfWeek(d: Date): string {
    const copy = new Date(d);
    const dow = copy.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    copy.setDate(copy.getDate() + offset);
    return copy.toISOString().slice(0, 10);
  }

  let weekStart = $state(mondayOfWeek(new Date()));
  let weekEnd = $state("");
  let employees = $state<PlanningRow[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  const hasPlannedColumns = $derived(employees.some((e) => e.plannedDays !== undefined));

  async function load() {
    loading = true;
    loadError = "";
    try {
      const res = await api.get<PlanningOverviewResponse>(
        `/shifts/planning-overview?weekStart=${weekStart}`,
      );
      weekEnd = res.weekEnd;
      employees = res.employees;
    } catch (err) {
      loadError =
        err instanceof Error ? err.message : "Planungsübersicht konnte nicht geladen werden.";
      employees = [];
    } finally {
      loading = false;
    }
  }

  function shiftWeek(days: number) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    weekStart = d.toISOString().slice(0, 10);
    load();
  }

  function prevWeek() {
    shiftWeek(-7);
  }
  function nextWeek() {
    shiftWeek(7);
  }

  function leaveCell(row: PlanningRow): string {
    if (row.leaveDays === 0) return "0";
    return `${row.leaveDays} (${row.leaveWeekdays.join(", ")})`;
  }

  onMount(load);
</script>

<svelte:head>
  <title>Planungsbedarf – Clokr</title>
</svelte:head>

<PageHead eyebrow="Schichtplanung" title="Planungsbedarf" accent="Planungsbedarf" />

<section class="page">
  <div class="card-animate week-pager">
    <button type="button" class="btn btn-ghost btn-sm" onclick={prevWeek} disabled={loading}>
      ← Vorherige Woche
    </button>
    <div class="week-pager-label">
      Woche {weekStart}{#if weekEnd}
        – {weekEnd}{/if}
    </div>
    <button type="button" class="btn btn-ghost btn-sm" onclick={nextWeek} disabled={loading}>
      Nächste Woche →
    </button>
  </div>

  {#if loadError}
    <div class="callout error">{loadError}</div>
  {/if}

  <div class="card-animate table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>Person</th>
          <th>Vertrag</th>
          <th>Urlaub diese Woche (Tage)</th>
          <th>noch einzuplanen</th>
          {#if hasPlannedColumns}
            <th>geplant</th>
            <th>Differenz</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#if loading}
          <tr><td colspan={hasPlannedColumns ? 6 : 4}>Lädt…</td></tr>
        {:else if employees.length === 0}
          <tr>
            <td colspan={hasPlannedColumns ? 6 : 4} class="empty">
              Keine SHIFT_BASED-Mitarbeiter im Scope.
            </td>
          </tr>
        {:else}
          {#each employees as row (row.employeeId)}
            <tr>
              <td>{row.name}</td>
              <td>{row.contractDays} Tage</td>
              <td>{leaveCell(row)}</td>
              <td>{row.stillToPlan} Tage</td>
              {#if hasPlannedColumns}
                <td>{row.plannedDays ?? "–"}</td>
                <td>{row.difference ?? "–"}</td>
              {/if}
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</section>

<style>
  .week-pager {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-4);
    padding: var(--pad-card);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
  }

  .week-pager-label {
    font-weight: 600;
    color: var(--text);
  }

  .empty {
    color: var(--text-muted);
    font-style: italic;
  }
</style>
