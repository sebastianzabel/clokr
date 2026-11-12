<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import PageHead from "$lib/components/layout/PageHead.svelte";
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
  <title>{pageLabel("/admin/support-access")} – Clokr</title>
</svelte:head>

<div data-testid="admin-support-access-page" style="display: contents;">
  <PageHead
    title={pageLabel("/admin/support-access")}
    sub="Zugriffe des Betreibers auf die Daten deines Unternehmens"
  />

  <section class="settings-group" aria-labelledby="support-access-title">
    <h2 class="settings-group-title" id="support-access-title">Zugriffe</h2>
    <p class="settings-group-desc">Neueste zuerst</p>
    <SupportAccessList
      {items}
      {total}
      {timezone}
      {loading}
      {loadError}
      bind:page
      bind:pageSize
      onOpen={(item) => void goto(`/admin/support-access/${item.id}`)}
      onPageChange={() => void load()}
      onRetry={() => void load()}
    />
  </section>
</div>
