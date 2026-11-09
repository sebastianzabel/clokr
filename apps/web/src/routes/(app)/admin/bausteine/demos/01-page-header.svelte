<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 1. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 1,
    name: "Seitenkopf",
    entries: ["components/ui/PageHeader.svelte", "components/ui/PageTabs.svelte"],
  };
</script>

<script lang="ts">
  import PageHeader from "$components/ui/PageHeader.svelte";

  const tabs = [
    { value: "overview", label: "Übersicht" },
    { value: "requests", label: "Anträge" },
    { value: "planning", label: "Planung" },
  ];
  const sentences: Record<string, string> = {
    overview: "Hier siehst du, was diese Woche ansteht.",
    requests: "Hier warten offene Anträge auf eine Entscheidung.",
    planning: "Hier planst du die nächsten Wochen.",
  };

  let tab = $state("overview");
</script>

<div data-block="1">
  <PageHeader
    headingLevel={2}
    title="Team-Übersicht"
    subtitle="Alle Personen des Salons Nord auf einen Blick."
  >
    {#snippet actions()}
      <button type="button" class="btn btn-secondary">Exportieren</button>
      <button type="button" class="btn btn-primary">Person hinzufügen</button>
    {/snippet}
  </PageHeader>

  <PageHeader headingLevel={2} title="Urlaub und Abwesenheit" {tabs} bind:tab>
    {#snippet panel(value)}
      <p>{sentences[value]}</p>
    {/snippet}
  </PageHeader>
</div>
