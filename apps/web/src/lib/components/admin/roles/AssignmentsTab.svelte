<!--
  AssignmentsTab — the „Zuweisungen“ tab of /admin/roles (Issue #83, AK-4): who holds which role,
  for which scope; grant, change and revoke. Without role:read the role picker cannot be filled,
  so granting and changing are visibly disabled with an explanation (D-15); revoking needs only
  role-assignment:manage. Every rejection shows the server's German text (D-08).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
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
  let loadError = $state<string | null>(null);
  let filter = $state("");

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

  // Assignments of users without an employee profile, one group per user (a grant would be a 404).
  let orphanGroups = $derived(
    Object.entries(
      groupAssignmentsByUser(assignments.filter((a) => !people.some((p) => p.userId === a.userId))),
    ),
  );

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
    } catch (err) {
      loadError = messageOf(err);
    }
  });
</script>

{#if loadError}
  <div class="callout error" role="alert">{loadError}</div>
{:else}
  <!-- Not animated: the blocks render their own dialogs, which must not sit inside an animated
       block (its transform traps fixed dialogs, #570). -->
  <Section
    title="ZUWEISUNGEN"
    sub="Welche Person welche Rolle in welchem Bereich hat"
    animate={false}
  >
    <div class="assignments">
      <div class="callout">Wer keine Rolle hat, kann sich nicht anmelden.</div>
      {#if !canReadRoles}
        <div class="callout brand" role="note">{ROLE_READ_REQUIRED_NOTE}</div>
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
          <!-- canManage: the tab is rendered only for holders of role-assignment:manage
               (routes/(app)/admin/roles/+page.svelte). -->
          <PersonRoleAssignments
            personName={block.name}
            userId={block.person.userId}
            items={block.items}
            {roles}
            {mandantRoleIds}
            {salons}
            {salonsLoaded}
            {people}
            canManage={true}
            {canReadRoles}
            permissionNote={false}
            onChanged={reloadAssignments}
          >
            {#snippet head()}
              <span class="assignments-name">{block.name}</span>
              {#if !block.person.isActive}
                <span class="chip">inaktiv</span>
              {/if}
            {/snippet}
          </PersonRoleAssignments>
        </div>
      {/each}

      {#each orphanGroups as [orphanUserId, items] (orphanUserId)}
        <div class="assignments-person">
          <PersonRoleAssignments
            personName="Nutzer ohne Mitarbeiterprofil"
            userId={orphanUserId}
            {items}
            {roles}
            {mandantRoleIds}
            {salons}
            {salonsLoaded}
            {people}
            canManage={true}
            {canReadRoles}
            allowGrant={false}
            permissionNote={false}
            onChanged={reloadAssignments}
          >
            {#snippet head()}
              <span class="assignments-name">Nutzer ohne Mitarbeiterprofil</span>
            {/snippet}
          </PersonRoleAssignments>
        </div>
      {/each}
    </div>
  </Section>
{/if}

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
  }
  .assignments-name {
    font-weight: 600;
    color: var(--text);
  }
</style>
