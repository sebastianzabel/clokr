<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { visibleIntegrationenTabs } from "$lib/settings/integrationen";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import ApiKeysPanel from "$lib/components/admin/integrationen/ApiKeysPanel.svelte";
  import PresenceSourcesPanel from "$lib/components/admin/integrationen/PresenceSourcesPanel.svelte";
  import TerminalsPanel from "$lib/components/admin/integrationen/TerminalsPanel.svelte";
  import Note from "$components/ui/Note.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";

  // ── Tabs (D-854-26: lowercase German ids) ──
  // The page merges sections of two old pages (the integrations page and System), so each tab is offered under
  // the alternatives of its own section (D-854-05, T-854-35).
  const user = $derived($authStore.user);
  const visibleTabs = $derived(visibleIntegrationenTabs(user));
  const visibleTabIds = $derived(visibleTabs.map((tab) => tab.value as string));
  let activeTab = $state<string>("");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  // Issue #83 (D-13): access is decided by the admin layout guard (admin-route-permissions.ts); the API
  // answers 403 regardless. Each panel loads its own data the first time its tab is shown.
  onMount(() => {
    activeTab = visibleTabIds.length > 0 ? tabFromHash($page.url.hash, visibleTabIds) : "";
    // Forced, so a freshly booked module shows without waiting for the navigation throttle (Issue #566).
    void salonContext.load($authStore.user?.id ?? null, { force: true });
  });
</script>

<svelte:head><title>{pageLabel("/admin/integrations")} – Clokr</title></svelte:head>

<PageHead
  title={pageLabel("/admin/integrations")}
  sub="WLAN-Anwesenheit, NFC-Terminals und API-Schlüssel für das ganze Unternehmen."
/>

{#if visibleTabs.length === 0}
  <div role="alert">
    <Note tone="bad">Du hast keine Berechtigung für die Integrationen.</Note>
  </div>
{:else}
  <PageTabs
    tabs={visibleTabs.map(({ value, label }) => ({ value, label }))}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche der Integrationen"
  >
    {#snippet panel(value)}
      {#if value === "wlan"}
        <PresenceSourcesPanel active={activeTab === "wlan"} />
      {:else if value === "terminals"}
        <TerminalsPanel active={activeTab === "terminals"} />
      {:else if value === "schluessel"}
        <ApiKeysPanel active={activeTab === "schluessel"} />
      {/if}
    {/snippet}
  </PageTabs>
{/if}
