<!--
  TenantTable - the operator's list of tenants (Issue #89, D-14).

  Name (link to the tenant page), Kurzname, Bundesland, Angelegt, Salons (active / total),
  Mitarbeitende (active), Letzte Aktivität and Status; a deactivated tenant carries its reason as a
  muted line under the badge. Since Issue #90 the three metric columns come from the dashboard
  route (`metrics`, keyed by tenant id) and an "Inaktiv" badge sits next to the status badge when
  the metrics say the tenant is inactive; a tenant without metrics shows a dash in those cells and
  no badge. The list is paged client-side above 25 rows.
  Up to 767 px the table becomes a stacked list by CSS only (same markup), so a phone never
  scrolls sideways: line one is the name with the status and inactivity badges, line two the
  muted "slug - Bundesland - Angelegt - Salons - Mitarbeitende - Letzte Aktivität" (the header row
  is hidden there, so each metric carries its own visible label), line three the reason.
-->
<script lang="ts">
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

  const visible = $derived(tenants.slice((page - 1) * pageSize, page * pageSize));
</script>

<div class="table-wrap">
  <table class="data-table tenant-table" data-testid="op-tenants-table">
    <caption class="sr-only">Mandanten</caption>
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Kurzname</th>
        <th scope="col">Bundesland</th>
        <th scope="col">Angelegt</th>
        <th scope="col">Salons</th>
        <th scope="col">Mitarbeitende</th>
        <th scope="col">Letzte Aktivität</th>
        <th scope="col">Status</th>
      </tr>
    </thead>
    <tbody>
      {#each visible as tenant (tenant.id)}
        {@const deactivated = tenant.deactivatedAt !== null}
        {@const metric = metrics.get(tenant.id)}
        <tr data-testid={`op-tenant-row-${tenant.id}`}>
          <td class="cell-name" data-label="Name">
            <a
              class="name"
              href={`/betreiber/mandanten/${tenant.id}`}
              data-testid={`op-tenant-link-${tenant.id}`}>{tenant.name}</a
            >
          </td>
          <td class="meta slug" data-label="Kurzname">{tenant.slug}</td>
          <td class="meta state" data-label="Bundesland">
            {federalStateLabel(tenant.federalState)}
          </td>
          <td class="meta date" data-label="Angelegt">{formatOperatorDate(tenant.createdAt)}</td>
          <td class="meta metric" data-label="Salons" data-testid={`op-tenant-salons-${tenant.id}`}>
            <span class="m-label" aria-hidden="true">Salons</span>
            {#if metric}
              <span aria-hidden="true">{metric.activeSalons} / {metric.totalSalons}</span>
              <span class="sr-only">{metric.activeSalons} von {metric.totalSalons} aktiv</span>
            {:else}
              –
            {/if}
          </td>
          <td
            class="meta metric"
            data-label="Mitarbeitende"
            data-testid={`op-tenant-employees-${tenant.id}`}
          >
            <span class="m-label" aria-hidden="true">Mitarbeitende</span>
            {metric ? metric.activeEmployees : "–"}
          </td>
          <td
            class="meta metric activity"
            data-label="Letzte Aktivität"
            data-testid={`op-tenant-activity-${tenant.id}`}
          >
            <span class="m-label" aria-hidden="true">Letzte Aktivität</span>
            {#if !metric}
              –
            {:else if metric.lastActivityAt === null}
              Keine Anmeldung
            {:else}
              {formatOperatorDay(metric.lastActivityAt)}
            {/if}
          </td>
          <td class="cell-status" data-label="Status">
            <span
              class="badge status"
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
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
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
  .name {
    color: var(--op-brand-text, var(--brand));
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
    text-decoration: none;
  }

  .name:hover,
  .name:focus-visible {
    text-decoration: underline;
  }

  /* "break-word" (not "anywhere") keeps the table layout from squeezing these columns down to one
     character when a long name claims the width; the minimum widths do the same for short words. */
  .meta {
    overflow-wrap: break-word;
  }

  .slug {
    min-width: 128px;
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .state {
    min-width: 128px;
  }

  .date {
    min-width: 96px;
  }

  .metric {
    min-width: 96px;
  }

  /* The column header carries the name on a wide screen; the stacked list shows this label instead. */
  .m-label {
    display: none;
  }

  /* The amber text of .badge-yellow measures 4.25:1 on its own tint (WCAG AA asks 4.5:1 for 13 px
     text), so the label takes the body text colour; the tint and border still carry the warning. */
  .inactive-badge {
    color: var(--text);
  }

  .reason {
    display: block;
    margin-top: 4px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .pagination-wrap {
    margin-top: 16px;
  }

  /* Eight columns do not fit a tablet width at the default padding: tighten the cells, let the
     headers wrap and lower the content minimums so the table fits without sideways scrolling. */
  @media (min-width: 768px) and (max-width: 1099px) {
    .tenant-table th {
      padding: 10px 6px;
      white-space: normal;
      vertical-align: bottom;
      font-size: 11px;
      letter-spacing: 0.02em;
    }

    .tenant-table td {
      padding: 10px 6px;
      font-size: 13px;
    }

    .slug {
      min-width: 72px;
    }

    .state {
      min-width: 84px;
    }

    .date {
      min-width: 74px;
    }

    .metric {
      min-width: 0;
    }
  }

  @media (max-width: 767px) {
    .tenant-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      border: 0;
    }

    .tenant-table,
    .tenant-table tbody {
      display: block;
    }

    /* One flex-wrap row per tenant: name and badge on line one, the meta cells on line two (the
       ::after item forces the break), the reason on line three. */
    .tenant-table tr {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      column-gap: 8px;
      row-gap: 4px;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .tenant-table tbody tr:last-child {
      border-bottom: 0;
    }

    .tenant-table tr::after {
      content: "";
      order: 3;
      flex-basis: 100%;
      height: 0;
    }

    .tenant-table td {
      padding: 0;
      border: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-muted);
    }

    .tenant-table td.cell-name {
      order: 1;
      flex: 0 1 auto;
      min-width: 0;
      font-size: 16px;
      color: var(--text);
    }

    .tenant-table .name {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }

    /* The status cell dissolves so the badge and the reason become items of the row. */
    .tenant-table td.cell-status {
      display: contents;
    }

    .tenant-table .status,
    .tenant-table .inactive-badge {
      order: 2;
    }

    /* The header row is hidden here, so every metric value names itself. */
    .tenant-table .m-label {
      display: inline;
      margin-right: 4px;
    }

    .tenant-table td.meta {
      order: 4;
      min-width: 0;
    }

    /* The separator trails its item, so a wrapped line never starts with a stray dot. */
    .tenant-table td.meta:not(.activity)::after {
      content: "\00b7";
      margin-left: 8px;
    }

    .tenant-table .reason {
      order: 5;
      flex-basis: 100%;
      margin-top: 0;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }
  }
</style>
