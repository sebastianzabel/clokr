<script lang="ts">
  // Issue #844: the Verwalten hub pages are guarded like the admin pages (one route table, RouteGuard).
  import RouteGuard from "$lib/components/layout/RouteGuard.svelte";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();
</script>

<RouteGuard>{@render children?.()}</RouteGuard>
