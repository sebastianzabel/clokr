<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { mode } from "$stores/mode";
  import { authStore } from "$stores/auth";
  import { avatarVersion } from "$stores/avatar";
  import { api } from "$api/client";
  import LanguageToggle from "$lib/components/ui/LanguageToggle.svelte";

  interface Props {
    currentPath: string;
    currentPageLabel: string;
  }

  // currentPath is part of the public API for symmetry with Sidebar; the
  // crumb itself only displays `currentPageLabel` per the design handoff.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { currentPath, currentPageLabel }: Props = $props();

  // ── Avatar dropdown ────────────────────────────────────────────
  let avatarMenuOpen = $state(false);
  let avatarSrc = $state<string | null>(null);

  $effect(() => {
    const empId = $authStore.user?.employeeId;
    const token = $authStore.accessToken;
    const cacheBust = $avatarVersion;
    if (!empId || !token) {
      avatarSrc = null;
      return;
    }

    let objectUrl: string | null = null;
    fetch(`/api/v1/avatars/${empId}?v=${cacheBust}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-cache",
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          avatarSrc = objectUrl;
        }
      })
      .catch(() => {});

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  async function handleLogout() {
    try {
      const refreshToken = $authStore.refreshToken;
      if (refreshToken) {
        await api.post("/auth/logout", { refreshToken });
      }
    } catch {
      /* swallow — local logout still proceeds */
    } finally {
      avatarMenuOpen = false;
      authStore.logout();
      goto("/login");
    }
  }

  function gotoProfile() {
    avatarMenuOpen = false;
    goto("/settings");
  }

  let roleLabel = $derived.by(() => {
    const r = $authStore.user?.role;
    if (r === "ADMIN") return "Administrator";
    if (r === "MANAGER") return "Manager";
    return "Mitarbeiter";
  });

  let displayName = $derived.by(() => {
    const u = $authStore.user;
    if (!u) return "";
    if (u.firstName) return u.firstName;
    return u.email;
  });

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
  let bellOpen = $state(false);
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
    bellOpen = false;
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

  onMount(() => {
    loadNotifications();
    pollInterval = setInterval(loadNotifications, 60_000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // ── Popover dismiss (SHELL-06) ─────────────────────────────────
  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (bellOpen && !target.closest(".bell-wrap")) {
      bellOpen = false;
    }
    if (avatarMenuOpen && !target.closest(".avatar-wrap")) {
      avatarMenuOpen = false;
    }
  }
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      bellOpen = false;
      avatarMenuOpen = false;
    }
  }

  // ── Mode toggle (SHELL-04) ─────────────────────────────────────
  function toggleMode() {
    mode.set($mode === "dark" ? "light" : "dark");
  }

  // ── Avatar initials ────────────────────────────────────────────
  let avatarInitials = $derived.by(() => {
    const u = $authStore.user;
    if (!u) return "?";
    if (u.firstName) return u.firstName[0].toUpperCase();
    return (u.email[0] ?? "?").toUpperCase();
  });
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

{#snippet iconSearch()}
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3-3" />
  </svg>
{/snippet}

{#snippet iconSun()}
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path
      d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
    />
  </svg>
{/snippet}

{#snippet iconMoon()}
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
{/snippet}

{#snippet iconBell()}
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </svg>
{/snippet}

<header class="topbar">
  <div class="topbar-actions">
    <button
      class="icon-btn"
      type="button"
      onclick={toggleMode}
      title={$mode === "dark" ? "Hellmodus" : "Dunkelmodus"}
      aria-label={$mode === "dark" ? "Hellmodus aktivieren" : "Dunkelmodus aktivieren"}
    >
      {#if $mode === "dark"}{@render iconSun()}{:else}{@render iconMoon()}{/if}
    </button>

    <div class="topbar-lang">
      <LanguageToggle variant="compact" />
    </div>

    <div class="bell-wrap">
      <button
        class="icon-btn"
        type="button"
        onclick={() => (bellOpen = !bellOpen)}
        aria-label="Benachrichtigungen"
        aria-expanded={bellOpen}
      >
        {@render iconBell()}
        {#if unreadCount > 0}<span class="dot" aria-hidden="true"></span>{/if}
      </button>
      {#if bellOpen}
        <div class="popover" role="dialog" aria-label="Benachrichtigungen">
          <div class="popover-hd">
            <b>Benachrichtigungen</b>
            {#if unreadCount > 0}
              <button type="button" class="link-btn" onclick={markAllRead}>
                Alle als gelesen
              </button>
            {/if}
          </div>
          <div class="popover-body">
            {#if notifications.length === 0}
              <div class="popover-empty">Keine neuen Benachrichtigungen</div>
            {:else}
              {#each notifications as n (n.id)}
                <button
                  type="button"
                  class="notif-item"
                  class:unread={!n.read}
                  onclick={() => handleNotificationClick(n)}
                >
                  <span class="notif-dot" class:unread-dot={!n.read} aria-hidden="true"></span>
                  <div class="notif-text">
                    <div class="notif-title">{n.title}</div>
                    <div class="notif-msg">{n.message}</div>
                    <div class="notif-time">{formatTimeAgo(n.createdAt)}</div>
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <div class="avatar-wrap">
      <button
        type="button"
        class="avatar avatar-btn"
        onclick={() => (avatarMenuOpen = !avatarMenuOpen)}
        aria-label="Persönliches Menü"
        aria-expanded={avatarMenuOpen}
      >
        {#if avatarSrc}
          <img src={avatarSrc} alt="" width="32" height="32" />
        {:else}
          <span>{avatarInitials}</span>
        {/if}
      </button>
      {#if avatarMenuOpen}
        <div class="popover avatar-menu" role="dialog" aria-label="Persönliches Menü">
          <div class="avatar-menu-hd">
            <div class="avatar avatar-menu-pic" aria-hidden="true">
              {#if avatarSrc}
                <img src={avatarSrc} alt="" width="44" height="44" />
              {:else}
                <span>{avatarInitials}</span>
              {/if}
            </div>
            <div class="avatar-menu-meta">
              <div class="avatar-menu-name">{displayName}</div>
              <div class="avatar-menu-email">{$authStore.user?.email ?? ""}</div>
              <div class="avatar-menu-role">{roleLabel}</div>
            </div>
          </div>
          <div class="avatar-menu-items">
            <button type="button" class="avatar-menu-item" onclick={gotoProfile}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span>Mein Profil</span>
            </button>
          </div>
          <div class="avatar-menu-foot">
            <button
              type="button"
              class="avatar-menu-item avatar-menu-logout"
              onclick={handleLogout}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>Abmelden</span>
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</header>

<style>
  .topbar {
    grid-area: topbar;
    background: var(--bg-card);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    padding: 0 24px;
    gap: 18px;
    position: sticky;
    top: 0;
    /* 1000 beats card-animate transform stacking contexts (those sit at default z-index
       within the page flow; 1000 ensures both bell and avatar popovers paint above them) */
    z-index: 1000;
    height: 60px;
    min-height: 60px;
  }
  .topbar-crumb {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 18px;
    color: var(--text-muted);
    font-weight: 400;
  }
  .topbar-crumb b {
    font-family: var(--font-sans);
    font-style: normal;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    margin-left: 10px;
  }
  .topbar-search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 6px 10px;
    width: 280px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .topbar-search input {
    background: transparent;
    border: 0;
    outline: 0;
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 13px;
  }
  .topbar-search input::placeholder {
    color: var(--text-muted);
  }
  .topbar-search .kbd {
    font-size: 11px;
    letter-spacing: 0.05em;
    color: var(--text-faint);
  }
  .topbar-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .icon-btn {
    width: 36px;
    height: 36px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    display: grid;
    place-items: center;
    position: relative;
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }
  .icon-btn:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }
  .icon-btn:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  /* Mobile touch target — WCAG 2.5.5 minimum 44×44 */
  @media (max-width: 640px) {
    .icon-btn {
      width: 44px;
      height: 44px;
    }
  }
  .topbar-lang {
    display: inline-flex;
    align-items: center;
  }
  .icon-btn .dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--brand);
    border: 2px solid var(--bg-card);
  }
  .bell-wrap {
    position: relative;
  }
  .popover {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: 340px;
    max-height: 420px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
    z-index: 300;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: fadeUp 200ms var(--ease-out);
  }
  .popover-hd {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text);
  }
  .link-btn {
    background: none;
    border: 0;
    color: var(--brand);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    font-family: var(--font-sans);
  }
  .link-btn:hover {
    text-decoration: underline;
  }
  .popover-body {
    flex: 1;
    overflow-y: auto;
  }
  .popover-empty {
    padding: 20px;
    text-align: center;
    font-size: 13px;
    color: var(--text-muted);
  }
  .notif-item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    text-align: left;
    padding: 12px 16px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    font-family: var(--font-sans);
    transition: background 120ms var(--ease);
  }
  .notif-item:hover {
    background: var(--bg-subtle);
  }
  .notif-item.unread {
    background: var(--brand-soft);
  }
  .notif-item.unread:hover {
    background: var(--brand-soft);
  }
  .notif-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: transparent;
    margin-top: 6px;
    flex-shrink: 0;
  }
  .notif-dot.unread-dot {
    background: var(--brand);
  }
  .notif-text {
    min-width: 0;
    flex: 1;
  }
  .notif-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .notif-msg {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .notif-time {
    font-size: 11.5px;
    color: var(--text-faint);
    margin-top: 2px;
  }
  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--brand-soft);
    color: var(--brand);
    display: grid;
    place-items: center;
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* ── Avatar dropdown menu (SHELL-07 — v1.5 popover) ─────────── */
  .avatar-wrap {
    position: relative;
  }
  .avatar-btn {
    border: 1px solid transparent;
    padding: 0;
    cursor: pointer;
    transition:
      border-color 120ms var(--ease),
      box-shadow 120ms var(--ease);
  }
  .avatar-btn:hover {
    border-color: var(--brand-light);
  }
  .avatar-btn:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  .avatar-btn[aria-expanded="true"] {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px var(--brand-soft);
  }
  .avatar-menu {
    width: 280px;
  }
  .avatar-menu-hd {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }
  .avatar-menu-pic {
    width: 44px;
    height: 44px;
    font-size: 15px;
    flex-shrink: 0;
  }
  .avatar-menu-meta {
    min-width: 0;
    flex: 1;
  }
  .avatar-menu-name {
    font-family: var(--font-serif);
    font-size: 16px;
    font-weight: 400;
    color: var(--text);
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .avatar-menu-email {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .avatar-menu-role {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--brand-light);
    margin-top: 4px;
  }
  .avatar-menu-items {
    display: flex;
    flex-direction: column;
    padding: 6px 0;
  }
  .avatar-menu-foot {
    border-top: 1px solid var(--border);
    padding: 6px 0;
  }
  .avatar-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 9px 16px;
    font-family: var(--font-sans);
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text);
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }
  .avatar-menu-item:hover:not(:disabled) {
    background: var(--bg-subtle);
    color: var(--brand);
  }
  .avatar-menu-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .avatar-menu-item svg {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .avatar-menu-item:hover:not(:disabled) svg {
    color: var(--brand);
  }
  .avatar-menu-logout {
    color: var(--bad);
  }
  .avatar-menu-logout svg {
    color: var(--bad);
  }
  .avatar-menu-logout:hover:not(:disabled),
  .avatar-menu-logout:hover:not(:disabled) svg {
    color: var(--bad);
    background: var(--bad-soft);
  }

  @media (max-width: 960px) {
    .topbar-search {
      display: none;
    }
    .topbar-crumb {
      font-size: 16px;
    }
  }
  @media (max-width: 720px) {
    .topbar-lang {
      display: none;
    }
    .topbar {
      padding: 0 12px;
    }
  }
</style>
