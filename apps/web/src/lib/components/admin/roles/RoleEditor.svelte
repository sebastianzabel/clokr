<!--
  RoleEditor — name and permissions of one role (Issue #83, D-06/D-09). Presentational: the parent
  owns the draft and every API call. A system role, or a caller without role:manage, sees every
  control visibly disabled — never hidden (AK). Labels come from the server catalog (D-02).
-->
<script lang="ts">
  import Section from "$lib/components/admin/Section.svelte";
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
    onCopy,
  }: Props = $props();

  const LOCK_TEXT = {
    system:
      "Systemrollen sind sichtbar, aber gesperrt. Kopieren Sie die Rolle, um eine eigene, änderbare Fassung anzulegen.",
    "read-only":
      "Sie können Rollen ansehen, aber nicht ändern. Dafür fehlt Ihnen das Recht, Rollen zu verwalten.",
  } as const;

  let dirty = $derived(draftDirty(draft));
  let title = $derived(
    isSystem ? "SYSTEMROLLE" : draft.roleId === null ? "NEUE ROLLE" : "ROLLE BEARBEITEN",
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

<Section {title} {dirty}>
  {#snippet actions()}
    {#if onCopy}
      <button type="button" class="btn btn-ghost btn-sm" disabled={!canCopy} onclick={onCopy}>
        Kopieren
      </button>
    {/if}
  {/snippet}
  {#snippet footer()}
    <button type="button" class="btn btn-ghost btn-sm" disabled={!dirty} onclick={onDiscard}>
      Verwerfen
    </button>
    <button
      type="submit"
      form="role-editor-form"
      class="btn btn-primary btn-sm"
      disabled={!canSave}
    >
      Speichern
    </button>
  {/snippet}

  <form id="role-editor-form" class="role-editor" onsubmit={handleSubmit}>
    {#if lockReason}
      <p class="form-hint role-editor-lock">{LOCK_TEXT[lockReason]}</p>
    {/if}
    {#if errorText}
      <div class="callout error" role="alert">{errorText}</div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="role-editor-name">Name der Rolle</label>
      <input
        id="role-editor-name"
        class="form-input"
        required
        maxlength="100"
        bind:value={draft.name}
        disabled={locked}
      />
    </div>

    {#each groups as group (group.resource)}
      <fieldset class="role-editor-group" disabled={locked}>
        <legend class="role-editor-legend">
          {group.label}
          {#if hasMandant(group)}
            <span class="chip chip-warn">wirkt nur bei Zuweisung für den ganzen Mandanten</span>
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
</Section>

<style>
  .role-editor {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .role-editor-lock {
    margin: 0;
  }
  .role-editor-group {
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 12px 16px;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 8px 16px;
  }
  .role-editor-group:disabled {
    background: var(--bg-subtle);
  }
  .role-editor-legend {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 0 6px;
    font-weight: 600;
    color: var(--text);
  }
  .role-editor-permission {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 14px;
    color: var(--text);
    min-height: 32px;
  }
  .role-editor-permission input {
    margin-top: 3px;
    accent-color: var(--brand);
  }
  .role-editor-group:disabled .role-editor-permission {
    color: var(--text-muted);
  }
</style>
