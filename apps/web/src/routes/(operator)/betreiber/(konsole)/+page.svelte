<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import PageHead from "$components/layout/PageHead.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import OperatorOverview from "$lib/components/operator/OperatorOverview.svelte";
  import TenantCreateDialog from "$lib/components/operator/TenantCreateDialog.svelte";
  import TenantTable from "$lib/components/operator/TenantTable.svelte";
  import { operatorApi } from "$lib/operator/client";
  import { describeLoadError } from "$lib/operator/labels";
  import type { CreateTenantBody, OperatorDashboard, OperatorTenant } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "error";

  const LOAD_FAILED = "Mandanten konnten nicht geladen werden. Bitte erneut versuchen.";

  let tenants = $state<OperatorTenant[]>([]);
  let dashboard = $state<OperatorDashboard | null>(null);
  let loadState = $state<LoadState>("loading");
  let loadError = $state(LOAD_FAILED);
  let page = $state(1);
  let pageSize = $state(25);
  let showCreate = $state(false);

  /** `silent` keeps the current list on screen while it refreshes (after a create). */
  async function load(silent = false) {
    if (!silent) loadState = "loading";
    try {
      // The list (master data) and the dashboard (aggregates) load together; either failing is the
      // one error state, so a half-filled console never shows.
      const [list, summary] = await Promise.all([
        operatorApi.listTenants(),
        operatorApi.getDashboard(),
      ]);
      tenants = list;
      dashboard = summary;
      loadState = "ready";
    } catch (err) {
      // A 401/403 was already handled by the client (session cleared, redirect to the sign-in).
      loadError = describeLoadError(err, LOAD_FAILED);
      loadState = "error";
    }
  }

  /** Dashboard metrics of each tenant, joined to the list rows by tenant id. */
  const metrics = $derived(new Map((dashboard?.tenants ?? []).map((item) => [item.id, item])));

  function openCreate() {
    showCreate = true;
  }

  function createTenant(body: CreateTenantBody) {
    return operatorApi.createTenant(body);
  }

  function openTenant(tenantId: string) {
    showCreate = false;
    void goto(`/betreiber/mandanten/${encodeURIComponent(tenantId)}`);
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>Mandanten – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-tenants-page">
  <PageHead
    eyebrow="Betreiber"
    title="Mandanten"
    sub="Mandanten anlegen, umbenennen und deaktivieren."
  >
    {#snippet actions()}
      <button
        type="button"
        class="btn btn-primary"
        aria-haspopup="dialog"
        data-testid="op-tenants-create"
        onclick={openCreate}>Mandant anlegen</button
      >
    {/snippet}
  </PageHead>

  {#if loadState === "ready" && dashboard && tenants.length > 0}
    <Section animate title="Übersicht" sub="Summen über alle aktiven Mandanten">
      <OperatorOverview {dashboard} />
    </Section>
  {/if}

  <Section animate>
    {#if loadState === "loading"}
      <div aria-busy="true" data-testid="op-tenants-loading">
        <span class="sr-only" role="status">Wird geladen …</span>
        {#each [0, 1, 2, 3, 4] as row (row)}
          <div class="skeleton row"></div>
        {/each}
      </div>
    {:else if loadState === "error"}
      <div class="alert alert-error" role="alert" data-testid="op-tenants-error">
        <div class="error-body">
          <p class="message">{loadError}</p>
          <button
            type="button"
            class="btn btn-outline"
            data-testid="op-tenants-retry"
            onclick={() => void load()}>Erneut laden</button
          >
        </div>
      </div>
    {:else if tenants.length === 0}
      <div data-testid="op-tenants-empty">
        <EmptyState
          icon="users"
          title="Noch keine Mandanten"
          description="Der erste Mandant erhält einen Standardsalon und eine Einladung für die erste Administration."
          actionLabel="Mandant anlegen"
          onaction={openCreate}
        />
      </div>
    {:else}
      <TenantTable {tenants} {metrics} bind:page bind:pageSize />
    {/if}
  </Section>
</div>

<TenantCreateDialog
  bind:open={showCreate}
  onCreate={createTenant}
  onOpen={openTenant}
  onCreated={() => void load(true)}
/>

<style>
  .row {
    height: 48px;
    margin-bottom: 8px;
  }

  .error-body {
    min-width: 0;
  }

  .message {
    margin: 0 0 16px;
    font-size: 16px;
    overflow-wrap: anywhere;
  }
</style>
