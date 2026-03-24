<script lang="ts">
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  onMount(() => {
    const role = $authStore.user?.role ?? "";
    if (!["ADMIN", "MANAGER"].includes(role)) {
      goto("/dashboard");
    }
  });

  const isAdmin = $derived($authStore.user?.role === "ADMIN");

  const tabs = $derived([
    { href: "/admin/employees", label: "Mitarbeiter",    show: true },
    { href: "/admin/vacation",  label: "Urlaub & Zeiten",show: true },
    { href: "/admin/shutdowns", label: "Betriebsurlaub", show: true },
    { href: "/admin/system",    label: "System",         show: true },
    { href: "/admin/audit",     label: "Audit Log",      show: isAdmin },
  ].filter(t => t.show));

  let pathname = $derived($page.url.pathname);
</script>

<div class="admin-shell">
  <div class="admin-header">
    <h1 class="admin-title">Administration</h1>
    <nav class="admin-tabs" aria-label="Admin-Navigation">
      {#each tabs as tab}
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

  .admin-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--color-border);
  }

  .admin-tab {
    padding: 0.625rem 1.25rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: color 0.12s, border-color 0.12s;
    white-space: nowrap;
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
</style>
