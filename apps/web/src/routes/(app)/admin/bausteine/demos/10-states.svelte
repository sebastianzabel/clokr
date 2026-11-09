<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 10. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 10,
    name: "Zustände",
    entries: [
      "components/ui/Skeleton.svelte",
      "components/ui/EmptyState.svelte",
      "components/ui/ErrorState.svelte",
    ],
  };
</script>

<script lang="ts">
  import Skeleton from "$components/ui/Skeleton.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
</script>

<div data-block="10" class="states-demo">
  <div class="shapes">
    <Skeleton shape="line" count={3} />
    <Skeleton shape="block" height="4rem" />
    <Skeleton shape="row" count={2} />
    <Skeleton shape="card" lines={2} />
    <p>Heute gearbeitet: <Skeleton inline width={5} /></p>
  </div>
  <EmptyState variant="noData" />
  <EmptyState variant="noMatches" onaction={() => {}} />
  <ErrorState onRetry={() => {}} />
</div>

<style>
  .states-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .shapes {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
</style>
