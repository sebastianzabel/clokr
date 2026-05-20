<script lang="ts">
  import { authStore } from "$stores/auth";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  type NavItem = { href: string; label: string; icon: string };
  type NavSection = { label: string; items: NavItem[] };

  // German labels match docs/design/reference/i18n.js DE entries verbatim.
  // Routes map to nearest existing screens; new routes may land in Phase 30-32.
  const employeeNav: NavItem[] = [
    { href: "/dashboard", label: "Übersicht", icon: "dashboard" },
    { href: "/time-entries", label: "Zeiterfassung", icon: "clock" },
    { href: "/leave", label: "Urlaub", icon: "umbrella" },
  ];

  const managerNav: NavItem[] = [
    // v1.5 Phase 30 manager screens — replaces the prior team-page hrefs.
    // Labels match docs/design/reference/i18n.js DE entries (nav_inbox / nav_team_cal / nav_shifts).
    { href: "/inbox", label: "Anträge", icon: "inbox" },
    { href: "/team/time-entries", label: "Team-Zeiten", icon: "clock" },
    { href: "/teamcal", label: "Team-Kalender", icon: "calendar" },
    { href: "/shifts", label: "Schichtplanung", icon: "grid" },
    { href: "/reports", label: "Berichte", icon: "chart" },
  ];

  const adminNav: NavItem[] = [
    { href: "/admin/employees", label: "Mitarbeitende", icon: "users" },
    { href: "/admin/vacation", label: "Urlaub & Zeiten", icon: "umbrella" },
    { href: "/admin/special-leave", label: "Sonderurlaub", icon: "star" },
    { href: "/admin/shutdowns", label: "Betriebsurlaub", icon: "calendar" },
    { href: "/admin/shifts", label: "Schichtplan", icon: "grid" },
    { href: "/admin/monatsabschluss", label: "Monatsabschluss", icon: "lock" },
    { href: "/admin/audit", label: "Compliance & Audit", icon: "shield" },
    { href: "/admin/wifi-presence", label: "WiFi-Präsenz", icon: "wifi" },
    { href: "/admin/system", label: "System", icon: "settings" },
    { href: "/admin/themes", label: "Themes & Branding", icon: "palette" },
    { href: "/admin/import", label: "CSV Import", icon: "upload" },
    { href: "/admin/export", label: "DATEV Export", icon: "download" },
  ];

  // Section visibility is gated by the authenticated user's role.
  // Server-side `requireRole(...)` middleware still enforces authorization
  // on every protected endpoint — this is a UI-only display gate.
  const sections = $derived.by((): NavSection[] => {
    const role = $authStore.user?.role;
    const out: NavSection[] = [{ label: "Mein Bereich", items: employeeNav }];
    if (role === "MANAGER" || role === "ADMIN") {
      out.push({ label: "Team", items: managerNav });
    }
    if (role === "ADMIN") {
      out.push({ label: "Administration", items: adminNav });
    }
    return out;
  });

  function isActive(href: string, path: string): boolean {
    if (href === "/dashboard") return path === "/dashboard";
    return path === href || path.startsWith(href + "/");
  }

  async function handleLogout() {
    try {
      const state = $authStore;
      const refreshToken = state.refreshToken;
      if (refreshToken) {
        await api.post("/auth/logout", { refreshToken });
      }
    } catch {
      // swallow — local logout still proceeds
    } finally {
      authStore.logout();
      goto("/login");
    }
  }
</script>

{#snippet navIcon(name: string)}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {#if name === "dashboard"}
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    {:else if name === "clock"}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    {:else if name === "calendar"}
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    {:else if name === "umbrella"}
      <path d="M12 3v18M3 12a9 9 0 0 1 18 0H3z" />
      <path d="M9 12a3 3 0 0 1 6 0" />
      <path d="M12 21a2 2 0 0 1-2-2" />
    {:else if name === "inbox"}
      <path d="M3 13l3-9h12l3 9" />
      <path d="M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
      <path d="M3 13h5l1 3h6l1-3h5" />
    {:else if name === "users"}
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <circle cx="17" cy="9" r="2.8" />
      <path d="M16 20a5 5 0 0 1 5.5-5" />
    {:else if name === "grid"}
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    {:else if name === "chart"}
      <path d="M4 20V8M10 20V4M16 20v-7M22 20H2" />
    {:else if name === "shield"}
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    {:else if name === "download"}
      <path d="M12 3v12m0 0l-4-4m4 4l4-4" />
      <path d="M4 19h16" />
    {:else if name === "upload"}
      <path d="M12 21V9m0 0l-4 4m4-4l4 4" />
      <path d="M4 5h16" />
    {:else if name === "lock"}
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    {:else if name === "palette"}
      <path d="M12 3a9 9 0 0 0 0 18c1 0 2-.8 2-2a2 2 0 0 1 2-2h1a4 4 0 0 0 4-4 9 9 0 0 0-9-10z" />
      <circle cx="7.5" cy="10.5" r="1" />
      <circle cx="12" cy="7.5" r="1" />
      <circle cx="16.5" cy="10.5" r="1" />
    {:else if name === "star"}
      <path d="M12 2.5l3 6.2 6.8 1-4.9 4.8 1.2 6.8L12 17.9 5.9 21.3l1.2-6.8L2.2 9.7l6.8-1z" />
    {:else if name === "wifi"}
      <path d="M3 9a15 15 0 0 1 18 0" />
      <path d="M6 12.5a10 10 0 0 1 12 0" />
      <path d="M9 16a5 5 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
    {:else if name === "settings"}
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />
    {:else if name === "logout"}
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5M21 12H9" />
    {/if}
  </svg>
{/snippet}

<aside class="sidebar" aria-label="Hauptnavigation">
  <a href="/dashboard" class="sidebar-brand">
    <img class="mark" src="/clokr-icon.png" alt="" aria-hidden="true" />
    <div class="name" translate="no">clo<em>kr</em></div>
  </a>

  <div class="sidebar-scroll">
    {#each sections as section (section.label)}
      <div class="sidebar-section-label" translate="no">{section.label}</div>
      <nav class="sidebar-nav" aria-label={section.label}>
        {#each section.items as item (item.href)}
          {@const active = isActive(item.href, currentPath)}
          <a
            href={item.href}
            class="nav-item"
            class:active
            aria-current={active ? "page" : undefined}
          >
            <span class="ico" aria-hidden="true">{@render navIcon(item.icon)}</span>
            <span class="label" translate="no">{item.label}</span>
          </a>
        {/each}
      </nav>
    {/each}
  </div>

  <div class="sidebar-foot">
    {#if $authStore.user}
      <div class="avatar" aria-hidden="true">
        {($authStore.user.firstName?.[0] ?? $authStore.user.email[0] ?? "?").toUpperCase()}
      </div>
      <div class="userinfo">
        <div class="name">{$authStore.user.firstName ?? $authStore.user.email}</div>
        <div class="role">
          {#if $authStore.user.role === "ADMIN"}
            Administrator
          {:else if $authStore.user.role === "MANAGER"}
            Manager
          {:else}
            Mitarbeiter
          {/if}
        </div>
      </div>
      <button
        class="icon-btn logout"
        type="button"
        onclick={handleLogout}
        aria-label="Abmelden"
        title="Abmelden"
      >
        {@render navIcon("logout")}
      </button>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    grid-area: sidebar;
    background: var(--bg-card);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
    width: 232px;
    min-width: 232px;
    z-index: 100;
  }

  .sidebar-brand,
  .sidebar-brand:hover,
  .sidebar-brand:focus {
    padding: 22px 20px 18px;
    margin-bottom: 14px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    border: 0;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }

  .sidebar-brand .mark {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    object-fit: contain;
    display: block;
  }

  .sidebar-brand .name {
    font-family: var(--font-serif);
    font-size: 24px;
    font-weight: 500;
    letter-spacing: 0.01em;
    text-decoration: none;
  }

  .sidebar-brand .name em {
    font-style: italic;
    color: var(--brand-light);
  }

  .sidebar-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .sidebar-scroll::-webkit-scrollbar {
    width: 6px;
  }
  .sidebar-scroll::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .sidebar-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--border-strong);
  }

  .sidebar-section-label {
    padding: 18px 20px 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 600;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    padding: 4px 10px;
    gap: 1px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 9px 12px;
    border-radius: var(--r-sm);
    color: var(--text-muted);
    font-weight: 500;
    font-size: 13.5px;
    text-decoration: none;
    position: relative;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .nav-item:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }

  .nav-item.active {
    background: var(--brand-soft);
    color: var(--text);
  }

  .nav-item.active::before {
    content: "";
    position: absolute;
    left: -10px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    background: var(--brand);
    border-radius: 1px;
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }

  .nav-item .ico {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    opacity: 0.85;
  }

  .sidebar-foot {
    margin-top: auto;
    padding: 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
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
  }

  .userinfo {
    min-width: 0;
    flex: 1;
  }

  .userinfo .name {
    font-weight: 600;
    font-size: 13px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }

  .userinfo .role {
    font-size: 11.5px;
    color: var(--text-muted);
  }

  .icon-btn {
    width: 30px;
    height: 30px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    display: grid;
    place-items: center;
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

  @media (max-width: 960px) {
    .sidebar {
      display: none;
    }
  }
</style>
