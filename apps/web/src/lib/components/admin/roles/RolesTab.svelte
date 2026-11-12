<!--
  RolesTab - the „Rollen“ tab of /admin/roles (Issue #83; rebuilt on the blocks of #843 in Issue #854):
  system and own roles in a DataTable; create, edit, copy and delete. The editor is a Dialog
  (RoleEditor) and is open exactly while a draft exists. Every rejection shows the server's German
  message (D-08); the four-eyes confirmation is server-driven (D-07): a 409 with the code
  FOUR_EYES_CONFIRMATION_REQUIRED opens a ConfirmDialog and resends with `confirm: true` only after an
  explicit confirmation. Controls a caller may not use are disabled, never hidden (D-06).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Note from "$components/ui/Note.svelte";
  import { toasts } from "$stores/toast";
  import { ApiError } from "$api/client";
  import {
    copyRole,
    createRole,
    deleteRole,
    fetchPermissionCatalog,
    isFourEyesConfirmation,
    listRoles,
    updateRole,
    type AccessRole,
    type PermissionCatalogGroup,
  } from "$lib/api/roles";
  import RoleEditor from "./RoleEditor.svelte";
  import {
    draftDirty,
    draftFromRole,
    newRoleDraft,
    orderedKeys,
    type RoleDraft,
  } from "./role-draft";

  interface Props {
    canManage: boolean;
    draft: RoleDraft | null;
    /** Called once catalog and roles have loaded — the page gates its unsaved marker on it. */
    onReady?: () => void;
    /**
     * Issue #624: given only when the Ketten-Paket is known to be missing. It replaces the create
     * action „Neue Rolle“ (display only — the server answers 409 MODULE_NOT_BOOKED either way) and
     * switches copying off, because a copy is a new role too. Editing and deleting stay free.
     */
    createHint?: import("svelte").Snippet;
  }

  let { canManage, draft = $bindable(), onReady, createHint }: Props = $props();

  let groups = $state<PermissionCatalogGroup[]>([]);
  let roles = $state<AccessRole[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let errorText = $state<string | null>(null);
  let saving = $state(false);

  let fourEyesOpen = $state(false);
  let fourEyesMessage = $state("");
  let pendingWrite: (() => Promise<void>) | null = null;

  let deleteOpen = $state(false);
  let deleteTarget = $state<AccessRole | null>(null);

  let discardOpen = $state(false);
  let pendingSelection: (() => void) | null = null;

  let totalPermissions = $derived(groups.reduce((sum, g) => sum + g.permissions.length, 0));
  let selectedRole = $derived(
    draft?.roleId ? (roles.find((r) => r.id === draft?.roleId) ?? null) : null,
  );
  let isSystem = $derived(selectedRole?.isSystem ?? false);
  let lockReason = $derived<"system" | "read-only" | null>(
    isSystem ? "system" : !canManage ? "read-only" : null,
  );

  const columns: DataTableColumn[] = [
    { key: "name", label: "Rolle", primary: true },
    { key: "kind", label: "Art" },
    { key: "rights", label: "Rechte" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  type RoleRow = {
    id: string;
    name: string;
    kind: string;
    rights: string;
    role: AccessRole;
  };

  let rows = $derived<RoleRow[]>(
    roles.map((role) => ({
      id: role.id,
      name: role.name,
      kind: role.isSystem ? "Systemrolle" : "Eigene Rolle",
      rights: `${role.permissions.length} von ${totalPermissions}`,
      role,
    })),
  );

  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return "Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.";
  }

  async function reloadRoles() {
    roles = await listRoles();
  }

  onMount(async () => {
    try {
      const [catalog, list] = await Promise.all([fetchPermissionCatalog(), listRoles()]);
      groups = catalog;
      roles = list;
      loaded = true;
      onReady?.();
    } catch (err) {
      loadError = messageOf(err);
    }
  });

  /**
   * Every role write goes through here: a four-eyes 409 opens the confirmation and resends the
   * same request with `confirm: true`; every other rejection shows the server text (D-07/D-08).
   */
  async function runRoleWrite(
    send: (confirm: boolean) => Promise<AccessRole | void>,
    onSuccess: (role: AccessRole | void) => Promise<void> | void,
  ) {
    errorText = null;
    saving = true;
    try {
      await onSuccess(await send(false));
    } catch (err) {
      if (isFourEyesConfirmation(err)) {
        fourEyesMessage = err.message;
        pendingWrite = async () => onSuccess(await send(true));
        fourEyesOpen = true;
      } else {
        errorText = messageOf(err);
      }
    } finally {
      saving = false;
    }
  }

  async function confirmFourEyes() {
    const write = pendingWrite;
    pendingWrite = null;
    if (!write) return;
    saving = true;
    try {
      await write();
    } catch (err) {
      errorText = messageOf(err);
    } finally {
      saving = false;
    }
  }

  function guardedSelect(select: () => void) {
    if (draft && draftDirty(draft)) {
      pendingSelection = select;
      discardOpen = true;
      return;
    }
    select();
  }

  /** The editor asked to close: a dirty draft asks first, a clean one just goes. */
  function requestClose() {
    if (!draft) return;
    guardedSelect(() => {
      errorText = null;
      draft = null;
    });
  }

  function openRole(role: AccessRole) {
    guardedSelect(() => {
      errorText = null;
      draft = draftFromRole(role);
    });
  }

  function openNew() {
    guardedSelect(() => {
      errorText = null;
      draft = newRoleDraft();
    });
  }

  function save() {
    const current = draft;
    if (!current) return;
    const body = {
      name: current.name.trim(),
      permissions: orderedKeys(groups, current.permissions),
    };
    if (current.roleId === null) {
      void runRoleWrite(
        (confirm) => createRole(confirm ? { ...body, confirm: true } : body),
        async () => {
          toasts.success("Rolle angelegt");
          await reloadRoles();
          draft = null;
        },
      );
    } else {
      const id = current.roleId;
      void runRoleWrite(
        (confirm) => updateRole(id, confirm ? { ...body, confirm: true } : body),
        async () => {
          toasts.success("Rolle gespeichert");
          await reloadRoles();
          draft = null;
        },
      );
    }
  }

  function copy(role: AccessRole) {
    guardedSelect(() => {
      void runRoleWrite(
        (confirm) => copyRole(role.id, confirm ? { confirm: true } : {}),
        async (created) => {
          toasts.success("Rolle kopiert");
          await reloadRoles();
          if (created) draft = draftFromRole(created);
        },
      );
    });
  }

  function discard() {
    if (!draft) return;
    draft =
      draft.roleId === null
        ? newRoleDraft()
        : { ...draft, name: draft.baseline.name, permissions: [...draft.baseline.permissions] };
  }

  function askDelete(role: AccessRole) {
    deleteTarget = role;
    deleteOpen = true;
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    try {
      await deleteRole(target.id);
      toasts.success("Rolle gelöscht");
      if (draft?.roleId === target.id) draft = null;
      await reloadRoles();
    } catch (err) {
      errorText = messageOf(err);
    }
  }
</script>

{#if loadError}
  <div role="alert"><Note tone="bad">{loadError}</Note></div>
{:else}
  <section class="settings-group" aria-labelledby="roles-title">
    <h2 class="settings-group-title" id="roles-title">Rollen</h2>
    <p class="settings-group-desc">Systemrollen und die eigenen Rollen des Unternehmens.</p>

    <div class="roles-bar">
      {#if createHint}
        {@render createHint()}
      {:else}
        <button type="button" class="btn btn-primary" disabled={!canManage} onclick={openNew}>
          Neue Rolle
        </button>
      {/if}
    </div>

    {#if errorText && !draft}
      <div role="alert"><Note tone="bad">{errorText}</Note></div>
    {/if}

    <DataTable {columns} {rows} rowKey={(row) => row.id} loading={!loaded} caption="Rollen">
      {#snippet cell(row, column)}
        {#if column.key === "name"}
          {row.name}
        {:else if column.key === "kind"}
          <Chip tone={row.role.isSystem ? "brand" : "neutral"}>{row.kind}</Chip>
        {:else if column.key === "rights"}
          {row.rights}
        {:else}
          <span class="roles-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick={() => openRole(row.role)}>
              {!row.role.isSystem && canManage ? "Bearbeiten" : "Ansehen"}
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              disabled={!canManage || !!createHint}
              title={createHint
                ? "Eine Kopie ist eine neue Rolle und braucht das Ketten-Paket."
                : canManage
                  ? undefined
                  : "Dafür fehlt dir das Recht, Rollen zu verwalten."}
              onclick={() => copy(row.role)}
            >
              Kopieren
            </button>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              disabled={row.role.isSystem || !canManage}
              title={row.role.isSystem
                ? "Systemrollen können nicht gelöscht werden."
                : canManage
                  ? undefined
                  : "Dafür fehlt dir das Recht, Rollen zu verwalten."}
              onclick={() => askDelete(row.role)}
            >
              Löschen
            </button>
          </span>
        {/if}
      {/snippet}
    </DataTable>
  </section>

  {#if draft}
    <RoleEditor
      bind:draft
      {groups}
      locked={lockReason !== null}
      {lockReason}
      {saving}
      {isSystem}
      canCopy={canManage && !createHint}
      {errorText}
      onSubmit={save}
      onDiscard={discard}
      onClose={requestClose}
      onCopy={selectedRole ? () => selectedRole && copy(selectedRole) : undefined}
    />
  {/if}
{/if}

<ConfirmDialog
  bind:open={fourEyesOpen}
  title="Vier-Augen-Prinzip bestätigen"
  description={fourEyesMessage}
  confirmLabel="Zusammenstellung bestätigen"
  cancelLabel="Abbrechen"
  onConfirm={confirmFourEyes}
  onCancel={() => (pendingWrite = null)}
/>

<ConfirmDialog
  bind:open={deleteOpen}
  title="Rolle löschen"
  description={deleteTarget
    ? `Die Rolle „${deleteTarget.name}“ wird gelöscht. Die Änderung wird protokolliert.`
    : ""}
  confirmLabel="Löschen"
  danger
  onConfirm={confirmDelete}
/>

<ConfirmDialog
  bind:open={discardOpen}
  title="Änderungen verwerfen?"
  description="Die geöffnete Rolle hat ungespeicherte Änderungen."
  confirmLabel="Verwerfen"
  onConfirm={() => {
    const select = pendingSelection;
    pendingSelection = null;
    select?.();
  }}
  onCancel={() => (pendingSelection = null)}
/>

<style>
  .roles-bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--s-3);
  }
  .roles-actions {
    display: inline-flex;
    justify-content: flex-end;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
</style>
