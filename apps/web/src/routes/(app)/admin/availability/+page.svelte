<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  // Phase 55 — Admin availability list page.
  // Issue #853 (D-853-13, D-853-18, S-22): the fourth roster tab. One searchable person table; a row opens
  // /admin/availability/[employeeId]. The list is unfiltered by design (an exempt page, Issue #558): it
  // reads `GET /employees` and the API narrows it to the caller's reach.

  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { toasts } from "$stores/toast";
  import { rosterTabs } from "$lib/nav/routes";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import { avatarIndex, initialsOf } from "$components/ui/ListRow.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import {
    availabilityRows,
    filterAvailability,
    sortAvailability,
    type AvailabilityEmployee,
  } from "$lib/team/availability-list";

  let employees = $state<AvailabilityEmployee[]>([]);
  let loading = $state(true);
  let search = $state("");
  let sort = $state<DataTableSort | null>(null);

  // The four roster tabs are the link tabs of the route table; a tab the caller may not open is not listed.
  const rosterTabsList = $derived(
    rosterTabs($authStore.user, { availabilityEnabled: $tenantFeatures.availabilityEnabled }),
  );

  const allRows = $derived(availabilityRows(employees));
  const shownRows = $derived(
    sortAvailability(filterAvailability(allRows, search), {
      key: "name",
      dir: sort?.dir ?? "asc",
    }),
  );

  const columns: DataTableColumn[] = [
    { key: "name", label: "Name", primary: true, sortable: true },
    { key: "open", label: "Verfügbarkeit", align: "end" },
  ];

  function detailHref(id: string): string {
    return `/admin/availability/${id}`;
  }

  async function loadEmployees(): Promise<void> {
    try {
      const list = await api.get<AvailabilityEmployee[]>("/employees?limit=500");
      employees = list ?? [];
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Mitarbeiter konnten nicht geladen werden.";
      toasts.error(msg);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    // Issue #83 (D-13): access is decided by the admin layout guard; the API answers 403 regardless.
    void loadEmployees();
  });
</script>

<svelte:head>
  <title>{pageLabel("/admin/availability")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/admin/availability")}
  sub="Wer kann wann arbeiten? Wähle eine Person, um ihre Verfügbarkeit zu bearbeiten."
/>
<PageTabs tabs={rosterTabsList} tab="/team/verfuegbarkeit" tabsLabel="Dienstplan" />

<div class="page" data-testid="availability-page">
  <DataTable
    caption="Personen"
    {columns}
    rows={shownRows}
    rowKey={(row) => row.id}
    rowTestId={(row) => `availability-row-${row.id}`}
    {sort}
    onSort={(next) => (sort = next)}
    filtered={search.trim() !== "" && allRows.length > 0}
    onResetFilters={() => (search = "")}
    onRowClick={(row) => void goto(detailHref(row.id))}
    {loading}
  >
    {#snippet toolbar()}
      <TableToolbar
        bind:query={search}
        count={shownRows.length}
        total={allRows.length}
        searchLabel="Name oder Nummer"
      />
    {/snippet}
    {#snippet cell(row, column)}
      {#if column.key === "name"}
        <span class="av-name">
          <span
            class="av-avatar"
            style="--av: var(--a{avatarIndex(row.name)}); --av-t: var(--a{avatarIndex(row.name)}-t)"
            aria-hidden="true">{initialsOf(row.name)}</span
          >
          <span class="av-text">
            <span class="av-title">{row.name}</span>
            {#if row.number !== ""}<span class="av-number">{row.number}</span>{/if}
          </span>
        </span>
      {:else if column.key === "open"}
        <a
          class="av-open"
          href={detailHref(row.id)}
          aria-label="Verfügbarkeit von {row.name} öffnen">Öffnen</a
        >
      {/if}
    {/snippet}
  </DataTable>
</div>

<style>
  .av-name {
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    min-width: 0;
  }

  .av-avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--av);
    color: var(--av-t);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .av-text {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
    text-align: start;
  }

  .av-title {
    font-weight: 600;
    color: var(--text);
  }

  .av-number {
    color: var(--text-3);
    font-size: var(--fs-xs);
    font-weight: 400;
  }

  .av-open {
    color: var(--brand);
    font-weight: 600;
    text-decoration: none;
  }

  .av-open:hover {
    text-decoration: underline;
  }
</style>
