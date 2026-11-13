<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 7, the bulk change preview. `entries` are relative to
  // apps/web/src/lib.
  export const block = {
    id: 7,
    name: "Formular-Satz",
    entries: ["components/ui/BulkPreviewDialog.svelte"],
  };
</script>

<script lang="ts">
  import BulkPreviewDialog from "$components/ui/BulkPreviewDialog.svelte";

  const people = ["Person A", "Person B", "Person C"];
</script>

<div data-block="7">
  <!-- The static panel: a portaled overlay would leave the frame's theme (see DialogPanel). -->
  <BulkPreviewDialog
    static
    title="Vorschau der Änderungen"
    eyebrow="Auf bestehende Verträge anwenden"
    count={people.length}
    effectiveDate="2026-12-01"
    confirmLabel="Änderungen übernehmen"
    onConfirm={() => {}}
  >
    {#snippet list()}
      <ul class="bulk-demo-list">
        {#each people as person (person)}
          <li>{person}</li>
        {/each}
      </ul>
    {/snippet}
  </BulkPreviewDialog>
</div>

<style>
  .bulk-demo-list {
    margin: 0;
    padding-left: var(--s-5);
    color: var(--text);
  }
</style>
