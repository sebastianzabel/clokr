<!--
  RoleEditor - name and permissions of one role in a wide Dialog (Issue #83, D-06/D-09; rebuilt on the
  blocks of #843 in Issue #854). Presentational: the parent owns the draft and every API call. A system
  role, or a caller without role:manage, sees every control visibly disabled - never hidden (AK).
  Labels come from the server catalog (D-02). The 409 four-eyes answer (code
  FOUR_EYES_CONFIRMATION_REQUIRED, #78) is handled by the parent: it opens its ConfirmDialog above this
  one and resends with `confirm: true`; every other refusal arrives here as `errorText`.

  The dialog is controlled: every way of closing (Escape, a click on the scrim, "Schließen") only calls
  `onClose`, and the parent decides whether the draft may go (a dirty draft asks first).
-->
<script lang="ts">
  import Chip from "$components/ui/Chip.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import type { PermissionCatalogGroup } from "$lib/api/roles";
  import { draftDirty, type RoleDraft } from "./role-draft";

  interface Props {
    draft: RoleDraft;
    groups: PermissionCatalogGroup[];
    locked: boolean;
    lockReason: "system" | "read-only" | null;
    saving: boolean;
    isSystem: boolean;
    canCopy: boolean;
    errorText: string | null;
    onSubmit: () => void;
    onDiscard: () => void;
    /** A request to close the dialog (Escape, scrim, "Schließen"); the parent may refuse it. */
    onClose: () => void;
    onCopy?: () => void;
  }

  let {
    draft = $bindable(),
    groups,
    locked,
    lockReason,
    saving,
    isSystem,
    canCopy,
    errorText,
    onSubmit,
    onDiscard,
    onClose,
    onCopy,
  }: Props = $props();

  const LOCK_TEXT = {
    system:
      "Systemrollen sind sichtbar, aber gesperrt. Kopier die Rolle, um eine eigene, änderbare Fassung anzulegen.",
    "read-only":
      "Du kannst Rollen ansehen, aber nicht ändern. Dafür fehlt dir das Recht, Rollen zu verwalten.",
  } as const;

  let dirty = $derived(draftDirty(draft));
  let title = $derived(
    isSystem ? "Systemrolle" : draft.roleId === null ? "Neue Rolle anlegen" : "Rolle bearbeiten",
  );
  let canSave = $derived(!locked && !saving && dirty && draft.name.trim().length > 0);

  function toggle(key: string, checked: boolean) {
    const without = draft.permissions.filter((k) => k !== key);
    draft.permissions = checked ? [...without, key] : without;
  }

  function hasMandant(group: PermissionCatalogGroup): boolean {
    return group.permissions.some((p) => p.relation === "MANDANT");
  }

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (canSave) onSubmit();
  }
</script>

<Dialog
  bind:open={() => true, (next) => !next && onClose()}
  size="wide"
  {title}
  ariaLabel="Rollen-Editor"
>
  <form id="role-editor-form" class="role-editor" novalidate onsubmit={handleSubmit}>
    {#if dirty}
      <div><Chip tone="warn">Nicht gespeichert</Chip></div>
    {/if}
    {#if lockReason}
      <Note tone="info">{LOCK_TEXT[lockReason]}</Note>
    {/if}
    {#if errorText}
      <div role="alert"><Note tone="bad">{errorText}</Note></div>
    {/if}

    <FormField label="Name der Rolle">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          class="form-input"
          required
          maxlength="100"
          data-autofocus={locked ? undefined : ""}
          bind:value={draft.name}
          disabled={locked}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={describedBy}
        />
      {/snippet}
    </FormField>

    {#each groups as group (group.resource)}
      <fieldset class="role-editor-group" disabled={locked}>
        <legend class="role-editor-legend">
          {group.label}
          {#if hasMandant(group)}
            <Chip tone="warn">wirkt nur bei Zuweisung für das ganze Unternehmen</Chip>
          {/if}
        </legend>
        {#each group.permissions as permission (permission.key)}
          <label class="role-editor-permission">
            <input
              type="checkbox"
              value={permission.key}
              checked={draft.permissions.includes(permission.key)}
              onchange={(event) => toggle(permission.key, event.currentTarget.checked)}
            />
            <span>{permission.label}</span>
          </label>
        {/each}
      </fieldset>
    {/each}
  </form>

  {#snippet footer()}
    {#if onCopy}
      <button type="button" class="btn btn-ghost" disabled={!canCopy} onclick={onCopy}>
        Kopieren
      </button>
    {/if}
    <button type="button" class="btn btn-ghost" disabled={!dirty} onclick={onDiscard}>
      Verwerfen
    </button>
    <button type="button" class="btn btn-secondary" onclick={onClose}>Schließen</button>
    <button type="submit" form="role-editor-form" class="btn btn-primary" disabled={!canSave}>
      Speichern
    </button>
  {/snippet}
</Dialog>

<style>
  .role-editor {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .role-editor-group {
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: var(--s-3) var(--s-4);
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--s-2) var(--s-4);
  }
  .role-editor-group:disabled {
    background: var(--sunk);
  }
  .role-editor-legend {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    padding: 0 var(--s-1);
    font-weight: 600;
    color: var(--text);
  }
  .role-editor-permission {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    font-size: var(--fs-base);
    color: var(--text);
    min-height: 32px;
  }
  .role-editor-permission input {
    margin-top: 3px;
    accent-color: var(--brand);
  }
  .role-editor-group:disabled .role-editor-permission {
    color: var(--text-2);
  }
</style>
