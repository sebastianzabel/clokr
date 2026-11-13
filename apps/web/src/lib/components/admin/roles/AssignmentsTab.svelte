<!--
  AssignmentsTab - the „Zuweisungen“ tab of /admin/roles (Issue #83, AK-4; rebuilt on the blocks of #843 in
  Issue #854): who holds which role, for which scope; grant, change and revoke. One DataTable row per person
  (plus one per user without an employee profile), searchable through the TableToolbar; the assignments of a
  row are the shared PersonRoleAssignments block, which owns the dialogs (Issue #580: roles are assigned in
  one way). Without role:read the role picker cannot be filled, so granting and changing are visibly
  disabled with an explanation (D-15); revoking needs only role-assignment:manage. Every rejection shows the
  server's German text (D-08).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Note from "$components/ui/Note.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import { ApiError } from "$api/client";
  import {
    listAssignablePeople,
    listRoleAssignments,
    loadAssignmentChoices,
    type AccessRole,
    type AssignablePerson,
    type RoleAssignment,
  } from "$lib/api/roles";
  import { ROLE_READ_REQUIRED_NOTE, groupAssignmentsByUser } from "$lib/roles/assignment-label";
  import { matchesSearch } from "$lib/table/search";
  import PersonRoleAssignments from "./PersonRoleAssignments.svelte";

  interface Props {
    canReadRoles: boolean;
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
  }

  let { canReadRoles, salons, salonsLoaded }: Props = $props();

  let people = $state<AssignablePerson[]>([]);
  let assignments = $state<RoleAssignment[]>([]);
  let roles = $state<AccessRole[]>([]);
  let mandantRoleIds = $state<string[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let query = $state("");

  const ORPHAN_NAME = "Nutzer ohne Mitarbeiterprofil";

  const columns: DataTableColumn[] = [
    { key: "name", label: "Person", primary: true },
    { key: "assignments", label: "Zuweisungen" },
  ];

  type PersonRow = {
    key: string;
    name: string;
    userId: string;
    isActive: boolean;
    orphan: boolean;
    items: RoleAssignment[];
    assignments: string;
  };

  // Assignments of users without an employee profile, one group per user (a grant would be a 404).
  let orphanGroups = $derived(
    Object.entries(
      groupAssignmentsByUser(assignments.filter((a) => !people.some((p) => p.userId === a.userId))),
    ),
  );

  let allRows = $derived<PersonRow[]>([
    ...people.map((person) => ({
      key: person.employeeId,
      name: `${person.firstName} ${person.lastName}`,
      userId: person.userId,
      isActive: person.isActive,
      orphan: false,
      items: assignments.filter((a) => a.userId === person.userId),
      assignments: "",
    })),
    ...orphanGroups.map(([userId, items]) => ({
      key: `user:${userId}`,
      name: ORPHAN_NAME,
      userId,
      isActive: true,
      orphan: true,
      items,
      assignments: "",
    })),
  ]);
  let rows = $derived(allRows.filter((row) => matchesSearch(row.name, query)));

  function messageOf(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : "Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.";
  }

  async function reloadAssignments() {
    assignments = await listRoleAssignments();
  }

  onMount(async () => {
    try {
      const [peopleList, assignmentList, choices] = await Promise.all([
        listAssignablePeople(),
        listRoleAssignments(),
        loadAssignmentChoices(canReadRoles),
      ]);
      people = peopleList;
      assignments = assignmentList;
      roles = choices.roles;
      mandantRoleIds = choices.mandantRoleIds;
      loaded = true;
    } catch (err) {
      loadError = messageOf(err);
    }
  });
</script>

{#if loadError}
  <div role="alert"><Note tone="bad">{loadError}</Note></div>
{:else}
  <section class="settings-group" aria-labelledby="assignments-title">
    <h2 class="settings-group-title" id="assignments-title">Zuweisungen</h2>
    <p class="settings-group-desc">Welche Person welche Rolle in welchem Bereich hat.</p>

    <div class="assignments-notes">
      <Note tone="info">Wer keine Rolle hat, kann sich nicht anmelden.</Note>
      {#if !canReadRoles}
        <Note tone="brand">{ROLE_READ_REQUIRED_NOTE}</Note>
      {/if}
    </div>

    <DataTable
      {columns}
      {rows}
      rowKey={(row) => row.key}
      loading={!loaded}
      filtered={query !== ""}
      onResetFilters={() => (query = "")}
      caption="Personen mit ihren Rollen-Zuweisungen"
    >
      {#snippet toolbar()}
        <TableToolbar
          bind:query
          count={rows.length}
          total={allRows.length}
          searchLabel="Person suchen"
          onReset={() => (query = "")}
        />
      {/snippet}
      {#snippet cell(row, column)}
        {#if column.key === "name"}
          <span class="assignments-name">{row.name}</span>
          {#if !row.isActive}
            <Chip tone="neutral">inaktiv</Chip>
          {/if}
        {:else}
          <!-- canManage: the tab is rendered only for holders of role-assignment:manage
               (routes/(app)/admin/roles/+page.svelte). -->
          <PersonRoleAssignments
            personName={row.name}
            userId={row.userId}
            items={row.items}
            {roles}
            {mandantRoleIds}
            {salons}
            {salonsLoaded}
            {people}
            canManage={true}
            {canReadRoles}
            allowGrant={!row.orphan}
            permissionNote={false}
            onChanged={reloadAssignments}
          />
        {/if}
      {/snippet}
    </DataTable>
  </section>
{/if}

<style>
  .assignments-notes {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin-bottom: var(--s-3);
  }
  .assignments-name {
    font-weight: 600;
    color: var(--text);
  }
</style>
