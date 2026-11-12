<!-- Issue #844: hub page of the route table entry /verwalten/daten (its children are listed by HubPage). -->
<script lang="ts">
  import HubPage from "$lib/components/layout/HubPage.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
</script>

<svelte:head>
  <title>{pageLabel("/verwalten/daten")} – Clokr</title>
</svelte:head>

<HubPage
  title={pageLabel("/verwalten/daten")}
  hub="/verwalten/daten"
  sub="Import, Export, Protokoll und Support-Zugriffe."
/>
