<!--
  OperatorOverview - the "Übersicht" tiles of the operator console start page (Issue #90, D-06).

  Four KPIStat tiles from the totals of `GET /operator/dashboard`: Mandanten (active / deactivated),
  Inaktive Mandanten (the threshold in days comes from the response, never from this file), Aktive
  Salons and Aktive Mitarbeitende. Counts only - the dashboard carries no person data. The grid
  collapses from four columns to two and to one at phone width, so nothing scrolls sideways.
-->
<script lang="ts">
  import KPIStat from "$components/ui/KPIStat.svelte";
  import type { OperatorDashboard } from "$lib/operator/types";

  interface Props {
    dashboard: OperatorDashboard;
  }

  let { dashboard }: Props = $props();

  const totals = $derived(dashboard.totals);

  function count(value: number): string {
    return value.toLocaleString("de-DE");
  }
</script>

<div class="overview-grid" data-testid="op-overview">
  <div class="tile" data-testid="op-overview-tenants">
    <KPIStat
      label="Mandanten"
      value={count(totals.tenants)}
      delta={`${count(totals.activeTenants)} aktiv · ${count(totals.deactivatedTenants)} deaktiviert`}
    />
  </div>
  <div class="tile" data-testid="op-overview-inactive">
    <KPIStat
      label="Inaktive Mandanten"
      value={count(totals.inactiveTenants)}
      delta={`keine Anmeldung seit ${count(dashboard.inactivityDays)} Tagen`}
      deltaTone={totals.inactiveTenants > 0 ? "warn" : "neutral"}
    />
  </div>
  <div class="tile" data-testid="op-overview-salons">
    <KPIStat label="Aktive Salons" value={count(totals.activeSalons)} />
  </div>
  <div class="tile" data-testid="op-overview-employees">
    <KPIStat label="Aktive Mitarbeitende" value={count(totals.activeEmployees)} />
  </div>
</div>

<style>
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 24px 32px;
  }

  .tile {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  /* The faint caption colour of the KPI recipe is 3.08:1 on the console's white card (WCAG AA
     asks 4.5:1 for 11 px text), so the console uses the muted text colour for it. */
  .tile :global(.kpi-label) {
    color: var(--text-muted);
  }

  @media (max-width: 639px) {
    .overview-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px 16px;
    }
  }

  @media (max-width: 399px) {
    .overview-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
