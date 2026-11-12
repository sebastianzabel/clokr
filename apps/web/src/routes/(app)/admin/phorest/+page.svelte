<!--
  Verwalten › System › Phorest (Issue #854, D-854-03): the connection to Phorest, the mapping of its staff and
  the shift sync, rebuilt in place on the blocks of #843. A status strip on top, then two tabs: „Verbindung“ (the
  credentials and import settings with their own SaveBar - `lib/settings/settings-pages.ts`, section
  `phorest-verbindung` - and the staff mapping) and „Abgleich“ (run the sync, last run, history).

  The panels own their forms and requests; the page owns the shared status the strip shows and sums the unsaved
  count into ONE `markUnsaved("admin-phorest", …)`. Both panels stay mounted (PageTabs keeps every panel in the
  DOM), so the strip is complete whichever tab is open. Access is decided by the admin layout guard and the API
  (`integration:manage`).
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { pageLabel } from "$lib/nav/page-labels";
  import { tabFromHash, writeTabHash } from "$lib/nav/tab-hash";
  import { markUnsaved } from "$stores/unsaved";
  import { emptyPhorestStatus, statusItems } from "$lib/settings/phorest";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import PhorestConnectionPanel from "$lib/components/admin/phorest/PhorestConnectionPanel.svelte";
  import PhorestSyncPanel from "$lib/components/admin/phorest/PhorestSyncPanel.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";

  // ── Tabs (D-854-26: lowercase German ids) ──
  const TABS = [
    { value: "verbindung", label: "Verbindung" },
    { value: "abgleich", label: "Abgleich" },
  ];
  const TAB_IDS = TABS.map((tab) => tab.value);

  let activeTab = $state("verbindung");

  function selectTab(next: string) {
    activeTab = next;
    writeTabHash(next);
  }

  onMount(() => {
    activeTab = tabFromHash($page.url.hash, TAB_IDS);
  });

  // What the status strip shows; the panels write to it as they load and save.
  let status = $state(emptyPhorestStatus());
  let connectionChanges = $state(0);
  let connection: PhorestConnectionPanel | undefined = $state();

  const items = $derived(statusItems(status));

  // Only a loaded panel counts changes, so a page that shows nothing but errors never arms the navigation guard.
  $effect(() => {
    markUnsaved("admin-phorest", connectionChanges > 0);
    return () => markUnsaved("admin-phorest", false);
  });
</script>

<svelte:head><title>{pageLabel("/admin/phorest")} – Clokr</title></svelte:head>

<PageHead
  title={pageLabel("/admin/phorest")}
  sub="Hier verbindest du Clokr mit Phorest und übernimmst die Schichten aus der Salon-Software."
/>

{#if status.configured}
  <KpiStrip {items} ariaLabel="Status der Phorest-Anbindung" />
{/if}

<PageTabs tabs={TABS} tab={activeTab} onTabChange={selectTab} tabsLabel="Bereiche von Phorest">
  {#snippet panel(value)}
    {#if value === "verbindung"}
      <PhorestConnectionPanel bind:this={connection} bind:status bind:changes={connectionChanges} />
    {:else if value === "abgleich"}
      <PhorestSyncPanel bind:status onsynced={() => connection?.reloadMapping()} />
    {/if}
  {/snippet}
</PageTabs>
