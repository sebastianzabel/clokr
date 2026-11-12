<!--
  Verwalten › System › Phorest (Issue #854, D-854-03): the connection to Phorest, the mapping of its staff and
  the shift sync, rebuilt in place on the blocks of #843. The page is a settings page: a status strip, then the
  connection with its own SaveBar (`lib/settings/settings-pages.ts`, section `phorest-verbindung`).

  The panel owns the form and the requests; the page owns the shared status the strip shows and sums the unsaved
  counts into ONE `markUnsaved("admin-phorest", …)` (a second registration under the same id would let one
  panel's cleanup disarm the other). Access is decided by the admin layout guard and the API (`integration:manage`).
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { markUnsaved } from "$stores/unsaved";
  import { emptyPhorestStatus, statusItems } from "$lib/settings/phorest";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import PhorestConnectionPanel from "$lib/components/admin/phorest/PhorestConnectionPanel.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";

  // What the status strip shows; the panels write to it as they load and save.
  let status = $state(emptyPhorestStatus());
  let connectionChanges = $state(0);

  const items = $derived(statusItems(status));

  // Gated on a loaded panel by construction: the panel counts changes only after its baseline is taken.
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

<PhorestConnectionPanel bind:status bind:changes={connectionChanges} />
