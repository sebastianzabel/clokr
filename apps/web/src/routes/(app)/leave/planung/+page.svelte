<script lang="ts">
  /**
   * /leave/planung - the old planner URL (Issue #835), since Issue #840 (D-840-03/31) a redirect stub.
   * The planner lives in the Planung tab of `/team/leave` (a holder of the manage permission) or of
   * `/leave` (everybody else); both hosts mount `LeavePlanningPanel`. Only `salonId` and `year` are
   * carried, so the #835 notification link keeps working: the host reads the salon deep link.
   *
   * The permission hint only chooses the target page (presentation, T-840-39): both targets are
   * guarded by their pages and the API. The target is built by `planungRedirect` alone (fixed paths,
   * whitelisted parameters, T-840-38) - never from the URL.
   */
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { hasPermission } from "$lib/permissions";
  import { planungRedirect } from "$lib/leave/area-tabs";

  onMount(() =>
    goto(
      planungRedirect(
        $page.url.searchParams,
        hasPermission($authStore.user, "leave-plan:manage:ZUGEWIESEN"),
      ),
      { replaceState: true },
    ),
  );
</script>
