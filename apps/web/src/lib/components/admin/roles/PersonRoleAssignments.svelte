<!--
  PersonRoleAssignments — Issue #580 (D-580-01/D-580-07): the ONE building block for a person's role
  assignments (role + scope), used by /admin/roles („Zuweisungen“), the employee detail tab
  „Berechtigungen“ and the employee create dialog. Lists the assignments, grants, changes and revokes
  them through AssignmentDialog and a ConfirmDialog. Every label comes from $lib/roles/assignment-label.
  The API stays the authority; disabled buttons only mirror the caller's permissions.
  Draft mode (`drafts` bound): the person does not exist yet (create dialog, D-580-03) — rows are
  fixed rows plus local drafts; nothing is requested and onChanged is never called.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
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
  <div class="person-roles-head">
    {#if head}{@render head()}{/if}
    {#if allowGrant}
      <button
        type="button"
        class="btn btn-ghost btn-sm person-roles-grant"
        disabled={!canEdit}
        onclick={() => (draftMode ? openDraft(null) : openDialog(null))}
      >
        Rolle zuweisen
      </button>
    {/if}
  </div>

  {#if permissionNote && !canManage}
    <div class="callout brand" role="note">{ASSIGN_RIGHT_REQUIRED_NOTE}</div>
  {:else if permissionNote && !canReadRoles}
    <div class="callout brand" role="note">{ROLE_READ_REQUIRED_NOTE}</div>
  {/if}
  {#if errorText}
    <div class="callout error" role="alert">{errorText}</div>
  {/if}

  {#if draftMode}
    {#if fixedRows.length === 0 && (drafts ?? []).length === 0}
      <p class="form-hint person-roles-empty">{NO_ASSIGNMENT_LABEL}</p>
    {:else}
      <ul class="assignments-list">
        {#each fixedRows as row, i (i)}
          <li class="assignments-item">
            <span class="assignments-role">{row.roleName}</span>
            <span class="assignments-scope">{scopeLabel(row.scope, ctx)}</span>
            <span class="assignments-actions"></span>
          </li>
        {/each}
        {#each drafts ?? [] as draft (draft.key)}
          <li class="assignments-item">
            <span class="assignments-role">
              {roleOf(draft.accessRoleId)?.name ?? ""}
              {#if roleOf(draft.accessRoleId)?.isSystem}
                <span class="chip chip-brand">{SYSTEM_ROLE_CHIP_LABEL}</span>
              {/if}
            </span>
            <span class="assignments-scope">{scopeLabel(draft.scope, ctx)}</span>
            <span class="assignments-actions">
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
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if items.length === 0}
    <p class="form-hint person-roles-empty">{NO_ASSIGNMENT_LABEL}</p>
  {:else}
    <ul class="assignments-list">
      {#each items as assignment (assignment.id)}
        <li class="assignments-item">
          <span class="assignments-role">
            {assignment.roleName}
            {#if assignment.isSystemRole}
              <span class="chip chip-brand">{SYSTEM_ROLE_CHIP_LABEL}</span>
            {/if}
          </span>
          <span class="assignments-scope">{scopeLabel(assignment.scope, ctx)}</span>
          <span class="assignments-actions">
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
          </span>
        </li>
      {/each}
    </ul>
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
    gap: 8px;
  }
  .person-roles-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .person-roles-grant {
    margin-left: auto;
  }
  .person-roles-empty {
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
    color: var(--text-2);
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
