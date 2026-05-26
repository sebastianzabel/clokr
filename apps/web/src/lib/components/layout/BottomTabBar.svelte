<script lang="ts">
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import MobileMoreSheet from "./MobileMoreSheet.svelte";

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  type NavItem = { href: string; label: string; icon: string };

  // The four primary tabs visible to every authenticated user.
  // Labels match Sidebar.svelte (employeeNav) verbatim — DE only, never translated.
  // The fourth slot ("Mehr") is rendered as a button, not a link, so it gets
  // its own active state derived from the open-sheet flag.
  const primaryTabs: NavItem[] = [
    { href: "/dashboard", label: "Übersicht", icon: "dashboard" },
    { href: "/time-entries", label: "Zeit", icon: "clock" },
    { href: "/leave", label: "Urlaub", icon: "umbrella" },
  ];

  // Mehr-sheet content per role — mirrors Sidebar.svelte sections exactly.
  // EMPLOYEE: just the items NOT already in the 3 primary tabs.
  // MANAGER:  EMPLOYEE overflow + all team items.
  // ADMIN:    MANAGER overflow + all admin items.
  // NOTE: "Berichte" intentionally NOT in employeeMore — the /reports page
  // is reachable for EMPLOYEEs via direct URL (EMP-06 personal monthly closes),
  // but per Sidebar IA Berichte is exposed in nav only to MANAGER+. Keep
  // mobile + desktop in sync.
  const employeeMore: NavItem[] = [
    { href: "/availability", label: "Verfügbarkeit", icon: "calendar-check" },
    { href: "/settings", label: "Mein Profil", icon: "settings" },
  ];

  const managerMore: NavItem[] = [
    { href: "/inbox", label: "Anträge", icon: "inbox" },
    { href: "/team/time-entries", label: "Team-Zeiten", icon: "clock" },
    { href: "/teamcal", label: "Team-Kalender", icon: "calendar" },
    { href: "/shifts", label: "Schichtplanung", icon: "grid" },
    { href: "/reports", label: "Berichte", icon: "chart" },
    { href: "/settings", label: "Mein Profil", icon: "settings" },
  ];

  // adminMore: flat list for mobile (12 entries). Group restructure deferred to ADMIN-MIG-14
  // (v2 backlog) — mobile users see the same flat list as today.
  const adminMore: NavItem[] = [
    { href: "/admin/employees", label: "Mitarbeitende", icon: "users" },
    { href: "/admin/vacation", label: "Urlaubsverwaltung", icon: "umbrella" },
    { href: "/admin/special-leave", label: "Sonderurlaubs-Typen", icon: "star" },
    { href: "/admin/shutdowns", label: "Betriebsurlaub", icon: "calendar" },
    { href: "/admin/shifts", label: "Schichtplan", icon: "grid" },
    { href: "/admin/month-close", label: "Monatsabschluss", icon: "lock" },
    { href: "/admin/audit", label: "Audit & Log", icon: "shield" },
    { href: "/admin/integrations", label: "Integrationen", icon: "wifi" },
    { href: "/admin/system", label: "Allgemein", icon: "settings" },
    { href: "/admin/themes", label: "Branding & Themes", icon: "palette" },
    { href: "/admin/import", label: "CSV Import", icon: "upload" },
    { href: "/admin/export", label: "DATEV Export", icon: "download" },
  ];

  // moreItems is reactive to the user role; server-side requireRole(...)
  // still enforces actual authorization on every protected route.
  //
  // Verfügbarkeits-System (Phase 47.3): the /availability entry is hidden
  // when the tenant feature flag is off. Fail-open while the store is loading.
  const moreItems = $derived.by((): NavItem[] => {
    const role = $authStore.user?.role;
    const availabilityOn = $tenantFeatures.availabilityEnabled;
    const base =
      role === "ADMIN"
        ? [...managerMore, ...adminMore]
        : role === "MANAGER"
          ? managerMore
          : employeeMore;
    return availabilityOn ? base : base.filter((it) => it.href !== "/availability");
  });

  let sheetOpen = $state(false);

  function isActive(href: string, path: string): boolean {
    if (href === "/dashboard") return path === "/dashboard";
    return path === href || path.startsWith(href + "/");
  }

  // The "Mehr" tab itself is considered active when the current path
  // matches any of its overflow items — gives visual continuity when
  // a user is sitting on (say) /admin/audit.
  const moreActive = $derived(!sheetOpen && moreItems.some((it) => isActive(it.href, currentPath)));
</script>

{#snippet tabIcon(name: string)}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if name === "dashboard"}
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    {:else if name === "clock"}
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    {:else if name === "umbrella"}
      <path d="M12 3v18M3 12a9 9 0 0 1 18 0H3z" />
      <path d="M9 12a3 3 0 0 1 6 0" />
      <path d="M12 21a2 2 0 0 1-2-2" />
    {:else if name === "more"}
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    {/if}
  </svg>
{/snippet}

<nav class="bottom-tab-bar" aria-label="Hauptnavigation (mobil)">
  {#each primaryTabs as tab (tab.href)}
    {@const active = isActive(tab.href, currentPath)}
    <a
      href={tab.href}
      class="tab"
      class:tab-active={active}
      aria-current={active ? "page" : undefined}
    >
      <span class="tab-icon" aria-hidden="true">{@render tabIcon(tab.icon)}</span>
      <span class="tab-label" translate="no">{tab.label}</span>
    </a>
  {/each}

  <button
    type="button"
    class="tab"
    class:tab-active={sheetOpen || moreActive}
    aria-haspopup="dialog"
    aria-expanded={sheetOpen}
    aria-label="Weitere Navigation öffnen"
    onclick={() => (sheetOpen = true)}
  >
    <span class="tab-icon" aria-hidden="true">{@render tabIcon("more")}</span>
    <span class="tab-label" translate="no">Mehr</span>
  </button>
</nav>

<MobileMoreSheet bind:open={sheetOpen} items={moreItems} {currentPath} />

<style>
  /* ── Bottom tab bar (UI-15) ───────────────────────────────────
     Fixed at viewport bottom on <960px. Above 960px the desktop sidebar
     handles nav, so the whole bar is display:none. */
  .bottom-tab-bar {
    display: none;
  }

  @media (max-width: 960px) {
    .bottom-tab-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      z-index: 90;
      padding-bottom: env(safe-area-inset-bottom, 0);
    }
  }

  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    /* WCAG 2.5.5 — min 44×44 touch target. 56px gives generous comfort. */
    min-height: 56px;
    padding: 6px 4px;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    text-decoration: none;
    font-family: var(--font-sans);
    cursor: pointer;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .tab:hover,
  .tab:focus-visible {
    color: var(--text);
    background: var(--bg-subtle);
  }

  .tab:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: -2px;
  }

  .tab-active {
    color: var(--brand);
    background: var(--brand-soft);
  }

  .tab-icon {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
  }

  .tab-label {
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.01em;
    line-height: 1;
  }
</style>
