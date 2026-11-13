<!--
  PersonRoleAssignments — Issue #580 (D-580-01/D-580-07): the ONE building block for a person's role
  assignments (role + scope), used by /admin/roles („Zuweisungen“), the employee detail tab
  „Berechtigungen“ and the employee create dialog. Lists the assignments, grants, changes and revokes
  them through AssignmentDialog and a ConfirmDialog. Every label comes from $lib/roles/assignment-label.
  The API stays the authority; disabled buttons only mirror the caller's permissions.
  Draft mode (`drafts` bound): the person does not exist yet (create dialog, D-580-03) — rows are
  fixed rows plus local drafts; nothing is requested and onChanged is never called.
  Rebuilt on the List, Chip and Note blocks in Issue #854; the props are unchanged.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Note from "$components/ui/Note.svelte";
  import { toasts } from "$stores/toast";
  import { ApiError } from "$api/client";
  import {
    deleteRoleAssignment,
    type AccessRole,
    type AssignmentDraft,
    type AssignmentScope,
    type AssignablePerson,
    type RoleAssignment,
  } from "$lib/api/roles";
  import {
    ASSIGN_RIGHT_REQUIRED_NOTE,
    NO_ASSIGNMENT_LABEL,
    ROLE_READ_REQUIRED_NOTE,
    SYSTEM_ROLE_CHIP_LABEL,
    scopeLabel,
  } from "$lib/roles/assignment-label";
  import AssignmentDialog from "./AssignmentDialog.svelte";

  interface Props {
    personName: string;
    /** The person's user; "" while the person does not exist yet (create dialog, draft rows). */
    userId?: string;
    items?: RoleAssignment[];
    /** Called after every successful grant, change or revoke; may reload asynchronously. */
    onChanged?: () => void | Promise<void>;
    roles: AccessRole[];
    mandantRoleIds: string[];
    salons: { id: string; name: string }[];
    salonsLoaded: boolean;
    people: AssignablePerson[];
    /** role-assignment:manage — without it every action is disabled. */
    canManage: boolean;
    /** role:read — without it the role picker cannot be filled, so grant and change are disabled. */
    canReadRoles: boolean;
    allowGrant?: boolean;
    /** Show the missing-permission note inside the block (a host may show it once instead). */
    permissionNote?: boolean;
    /** Rendered at the start of the head row (e.g. the person's name). */
    head?: Snippet;
    /** Draft mode: the chosen-but-not-yet-stored assignments (bindable). */
    drafts?: AssignmentDraft[];
    /** Draft mode: rows shown first and never editable (the role the create API grants). */
    fixedRows?: { roleName: string; scope: AssignmentScope }[];
  }

  let {
    personName,
    userId = "",
    items = [],
    onChanged = () => {},
    roles,
    mandantRoleIds,
    salons,
    salonsLoaded,
    people,
    canManage,
    canReadRoles,
    allowGrant = true,
    permissionNote = true,
    head,
    drafts = $bindable(),
    fixedRows = [],
  }: Props = $props();

  let draftMode = $derived(drafts !== undefined);
  let editedDraft = $state<AssignmentDraft | null>(null);

  function roleOf(id: string): AccessRole | undefined {
    return roles.find((r) => r.id === id);
  }

  function openDraft(draft: AssignmentDraft | null) {
    editedDraft = draft;
    dialogAssignment = null;
    dialogOpen = true;
  }

  function takeDraft(choice: { accessRoleId: string; scope: AssignmentScope }) {
    const current = drafts ?? [];
    const edited = editedDraft;
    drafts = edited
      ? current.map((d) => (d.key === edited.key ? { ...d, ...choice } : d))
      : [...current, { key: crypto.randomUUID(), ...choice }];
  }

  function removeDraft(key: string) {
    drafts = (drafts ?? []).filter((d) => d.key !== key);
  }

  let dialogOpen = $state(false);
  let dialogAssignment = $state<RoleAssignment | null>(null);
  let revokeOpen = $state(false);
  let revokeTarget = $state<RoleAssignment | null>(null);
  let errorText = $state<string | null>(null);

  let ctx = $derived({ salons, salonsLoaded, people });
  let canEdit = $derived(canManage && canReadRoles);

  function messageOf(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : "Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.";
  }

  function openDialog(assignment: RoleAssignment | null) {
    errorText = null;
    dialogAssignment = assignment;
    dialogOpen = true;
  }

  async function notifyChanged() {
    try {
      await onChanged();
    } catch (err) {
      errorText = messageOf(err);
    }
  }

  function askRevoke(assignment: RoleAssignment) {
    errorText = null;
    revokeTarget = assignment;
    revokeOpen = true;
  }

  async function confirmRevoke() {
    const target = revokeTarget;
    if (!target) return;
    try {
      await deleteRoleAssignment(target.id);
      toasts.success("Zuweisung entzogen");
    } catch (err) {
      errorText = messageOf(err);
      return;
    }
    await notifyChanged();
  }
</script>

<div class="person-roles">
  {#if head}
    <div class="person-roles-head">{@render head()}</div>
  {/if}

  {#if permissionNote && !canManage}
    <Note tone="brand">{ASSIGN_RIGHT_REQUIRED_NOTE}</Note>
  {:else if permissionNote && !canReadRoles}
    <Note tone="brand">{ROLE_READ_REQUIRED_NOTE}</Note>
  {/if}
  {#if errorText}
    <div role="alert"><Note tone="bad">{errorText}</Note></div>
  {/if}

  {#if draftMode}
    {#if fixedRows.length === 0 && (drafts ?? []).length === 0}
      <p class="person-roles-empty">{NO_ASSIGNMENT_LABEL}</p>
    {:else}
      <List ariaLabel="Rollen von {personName}">
        {#each fixedRows as row, i (i)}
          <ListRow title={row.roleName} subtitle={scopeLabel(row.scope, ctx)} avatar={false} wrap />
        {/each}
        {#each drafts ?? [] as draft (draft.key)}
          <ListRow
            title={roleOf(draft.accessRoleId)?.name ?? ""}
            subtitle={scopeLabel(draft.scope, ctx)}
            avatar={false}
            variant="task"
            wrap
          >
            {#snippet actions()}
              {#if roleOf(draft.accessRoleId)?.isSystem}
                <Chip tone="brand">{SYSTEM_ROLE_CHIP_LABEL}</Chip>
              {/if}
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={!canEdit}
                onclick={() => openDraft(draft)}
              >
                Ändern
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={!canManage}
                onclick={() => removeDraft(draft.key)}
              >
                Entfernen
              </button>
            {/snippet}
          </ListRow>
        {/each}
      </List>
    {/if}
  {:else if items.length === 0}
    <p class="person-roles-empty">{NO_ASSIGNMENT_LABEL}</p>
  {:else}
    <List ariaLabel="Rollen von {personName}">
      {#each items as assignment (assignment.id)}
        <ListRow
          title={assignment.roleName}
          subtitle={scopeLabel(assignment.scope, ctx)}
          avatar={false}
          variant="task"
          wrap
        >
          {#snippet actions()}
            {#if assignment.isSystemRole}
              <Chip tone="brand">{SYSTEM_ROLE_CHIP_LABEL}</Chip>
            {/if}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={!canEdit}
              onclick={() => openDialog(assignment)}
            >
              Ändern
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              disabled={!canManage}
              onclick={() => askRevoke(assignment)}
            >
              Entziehen
            </button>
          {/snippet}
        </ListRow>
      {/each}
    </List>
  {/if}

  {#if allowGrant}
    <div class="person-roles-grant">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        disabled={!canEdit}
        onclick={() => (draftMode ? openDraft(null) : openDialog(null))}
      >
        Rolle zuweisen
      </button>
    </div>
  {/if}
</div>

<AssignmentDialog
  bind:open={dialogOpen}
  {userId}
  {personName}
  assignment={dialogAssignment}
  {roles}
  {mandantRoleIds}
  {salons}
  {salonsLoaded}
  {people}
  onSaved={notifyChanged}
  onDraft={draftMode ? takeDraft : undefined}
  draft={editedDraft}
/>

<ConfirmDialog
  bind:open={revokeOpen}
  title="Zuweisung entziehen"
  description={revokeTarget
    ? `${personName} verliert die Rolle „${revokeTarget.roleName}“. Die Änderung wird protokolliert.`
    : ""}
  confirmLabel="Entziehen"
  danger
  onConfirm={confirmRevoke}
/>

<style>
  .person-roles {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }
  .person-roles-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .person-roles-empty {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .person-roles-grant {
    display: flex;
  }
</style>
