<!--
  TenantTable - the operator's list of tenants (Issue #89, D-14).

  Name (link to the tenant page), Kurzname, Bundesland, Angelegt, Salons (active / total),
  Mitarbeitende (active), Letzte Aktivität and Status; a deactivated tenant carries its reason as a
  muted line under the badge. Rendered by the DataTable block (Issue #899), which becomes a card
  list below 760 px of container width. Since Issue #90 the three metric columns come from the dashboard
  route (`metrics`, keyed by tenant id) and an "Inaktiv" badge sits next to the status badge when
  the metrics say the tenant is inactive; a tenant without metrics shows a dash in those cells and
  no badge. The list is paged client-side above 25 rows.
  A phone never scrolls sideways: the card layout prints each column label in front of its value.
-->
<script lang="ts">
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import { federalStateLabel, formatOperatorDate, formatOperatorDay } from "$lib/operator/labels";
  import type { OperatorDashboardTenant, OperatorTenant } from "$lib/operator/types";

  interface Props {
    tenants: OperatorTenant[];
    page?: number;
    pageSize?: number;
    /** Dashboard metrics by tenant id (Issue #90); a tenant without an entry shows dashes. */
    metrics?: ReadonlyMap<string, OperatorDashboardTenant>;
  }

  let {
    tenants,
    page = $bindable(1),
    pageSize = $bindable(25),
    metrics = new Map(),
  }: Props = $props();

  const COLUMNS: DataTableColumn[] = [
    { key: "name", label: "Name", primary: true },
    { key: "slug", label: "Kurzname" },
    { key: "state", label: "Bundesland" },
    { key: "createdAt", label: "Angelegt" },
    { key: "salons", label: "Salons" },
    { key: "employees", label: "Mitarbeitende" },
    { key: "activity", label: "Letzte Aktivität" },
    { key: "status", label: "Status" },
  ];

  const visible = $derived(tenants.slice((page - 1) * pageSize, page * pageSize));
</script>

<div data-testid="op-tenants-table">
  <DataTable
    caption="Mandanten"
    columns={COLUMNS}
    rows={visible}
    rowKey={(tenant) => tenant.id}
    rowTestId={(tenant) => `op-tenant-row-${tenant.id}`}
  >
    {#snippet cell(tenant, column)}
      {@const deactivated = tenant.deactivatedAt !== null}
      {@const metric = metrics.get(tenant.id)}
      {#if column.key === "name"}
        <a
          class="name"
          href={`/betreiber/mandanten/${tenant.id}`}
          data-testid={`op-tenant-link-${tenant.id}`}>{tenant.name}</a
        >
      {:else if column.key === "slug"}
        <span class="slug">{tenant.slug}</span>
      {:else if column.key === "state"}
        {federalStateLabel(tenant.federalState)}
      {:else if column.key === "createdAt"}
        {formatOperatorDate(tenant.createdAt)}
      {:else if column.key === "salons"}
        <span data-testid={`op-tenant-salons-${tenant.id}`}>
          {#if metric}
            <span aria-hidden="true">{metric.activeSalons} / {metric.totalSalons}</span>
            <span class="sr-only">{metric.activeSalons} von {metric.totalSalons} aktiv</span>
          {:else}
            –
          {/if}
        </span>
      {:else if column.key === "employees"}
        <span data-testid={`op-tenant-employees-${tenant.id}`}
          >{metric ? metric.activeEmployees : "–"}</span
        >
      {:else if column.key === "activity"}
        <span data-testid={`op-tenant-activity-${tenant.id}`}>
          {#if !metric}
            –
          {:else if metric.lastActivityAt === null}
            Keine Anmeldung
          {:else}
            {formatOperatorDay(metric.lastActivityAt)}
          {/if}
        </span>
      {:else}
        <span class="status-cell">
          <span
            class="badge"
            class:badge-green={!deactivated}
            class:badge-gray={deactivated}
            data-testid={`op-tenant-status-${tenant.id}`}
            data-state={deactivated ? "deactivated" : "active"}
            >{deactivated ? "Deaktiviert" : "Aktiv"}</span
          >
          {#if metric?.inactive}
            <span
              class="badge badge-yellow inactive-badge"
              data-testid={`op-tenant-inactive-${tenant.id}`}>Inaktiv</span
            >
          {/if}
          {#if deactivated && tenant.deactivatedReason}
            <span class="reason">Grund: {tenant.deactivatedReason}</span>
          {/if}
        </span>
      {/if}
    {/snippet}
  </DataTable>
</div>

{#if tenants.length > 25}
  <div class="pagination-wrap" data-testid="op-tenants-pagination">
    <Pagination
      total={tenants.length}
      bind:page
      bind:pageSize
      pageSizeOptions={[25, 50, 100]}
      labelSingular="Mandant"
      labelPlural="Mandanten"
    />
  </div>
{/if}

<style>
  /* A 200-character name wraps inside its own width instead of widening the table (the block keeps
     cells on one line). */
  .name {
    display: inline-block;
    max-width: 40ch;
    white-space: normal;
    overflow-wrap: anywhere;
    color: var(--brand);
    font-weight: 600;
    text-decoration: none;
  }

  .name:hover,
  .name:focus-visible {
    text-decoration: underline;
  }

  .slug {
    font-family: var(--font-code);
    font-size: 13px;
  }

  .status-cell {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  /* The amber text of .badge-yellow measures 4.25:1 on its own tint (WCAG AA asks 4.5:1 for 13 px
     text), so the label takes the body text colour; the tint and border still carry the warning. */
  .inactive-badge {
    color: var(--text);
  }

  /* The deactivation reason is a muted line under the badges; the block keeps a cell on one line,
     so the reason wraps inside its own width and clamps at two lines. */
  .reason {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    flex-basis: 100%;
    max-width: 48ch;
    white-space: normal;
    text-align: start;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }

  .pagination-wrap {
    margin-top: 16px;
  }
</style>
