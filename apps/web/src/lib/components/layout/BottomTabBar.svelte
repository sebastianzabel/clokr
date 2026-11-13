<script lang="ts">
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { activeNavHref } from "$lib/nav/active-route";
  import { visibleNavSections, type NavSection } from "$lib/nav/app-nav";
  import { pageLabel } from "$lib/nav/page-labels";
  import { mobileTabs, navCurrentPath } from "$lib/nav/routes";
  import MobileMoreSheet from "./MobileMoreSheet.svelte";
  import Icon from "$lib/components/Icon.svelte";

  interface Props {
    currentPath: string;
  }

  let { currentPath }: Props = $props();

  type NavItem = { href: string; label: string; icon: string };

  // #844 (D-844-13): the tab-bar targets come from the route table — Salon · Aufgaben · Mein Tag · Abwesend for
  // a team reach, Mein Tag · Zeiten · Abwesend · Plan otherwise; a target the user may not open is skipped.
  // „Mehr“ is rendered as a button, not a link, so it gets its own active state from the open-sheet flag.
  const primaryTabs = $derived(
    mobileTabs($authStore.user, { availabilityEnabled: $tenantFeatures.availabilityEnabled }),
  );

  // The Mehr sheet shows the same areas as the desktop Sidebar, generated from the one navigation definition
  // ($lib/nav/app-nav, #516) - nothing is hand-listed here. The primary tabs are shortcuts to targets the sheet
  // lists as well, so every target has an entry that can be marked as the current page.
  const sections = $derived.by((): NavSection[] => {
    const nav = visibleNavSections($authStore.user, {
      availabilityEnabled: $tenantFeatures.availabilityEnabled,
    });
    // The profile page has no rail entry (desktop reaches it from the avatar menu); it stays reachable here,
    // under „Ich“, which every signed-in user has.
    const ich = nav.find((section) => section.area === "ich");
    ich?.items.push({
      href: "/ich/profil",
      label: pageLabel("/ich/profil"),
      icon: "settings",
      testId: "nav-settings",
    });
    return nav;
  });
  const moreItems = $derived(sections.flatMap((section) => section.items));
  const primaryHrefs = $derived(primaryTabs.map((tab) => tab.href));

  let sheetOpen = $state(false);

  // One decision for the whole bar (shared rule, $lib/nav/active-route): at most one item is
  // current, whether it is a primary tab or an overflow item behind "Mehr".
  const currentHref = $derived(
    activeNavHref(
      [...primaryTabs, ...moreItems].map((it) => it.href),
      navCurrentPath(currentPath),
    ),
  );
  // The overflow item that is the current page, if any - it is held by the "Mehr" trigger.
  // A primary tab keeps the mark itself, so its twin in the sheet does not count here.
  const moreCurrent = $derived(
    currentHref !== null && !primaryHrefs.includes(currentHref)
      ? (moreItems.find((it) => it.href === currentHref) ?? null)
      : null,
  );
</script>

{#snippet tabIcon(name: string)}
  {#if name === "more"}
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  {:else}
    <Icon {name} size={22} />
  {/if}
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

<MobileMoreSheet bind:open={sheetOpen} {sections} {currentPath} />

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
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--card);
      border-top: 1px solid var(--line);
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
    color: var(--text-2);
    text-decoration: none;
    font-family: var(--font-ui);
    cursor: pointer;
    transition:
      background 120ms var(--ease),
      color 120ms var(--ease);
  }

  .tab:hover,
  .tab:focus-visible {
    color: var(--text);
    background: var(--sunk);
  }

  .tab:focus-visible {
    outline: 2px solid var(--brand);
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
