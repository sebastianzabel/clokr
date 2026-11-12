<!--
  SettingsGroup - one settings section (Issue #854, D-854-04/D-854-15): a `.settings-group` with a
  sentence-case h2, an optional description, the section's fields and its own SaveBar.

  The group owns no state and no request. The section component that renders it keeps the snapshot
  and the values (`$lib/settings/section-state`), counts `changes`/`errors` and passes the save and
  discard handlers; the SaveBar exists only while the section has unsaved changes.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";

  interface Props {
    /** Optional anchor id of the section (`/verwalten/...#pausen`), for links from other pages. */
    id?: string;
    /** Section heading, German, sentence case. */
    title: string;
    /** One muted line below the heading. */
    description?: string;
    /** Number of unsaved changes; the SaveBar is hidden at 0. */
    changes: number;
    /** Number of invalid fields; saving is blocked while above 0. */
    errors: number;
    saving?: boolean;
    /** What the save does ("Pausen speichern"), never a bare "Speichern". */
    saveLabel: string;
    onSave: () => void;
    onDiscard: () => void;
    children: Snippet;
  }

  let {
    id,
    title,
    description,
    changes,
    errors,
    saving = false,
    saveLabel,
    onSave,
    onDiscard,
    children,
  }: Props = $props();

  const uid = $props.id();
  const titleId = `${uid}-title`;
</script>

<section class="settings-group" {id} aria-labelledby={titleId}>
  <h2 class="settings-group-title" id={titleId}>{title}</h2>
  {#if description}
    <p class="settings-group-desc">{description}</p>
  {/if}
  <div class="sg-fields">
    {@render children()}
  </div>
  <SaveBar {changes} {errors} {saving} {saveLabel} {onSave} {onDiscard} />
</section>

<style>
  .sg-fields {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    max-width: 44rem;
    min-width: 0;
  }
</style>
