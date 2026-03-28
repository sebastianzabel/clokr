<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  import { clientLogger } from "$lib/utils/logger";
  import CommandPalette from "$lib/components/ui/CommandPalette.svelte";
  interface Props {
    children?: import("svelte").Snippet;
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
      const res = await api.get<{ notifications: Notification[]; unreadCount: number }>(
        "/notifications",
      );
      notifications = res.notifications;
      unreadCount = res.unreadCount;
    } catch (err) {
      console.error("Failed to load notifications:", err);
    }
  }

  async function markRead(id: string) {
    await api.patch(`/notifications/${id}/read`, {});
    notifications = notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
    unreadCount = Math.max(0, unreadCount - 1);
  }

  async function markAllRead() {
    await api.patch("/notifications/read-all", {});
    notifications = notifications.map((n) => ({ ...n, read: true }));
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
  // ── Inactivity timeout ───────────────────────────────────────────
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionTimeoutMs = 60 * 60 * 1000; // Default 60min, updated from login response

  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (sessionTimeoutMs <= 0) return; // 0 = disabled
    inactivityTimer = setTimeout(() => {
      authStore.logout();
      goto("/login?reason=timeout");
    }, sessionTimeoutMs);
  }

  const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "scroll"] as const;

  onMount(() => {
    if (!$authStore.accessToken) {
      goto("/login");
      return;
    }

    // Load session timeout from stored config
    const storedTimeout = localStorage.getItem("clokr_session_timeout");
    if (storedTimeout) sessionTimeoutMs = parseInt(storedTimeout) * 60 * 1000;

    // Install client error logging
    clientLogger.install();

    // Start inactivity timer
    resetInactivityTimer();
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, resetInactivityTimer, { passive: true });
    }

    loadNotifications();
    pollInterval = setInterval(loadNotifications, 60_000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (typeof document !== "undefined") {
      for (const evt of ACTIVITY_EVENTS) {
        document.removeEventListener(evt, resetInactivityTimer);
      }
    }
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

  let navItems = $derived(
    [
      { href: "/dashboard", icon: "home", label: "Dashboard", show: true },
      { href: "/time-entries", icon: "clock", label: "Zeiterfassung", show: true },
      { href: "/leave", icon: "calendar-off", label: "Abwesenheiten", show: true },
      { href: "/reports", icon: "bar-chart-3", label: "Berichte", show: true },
      { href: "/admin", icon: "settings", label: "Admin", show: isManager },
    ].filter((i) => i.show),
  );

  let pathname = $derived($page.url.pathname);

  function isActive(href: string): boolean {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(href + "/");
  }
</script>

{#snippet navSvgIcon(name: string, size?: number)}
  {@const s = size ?? 18}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={s}
    height={s}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {#if name === "home"}
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    {:else if name === "clock"}
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    {:else if name === "calendar-off"}
      <path d="M4.18 4.18A2 2 0 0 0 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.82-1.18" />
      <path d="M21 15.5V6a2 2 0 0 0-2-2H9.5" />
      <path d="M16 2v4" />
      <path d="M3 10h7" />
      <path d="M21 10h-5.5" />
      <line x1="2" x2="22" y1="2" y2="22" />
    {:else if name === "bar-chart-3"}
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    {:else if name === "settings"}
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      />
      <circle cx="12" cy="12" r="3" />
    {/if}
  </svg>
{/snippet}

<svelte:window
  onclick={handleWindowClick}
  onkeydown={(e) => {
    if (e.key === "Escape") showNotifications = false;
  }}
/>

{#if $authStore.accessToken}
  <div class="app-shell">
    <a href="#main-content" class="skip-to-content">Zum Inhalt springen</a>
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-logo-block">
          <img src="/clokr-icon.png" alt="Clokr" class="brand-icon-img" />
          <span class="brand-name">Clokr</span>
        </div>
        <div class="notification-wrapper">
          <button
            class="notification-bell"
            onclick={() => {
              showNotifications = !showNotifications;
            }}
            aria-label="Benachrichtigungen"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
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
                      {#if n.link}
                        <svg
                          class="notification-arrow"
                          xmlns="http://www.w3.org/2000/svg"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg
                        >
                      {/if}
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
          {@const active =
            item.href === "/dashboard"
              ? $page.url.pathname === "/dashboard"
              : $page.url.pathname === item.href || $page.url.pathname.startsWith(item.href + "/")}
          <a
            href={item.href}
            class="nav-item"
            class:nav-item--active={active}
            aria-current={active ? "page" : undefined}
          >
            <span class="nav-icon">{@render navSvgIcon(item.icon)}</span>
            <span class="nav-label">{item.label}</span>
          </a>
        {/each}
      </nav>

      <div class="sidebar-footer">
        {#if $authStore.user}
          <a href="/settings" class="sidebar-user">
            {#if $authStore.user.employeeId}
              <img
                src="/api/v1/avatars/{$authStore.user.employeeId}"
                alt=""
                class="sidebar-user-avatar-img"
                onerror={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  if (e.target instanceof HTMLElement && e.target.nextElementSibling)
                    (e.target.nextElementSibling as HTMLElement).style.display = "flex";
                }}
              />
            {/if}
            <div
              class="sidebar-user-avatar"
              aria-hidden="true"
              style={$authStore.user.employeeId ? "display:none" : ""}
            >
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
          </a>
        {/if}
        <div class="sidebar-footer-actions">
          <button
            class="btn btn-ghost btn-sm logout-btn"
            onclick={handleLogout}
            aria-label="Abmelden"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline
                points="16 17 21 12 16 7"
              /><line x1="21" y1="12" x2="9" y2="12" /></svg
            >
            Abmelden
          </button>
        </div>
        <p class="sidebar-version">v{__APP_VERSION__}</p>
      </div>
    </aside>

    <!-- Mobile Header -->
    <header class="mobile-header">
      <div class="mobile-header-brand">
        <img src="/clokr-icon.png" alt="Clokr" class="mobile-header-icon" />
        <span class="mobile-header-name">Clokr</span>
      </div>
      <div class="notification-wrapper">
        <button
          class="notification-bell"
          onclick={() => {
            showNotifications = !showNotifications;
          }}
          aria-label="Benachrichtigungen"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {#if unreadCount > 0}
            <span class="notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
          {/if}
        </button>

        {#if showNotifications}
          <div class="notification-dropdown notification-dropdown--mobile">
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
    </header>

    <!-- Main Content -->
    <main class="app-main" id="main-content">
      {@render children?.()}
    </main>

    <!-- Mobile Bottom Nav -->
    <nav class="mobile-nav" aria-label="Mobile Navigation">
      {#each navItems as item}
        {@const active =
          item.href === "/dashboard"
            ? $page.url.pathname === "/dashboard"
            : $page.url.pathname === item.href || $page.url.pathname.startsWith(item.href + "/")}
        <a
          href={item.href}
          class="mobile-nav-item"
          class:mobile-nav-item--active={active}
          aria-current={active ? "page" : undefined}
        >
          <span class="mobile-nav-icon">{@render navSvgIcon(item.icon, 20)}</span>
          <span class="mobile-nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>

    <CommandPalette />
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
    background-color: var(--glass-bg-strong, var(--sidebar-bg));
    backdrop-filter: blur(var(--glass-blur, 16px));
    -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
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
    position: relative;
    display: flex;
    justify-content: center;
    padding: 1.5rem 1.25rem 1rem;
    border-bottom: 1px solid var(--color-border-subtle);
    flex-shrink: 0;
  }

  .brand-logo-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
  }

  .brand-icon-img {
    width: 52px;
    height: 52px;
    border-radius: 12px;
    flex-shrink: 0;
  }

  .brand-name {
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--color-brand);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* ── Notifications ──────────────────────────────────────────────── */
  .notification-wrapper {
    position: absolute;
    top: 1.25rem;
    right: 1rem;
  }

  .notification-bell {
    position: relative;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
    transition:
      background-color 0.12s,
      color 0.12s;
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
    position: fixed;
    top: 3.5rem;
    left: 240px;
    width: 340px;
    max-height: 420px;
    background: var(--glass-bg-strong, var(--color-surface));
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
    z-index: 300;
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
    padding: 0.75rem 2rem 0.75rem 1rem;
    cursor: pointer;
    transition: background-color 0.12s;
    position: relative;
  }

  .notification-arrow {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    opacity: 0;
    color: var(--color-text-muted);
    transition: opacity 0.15s;
  }

  .notification-item:hover .notification-arrow {
    opacity: 0.6;
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
    transition:
      background-color 0.12s,
      color 0.12s;
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
    flex-shrink: 0;
    width: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: inherit;
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

  .sidebar-version {
    font-size: 0.6875rem;
    color: var(--color-text-muted);
    text-align: center;
    margin: 0;
    opacity: 0.6;
  }

  .sidebar-user {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    text-decoration: none;
    color: inherit;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-sm);
    transition: background 0.15s;
    cursor: pointer;
  }
  .sidebar-user:hover {
    background: var(--color-bg-subtle);
  }

  .sidebar-user-avatar-img {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
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

  .sidebar-footer-actions {
    margin-top: 0.5rem;
  }

  .logout-btn {
    width: 100%;
    justify-content: center;
    font-size: 0.8125rem;
    gap: 0.4rem;
    border: 1px solid var(--color-border);
    background-color: var(--color-bg-subtle);
    color: var(--color-text-muted);
  }

  .logout-btn:hover {
    background-color: var(--color-red-bg);
    border-color: var(--color-red-border);
    color: var(--color-red);
  }

  /* ── Main Content ──────────────────────────────────────────────────── */
  .app-main {
    flex: 1;
    margin-left: 240px;
    padding: 2rem;
    min-height: 100vh;
    min-width: 0;
    padding-bottom: 5rem; /* space for mobile nav */
  }

  /* ── Mobile Bottom Nav ─────────────────────────────────────────────── */
  .mobile-nav {
    display: none;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--glass-bg-strong, var(--sidebar-bg));
    backdrop-filter: blur(var(--glass-blur, 16px));
    -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
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
    font-weight: 600;
    position: relative;
  }

  .mobile-nav-item--active::before {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 1.5rem;
    height: 3px;
    border-radius: 0 0 3px 3px;
    background-color: var(--color-brand);
  }

  .mobile-nav-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .mobile-nav-label {
    line-height: 1;
  }

  /* ── Mobile Header ────────────────────────────────────────────────── */
  .mobile-header {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 3.25rem;
    background: var(--glass-bg-strong, var(--sidebar-bg));
    backdrop-filter: blur(var(--glass-blur, 16px));
    -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
    border-bottom: 1px solid var(--color-border);
    z-index: 100;
    padding: 0 1rem;
    align-items: center;
    justify-content: space-between;
  }

  .mobile-header-brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mobile-header-icon {
    width: 28px;
    height: 28px;
    border-radius: 6px;
  }

  .mobile-header-name {
    font-size: 0.9375rem;
    font-weight: 700;
    color: var(--color-brand);
  }

  .notification-dropdown--mobile {
    position: fixed;
    top: 3.25rem;
    left: 0.5rem;
    right: 0.5rem;
    width: auto;
    max-height: 60vh;
  }

  @media (max-width: 768px) {
    .mobile-header {
      display: flex;
    }

    .sidebar {
      display: none;
    }

    .app-main {
      margin-left: 0;
      padding: 4.5rem 1rem 5rem;
    }

    .mobile-nav {
      display: flex;
    }
  }
</style>
