<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SalonTable from "$lib/components/operator/SalonTable.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import { federalStateLabel, formatOperatorDate } from "$lib/operator/labels";
  import type { OperatorSalon, OperatorTenant } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "not-found" | "error";

  let tenant = $state<OperatorTenant | null>(null);
  let salons = $state<OperatorSalon[]>([]);
  let loadState = $state<LoadState>("loading");

  const tenantId = $derived($page.params.id ?? "");
  const deactivated = $derived(tenant !== null && tenant.deactivatedAt !== null);

  async function load() {
    loadState = "loading";
    try {
      const [loadedTenant, loadedSalons] = await Promise.all([
        operatorApi.getTenant(tenantId),
        operatorApi.listSalons(tenantId),
      ]);
      tenant = loadedTenant;
      salons = loadedSalons;
      loadState = "ready";
    } catch (err) {
      // A 401/403 was already handled by the client (session cleared, redirect to the sign-in).
      loadState = err instanceof OperatorApiError && err.status === 404 ? "not-found" : "error";
    }
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>{tenant ? tenant.name : "Mandant"} – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-tenant-page">
  {#if loadState === "ready" && tenant}
    <div>
      <Breadcrumb crumbs={[{ label: "Mandanten", href: "/betreiber" }, { label: tenant.name }]} />
      <PageHead eyebrow="Mandant" title={tenant.name} sub={`Kurzname ${tenant.slug}`} />
    </div>

    <Section title="Mandant" sub="Stammdaten und Status" animate>
      <dl class="facts">
        <dt>Name</dt>
        <dd data-testid="op-tenant-name">{tenant.name}</dd>
        <dt>Kurzname</dt>
        <dd class="mono" data-testid="op-tenant-slug">{tenant.slug}</dd>
        <dt>Bundesland</dt>
        <dd data-testid="op-tenant-federal-state">{federalStateLabel(tenant.federalState)}</dd>
        <dt>Angelegt</dt>
        <dd>{formatOperatorDate(tenant.createdAt)}</dd>
        <dt>Status</dt>
        <dd>
          <span
            class="badge"
            class:badge-green={!deactivated}
            class:badge-gray={deactivated}
            data-testid="op-tenant-status"
            data-state={deactivated ? "deactivated" : "active"}
            >{deactivated ? "Deaktiviert" : "Aktiv"}</span
          >
        </dd>
      </dl>
      {#if deactivated && tenant.deactivatedAt}
        <div class="callout brand notice" data-testid="op-tenant-deactivated-notice">
          <p>
            Deaktiviert am {formatOperatorDate(tenant.deactivatedAt)}.{tenant.deactivatedReason
              ? ` Grund: ${tenant.deactivatedReason}`
              : ""}
          </p>
        </div>
      {/if}
    </Section>

    <Section title="Salons" sub="Standorte des Mandanten" animate>
      <div data-testid="op-salons-section">
        <SalonTable {salons} />
      </div>
    </Section>
  {:else}
    <PageHead eyebrow="Betreiber" title="Mandant" />

    {#if loadState === "loading"}
      <div aria-busy="true" data-testid="op-tenant-loading">
        <span class="sr-only" role="status">Wird geladen …</span>
        <div class="skeleton row"></div>
        <div class="skeleton row"></div>
        <div class="skeleton row"></div>
      </div>
    {:else if loadState === "not-found"}
      <div data-testid="op-tenant-not-found">
        <p class="message">Mandant nicht gefunden.</p>
        <a class="btn btn-outline" href="/betreiber">Zur Mandantenliste</a>
      </div>
    {:else}
      <div class="alert alert-error" role="alert" data-testid="op-tenant-error">
        <p class="message">Der Mandant konnte nicht geladen werden. Bitte erneut versuchen.</p>
        <button type="button" class="btn btn-outline" onclick={() => void load()}
          >Erneut laden</button
        >
      </div>
    {/if}
  {/if}
</div>

<style>
  .facts {
    display: grid;
    grid-template-columns: minmax(96px, 160px) 1fr;
    gap: 8px 16px;
    margin: 0;
    font-size: 16px;
  }

  .facts dt {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .notice {
    margin-top: 16px;
  }

  .message {
    margin: 0 0 16px;
    font-size: 16px;
  }

  .row {
    height: 48px;
    margin-bottom: 8px;
  }

  @media (max-width: 559px) {
    .facts {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .facts dd {
      margin-bottom: 8px;
    }
  }
</style>
