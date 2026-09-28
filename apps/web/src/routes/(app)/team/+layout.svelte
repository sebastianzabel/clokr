<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { hasAnyPermission } from "$lib/permissions"; // Phase 378 (#378)

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // Phase 378 (#378): permission-based, not role-based — shared by /team/time-entries and
  // /team/leave, whose data sources need different permissions (`time-entry:read:ZUGEWIESEN` /
  // `leave-request:read:ZUGEWIESEN`). Both real scoped Systemrollen-Templates in scope
  // (Salonmanager, Ausbilder, #76) hold BOTH, so this combined OR-guard is a UX convenience, not
  // the security boundary — that stays server-side, unchanged, per subpage's own permission.
  onMount(() => {
    const holdsTeamReadPermission = hasAnyPermission($authStore.user, [
      "time-entry:read:ZUGEWIESEN",
      "leave-request:read:ZUGEWIESEN",
    ]);
    if (!holdsTeamReadPermission) {
      goto("/dashboard");
    }
  });
</script>

{@render children?.()}
