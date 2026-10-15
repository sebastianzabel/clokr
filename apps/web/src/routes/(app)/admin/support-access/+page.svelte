<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";
  import SectionStack from "$lib/components/admin/SectionStack.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SupportAccessList from "$lib/components/admin/SupportAccessList.svelte";
  import type { SupportAccessItem, SupportAccessListResponse } from "$lib/support-access/labels";

  let items: SupportAccessItem[] = $state([]);
  let total = $state(0);
  let timezone = $state("Europe/Berlin");
  // Starts TRUE: onMount fires the request after the first paint, and a false start would flash
  // the empty state before any request had been made.
  let loading = $state(true);
  let loadError = $state("");
  let page = $state(1);
  let pageSize = $state(25);

  onMount(() => {
    void load();
  });

  async function load() {
    loading = true;
    loadError = "";
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
      const res = await api.get<SupportAccessListResponse>(`/support-accesses?${params}`);
      items = res.items;
      total = res.total;
      timezone = res.timezone;
    } catch {
      loadError = "Die Support-Zugriffe konnten nicht geladen werden.";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Support-Zugriffe – Clokr</title>
</svelte:head>

<SectionStack
  eyebrow="Compliance"
  title="Support-Zugriffe"
  sub="Zugriffe des Betreibers auf Ihre Daten"
  animate
>
  <Section title="Zugriffe" sub="Neueste zuerst">
    <SupportAccessList
      {items}
      {total}
      {timezone}
      {loading}
      {loadError}
      bind:page
      bind:pageSize
      onPageChange={() => void load()}
      onRetry={() => void load()}
    />
  </Section>
</SectionStack>
