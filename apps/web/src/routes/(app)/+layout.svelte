<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { afterNavigate, beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { salonContext } from "$stores/salon-context";
  import { clearUnsaved, hasUnsaved } from "$stores/unsaved";
  import Sidebar from "$lib/components/layout/Sidebar.svelte";
  import Topbar from "$lib/components/layout/Topbar.svelte";
  import BottomTabBar from "$lib/components/layout/BottomTabBar.svelte";
  import CommandPalette from "$lib/components/ui/CommandPalette.svelte";
  import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
  import ErrorBoundary from "$lib/components/ui/ErrorBoundary.svelte";
  import WhatsNewPanel from "$lib/components/layout/WhatsNewPanel.svelte";
  import { hasUnreadReleaseNotes, whatsNewOpen } from "$stores/release-notes";
  import { isMobileViewport } from "$lib/utils/viewport";
  import { labelForPath } from "$lib/nav/page-labels";
  import { loginPathWithNext } from "$lib/nav/login-next";
  import { installPushNavigateListener } from "$lib/push/navigate-message";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // ── Page label: the one table in $lib/nav/page-labels (Issue #574) ──
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
      clearUnsaved(); // N-08 — a timed-out session must never be held hostage by a dirty section
      goto("/login?reason=timeout");
    }, sessionTimeoutMs);
  }

  const ACTIVITY_EVENTS = ["mousedown", "keydown", "touchstart", "scroll"] as const;

  // ── Unsaved-changes navigation guard (Phase 109, D-12 / AK-07) ──
  // beforeNavigate's callback is SYNCHRONOUS: cancel() must be decided now, so a custom dialog
  // cannot be awaited here (N-07). The guard therefore always cancels when the registry is
  // non-empty, remembers the target, and re-issues the navigation from the dialog's confirm handler.
  // It has no way to recognise a forced logout — that is why all four logout call sites clear the
  // registry themselves (N-08).
  let confirmLeaveOpen = $state(false);
  let pendingUrl = $state<string | null>(null);

  beforeNavigate((navigation) => {
    if (!hasUnsaved()) return;
    navigation.cancel();
    if (navigation.willUnload) {
      // Tab close / real browser navigation: the browser shows its own, non-customisable
      // prompt. Rendering our dialog into a page that is unloading would never be seen.
      return;
    }
    pendingUrl = navigation.to?.url.href ?? null;
    confirmLeaveOpen = true;
  });

  function discardAndLeave() {
    clearUnsaved(); // must precede the goto, or this guard would cancel its own retry
    confirmLeaveOpen = false;
    const target = pendingUrl;
    pendingUrl = null;
    if (target) void goto(target);
  }

  function keepEditing() {
    // ConfirmDialog also routes ESC and backdrop clicks here (its M-01 fix), so this is the
    // single place that has to forget the pending target.
    pendingUrl = null;
  }

  // Phase 110 (D-07/AK-07): auto-open once per session when this user has not yet acknowledged
  // the newest release baked into the running image. Fires only once — autoOpened latches — so
  // dismissing it (which writes the seen state server-side) is final for this session even if the
  // PUT fails.
  //
  // WhatsNewPanel is a non-modal drawer: it sets no `inert` on sibling nodes and does not lock
  // body scroll, so the "Einstempeln" button stays reachable in MECHANISM while it is open (N-07,
  // asserted in WhatsNewPanel.test.ts). That held on desktop but not in OUTCOME on a phone —
  // measured live at 390x844, the drawer covered 92% of the viewport width and its full height
  // directly over the button (`elementFromPoint()` on the button's centre resolved into
  // `aside.whats-new`). Below the app's mobile breakpoint (isMobileViewport(), same 960px
  // BottomTabBar.svelte/`.app` grid already use) auto-open is therefore suppressed entirely —
  // manual opening via the version-line dot (Sidebar + MobileMoreSheet) stays available at every
  // width; only the AUTOMATIC trigger yields to the primary clock-in action on a phone.
  let autoOpened = $state(false);
  $effect(() => {
    if (autoOpened) return;
    if (!$hasUnreadReleaseNotes) return;
    if (isMobileViewport()) return;
    autoOpened = true;
    whatsNewOpen.set(true);
  });

  let removePushNavigateListener: (() => void) | undefined;

  onMount(() => {
    if (!$authStore.accessToken) {
      // Issue #608 (D-20): keep the page the person was heading to through sign-in.
      goto(loginPathWithNext($page.url));
      return;
    }

    // Load session timeout from stored config (parseInt returns NaN on tamper
    // → multiplied by 60000 still NaN → `<= 0` guard disables timer safely).
    const storedTimeout = localStorage.getItem("clokr_session_timeout");
    if (storedTimeout) sessionTimeoutMs = parseInt(storedTimeout) * 60 * 1000;

    // Client error logging is installed by the ROOT layout (src/routes/+layout.svelte)
    // so the (auth) pages are covered too — see issue #149.

    // Hydrate tenant feature flags once per (app) session. Used by Sidebar +
    // BottomTabBar + admin pages to conditionally render feature-gated nav.
    // Fire-and-forget — UI shouldn't block on this; store fails open.
    void tenantFeatures.fetch();

    // Issue #82 (D-10): the tenant and salon context, forced once per mount. Fire-and-forget; the
    // store fails closed for presentation and never gates data — the server decides every request.
    void salonContext.load($authStore.user?.id ?? null, { force: true });

    // Issue #608 (review WR-05): a tapped push notification asks this window to navigate; it goes
    // through the router, so the unsaved-changes guard above applies.
    removePushNavigateListener = installPushNavigateListener((path) => goto(path));

    // Start inactivity timer
    resetInactivityTimer();
    for (const evt of ACTIVITY_EVENTS) {
      document.addEventListener(evt, resetInactivityTimer, { passive: true });
    }
  });

  // Issue #82 (D-10 adaptation): the context is re-validated after in-app navigation — throttled by
  // the store, so options appear or vanish at a later page change without a reload. `/admin/salons`
  // itself forces a reload after every successful write (Issue #563), so it never waits for this
  // throttle. The initial mount is covered by onMount.
  afterNavigate((navigation) => {
    if (navigation.from === null || !$authStore.accessToken) return;
    void salonContext.load($authStore.user?.id ?? null);
  });

  onDestroy(() => {
    removePushNavigateListener?.();
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
        <ErrorBoundary scope="view">
          {@render children?.()}
        </ErrorBoundary>
      </div>
    </main>
    <BottomTabBar {currentPath} />
  </div>
  <CommandPalette />
  <ConfirmDialog
    bind:open={confirmLeaveOpen}
    title="Ungespeicherte Änderungen verwerfen?"
    description="Auf dieser Seite gibt es Änderungen, die noch nicht gespeichert wurden. Wenn du die Seite verlässt, gehen sie verloren."
    confirmLabel="Verwerfen und verlassen"
    cancelLabel="Auf der Seite bleiben"
    danger
    onConfirm={discardAndLeave}
    onCancel={keepEditing}
  />
  <WhatsNewPanel />
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
