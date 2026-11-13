<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, moduleBooked } from "$stores/salon-context";
  import { salonAdminRights } from "$lib/page-rights";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import ModuleHint from "$lib/components/admin/ModuleHint.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import { matchesSearch } from "$lib/table/search";
  import { oneOf, text, urlState } from "$lib/table/url-state";
  import { federalStateLabel } from "$lib/salons/federal-states";
  import type { SalonDto } from "$lib/salons/salon-form";

  // Presentation only: the API refuses a create without salon:manage on its own.
  const rights = $derived(salonAdminRights($authStore.user));

  let salons: SalonDto[] = $state([]);
  let loading = $state(true);
  let loadError = $state("");
  let forbidden = $state(false);

  const activeCount = $derived(salons.filter((salon) => salon.isActive).length);
  // Display only (Phase 566, D-12; fifth set-up spot, Issue #563 D-18): without the CHAIN module
  // the salon limit is reached with the first active salon. An unknown package state (null) hides
  // nothing, and the server's 409 on create and activate stays the authority.
  const chainHint = $derived(
    moduleBooked($salonContext, "CHAIN") === false &&
      activeCount >= ($salonContext.packages?.salonLimit ?? Number.POSITIVE_INFINITY),
  );

  /** "Straße, PLZ Ort" from the non-empty parts, "—" when the salon has no address at all. */
  function addressOf(salon: SalonDto): string {
    const place = [salon.postalCode, salon.city].filter((part) => part && part.trim()).join(" ");
    const parts = [salon.street, place].filter((part) => part && part.trim());
    return parts.length > 0 ? parts.join(", ") : "—";
  }

  // ── Table state in the URL (Issue #854, D-854-03): the search text and the status filter ────
  // The schema is an allow-list: every other key of the URL (e.g. `salonId`) is left alone and a
  // value that fails its parser is the default.
  const listUrlSchema = {
    q: text({ max: 80 }),
    status: oneOf(["all", "active", "inactive"] as const, "all"),
  };
  const listUrl = urlState(listUrlSchema);
  const urlQuery = $derived(listUrl.read().q);
  const status = $derived(listUrl.read().status);

  // `query` is the raw (normalised) input of the toolbar; the URL carries the parsed value. Values
  // written to the URL whose echo has not come back yet are remembered, so a fast typist's "a",
  // "ab" does not get "a" written back into the input by the first echo.
  let query = $state(listUrl.read().q);
  let pendingEchoes: string[] = [];
  function setQuery(value: string) {
    query = value;
    const next = listUrlSchema.q.parse(value);
    if (next === listUrl.read().q) return;
    pendingEchoes = [...pendingEchoes, next];
    listUrl.write({ q: next });
  }
  $effect(() => {
    const fromUrl = urlQuery;
    untrack(() => {
      const index = pendingEchoes.indexOf(fromUrl);
      if (index >= 0) {
        pendingEchoes = pendingEchoes.slice(index + 1);
        return;
      }
      // A change the page did not write itself (back/forward, a link): the input follows the URL.
      pendingEchoes = [];
      if (listUrlSchema.q.parse(query) !== fromUrl) query = fromUrl;
    });
  });

  function resetFilters() {
    query = "";
    if (listUrl.read().q !== "") pendingEchoes = [...pendingEchoes, ""];
    listUrl.write({ q: "", status: "all" });
  }

  type SalonRow = {
    id: string;
    name: string;
    federalState: string;
    address: string;
    isActive: boolean;
  };

  const allRows = $derived<SalonRow[]>(
    [...salons]
      .sort((a, b) => a.name.localeCompare(b.name, "de"))
      .map((salon) => ({
        id: salon.id,
        name: salon.name,
        federalState: federalStateLabel(salon.federalState),
        address: addressOf(salon),
        isActive: salon.isActive,
      })),
  );
  const rows = $derived(
    allRows.filter(
      (row) =>
        (status === "all" || (status === "active") === row.isActive) &&
        matchesSearch(`${row.name} ${row.federalState} ${row.address}`, query),
    ),
  );
  const filtered = $derived(query !== "" || status !== "all");

  const columns: DataTableColumn[] = [
    { key: "name", label: "Name", primary: true },
    { key: "federalState", label: "Bundesland" },
    { key: "address", label: "Adresse" },
    { key: "status", label: "Status" },
  ];

  const filters = $derived([
    {
      key: "status",
      label: "Status",
      value: status === "all" ? "" : status,
      options: [
        { value: "active", label: "Aktiv" },
        { value: "inactive", label: "Inaktiv" },
      ],
    },
  ]);

  onMount(async () => {
    try {
      const res = await api.get<{ salons: SalonDto[] }>("/salons?includeInactive=true");
      salons = res.salons;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        forbidden = true;
      } else {
        loadError = "Die Salons konnten nicht geladen werden.";
      }
    } finally {
      loading = false;
    }
  });
</script>

<PageHead
  title={pageLabel("/admin/salons")}
  sub="Standorte deines Unternehmens mit Adresse und Öffnungszeiten."
>
  {#snippet actions()}
    {#if rights.canManage}
      {#if chainHint}
        <ModuleHint module="CHAIN" subject="Weitere Salons" />
      {:else}
        <a class="btn btn-primary" href="/admin/salons/neu">Salon anlegen</a>
      {/if}
    {/if}
  {/snippet}
</PageHead>

{#if forbidden}
  <Note tone="info">Für die Salonübersicht fehlt dir die Berechtigung.</Note>
{:else if loadError}
  <div role="alert"><Note tone="bad">{loadError}</Note></div>
{:else if !loading && salons.length === 0}
  <EmptyState
    icon="inbox"
    title="Noch keine Salons angelegt"
    description="Sobald ein Salon angelegt ist, erscheint er hier."
  />
{:else}
  <DataTable
    {columns}
    {rows}
    rowKey={(row) => row.id}
    {loading}
    {filtered}
    onResetFilters={resetFilters}
    onRowClick={(row) => goto(`/admin/salons/${row.id}`)}
    caption="Alle Salons, aktive und deaktivierte Standorte"
  >
    {#snippet toolbar()}
      <TableToolbar
        bind:query={() => query, setQuery}
        count={rows.length}
        total={allRows.length}
        {filters}
        searchLabel="Salons suchen"
        onFilterChange={(_key, value) =>
          listUrl.write({ status: value === "" ? "all" : (value as "active" | "inactive") })}
        onReset={resetFilters}
      />
    {/snippet}
    {#snippet cell(row, column)}
      {#if column.key === "status"}
        <Chip tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? "Aktiv" : "Inaktiv"}</Chip>
      {:else if column.key === "federalState"}
        {row.federalState}
      {:else if column.key === "address"}
        {row.address}
      {:else}
        {row.name}
      {/if}
    {/snippet}
  </DataTable>
{/if}
