<script lang="ts">
  import BrandLogo from "$lib/components/brand/BrandLogo.svelte";
  import { authStore } from "$stores/auth";
  import { salonContext, roleNamesLabel } from "$stores/salon-context";
  import { tenantFeatures } from "$stores/tenant-features";
  import { versionStore, loadVersion } from "$stores/version";
  import {
    hasUnreadReleaseNotes,
    loadReleaseNotesData,
    openWhatsNew,
    whatsNewEntryLabel,
  } from "$stores/release-notes";
  import { goto } from "$app/navigation";
  import { clearUnsaved } from "$stores/unsaved";
  import { api } from "$api/client";
  import Icon from "$lib/components/Icon.svelte";
  import { visibleNavSections } from "$lib/nav/app-nav";
  import { activeNavHref } from "$lib/nav/active-route";
  import { homeHref, navCurrentPath } from "$lib/nav/routes";
  import { removeThisDevicePush } from "$lib/push/logout";
  import { onMount } from "svelte";

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  // Phase 69 (DEVOPS-V8-02): runtime version display.
  // Subscribes to the shared $versionStore (hydrated by loadVersion()) so
  // Sidebar + MobileMoreSheet stay in sync and only one network call is made.
  // Fail-silent (D-08) — no toast, no console.error.
  onMount(() => {
    loadVersion();
    // Phase 110 (D-07/D-09): the unread marker must be able to render as soon as the shell does,
    // so the notes and the seen state are hydrated here alongside the version. Both loaders are
    // single-shot and fail-silent, so calling this from two components costs one request total.
    loadReleaseNotesData();
  });

  // Sections, headings and items come from the one navigation definition ($lib/nav/app-nav),
  // the same one the mobile "Mehr" sheet renders (#516). A UI-only display gate; server-side
  // permission guards still decide every request.
  //
  // The Verfügbarkeits-System (Phase 47.3) is gated by a tenant feature flag.
  // While `$tenantFeatures.loaded === false` the flag is treated as on
  // (fail-open) so nav doesn't flash hidden→visible during initial load.
  const sections = $derived(
    visibleNavSections($authStore.user, {
      availabilityEnabled: $tenantFeatures.availabilityEnabled,
    }),
  );

  // The one current item across all sections (shared rule, longest matching href wins).
  const currentHref = $derived(
    activeNavHref(
      sections.flatMap((section) => section.items.map((item) => item.href)),
      navCurrentPath(currentPath),
    ),
  );

  async function handleLogout() {
    try {
      // Issue #608 (D-18): stop this device's pushes while the token is still valid, so a shared
      // phone does not keep notifying the previous person. Bounded and never throws.
      await removeThisDevicePush();
      const state = $authStore;
      const refreshToken = state.refreshToken;
      if (refreshToken) {
        await api.post("/auth/logout", { refreshToken });
      }
    } catch {
      // swallow — local logout still proceeds
    } finally {
      authStore.logout();
      clearUnsaved(); // N-08: the nav guard cannot tell a logout from any other navigation
      goto("/login");
    }
  }
</script>

<aside class="sidebar" aria-label="Hauptnavigation" data-testid="sidebar">
  <!-- Owner 13.11.2026: mark 40 px in a 64 px rail head (was 32 px, aligned to the header, #852) -->
  <a href={homeHref($authStore.user)} class="sidebar-brand" data-testid="sidebar-brand">
    <BrandLogo size={40} label="Clokr Zeiterfassung" />
  </a>

  <div class="sidebar-scroll">
    <!-- #844 (Z-01): one heading per area — Ich · Team · Verwalten -->
    {#each sections as section (section.area)}
      <div class="sidebar-section-label" translate="no">{section.label}</div>
      <nav class="sidebar-nav" aria-label={section.label}>
        {#each section.items as item (item.href)}
          {@const active = item.href === currentHref}
          <a
            href={item.href}
            class="nav-item"
            class:active
            aria-current={active ? "page" : undefined}
            data-testid={item.testId}
          >
            <span class="ico" aria-hidden="true"><Icon name={item.icon} size={19} /></span>
            <span class="label" translate="no">{item.label}</span>
          </a>
        {/each}
      </nav>
    {/each}
  </div>

  <div class="sidebar-foot" data-testid="sidebar-user-menu">
    {#if $authStore.user}
      <div class="avatar" aria-hidden="true">
        {($authStore.user.firstName?.[0] ?? $authStore.user.email[0] ?? "?").toUpperCase()}
      </div>
      <div class="userinfo">
        <div class="name">{$authStore.user.firstName ?? $authStore.user.email}</div>
        <div class="role">
          {roleNamesLabel($salonContext)}
        </div>
      </div>
      <button
        class="icon-btn logout"
        type="button"
        onclick={handleLogout}
        aria-label="Abmelden"
        title="Abmelden"
        data-testid="sidebar-logout"
      >
        <Icon name="logout" size={17} />
      </button>
    {/if}
  </div>

  {#if $versionStore}
    <div class="sidebar-version" aria-label="Anwendungsversion">
      <button
        type="button"
        class="version-btn"
        onclick={openWhatsNew}
        aria-label={whatsNewEntryLabel($versionStore, $hasUnreadReleaseNotes)}
        title="Was ist neu"
        data-testid="sidebar-whats-new"
      >
        <span class="version-label" translate="no">v{$versionStore}</span>
        {#if $hasUnreadReleaseNotes}
          <span class="badge badge-purple version-badge" aria-hidden="true">Neu</span>
        {/if}
      </button>
    </div>
  {/if}
</aside>

<style>
  /* #844 (D-844-11): the rail of design concept § 2 — 220 px, tinted, one heading per area */
  .sidebar {
    grid-area: sidebar;
    background: var(--rail);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    /* #844 (owner acceptance): the rail always spans the full viewport height with its own scroll, whatever
       the page length — fixed, not sticky (a sticky grid item depends on every ancestor and the browser);
       the grid column of the app layout keeps its width. */
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    height: 100vh;
    height: 100dvh;
    width: var(--sidebar-w);
    min-width: var(--sidebar-w);
    z-index: 100;
  }

  .sidebar-brand,
  .sidebar-brand:hover,
  .sidebar-brand:focus {
    /* Owner 13.11.2026: a taller rail head for the larger mark (64 px). Until then the row matched the
       header height (#852/#844); the larger logo no longer fits that line. */
    box-sizing: border-box;
    height: 64px;
    min-height: 64px;
    padding: 0 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    border: 0;
    /* the mark takes the brand colour inside BrandLogo; the wordmark is text-coloured (#852) */
    color: var(--text);
  }

  .sidebar-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
  }
  .sidebar-scroll::-webkit-scrollbar {
    width: 6px;
  }
  .sidebar-scroll::-webkit-scrollbar-thumb {
    background: var(--line);
    border-radius: 3px;
  }
  .sidebar-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--line-2);
  }

  /* Owner 13.11.2026: more air above each area heading (was 6 px) */
  .sidebar-section-label {
    padding: 20px 18px 6px;
    font-size: var(--fs-th);
    color: var(--text-3);
    font-weight: 600;
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    padding: 0 10px;
    gap: 2px;
  }

  /* Owner 13.11.2026: 36 px rows (were 30 px, #844 prototype). The longest menu (admin) now scrolls
     inside the rail at 1024×768; the rail has its own scroll. */
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 8px;
    border-radius: var(--r-control);
    color: var(--text-2);
    font-weight: 500;
    font-size: 14px;
    text-decoration: none;
    position: relative;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .nav-item:hover {
    background: var(--sunk);
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
    top: 9px;
    bottom: 9px;
    width: 2px;
    background: var(--brand);
    border-radius: 1px;
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  .nav-item .ico {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    opacity: 0.85;
  }

  .sidebar-foot {
    margin-top: auto;
    padding: 8px 14px;
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
    color: var(--text-2);
  }

  .icon-btn {
    width: 30px;
    height: 30px;
    border-radius: var(--r-control);
    border: 1px solid transparent;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-2);
    cursor: pointer;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .icon-btn:hover {
    background: var(--sunk);
    color: var(--text);
  }

  .icon-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  /* Phase 69 — runtime version display.
     Literal font-size 0.75rem per D-07 (no --text-xs token exists in tokens.css). */
  .sidebar-version {
    padding: 0 var(--s-3) var(--s-2);
    text-align: center;
  }

  /* Phase 110 (D-09): the version line is now the What's-New entry point — reset the
     button chrome so it still reads as plain text, keep a visible focus ring because it
     is now a real interactive control. */
  .version-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .version-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  .version-label {
    font-size: 0.75rem;
    color: var(--text-3);
    font-feature-settings: "tnum";
    letter-spacing: 0.02em;
  }

  /* Mirrors Topbar.svelte's .notif-dot.unread-dot idiom. */
  .version-badge {
    font-size: 10px;
    padding: 1px 6px;
  }

  /* #851: „Konto“ and the always-on „Dienstplan“ give the Inhaber 19 entries; on a short screen
     (1024×768) 28 px rows keep every one of them in view without scrolling the rail. */
  @media (max-height: 800px) {
    .nav-item {
      height: 28px;
    }
  }

  @media (max-width: 960px) {
    .sidebar {
      display: none;
    }
  }
</style>
