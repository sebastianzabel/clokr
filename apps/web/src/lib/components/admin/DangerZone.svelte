<!--
  DangerZone — Standalone red-tinted card for destructive actions.

  Adopts GitHub's Danger Zone pattern. Thin wrapper around
  <Section tone="danger"> with a default title and required actions snippet.

  Place as the LAST child in a SectionStack or as the LAST tab panel in a ListDetail.
  Callers wire ConfirmDialog (ui/ConfirmDialog.svelte) or a type-to-confirm input
  around each destructive action — DangerZone does NOT compose ConfirmDialog itself.

  Props:
    title       — section title (default: "Danger Zone")
    description — muted sub below title
    animate     — opt-in card-animate entrance
    actions     — destructive action buttons + confirmation flows (required snippet)

  Example:
    <DangerZone description="Irreversible Aktionen für diesen Mandanten.">
      {#snippet actions()}
        <button class="btn btn-danger" onclick={confirmDelete}>
          Daten zurücksetzen
        </button>
      {/snippet}
    </DangerZone>
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import Section from "./Section.svelte";

  interface Props {
    title?: string;
    description?: string;
    animate?: boolean;
    actions: Snippet;
  }

  let {
    title = "Danger Zone",
    description,
    animate,
    actions,
  }: Props = $props();
</script>

<Section
  tone="danger"
  title={title}
  sub={description}
  animate={animate}
>
  <div class="danger-actions">
    {@render actions()}
  </div>
</Section>

<style>
  .danger-actions {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding-top: var(--s-3);
  }
</style>
