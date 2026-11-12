<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { visibleAbwesenheitenTabs, type AbwesenheitenConfig } from "$lib/settings/abwesenheiten";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import BetriebsurlaubPanel from "$lib/components/admin/abwesenheiten/BetriebsurlaubPanel.svelte";
  import SonderurlaubPanel from "$lib/components/admin/abwesenheiten/SonderurlaubPanel.svelte";
  import UebertragPanel from "$lib/components/admin/abwesenheiten/UebertragPanel.svelte";
  import UrlaubPanel from "$lib/components/admin/abwesenheiten/UrlaubPanel.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Note from "$components/ui/Note.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";

  // ── Tabs (D-854-26: lowercase German ids; Urlaubsgrenzen joins in plan 854-13) ──
  // The page merges sections of two old pages, so each tab is offered under the alternatives of its own
  // sections (D-854-05, T-854-30).
  const user = $derived($authStore.user);
  const visibleTabs = $derived(visibleAbwesenheitenTabs(user));
  const visibleTabIds = $derived(visibleTabs.map((tab) => tab.value as string));
  // The settings tabs read `GET /settings/work`; a person who holds only the shutdown permission must not
  // trigger it (and see an error page).
  const showSettings = $derived(visibleTabs.some((tab) => tab.usesConfig));
  let activeTab = $state<string>("");

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
    activeTab = visibleTabIds.length > 0 ? tabFromHash($page.url.hash, visibleTabIds) : "";
    if (showSettings) void loadConfig();
    else loading = false;
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
  sub="Urlaub, Sonderurlaub, Übertrag und Betriebsurlaub für das ganze Unternehmen."
/>

{#if visibleTabs.length === 0}
  <div role="alert">
    <Note tone="bad">Du hast keine Berechtigung für die Einstellungen der Abwesenheiten.</Note>
  </div>
{:else if error}
  <ErrorState message={error} onRetry={loadConfig} retrying={loading} />
{:else if loading}
  <Skeleton shape="card" count={2} lines={3} />
{:else}
  <PageTabs
    tabs={visibleTabs.map(({ value, label }) => ({ value, label }))}
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
      {:else if value === "betriebsurlaub"}
        <BetriebsurlaubPanel active={activeTab === "betriebsurlaub"} />
      {/if}
    {/snippet}
  </PageTabs>
{/if}
