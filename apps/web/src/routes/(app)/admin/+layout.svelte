<script lang="ts">
  // Issue #83 (D-10/D-16): the admin area is guarded by permission through the one route map —
  // children render only after "allow", a cached session without a permission list waits for its
  // refresh, everything else redirects. A UX gate only; the API answers 403 regardless.
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { loadPermissionsIfMissing } from "$api/client";
  import { adminGuardDecision } from "$lib/nav/admin-route-permissions";
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
    if (decision === "deny") void goto("/dashboard", { replaceState: true });
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
  <div class="admin-shell">
    <div class="admin-content">
      {@render children?.()}
    </div>
  </div>
{:else if decision === "wait"}
  <div class="admin-shell">
    <div role="status" aria-live="polite" class="admin-wait">
      <Spinner />
      <span>Berechtigungen werden geladen …</span>
    </div>
  </div>
{/if}

<style>
  .admin-wait {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 24px 0;
    color: var(--text-muted);
  }

  .admin-shell {
    /* max-width inherited from .app-main (1600px) */
  }

  .admin-content {
    padding-top: 0.5rem;
  }

  /* ── Section Headers (Phase 9) — used by admin sub-pages ─────── */
  /* Apply to <h2> inside .card sections: <h2 class="section-header">Title</h2> */
  :global(.section-header) {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
</style>
