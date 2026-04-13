<script lang="ts">
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import Breadcrumb from "$lib/components/ui/Breadcrumb.svelte";
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

  const isAdmin = $derived($authStore.user?.role === "ADMIN");
  const isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));

  const tabs = $derived(
    [
      { href: "/admin/employees", label: "Mitarbeiter", show: true },
      { href: "/admin/vacation", label: "Urlaub & Zeiten", show: true },
      { href: "/admin/shifts", label: "Schichtplan", show: isManager },
      { href: "/admin/special-leave", label: "Sonderurlaub", show: true },
      { href: "/admin/shutdowns", label: "Betriebsurlaub", show: true },
      { href: "/admin/monatsabschluss", label: "Monatsabschluss", show: isManager },
      { href: "/admin/system", label: "System", show: true },
      { href: "/admin/import", label: "Import", show: isAdmin },
      { href: "/admin/audit", label: "Audit Log", show: isAdmin },
    ].filter((t) => t.show),
  );

  let pathname = $derived($page.url.pathname);
</script>

<div class="admin-shell">
  <Breadcrumb crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Admin" }]} />

  <div class="admin-header">
    <h1 class="admin-title">Administration</h1>
    <div class="admin-tabs-wrap">
      <nav class="admin-tabs" aria-label="Admin-Navigation">
        {#each tabs as tab (tab.href)}
          {@const active = pathname === tab.href || pathname.startsWith(tab.href + "/")}
          <a
            href={tab.href}
            class="admin-tab"
            class:admin-tab--active={active}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </a>
        {/each}
      </nav>
    </div>
  </div>

  <div class="admin-content">
    {@render children?.()}
  </div>
</div>

<style>
  .admin-shell {
    /* max-width inherited from .app-main (1600px) */
  }

  .admin-header {
    margin-bottom: 2rem;
  }

  .admin-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--color-text);
    margin: 0 0 1.25rem;
  }

  .admin-tabs-wrap {
    position: relative;
  }
  .admin-tabs-wrap::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    bottom: 2px;
    width: 2rem;
    background: linear-gradient(to right, transparent, var(--color-surface));
    pointer-events: none;
    z-index: 1;
  }
  .admin-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--color-border);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    padding-right: 2rem; /* Space for fade gradient */
  }

  .admin-tabs::-webkit-scrollbar {
    height: 3px;
  }
  .admin-tabs::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 3px;
  }

  .admin-tab {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition:
      color 0.12s,
      border-color 0.12s;
    white-space: nowrap;
    flex-shrink: 0;
  }

  @media (max-width: 640px) {
    .admin-tab {
      padding: 0.5rem 0.875rem;
      font-size: 0.8125rem;
    }
  }

  .admin-tab:hover:not(.admin-tab--active) {
    color: var(--color-text);
  }

  .admin-tab--active {
    color: var(--color-brand);
    border-bottom-color: var(--color-brand);
    font-weight: 600;
  }

  .admin-content {
    padding-top: 0.5rem;
  }

  @media (max-width: 640px) {
    .admin-title {
      font-size: 1.375rem;
    }

    .admin-header {
      margin-bottom: 1.25rem;
    }
  }

  /* ── Section Headers (Phase 9) — used by admin sub-pages ─────── */
  /* Apply to <h2> inside .card sections: <h2 class="section-header">Title</h2> */
  :global(.section-header) {
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin: 0 0 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--color-border-subtle);
  }
</style>
