<!--
  AssignmentsTab — the „Zuweisungen“ tab of /admin/roles (Issue #83, AK-4): who holds which role,
  for which scope; grant, change and revoke. Without role:read the role picker cannot be filled,
  so granting and changing are visibly disabled with an explanation (D-15); revoking needs only
  role-assignment:manage. Every rejection shows the server's German text (D-08).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import { toasts } from "$stores/toast";
  import { ApiError } from "$api/client";
  import {
    deleteRoleAssignment,
    fetchPermissionCatalog,
    listAssignablePeople,
    listRoleAssignments,
    listRoles,
    type AccessRole,
    type AssignablePerson,
    type RoleAssignment,
  } from "$lib/api/roles";
  import AssignmentDialog from "./AssignmentDialog.svelte";

  interface Props {
    canReadRoles: boolean;
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
  }

  let { canReadRoles, salons, salonsLoaded }: Props = $props();

  let people = $state<AssignablePerson[]>([]);
  let assignments = $state<RoleAssignment[]>([]);
  let roles = $state<AccessRole[]>([]);
  let mandantKeys = $state<string[]>([]);
  let loadError = $state<string | null>(null);
  let errorText = $state<string | null>(null);
  let filter = $state("");

  let dialogOpen = $state(false);
  let dialogUserId = $state("");
  let dialogName = $state("");
  let dialogAssignment = $state<RoleAssignment | null>(null);

  let revokeOpen = $state(false);
  let revokeTarget = $state<{ assignment: RoleAssignment; name: string } | null>(null);

  const UNKNOWN_SALON = "Salon nicht mehr aktiv";
  const UNKNOWN_PERSON = "Person nicht mehr verfügbar";

  let mandantRoleIds = $derived(
    roles.filter((r) => r.permissions.some((key) => mandantKeys.includes(key))).map((r) => r.id),
  );

  let blocks = $derived.by(() => {
    const needle = filter.trim().toLocaleLowerCase("de");
    return people
      .filter(
        (p) =>
          needle === "" || `${p.firstName} ${p.lastName}`.toLocaleLowerCase("de").includes(needle),
      )
      .map((person) => ({
        person,
        name: `${person.firstName} ${person.lastName}`,
        items: assignments.filter((a) => a.userId === person.userId),
      }));
  });

  let orphanAssignments = $derived(
    assignments.filter((a) => !people.some((p) => p.userId === a.userId)),
  );

  function messageOf(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.";
  }

  function salonName(id: string): string {
    if (!salonsLoaded) return "…";
    return salons.find((s) => s.id === id)?.name ?? UNKNOWN_SALON;
  }

  function personName(id: string): string {
    const person = people.find((p) => p.employeeId === id);
    return person ? `${person.firstName} ${person.lastName}` : UNKNOWN_PERSON;
  }

  function scopeSummary(assignment: RoleAssignment): string {
    const scope = assignment.scope;
    if (scope.type === "TENANT") return "Ganzer Mandant";
    if (scope.type === "SALONS") return `Salons: ${scope.salonIds.map(salonName).join(", ")}`;
    return `Personen: ${scope.employeeIds.map(personName).join(", ")}`;
  }

  async function reloadAssignments() {
    assignments = await listRoleAssignments();
  }

  onMount(async () => {
    try {
      const [peopleList, assignmentList] = await Promise.all([
        listAssignablePeople(),
        listRoleAssignments(),
      ]);
      people = peopleList;
      assignments = assignmentList;
      if (canReadRoles) {
        const [roleList, catalog] = await Promise.all([listRoles(), fetchPermissionCatalog()]);
        roles = roleList;
        mandantKeys = catalog.flatMap((group) =>
          group.permissions.filter((p) => p.relation === "MANDANT").map((p) => p.key),
        );
      }
    } catch (err) {
      loadError = messageOf(err);
    }
  });

  function openDialog(userId: string, name: string, assignment: RoleAssignment | null) {
    dialogUserId = userId;
    dialogName = name;
    dialogAssignment = assignment;
    dialogOpen = true;
  }

  async function onSaved() {
    errorText = null;
    try {
      await reloadAssignments();
    } catch (err) {
      errorText = messageOf(err);
    }
  }

  function askRevoke(assignment: RoleAssignment, name: string) {
    revokeTarget = { assignment, name };
    revokeOpen = true;
  }

  async function confirmRevoke() {
    const target = revokeTarget;
    if (!target) return;
    errorText = null;
    try {
      await deleteRoleAssignment(target.assignment.id);
      toasts.success("Zuweisung entzogen");
      await reloadAssignments();
    } catch (err) {
      errorText = messageOf(err);
    }
  }
</script>

{#snippet assignmentRows(items: RoleAssignment[], name: string)}
  {#if items.length === 0}
    <p class="form-hint assignments-empty">Keine gespeicherte Zuweisung</p>
  {:else}
    <ul class="assignments-list">
      {#each items as assignment (assignment.id)}
        <li class="assignments-item">
          <span class="assignments-role">
            {assignment.roleName}
            {#if assignment.isSystemRole}
              <span class="chip chip-brand">Systemrolle</span>
            {/if}
          </span>
          <span class="assignments-scope">{scopeSummary(assignment)}</span>
          <span class="assignments-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={!canReadRoles}
              onclick={() => openDialog(assignment.userId, name, assignment)}
            >
              Ändern
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onclick={() => askRevoke(assignment, name)}
            >
              Entziehen
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#if loadError}
  <div class="callout error" role="alert">{loadError}</div>
{:else}
  <Section title="ZUWEISUNGEN" sub="Welche Person welche Rolle in welchem Bereich hat">
    <div class="assignments">
      <div class="callout">
        Personen ohne gespeicherte Zuweisung erhalten ihre Rechte bis zur ersten Zuweisung aus ihrer
        bisherigen Rollenangabe. Die erste Zuweisung übernimmt diese Rollenangabe als eigene
        Zuweisung.
      </div>
      {#if !canReadRoles}
        <div class="callout brand" role="note">
          Zum Zuweisen und Ändern brauchen Sie zusätzlich das Recht, Rollen zu lesen.
        </div>
      {/if}
      {#if errorText}
        <div class="callout error" role="alert">{errorText}</div>
      {/if}

      <input
        class="form-input assignments-filter"
        type="search"
        placeholder="Person suchen"
        aria-label="Person suchen"
        bind:value={filter}
      />

      {#each blocks as block (block.person.employeeId)}
        <div class="assignments-person">
          <div class="assignments-person-head">
            <span class="assignments-name">{block.name}</span>
            {#if !block.person.isActive}
              <span class="chip">inaktiv</span>
            {/if}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={!canReadRoles}
              onclick={() => openDialog(block.person.userId, block.name, null)}
            >
              Rolle zuweisen
            </button>
          </div>
          {@render assignmentRows(block.items, block.name)}
        </div>
      {/each}

      {#if orphanAssignments.length > 0}
        <div class="assignments-person">
          <div class="assignments-person-head">
            <span class="assignments-name">Nutzer ohne Mitarbeiterprofil</span>
          </div>
          {@render assignmentRows(orphanAssignments, "Nutzer ohne Mitarbeiterprofil")}
        </div>
      {/if}
    </div>
  </Section>
{/if}

<AssignmentDialog
  bind:open={dialogOpen}
  userId={dialogUserId}
  personName={dialogName}
  assignment={dialogAssignment}
  {roles}
  {mandantRoleIds}
  {salons}
  {salonsLoaded}
  {people}
  {onSaved}
/>

<ConfirmDialog
  bind:open={revokeOpen}
  title="Zuweisung entziehen"
  description={revokeTarget
    ? `${revokeTarget.name} verliert die Rolle „${revokeTarget.assignment.roleName}“. Die Änderung wird protokolliert.`
    : ""}
  confirmLabel="Entziehen"
  danger
  onConfirm={confirmRevoke}
/>

<style>
  .assignments {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .assignments-filter {
    max-width: 320px;
  }
  .assignments-person {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .assignments-person-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .assignments-name {
    font-weight: 600;
    color: var(--text);
    margin-right: auto;
  }
  .assignments-empty {
    margin: 0;
  }
  .assignments-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .assignments-item {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(200px, 2fr) auto;
    align-items: center;
    gap: 8px 16px;
    font-size: 14px;
  }
  .assignments-role {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .assignments-scope {
    color: var(--text-muted);
  }
  .assignments-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  @media (max-width: 720px) {
    .assignments-item {
      grid-template-columns: 1fr;
    }
    .assignments-actions {
      justify-content: flex-start;
    }
  }
</style>
