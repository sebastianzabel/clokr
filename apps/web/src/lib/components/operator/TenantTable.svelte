<!--
  TenantTable - the operator's list of tenants (Issue #89, D-14).

  Name (link to the tenant page), Kurzname, Bundesland, Angelegt and Status; a deactivated tenant
  carries its reason as a muted line under the badge. The list is paged client-side above 25 rows.
  Up to 639 px the table becomes a stacked list by CSS only (same markup), so a phone never
  scrolls sideways: line one is the name with the status badge, line two the muted
  "slug - Bundesland - Angelegt", line three the reason.
-->
<script lang="ts">
  import Pagination from "$components/ui/Pagination.svelte";
  import { federalStateLabel, formatOperatorDate } from "$lib/operator/labels";
  import type { OperatorTenant } from "$lib/operator/types";

  interface Props {
    tenants: OperatorTenant[];
    page?: number;
    pageSize?: number;
  }

  let { tenants, page = $bindable(1), pageSize = $bindable(25) }: Props = $props();

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
        <th scope="col">Status</th>
      </tr>
    </thead>
    <tbody>
      {#each visible as tenant (tenant.id)}
        {@const deactivated = tenant.deactivatedAt !== null}
        <tr data-testid={`op-tenant-row-${tenant.id}`}>
          <td class="cell-name" data-label="Name">
            <a
              class="name"
              href={`/betreiber/mandanten/${tenant.id}`}
              data-testid={`op-tenant-link-${tenant.id}`}>{tenant.name}</a
            >
          </td>
          <td class="meta slug" data-label="Kurzname">{tenant.slug}</td>
          <td class="meta" data-label="Bundesland">{federalStateLabel(tenant.federalState)}</td>
          <td class="meta" data-label="Angelegt">{formatOperatorDate(tenant.createdAt)}</td>
          <td class="cell-status" data-label="Status">
            <span
              class="badge status"
              class:badge-green={!deactivated}
              class:badge-gray={deactivated}
              data-testid={`op-tenant-status-${tenant.id}`}
              data-state={deactivated ? "deactivated" : "active"}
              >{deactivated ? "Deaktiviert" : "Aktiv"}</span
            >
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
    color: var(--brand);
    font-weight: 600;
    overflow-wrap: anywhere;
    min-width: 0;
    text-decoration: none;
  }

  .name:hover,
  .name:focus-visible {
    text-decoration: underline;
  }

  .slug {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .meta {
    overflow-wrap: anywhere;
    min-width: 0;
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

  @media (max-width: 639px) {
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

    .tenant-table .status {
      order: 2;
    }

    .tenant-table td.meta {
      order: 4;
    }

    .tenant-table td.meta + td.meta::before {
      content: "\00b7";
      margin-right: 8px;
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
