<script lang="ts">
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import Icon from "$lib/components/Icon.svelte";

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  type NavItem = { href: string; label: string; icon: string };
  // NavSection is a top-level sidebar section (e.g. "Mein Bereich", "Team") or
  // an admin sub-group (e.g. "PERSONAL", "PLANUNG"). The `isAdminGroup` flag
  // drives which label class to render.
  type NavSection = { label: string; items: NavItem[]; isAdminGroup?: boolean };
  // NavGroup represents one of the 5 uppercase-labeled admin sub-groups defined
  // in docs/ADMIN_STRUCTURE.md §1.
  type NavGroup = { label: string; items: NavItem[] };

  // German labels match docs/design/reference/i18n.js DE entries verbatim.
  // Routes map to nearest existing screens; new routes may land in Phase 30-32.
  const employeeNav: NavItem[] = [
    { href: "/dashboard", label: "Übersicht", icon: "dashboard" },
    { href: "/time-entries", label: "Zeiterfassung", icon: "clock" },
    { href: "/leave", label: "Urlaub", icon: "umbrella" },
    { href: "/availability", label: "Verfügbarkeit", icon: "calendar-check" },
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

  // 5-group admin nav per docs/ADMIN_STRUCTURE.md §1 (Phase 51 Regulatorium).
  // Labels are UPPERCASE visual-only section headers — never clickable.
  // SYSTEM group entries use Phase-52 labels: Allgemein / Branding & Themes / Integrationen.
  const adminNav: NavGroup[] = [
    {
      label: "PERSONAL",
      items: [
        { href: "/admin/employees", label: "Mitarbeitende", icon: "users" },
        // Sonderurlaubs-Typen merged into /admin/vacation as the "Sonderurlaub" tab.
        // The old route still resolves and redirects (apps/web/src/routes/(app)/admin/special-leave).
        { href: "/admin/vacation", label: "Urlaubsverwaltung", icon: "umbrella" },
        { href: "/admin/shutdowns", label: "Betriebsurlaub", icon: "calendar" },
      ],
    },
    {
      label: "PLANUNG",
      items: [
        { href: "/admin/shifts", label: "Schichtplan", icon: "grid" },
        { href: "/admin/availability", label: "Verfügbarkeit", icon: "calendar-check" },
      ],
    },
    {
      label: "COMPLIANCE",
      items: [
        { href: "/admin/month-close", label: "Monatsabschluss", icon: "lock" },
        { href: "/admin/audit", label: "Audit & Log", icon: "shield" },
      ],
    },
    {
      label: "DATEN",
      items: [
        { href: "/admin/import", label: "CSV Import", icon: "upload" },
        { href: "/admin/export", label: "DATEV Export", icon: "download" },
      ],
    },
    {
      label: "SYSTEM",
      items: [
        { href: "/admin/system", label: "Allgemein", icon: "settings" },
        { href: "/admin/themes", label: "Branding & Themes", icon: "palette" },
        { href: "/admin/integrations", label: "Integrationen", icon: "wifi" },
      ],
    },
  ];

  // Section visibility is gated by the authenticated user's role.
  // Server-side `requireRole(...)` middleware still enforces authorization
  // on every protected endpoint — this is a UI-only display gate.
  //
  // The Verfügbarkeits-System (Phase 47.3) is gated by a tenant feature flag.
  // While `$tenantFeatures.loaded === false` the flag is treated as on
  // (fail-open) so nav doesn't flash hidden→visible during initial load.
  const sections = $derived.by((): NavSection[] => {
    const role = $authStore.user?.role;
    const availabilityOn = $tenantFeatures.availabilityEnabled;
    const filterAvailability = (items: NavItem[]): NavItem[] =>
      availabilityOn
        ? items
        : items.filter((it) => it.href !== "/availability" && it.href !== "/admin/availability");

    const out: NavSection[] = [{ label: "Mein Bereich", items: filterAvailability(employeeNav) }];
    if (role === "MANAGER" || role === "ADMIN") {
      out.push({ label: "Team", items: managerNav });
    }
    if (role === "ADMIN") {
      // Expand each NavGroup into its own NavSection (isAdminGroup: true) so the
      // render loop can apply the correct label class for the 5 admin sub-groups.
      for (const group of adminNav) {
        const filtered = filterAvailability(group.items);
        if (filtered.length > 0) {
          out.push({ label: group.label, items: filtered, isAdminGroup: true });
        }
      }
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

<aside class="sidebar" aria-label="Hauptnavigation">
  <a href="/dashboard" class="sidebar-brand">
    <img class="mark" src="/clokr-icon.png" alt="" aria-hidden="true" />
    <div class="name" translate="no">clo<em>kr</em></div>
  </a>

  <div class="sidebar-scroll">
    {#each sections as section (section.label)}
      {#if section.isAdminGroup}
        <div class="nav-section-label" aria-hidden="true" translate="no">{section.label}</div>
      {:else}
        <div class="sidebar-section-label" translate="no">{section.label}</div>
      {/if}
      <nav class="sidebar-nav" aria-label={section.label}>
        {#each section.items as item (item.href)}
          {@const active = isActive(item.href, currentPath)}
          <a
            href={item.href}
            class="nav-item"
            class:active
            aria-current={active ? "page" : undefined}
          >
            <span class="ico" aria-hidden="true"><Icon name={item.icon} size={17} /></span>
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
        <Icon name="logout" size={17} />
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

  /* Admin sub-group labels (PERSONAL, PLANUNG, COMPLIANCE, DATEN, SYSTEM).
     Smaller + slightly indented to nest visually within the admin section. */
  .nav-section-label {
    font-size: 0.6875rem; /* ~11px */
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: var(--s-4) var(--s-3) var(--s-1) 20px;
    user-select: none;
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
