<script lang="ts">
  // Issue #853 (D-853-14, D-853-15) - Team › Personen: the read-only team directory for leaders. A page
  // created by #853 (no route file to reroute). The data is exactly `GET /employees`: the server narrows the
  // list to the caller's reach (#547) and masks the saldo without `overtime:read`; this page decides nothing
  // about either. Read-only: no write call, no e-mail column, no edit actions (Verwalten › Personen does that).
  // The header salon narrows the list through `salonPageFilter` (#558), never the store's raw selection.
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { salonContext } from "$stores/salon-context";
  import { pageLabel } from "$lib/nav/page-labels";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope";
  import { fmtBalance } from "$lib/utils/format-minutes";

  // A type alias, not an interface: DataTable's row generic wants an index-signature-compatible type.
  type Person = {
    id: string;
    firstName: string;
    lastName: string;
    user: { isActive: boolean };
    workSchedule: { type: string } | null;
    /** Null while the caller may not read the saldo of this person (server-side mask). */
    overtimeAccount: { balanceHours: number | string | null } | null;
  };

  let people: Person[] = $state([]);
  let loading = $state(true);
  let failed = $state(false);
  let salonRejected = $state(false);

  // Waits for the salon context so the first request is already filtered; reloads when the header salon
  // changes. The effect reads primitive deriveds only.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  // Plain let: an older response never overwrites a newer one (not reactive on purpose).
  let generation = 0;

  // Sentinel set by the DSGVO anonymisation (CLAUDE.md): such a row is never listed.
  function isAnonymized(person: Person): boolean {
    return person.firstName === "Gelöscht" && person.lastName.startsWith("GELÖSCHT-");
  }

  async function load() {
    const current = ++generation;
    loading = true;
    failed = false;
    try {
      const list = await api.get<Person[]>(withSalonId("/employees", pageSalonId));
      if (current !== generation) return;
      people = list.filter((person) => !isAnonymized(person));
      salonRejected = false;
    } catch (e: unknown) {
      if (current !== generation) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: a calm text, no error state.
        people = [];
        salonRejected = true;
      } else {
        failed = true;
      }
    } finally {
      if (current === generation) loading = false;
    }
  }

  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    untrack(() => {
      void load();
    });
  });

  function scheduleLabel(type: string | null | undefined): string {
    switch (type) {
      case "FIXED_SCHEDULE":
        return "Feste Arbeitszeit";
      case "FLEXTIME":
        return "Gleitzeit";
      case "MONTHLY_HOURS":
        return "Monatsstunden";
      case "SHIFT_BASED":
        return "Nach Schichtplan";
      default:
        return "—";
    }
  }

  // The stored saldo is in hours; the shared formatter takes minutes (±H:MM, one column, one value).
  function saldoLabel(person: Person): string {
    const hours = person.overtimeAccount?.balanceHours;
    if (hours === null || hours === undefined) return "—";
    const value = Number(hours);
    return Number.isFinite(value) ? fmtBalance(Math.round(value * 60)) : "—";
  }

  // The saldo column exists only when the caller may read at least one saldo (no column of dashes).
  const showSaldo = $derived(people.some((person) => saldoLabel(person) !== "—"));

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Name", primary: true },
    { key: "schedule", label: "Arbeitszeitmodell" },
    ...(showSaldo ? [{ key: "saldo", label: "Saldo", align: "end" as const }] : []),
    { key: "status", label: "Status" },
  ]);

  // The list arrives ordered by last name from the server; the visible name is „Nachname, Vorname“.
  const rows = $derived(
    people.map((person) => ({ ...person, name: `${person.lastName}, ${person.firstName}` })),
  );
</script>

<svelte:head>
  <title>{pageLabel("/team/personen")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/team/personen")}
  sub="Alle Personen in deinem Zuständigkeitsbereich."
/>

<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />

{#if failed}
  <ErrorState onRetry={() => void load()} retrying={loading} />
{:else}
  <DataTable
    {columns}
    {rows}
    rowKey={(row) => row.id}
    rowTestId={(row) => `team-personen-row-${row.id}`}
    onRowClick={(row) => goto(`/team/zeiten?employeeId=${encodeURIComponent(row.id)}`)}
    {loading}
    caption="Personen"
  >
    {#snippet cell(row, column)}
      {#if column.key === "name"}
        <strong>{row.name}</strong>
      {:else if column.key === "schedule"}
        {scheduleLabel(row.workSchedule?.type)}
      {:else if column.key === "saldo"}
        {saldoLabel(row)}
      {:else if column.key === "status"}
        <Chip tone={row.user.isActive ? "ok" : "neutral"}
          >{row.user.isActive ? "Aktiv" : "Inaktiv"}</Chip
        >
      {/if}
    {/snippet}
  </DataTable>
{/if}
