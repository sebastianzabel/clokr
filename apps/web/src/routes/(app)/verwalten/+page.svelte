<!-- Issue #844: hub page of the route table entry /verwalten (its children are listed by HubPage). -->
<script lang="ts">
  import HubPage from "$lib/components/layout/HubPage.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
</script>

<svelte:head>
  <title>{pageLabel("/verwalten")} – Clokr</title>
</svelte:head>

<HubPage
  title={pageLabel("/verwalten")}
  hub="/verwalten"
  sub="Alles, was du für den Betrieb einrichtest und pflegst."
/>
