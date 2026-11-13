<script lang="ts">
  // Phase 378 (#378), since #844: every Team page is guarded by its own route-table permission (RouteGuard) —
  // Heute im Salon by team-overview:read, Zeiten by time-entry:read, Abwesenheiten by leave-request:read — not by
  // one combined OR. A UX convenience, not the security boundary; that stays server-side per endpoint.
  import RouteGuard from "$lib/components/layout/RouteGuard.svelte";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();
</script>

<RouteGuard>{@render children?.()}</RouteGuard>
