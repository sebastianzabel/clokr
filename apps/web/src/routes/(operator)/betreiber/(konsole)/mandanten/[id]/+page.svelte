<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SalonsSection from "$lib/components/operator/SalonsSection.svelte";
  import TenantMasterData from "$lib/components/operator/TenantMasterData.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import type { OperatorSalon, OperatorTenant } from "$lib/operator/types";
  import { toasts } from "$stores/toast";

  type LoadState = "loading" | "ready" | "not-found" | "error";

  let tenant = $state<OperatorTenant | null>(null);
  let salons = $state<OperatorSalon[]>([]);
  let loadState = $state<LoadState>("loading");

  const tenantId = $derived($page.params.id ?? "");

  /**
   * Reads the tenant and its salons from the server. After an action the reload is silent: the
   * page keeps its content (and the open dialogs) on screen instead of flashing the skeleton.
   */
  async function load(silent = false) {
    if (!silent) loadState = "loading";
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

  async function renameTenant(name: string) {
    await operatorApi.renameTenant(tenantId, name);
    toasts.success("Mandant umbenannt.");
    await load(true);
  }

  async function deactivateTenant(id: string, reason: string) {
    await operatorApi.deactivateTenant(id, reason);
    toasts.success("Mandant deaktiviert.");
    await load(true);
  }

  async function reactivateTenant() {
    await operatorApi.reactivateTenant(tenantId);
    toasts.success("Mandant reaktiviert.");
    await load(true);
  }

  async function resendInvitation() {
    const result = await operatorApi.resendInvitation(tenantId);
    if (result.invitationMailSent) toasts.success("Einladung gesendet.");
    return result;
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
      <TenantMasterData
        {tenant}
        onRename={renameTenant}
        onDeactivate={deactivateTenant}
        onReactivate={reactivateTenant}
        onResend={resendInvitation}
      />
    </Section>

    <SalonsSection
      {tenantId}
      {salons}
      onCreate={operatorApi.createSalon}
      onUpdate={operatorApi.updateSalon}
      onReload={() => load(true)}
    />
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
  .message {
    margin: 0 0 16px;
    font-size: 16px;
  }

  .row {
    height: 48px;
    margin-bottom: 8px;
  }
</style>
