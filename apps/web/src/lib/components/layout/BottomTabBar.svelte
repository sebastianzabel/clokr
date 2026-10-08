<script lang="ts">
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { visibleTeamNavItems } from "$lib/nav/team-nav";
  import { activeNavHref } from "$lib/nav/active-route";
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
    { href: "/leave", label: "Abwesenheiten", icon: "umbrella" },
  ];

  // Mehr-sheet content, Phase 378 (#378): the Team items themselves and which permission gates
  // each one moved to $lib/nav/team-nav.ts (visibleTeamNavItems, shared with Sidebar.svelte) —
  // filtered per-item by permission, so a Salonmanager or Ausbilder (Salon-/Personen-Scope role
  // assignment, #76) sees exactly the items their permissions allow, same as the desktop nav.
  // "Mein Profil" is appended after the team items for every actor that has any (mirrors the old
  // `managerMore`'s trailing settings entry byte-for-byte); an actor with none falls back to the
  // plain employee overflow (Verfügbarkeit + Mein Profil).
  // NOTE: "Berichte" intentionally absent for a plain Mitarbeiter — the /reports page is
  // reachable for EMPLOYEEs via direct URL (EMP-06 personal monthly closes), but neither
  // Systemrollen-Template without `report:read:ZUGEWIESEN` gets a nav entry for it either.

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

  // moreItems is reactive to the caller's PERMISSIONS (Phase 378, #378) for the team items, and
  // to `role` only for the `/admin/*` items (out of this issue's scope, #83 owns that UI — same
  // documented exception as Sidebar.svelte's admin sub-groups); server-side permission guards
  // still enforce actual authorization on every protected route.
  //
  // Verfügbarkeits-System (Phase 47.3): the /availability entry is hidden
  // when the tenant feature flag is off. Fail-open while the store is loading.
  const moreItems = $derived.by((): NavItem[] => {
    const role = $authStore.user?.role; // ADMIN-only /admin/* items gate — see comment above
    const availabilityOn = $tenantFeatures.availabilityEnabled;
    const teamItems = visibleTeamNavItems($authStore.user);
    const settingsItem: NavItem = { href: "/settings", label: "Mein Profil", icon: "settings" };
    const base: NavItem[] =
      teamItems.length > 0
        ? role === "ADMIN"
          ? [...teamItems, settingsItem, ...adminMore]
          : [...teamItems, settingsItem]
        : [{ href: "/availability", label: "Verfügbarkeit", icon: "calendar-check" }, settingsItem];
    return availabilityOn ? base : base.filter((it) => it.href !== "/availability");
  });

  let sheetOpen = $state(false);

  // One decision for the whole bar (shared rule, $lib/nav/active-route): at most one item is
  // current, whether it is a primary tab or an overflow item behind "Mehr".
  const currentHref = $derived(
    activeNavHref(
      [...primaryTabs, ...moreItems].map((it) => it.href),
      currentPath,
    ),
  );
  // The overflow item that is the current page, if any — it is held by the "Mehr" trigger.
  const moreCurrent = $derived(moreItems.find((it) => it.href === currentHref) ?? null);
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
    {@const active = tab.href === currentHref}
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

  <!--
    The trigger holds the current page when it lives behind "Mehr": aria-current="true" ("the
    current item within a set", ARIA 1.2) — it is not the page itself, the link in the sheet keeps
    "page". Same split as the GOV.UK service navigation (group = true, page = page). Many mobile
    screen readers do not announce aria-current, so the accessible name carries the location too;
    it starts with the visible label "Mehr" (WCAG 2.5.3 Label in Name). #515
  -->
  <button
    type="button"
    class="tab"
    class:tab-active={sheetOpen || moreCurrent !== null}
    aria-haspopup="dialog"
    aria-expanded={sheetOpen}
    aria-current={moreCurrent ? "true" : undefined}
    aria-label={moreCurrent ? `Mehr, aktuelle Seite: ${moreCurrent.label}` : "Mehr"}
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
    position: relative;
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

  /* The current item is marked by more than colour (WCAG 1.4.1): a brand bar and a heavier label,
     the same recipe as the desktop sidebar's .nav-item.active::before (Sidebar.svelte) and the
     global .view-tab--active (app.css). The tint above stays; the bar carries the meaning. */
  .tab[aria-current]::before {
    content: "";
    position: absolute;
    top: 0;
    left: 30%;
    right: 30%;
    height: 2px;
    background: var(--brand);
    border-radius: 0 0 1px 1px;
  }

  .tab[aria-current] .tab-label {
    font-weight: 600;
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
