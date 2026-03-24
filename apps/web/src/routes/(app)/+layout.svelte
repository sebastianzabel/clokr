<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  onMount(() => {
    if (!$authStore.accessToken) {
      goto("/login");
    }
  });

  async function handleLogout() {
    try {
      if ($authStore.refreshToken) {
        await api.post("/auth/logout", { refreshToken: $authStore.refreshToken });
      }
    } catch {
      // continue regardless
    } finally {
      authStore.logout();
      goto("/login");
    }
  }

  let isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));

  let navItems = $derived([
    { href: "/dashboard",        icon: "🏠",  label: "Dashboard",      show: true },
    { href: "/time-entries",     icon: "🕐",  label: "Zeiterfassung",  show: true },
    { href: "/leave",            icon: "🌴",  label: "Abwesenheiten",  show: true },
    { href: "/reports",          icon: "📊",  label: "Berichte",       show: true },
    { href: "/admin",            icon: "⚙️",  label: "Admin",          show: isManager },
  ].filter(i => i.show));

  let pathname = $derived($page.url.pathname);

  function isActive(href: string): boolean {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(href + "/");
  }
</script>

{#if $authStore.accessToken}
  <div class="app-shell">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">✂️</span>
        <span class="brand-name">Zeiterfassung</span>
      </div>

      <nav class="sidebar-nav" aria-label="Hauptnavigation">
        {#each navItems as item}
          {@const active = item.href === "/dashboard"
            ? $page.url.pathname === "/dashboard"
            : $page.url.pathname === item.href || $page.url.pathname.startsWith(item.href + "/")}
          <a
            href={item.href}
            class="nav-item"
            class:nav-item--active={active}
            aria-current={active ? "page" : undefined}
          >
            <span class="nav-icon">{item.icon}</span>
            <span class="nav-label">{item.label}</span>
          </a>
        {/each}

      </nav>

      <div class="sidebar-footer">
        {#if $authStore.user}
          <div class="sidebar-user">
            <div class="sidebar-user-avatar" aria-hidden="true">
              {($authStore.user.email[0] ?? "?").toUpperCase()}
            </div>
            <div class="sidebar-user-info">
              <p class="sidebar-user-email">{$authStore.user.email}</p>
              <p class="sidebar-user-role">
                {#if $authStore.user.role === "ADMIN"}Administrator
                {:else if $authStore.user.role === "MANAGER"}Manager
                {:else}Mitarbeiter{/if}
              </p>
            </div>
          </div>
        {/if}
        <button class="btn btn-ghost btn-sm logout-btn" onclick={handleLogout} aria-label="Abmelden">
          Abmelden
        </button>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="app-main">
      {@render children?.()}
    </main>

    <!-- Mobile Bottom Nav -->
    <nav class="mobile-nav" aria-label="Mobile Navigation">
      {#each navItems as item}
        {@const active = item.href === "/dashboard"
          ? $page.url.pathname === "/dashboard"
          : $page.url.pathname === item.href || $page.url.pathname.startsWith(item.href + "/")}
        <a
          href={item.href}
          class="mobile-nav-item"
          class:mobile-nav-item--active={active}
          aria-current={active ? "page" : undefined}
        >
          <span class="mobile-nav-icon">{item.icon}</span>
          <span class="mobile-nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>
  </div>
{/if}

<style>
  /* ── Shell ─────────────────────────────────────────────────────────── */
  .app-shell {
    display: flex;
    min-height: 100vh;
    background-color: var(--color-bg);
  }

  /* ── Sidebar ───────────────────────────────────────────────────────── */
  .sidebar {
    width: 240px;
    min-width: 240px;
    background-color: var(--sidebar-bg, #fff);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    z-index: 100;
    overflow-y: auto;
  }

  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 1.25rem 1.25rem 1rem;
    border-bottom: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
  }

  .brand-icon {
    font-size: 1.375rem;
    line-height: 1;
  }

  .brand-name {
    font-size: 1rem;
    font-weight: 700;
    color: var(--color-brand);
    letter-spacing: -0.01em;
  }

  /* ── Nav ───────────────────────────────────────────────────────────── */
  .sidebar-nav {
    flex: 1;
    padding: 0.75rem 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-muted);
    text-decoration: none;
    border-left: 3px solid transparent;
    transition: background-color 0.12s, color 0.12s;
    position: relative;
  }

  .nav-item:hover:not(.nav-item--disabled):not(.nav-item--active) {
    background-color: var(--color-bg-subtle);
    color: var(--color-text);
  }

  .nav-item--active {
    background-color: var(--color-brand-tint);
    color: var(--color-brand);
    border-left-color: var(--color-brand);
  }

  .nav-icon {
    font-size: 1.125rem;
    flex-shrink: 0;
    width: 1.25rem;
    text-align: center;
  }

  .nav-label {
    flex: 1;
  }

  /* ── Sidebar Footer ────────────────────────────────────────────────── */
  .sidebar-footer {
    padding: 0.875rem 1rem;
    border-top: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
  }

  .sidebar-user-avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background-color: var(--color-brand-tint);
    color: var(--color-brand);
    font-size: 0.8125rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .sidebar-user-info {
    min-width: 0;
  }

  .sidebar-user-email {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-user-role {
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .logout-btn {
    width: 100%;
    justify-content: center;
    font-size: 0.8125rem;
  }

  /* ── Main Content ──────────────────────────────────────────────────── */
  .app-main {
    flex: 1;
    margin-left: 240px;
    padding: 2rem;
    min-height: 100vh;
    min-width: 0;
    max-width: 1600px;
    padding-bottom: 5rem; /* space for mobile nav */
  }

  /* ── Mobile Bottom Nav ─────────────────────────────────────────────── */
  .mobile-nav {
    display: none;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--sidebar-bg, #fff);
    border-top: 1px solid var(--color-border);
    z-index: 100;
    padding: 0.25rem 0;
  }

  .mobile-nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.5rem 0.25rem;
    text-decoration: none;
    color: var(--color-text-muted);
    font-size: 0.65rem;
    font-weight: 500;
    transition: color 0.12s;
  }

  .mobile-nav-item--active {
    color: var(--color-brand);
  }

  .mobile-nav-icon {
    font-size: 1.25rem;
    line-height: 1;
  }

  .mobile-nav-label {
    line-height: 1;
  }

  @media (max-width: 768px) {
    .sidebar {
      display: none;
    }

    .app-main {
      margin-left: 0;
      padding: 1.25rem 1rem;
    }

    .mobile-nav {
      display: flex;
    }
  }
</style>
