<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // ── Notifications ──────────────────────────────────────────────
  interface Notification {
    id: string;
    type: string;
    title: string;
    message: string;
    link?: string;
    read: boolean;
    createdAt: string;
  }

  let notifications: Notification[] = $state([]);
  let unreadCount = $state(0);
  let showNotifications = $state(false);
  let pollInterval: ReturnType<typeof setInterval> | undefined;

  async function loadNotifications() {
    try {
      const res = await api.get<{ notifications: Notification[]; unreadCount: number }>("/notifications");
      notifications = res.notifications;
      unreadCount = res.unreadCount;
    } catch {}
  }

  async function markRead(id: string) {
    await api.patch(`/notifications/${id}/read`, {});
    notifications = notifications.map(n => n.id === id ? { ...n, read: true } : n);
    unreadCount = Math.max(0, unreadCount - 1);
  }

  async function markAllRead() {
    await api.patch("/notifications/read-all", {});
    notifications = notifications.map(n => ({ ...n, read: true }));
    unreadCount = 0;
  }

  function handleNotificationClick(n: Notification) {
    if (!n.read) markRead(n.id);
    showNotifications = false;
    if (n.link) goto(n.link);
  }

  function formatTimeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "gerade eben";
    if (mins < 60) return `vor ${mins} Min.`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `vor ${hours} Std.`;
    const days = Math.floor(hours / 24);
    return `vor ${days} Tag${days > 1 ? "en" : ""}`;
  }

  // ── Auth & lifecycle ───────────────────────────────────────────
  onMount(() => {
    if (!$authStore.accessToken) {
      goto("/login");
      return;
    }
    loadNotifications();
    pollInterval = setInterval(loadNotifications, 60_000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // Close dropdown on outside click
  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (showNotifications && !target.closest(".notification-wrapper")) {
      showNotifications = false;
    }
  }

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
    { href: "/time-entries",     icon: "🕐",  label: "Zeiteinträge",   show: true },
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

<svelte:window onclick={handleWindowClick} />

{#if $authStore.accessToken}
  <div class="app-shell">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-icon">⏱️</span>
        <span class="brand-name">Clokr</span>
        <div class="notification-wrapper">
          <button
            class="notification-bell"
            onclick={() => { showNotifications = !showNotifications; }}
            aria-label="Benachrichtigungen"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {#if unreadCount > 0}
              <span class="notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
            {/if}
          </button>

          {#if showNotifications}
            <div class="notification-dropdown">
              <div class="notification-header">
                <span class="notification-header-title">Benachrichtigungen</span>
                {#if unreadCount > 0}
                  <button class="notification-mark-all" onclick={markAllRead}>Alle gelesen</button>
                {/if}
              </div>
              <div class="notification-list">
                {#if notifications.length === 0}
                  <p class="notification-empty">Keine Benachrichtigungen</p>
                {:else}
                  {#each notifications as n (n.id)}
                    <button
                      class="notification-item"
                      class:notification-item--unread={!n.read}
                      onclick={() => handleNotificationClick(n)}
                    >
                      <div class="notification-item-title">{n.title}</div>
                      <div class="notification-item-message">{n.message}</div>
                      <div class="notification-item-time">{formatTimeAgo(n.createdAt)}</div>
                    </button>
                  {/each}
                {/if}
              </div>
            </div>
          {/if}
        </div>
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
    flex: 1;
  }

  /* ── Notifications ──────────────────────────────────────────────── */
  .notification-wrapper {
    position: relative;
    margin-left: auto;
  }

  .notification-bell {
    position: relative;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    transition: background-color 0.12s, color 0.12s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .notification-bell:hover {
    background-color: var(--color-bg-subtle);
    color: var(--color-text);
  }

  .notification-badge {
    position: absolute;
    top: 0;
    right: 0;
    min-width: 1rem;
    height: 1rem;
    padding: 0 0.25rem;
    border-radius: 9999px;
    background-color: var(--color-danger, #ef4444);
    color: #fff;
    font-size: 0.625rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transform: translate(25%, -25%);
  }

  .notification-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    width: 320px;
    max-height: 420px;
    background: var(--sidebar-bg, #fff);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
    z-index: 200;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .notification-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
  }

  .notification-header-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .notification-mark-all {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--color-brand);
    font-weight: 500;
    padding: 0;
  }

  .notification-mark-all:hover {
    text-decoration: underline;
  }

  .notification-list {
    flex: 1;
    overflow-y: auto;
  }

  .notification-empty {
    padding: 2rem 1rem;
    text-align: center;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .notification-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--color-border-subtle);
    padding: 0.75rem 1rem;
    cursor: pointer;
    transition: background-color 0.12s;
  }

  .notification-item:hover {
    background-color: var(--color-bg-subtle);
  }

  .notification-item--unread {
    background-color: var(--color-brand-tint, rgba(59, 130, 246, 0.05));
  }

  .notification-item--unread:hover {
    background-color: var(--color-brand-tint, rgba(59, 130, 246, 0.1));
  }

  .notification-item-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 0.125rem;
  }

  .notification-item-message {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    line-height: 1.4;
    margin-bottom: 0.25rem;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .notification-item-time {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    opacity: 0.7;
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
