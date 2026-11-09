<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 6. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 6,
    name: "Tabelle + Toolbar",
    entries: [
      "components/ui/DataTable.svelte",
      "components/ui/TableToolbar.svelte",
      "components/ui/SortHeader.svelte",
    ],
  };
</script>

<script lang="ts">
  import DataTable, { type DataTableSort } from "$components/ui/DataTable.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import { matchesSearch } from "$lib/table/search";

  interface DemoRow extends Record<string, unknown> {
    id: number;
    name: string;
    email: string;
    status: "Aktiv" | "Ausgetreten";
  }

  // Local state only: the example page renders this demo six times, so no URL state is shared.
  const ALL_ROWS: DemoRow[] = [
    { id: 1, name: "Person A", email: "person-a@beispiel.test", status: "Aktiv" },
    { id: 2, name: "Person B", email: "person-b@beispiel.test", status: "Aktiv" },
    { id: 3, name: "Person C", email: "person-c@beispiel.test", status: "Ausgetreten" },
    { id: 4, name: "Person D", email: "person-d@beispiel.test", status: "Aktiv" },
    { id: 5, name: "Person E", email: "person-e@beispiel.test", status: "Ausgetreten" },
  ];

  const NO_ROWS: DemoRow[] = [];

  const columns = [
    { key: "name", label: "Name", primary: true, sortable: true },
    { key: "email", label: "E-Mail" },
    { key: "status", label: "Status", sortable: true },
  ];

  let query = $state("");
  let status = $state("");
  let sort = $state<DataTableSort | null>({ key: "name", dir: "asc" });

  const visible = $derived.by(() => {
    const matching = ALL_ROWS.filter(
      (r) => (status === "" || r.status === status) && matchesSearch(`${r.name} ${r.email}`, query),
    );
    if (!sort) return matching;
    const { key, dir } = sort;
    return [...matching].sort((a, b) => {
      const cmp = String(a[key]).localeCompare(String(b[key]), "de");
      return dir === "asc" ? cmp : -cmp;
    });
  });

  const filters = $derived([
    {
      key: "status",
      label: "Status",
      value: status,
      options: [
        { value: "Aktiv", label: "Aktiv" },
        { value: "Ausgetreten", label: "Ausgetreten" },
      ],
    },
  ]);

  function resetFilters() {
    query = "";
    status = "";
  }
</script>

<div data-block="6" class="table-demo">
  <DataTable
    {columns}
    rows={visible}
    rowKey={(r) => r.id}
    {sort}
    onSort={(next) => (sort = next)}
    filtered={query !== "" || status !== ""}
    onResetFilters={resetFilters}
    caption="Beispieltabelle Team"
  >
    {#snippet toolbar()}
      <TableToolbar
        bind:query
        count={visible.length}
        total={ALL_ROWS.length}
        {filters}
        onFilterChange={(_key, value) => (status = value)}
        onReset={resetFilters}
      />
    {/snippet}
    {#snippet cell(row, column)}
      {#if column.key === "status"}
        <Chip tone={row.status === "Aktiv" ? "ok" : "neutral"}>{row.status}</Chip>
      {:else}
        {row[column.key]}
      {/if}
    {/snippet}
  </DataTable>

  <DataTable
    {columns}
    rows={NO_ROWS}
    rowKey={(r) => r.id}
    filtered
    onResetFilters={() => {}}
    caption="Beispieltabelle ohne Treffer"
  />
</div>

<style>
  .table-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }
</style>
