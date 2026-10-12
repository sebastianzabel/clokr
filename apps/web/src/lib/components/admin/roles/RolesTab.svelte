<!--
  RolesTab — the „Rollen“ tab of /admin/roles (Issue #83): system and own roles, create, edit, copy,
  delete. Every rejection shows the server's German message (D-08); the four-eyes confirmation is
  server-driven (D-07). Controls a caller may not use are disabled, never hidden (D-06).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
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
  }

  let { canManage, draft = $bindable(), onReady }: Props = $props();

  let groups = $state<PermissionCatalogGroup[]>([]);
  let roles = $state<AccessRole[]>([]);
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

  function messageOf(err: unknown): string {
    if (err instanceof ApiError) return err.message;
    return "Die Anfrage ist fehlgeschlagen. Bitte versuchen Sie es erneut.";
  }

  async function reloadRoles() {
    roles = await listRoles();
  }

  onMount(async () => {
    try {
      const [catalog, list] = await Promise.all([fetchPermissionCatalog(), listRoles()]);
      groups = catalog;
      roles = list;
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
        async (role) => {
          toasts.success("Rolle angelegt");
          await reloadRoles();
          if (role) draft = draftFromRole(role);
        },
      );
    } else {
      const id = current.roleId;
      void runRoleWrite(
        (confirm) => updateRole(id, confirm ? { ...body, confirm: true } : body),
        async (role) => {
          toasts.success("Rolle gespeichert");
          await reloadRoles();
          if (role) draft = draftFromRole(role);
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
  <div class="callout error" role="alert">{loadError}</div>
{:else}
  <Section title="ROLLEN" sub="Systemrollen und die eigenen Rollen des Mandanten">
    {#snippet actions()}
      <button type="button" class="btn btn-primary btn-sm" disabled={!canManage} onclick={openNew}>
        Neue Rolle
      </button>
    {/snippet}

    {#if errorText && !draft}
      <div class="callout error" role="alert">{errorText}</div>
    {/if}

    <table class="data-table">
      <thead>
        <tr>
          <th scope="col">Rolle</th>
          <th scope="col">Art</th>
          <th scope="col">Rechte</th>
          <th scope="col"><span class="sr-only">Aktionen</span></th>
        </tr>
      </thead>
      <tbody>
        {#each roles as role (role.id)}
          <tr class:roles-row-active={draft?.roleId === role.id}>
            <td>{role.name}</td>
            <td>
              {#if role.isSystem}
                <span class="chip chip-brand">Systemrolle</span>
              {:else}
                <span class="chip">Eigene Rolle</span>
              {/if}
            </td>
            <td>{role.permissions.length} von {totalPermissions}</td>
            <td class="roles-actions">
              <button type="button" class="btn btn-ghost btn-sm" onclick={() => openRole(role)}>
                {!role.isSystem && canManage ? "Bearbeiten" : "Ansehen"}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                disabled={!canManage}
                title={canManage ? undefined : "Dafür fehlt Ihnen das Recht, Rollen zu verwalten."}
                onclick={() => copy(role)}
              >
                Kopieren
              </button>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                disabled={role.isSystem || !canManage}
                title={role.isSystem
                  ? "Systemrollen können nicht gelöscht werden."
                  : canManage
                    ? undefined
                    : "Dafür fehlt Ihnen das Recht, Rollen zu verwalten."}
                onclick={() => askDelete(role)}
              >
                Löschen
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Section>

  {#if draft}
    <RoleEditor
      bind:draft
      {groups}
      locked={lockReason !== null}
      {lockReason}
      {saving}
      {isSystem}
      canCopy={canManage}
      {errorText}
      onSubmit={save}
      onDiscard={discard}
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
  .roles-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    flex-wrap: wrap;
  }
  .roles-row-active td {
    background: var(--brand-soft);
  }
</style>
