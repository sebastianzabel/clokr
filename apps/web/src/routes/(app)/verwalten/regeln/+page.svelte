<!-- Issue #844: hub page of the route table entry /verwalten/regeln (its children are listed by HubPage). -->
<script lang="ts">
  import HubPage from "$lib/components/layout/HubPage.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
</script>

<svelte:head>
  <title>{pageLabel("/verwalten/regeln")} – Clokr</title>
</svelte:head>

<HubPage
  title={pageLabel("/verwalten/regeln")}
  hub="/verwalten/regeln"
  sub="Die Vorgaben für Urlaub, Betriebsurlaub, Urlaubsgrenzen und Schichten."
/>
