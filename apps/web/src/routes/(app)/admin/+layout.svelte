<script lang="ts">
  import { authStore } from "$stores/auth";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  onMount(() => {
    const role = $authStore.user?.role ?? "";
    if (!["ADMIN", "MANAGER"].includes(role)) {
      goto("/dashboard");
    }
  });
</script>

<div class="admin-shell">
  <div class="admin-content">
    {@render children?.()}
  </div>
</div>

<style>
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
