<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { clientLogger } from "$lib/utils/logger";
  import Sidebar from "$lib/components/layout/Sidebar.svelte";
  import Topbar from "$lib/components/layout/Topbar.svelte";
  import BottomTabBar from "$lib/components/layout/BottomTabBar.svelte";
  import CommandPalette from "$lib/components/ui/CommandPalette.svelte";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // ── Page label mapping (longest-prefix match) ──────────────────
  // German labels match docs/design/reference/i18n.js DE entries verbatim.
  const PAGE_LABELS: Record<string, string> = {
    "/dashboard": "Übersicht",
    "/time-entries": "Zeiterfassung",
    "/leave": "Urlaub",
    "/reports": "Berichte",
    // v1.5 Phase 30 manager screens — primary nav targets.
    "/inbox": "Anträge",
    "/teamcal": "Team-Kalender",
    "/shifts": "Schichtplanung",
    // Pre-v1.5 team pages kept for direct-link compatibility (no longer in nav).
    "/team/leave": "Team-Anträge",
    "/team/time-entries": "Team-Zeiten",
    "/admin/employees": "Mitarbeitende",
    "/admin/month-close": "Monatsabschluss",
    "/admin/audit": "Compliance & Audit",
    "/admin/themes": "Branding & Themes",
    "/admin/import": "CSV Import",
    "/admin/export": "DATEV Export",
    "/admin/shifts": "Schichtplanung",
    "/admin/system": "Allgemein",
    // /admin/wifi-presence 301-redirects to /admin/integrations (Phase 52 rename)
    "/admin/wifi-presence": "Integrationen",
    "/admin/integrations": "Integrationen",
    "/admin/shutdowns": "Betriebsurlaub",
    "/admin/special-leave": "Sonderurlaub",
    "/admin/vacation": "Urlaub",
    "/admin": "Administration",
    "/settings": "Mein Profil",
  };
  // Longest-prefix match (sort descending by length) so '/admin/employees' wins over '/admin'.
  const SORTED_PREFIXES = Object.keys(PAGE_LABELS).sort((a, b) => b.length - a.length);

  function labelForPath(path: string): string {
    for (const prefix of SORTED_PREFIXES) {
      if (path === prefix || path.startsWith(prefix + "/")) return PAGE_LABELS[prefix];
    }
    return "";
  }

  let currentPath = $derived($page.url.pathname);
  let currentPageLabel = $derived(labelForPath(currentPath));

  // ── Inactivity timer ───────────────────────────────────────────
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

    // Load session timeout from stored config (parseInt returns NaN on tamper
    // → multiplied by 60000 still NaN → `<= 0` guard disables timer safely).
    const storedTimeout = localStorage.getItem("clokr_session_timeout");
    if (storedTimeout) sessionTimeoutMs = parseInt(storedTimeout) * 60 * 1000;

    // Install client error logging
    clientLogger.install();

    // Hydrate tenant feature flags once per (app) session. Used by Sidebar +
    // BottomTabBar + admin pages to conditionally render feature-gated nav.
    // Fire-and-forget — UI shouldn't block on this; store fails open.
    void tenantFeatures.fetch();

    // Start inactivity timer
    resetInactivityTimer();
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, resetInactivityTimer, { passive: true });
    }
  });

  onDestroy(() => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (typeof document !== "undefined") {
      for (const evt of ACTIVITY_EVENTS) {
        document.removeEventListener(evt, resetInactivityTimer);
      }
    }
  });
</script>

{#if $authStore.accessToken}
  <div class="app">
    <a href="#main-content" class="skip-to-content">Zum Inhalt springen</a>
    <Sidebar {currentPath} />
    <Topbar {currentPath} {currentPageLabel} />
    <main class="main" id="main-content">
      <div class="page-fade">
        {@render children?.()}
      </div>
    </main>
    <BottomTabBar {currentPath} />
  </div>
  <CommandPalette />
{/if}

<style>
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    grid-template-rows: var(--topbar-h) 1fr;
    grid-template-areas:
      "sidebar topbar"
      "sidebar main";
    min-height: 100vh;
    background: var(--bg);
  }

  .main {
    grid-area: main;
    padding: 28px 32px 60px;
    max-width: 1400px;
    width: 100%;
    min-width: 0;
  }

  .page-fade {
    animation: fadeUp 400ms var(--ease-out);
  }

  /* Skip-to-content link (preserve a11y; positioned off-screen until focused) */
  .skip-to-content {
    position: absolute;
    top: -40px;
    left: 8px;
    padding: 8px 12px;
    background: var(--brand);
    color: white;
    text-decoration: none;
    border-radius: var(--r-sm);
    z-index: 1000;
    transition: top 120ms var(--ease);
  }

  .skip-to-content:focus {
    top: 8px;
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }

  @media (max-width: 960px) {
    .app {
      grid-template-columns: 1fr;
      grid-template-rows: var(--topbar-h) 1fr;
      grid-template-areas:
        "topbar"
        "main";
    }

    /* Bottom-tab-bar clearance: BottomTabBar is fixed and ~62px tall (incl.
       gap + safe-area). 80px padding keeps the last card / form fully visible
       above the bar. The bar itself adds env(safe-area-inset-bottom) so a
       gesture-nav iPhone doesn't double-stack the inset. */
    .main {
      padding: 16px 16px 80px;
    }
  }
</style>
