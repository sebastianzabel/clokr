<script lang="ts">
  // Phase 430 (D-12/D-13/D-14, Issue #430) — Wochenübersicht "Planungsbedarf".
  //
  // Read-only, week-pageable view: one row per SHIFT_BASED employee in scope, showing contract
  // days, this week's approved leave days (+ weekdays), other absences, days still to plan, and —
  // once shifts exist for that week — the planned count and the difference. Paging is by
  // weekStart alone, no artificial upper bound (owner: leave can be booked a year ahead).

  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { salonContext } from "$stores/salon-context";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
  import { rosterTabs } from "$lib/nav/routes";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import PeriodPicker from "$components/ui/PeriodPicker.svelte";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope"; // Issue #558 (D-03/D-04/D-07)
  import { mondayOfWeek, planningWeekLabel } from "$lib/shifts/planning-week"; // Issue #849

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

  let weekStart = $state(mondayOfWeek(new Date()));
  let weekEnd = $state("");
  let employees = $state<PlanningRow[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  // Issue #558: the header salon narrows the persons (master-data rule, Stammsalon today or an
  // active deployment). The page decides only through `salonPageFilter` (never the store's raw
  // selection); a single-salon tenant or a one-salon caller never sends a `salonId`.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  let salonRejected = $state(false);
  // Plain `let` (never `$state`): the effect below starts `load()` untracked and must not depend on it.
  let loadGeneration = 0;

  const hasPlannedColumns = $derived(employees.some((e) => e.plannedDays !== undefined));

  // Issue #853 (D-853-05): the four roster tabs are the link tabs of the route table; a tab the caller
  // may not open (Verfügbarkeit without the feature or its permissions) is not part of the list.
  const rosterTabsList = $derived(
    rosterTabs($authStore.user, { availabilityEnabled: $tenantFeatures.availabilityEnabled }),
  );

  // Issue #853 (D-853-13): one block table. The two plan columns exist only once a row carries them.
  const PLANNING_COLUMNS: DataTableColumn[] = [
    { key: "name", label: "Person", primary: true },
    { key: "contract", label: "Vertrag" },
    { key: "leave", label: "Urlaub diese Woche (Tage)" },
    { key: "toPlan", label: "noch einzuplanen" },
  ];
  const PLANNED_COLUMNS: DataTableColumn[] = [
    { key: "planned", label: "geplant" },
    { key: "difference", label: "Differenz" },
  ];
  const columns = $derived(
    hasPlannedColumns ? [...PLANNING_COLUMNS, ...PLANNED_COLUMNS] : PLANNING_COLUMNS,
  );

  /** One table row per person; the cells read the figures through `cellText()`. */
  const tableRows = $derived(
    employees.map((e) => ({
      key: e.employeeId,
      name: e.name,
      contract: `${e.contractDays} Tage`,
      leave: leaveCell(e),
      toPlan: `${e.stillToPlan} Tage`,
      planned: e.plannedDays ?? "–",
      difference: e.difference ?? "–",
    })),
  );

  async function load() {
    const salonId = pageSalonId;
    const generation = ++loadGeneration;
    loading = true;
    loadError = "";
    try {
      const res = await api.get<PlanningOverviewResponse>(
        withSalonId(`/shifts/planning-overview?weekStart=${weekStart}`, salonId),
      );
      if (generation !== loadGeneration) return;
      salonRejected = false;
      // Issue #849 (3): the server normalises to the Monday of the week; take both bounds from it.
      weekStart = res.weekStart;
      weekEnd = res.weekEnd;
      employees = res.employees;
    } catch (err) {
      if (generation !== loadGeneration) return;
      employees = [];
      if (isSalonFilterRejected(err)) {
        // The one 404 of an inadmissible salon: a calm text, no error callout.
        salonRejected = true;
        return;
      }
      loadError =
        err instanceof Error ? err.message : "Planungsübersicht konnte nicht geladen werden.";
    } finally {
      if (generation === loadGeneration) loading = false;
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
  function goToToday() {
    weekStart = mondayOfWeek(new Date());
    load();
  }

  function leaveCell(row: PlanningRow): string {
    if (row.leaveDays === 0) return "0";
    return `${row.leaveDays} (${row.leaveWeekdays.join(", ")})`;
  }

  // Issue #558: this effect starts the first load (once the salon context is known, so the first
  // request is already filtered) and every reload after a header salon change. It reads only the
  // two primitive deriveds and starts `load()` untracked; week paging calls `load()` directly.
  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    untrack(() => void load());
  });
</script>

<svelte:head>
  <title>{pageLabel("/shifts/planning")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/shifts/planning")}
  sub="Wie viele Tage pro Person in dieser Woche noch einzuplanen sind: Vertrag, Urlaub und, sobald Schichten bestehen, der Plan."
/>
<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />
<PageTabs tabs={rosterTabsList} tab="/team/dienstplan/planung" tabsLabel="Dienstplan" />

<div class="page" data-testid="shifts-planning-page">
  <!-- One toolbar row (prototype .toolbar2): the week on the left. The scope label sits right under the head. -->
  <div class="planning-period-row">
    <PeriodPicker
      label={planningWeekLabel(weekStart, weekEnd)}
      onPrev={prevWeek}
      onNext={nextWeek}
      onToday={goToToday}
      zooms={["woche"]}
      zoom="woche"
      prevLabel="Vorherige Woche"
      nextLabel="Nächste Woche"
      testIdPrefix="planning-week"
    />
  </div>

  {#if loadError}
    <div class="callout error">{loadError}</div>
  {/if}

  <!-- A rejected salon shows only the calm text of the scope label, not an empty state. -->
  {#if !salonRejected}
    {#if !loading && employees.length === 0}
      <EmptyState icon="calendar" title="In deiner Reichweite arbeitet niemand nach Schichtplan." />
    {:else}
      <DataTable
        caption="Planungsbedarf der Woche"
        {columns}
        rows={tableRows}
        rowKey={(row) => row.key}
        {loading}
      />
    {/if}
  {/if}
</div>

<style>
  .planning-period-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  /* The picker keeps its own label and arrows (block); only its page-sized padding goes, so the week
     starts at the page edge like the prototype's .period. */
  .planning-period-row :global(.month-bar) {
    padding: 0;
  }
</style>
