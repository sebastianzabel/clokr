<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SupportEmployeeTable from "$lib/components/operator/SupportEmployeeTable.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import {
    failureText,
    SUPPORT_ACCESS_REQUIRED,
    SUPPORT_READ_OVERRIDES,
  } from "$lib/operator/reasons";
  import { supportLeavePath, supportProtocolPath, tenantPagePath } from "$lib/operator/support-nav";
  import type { SupportEmployee } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "error";

  let tenantName = $state("");
  let employees = $state<SupportEmployee[]>([]);
  let loadState = $state<LoadState>("loading");
  let errorText = $state("");

  const tenantId = $derived($page.params.id ?? "");

  async function load() {
    loadState = "loading";
    try {
      const [tenant, list] = await Promise.all([
        operatorApi.getTenant(tenantId),
        operatorApi.listSupportEmployees(tenantId),
      ]);
      tenantName = tenant.name;
      employees = list.items;
      loadState = "ready";
    } catch (err) {
      if (err instanceof OperatorApiError && err.code === SUPPORT_ACCESS_REQUIRED) {
        void goto(supportLeavePath(tenantId, SUPPORT_ACCESS_REQUIRED));
        return;
      }
      errorText = failureText(err, { overrides: SUPPORT_READ_OVERRIDES });
      loadState = "error";
    }
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>Mitarbeitende – Support – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-support-employees-page">
  <div>
    <Breadcrumb
      crumbs={[
        { label: "Mandanten", href: "/betreiber" },
        { label: tenantName || "Mandant", href: tenantPagePath(tenantId) },
        { label: "Support" },
      ]}
    />
    <PageHead eyebrow="Support-Zugriff" title="Mitarbeitende">
      {#snippet actions()}
        <a
          class="btn btn-outline"
          href={supportProtocolPath(tenantId)}
          data-testid="op-support-protocol-link">Protokoll</a
        >
      {/snippet}
    </PageHead>
  </div>

  {#if loadState === "loading"}
    <div aria-busy="true" data-testid="op-support-employees-loading">
      <span class="sr-only" role="status">Wird geladen …</span>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
    </div>
  {:else if loadState === "error"}
    <div class="alert alert-error" role="alert" data-testid="op-support-employees-error">
      <p class="message">{errorText}</p>
      <button type="button" class="btn btn-outline" onclick={() => void load()}>Erneut laden</button
      >
    </div>
  {:else}
    <Section sub="Eingeschränkte Ansicht, jeder Abruf wird protokolliert" animate>
      <SupportEmployeeTable {tenantId} {employees} />
    </Section>
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
