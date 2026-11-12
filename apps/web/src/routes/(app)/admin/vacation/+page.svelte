<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { markUnsaved } from "$stores/unsaved";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import type { AbwesenheitenConfig } from "$lib/settings/abwesenheiten";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SonderurlaubPanel from "$lib/components/admin/abwesenheiten/SonderurlaubPanel.svelte";
  import UebertragPanel from "$lib/components/admin/abwesenheiten/UebertragPanel.svelte";
  import UrlaubPanel from "$lib/components/admin/abwesenheiten/UrlaubPanel.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  // ── Tabs (D-854-26: lowercase German ids; Betriebsurlaub and Urlaubsgrenzen join in plans 854-12/13) ──
  const TABS = [
    { value: "urlaub", label: "Urlaub" },
    { value: "sonderurlaub", label: "Sonderurlaub" },
    { value: "uebertrag", label: "Übertrag" },
  ];
  const TAB_IDS = TABS.map((tab) => tab.value);
  let activeTab = $state<string>("urlaub");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  let config = $state<AbwesenheitenConfig>({});
  let loading = $state(true);
  let error = $state("");

  async function loadConfig() {
    loading = true;
    error = "";
    try {
      config = await api.get<AbwesenheitenConfig>("/settings/work");
      snapshotsReady = true;
    } catch (e: unknown) {
      console.error(e);
      error = "Die Einstellungen konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  // Issue #83 (D-13): access is decided by the admin layout guard (admin-route-permissions.ts);
  // the API answers 403 regardless.
  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
    void loadConfig();
  });

  // The unsaved counts of the panels, summed into ONE registration (a second registration under the same id
  // would let one panel's cleanup disarm the other's).
  let urlaubChanges = $state(0);
  let uebertragChanges = $state(0);

  // Gate the registration on "the baseline has been taken" (WR-01): a failed load must not arm the
  // navigation guard on a page that shows nothing but an error.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-vacation", snapshotsReady && urlaubChanges + uebertragChanges > 0);
    return () => markUnsaved("admin-vacation", false);
  });

  // The overview figures follow what a panel just saved.
  function merge(saved: Partial<AbwesenheitenConfig>) {
    config = { ...config, ...saved };
  }
</script>

<svelte:head>
  <title>{pageLabel("/admin/vacation")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/admin/vacation")}
  sub="Urlaub, Sonderurlaub und Übertrag für das ganze Unternehmen."
/>

{#if error}
  <ErrorState message={error} onRetry={loadConfig} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else}
  <PageTabs
    tabs={TABS}
    tab={activeTab}
    onTabChange={selectTab}
    tabsLabel="Bereiche der Abwesenheiten"
  >
    {#snippet panel(value)}
      {#if value === "urlaub"}
        <UrlaubPanel {config} bind:changes={urlaubChanges} onSaved={merge} />
      {:else if value === "sonderurlaub"}
        <SonderurlaubPanel active={activeTab === "sonderurlaub"} />
      {:else if value === "uebertrag"}
        <UebertragPanel {config} bind:changes={uebertragChanges} onSaved={merge} />
      {/if}
    {/snippet}
  </PageTabs>
{/if}
