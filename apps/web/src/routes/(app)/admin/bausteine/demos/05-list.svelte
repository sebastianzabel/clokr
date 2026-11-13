<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 5. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 5,
    name: "Liste",
    entries: ["components/ui/List.svelte", "components/ui/ListRow.svelte"],
  };
</script>

<script lang="ts">
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
</script>

<div data-block="5">
  <List ariaLabel="Team">
    <ListRow title="Person A" subtitle="Salon Nord">
      {#snippet trailing()}<Chip tone="ok">Genehmigt</Chip>{/snippet}
    </ListRow>
    <ListRow title="Person B" subtitle="Salon Süd">
      {#snippet trailing()}<Chip tone="warn">Offen</Chip>{/snippet}
    </ListRow>
    <ListRow title="Person C" subtitle="Salon Nord">
      {#snippet trailing()}<Chip tone="neutral">Entwurf</Chip>{/snippet}
    </ListRow>
    <ListRow
      variant="task"
      title="Urlaubsantrag 10.11.–14.11.2026"
      subtitle="Person A · Salon Nord"
    >
      {#snippet actions()}
        <button type="button" class="btn btn-secondary btn-sm">Ablehnen</button>
        <button type="button" class="btn btn-primary btn-sm">Genehmigen</button>
      {/snippet}
    </ListRow>
  </List>
</div>
