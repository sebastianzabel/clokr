<!--
  RouteGuard — Issue #83 (D-10/D-16), since #844 shared by the admin, Verwalten and Team layouts: the page
  renders only after "allow" (permissions of the route table, `admin-route-permissions.ts`); a cached session
  without a permission list waits for its refresh; everything else goes to the person's start page (Z-02).
  A UX gate only; the API answers 403 regardless.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { loadPermissionsIfMissing } from "$api/client";
  import { adminGuardDecision } from "$lib/nav/admin-route-permissions";
  import { homeHref } from "$lib/nav/routes";
  import Spinner from "$components/ui/Spinner.svelte";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  let refreshFailed = $state(false);
  const decision = $derived(
    refreshFailed ? "deny" : adminGuardDecision($authStore.user, $page.url.pathname),
  );

  $effect(() => {
    if (decision === "deny") void goto(homeHref($authStore.user), { replaceState: true });
  });

  onMount(async () => {
    const user = get(authStore).user;
    if (user && user.permissions === undefined) {
      const refreshed = await loadPermissionsIfMissing();
      if (!refreshed && get(authStore).user?.permissions === undefined) refreshFailed = true;
    }
  });
</script>

{#if decision === "allow"}
  {@render children?.()}
{:else if decision === "wait"}
  <div role="status" aria-live="polite" class="guard-wait">
    <Spinner />
    <span>Berechtigungen werden geladen …</span>
  </div>
{/if}

<style>
  .guard-wait {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 24px 0;
    color: var(--text-2);
  }
</style>
