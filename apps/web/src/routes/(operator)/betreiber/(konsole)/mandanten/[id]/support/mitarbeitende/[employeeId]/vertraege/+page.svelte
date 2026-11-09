<script lang="ts">
  import Skeleton from "$components/ui/Skeleton.svelte";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SupportContracts from "$lib/components/operator/SupportContracts.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import {
    EMPLOYEE_NOT_FOUND,
    failureText,
    REASON_TEXTS,
    SUPPORT_ACCESS_REQUIRED,
    SUPPORT_READ_OVERRIDES,
  } from "$lib/operator/reasons";
  import {
    supportBasePath,
    supportLeavePath,
    supportMonthPath,
    tenantPagePath,
  } from "$lib/operator/support-nav";
  import type { SupportContract } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "not-found" | "error";

  let tenantName = $state("");
  let contracts = $state<SupportContract[]>([]);
  let loadState = $state<LoadState>("loading");
  let errorText = $state("");

  const tenantId = $derived($page.params.id ?? "");
  const employeeId = $derived($page.params.employeeId ?? "");

  async function load() {
    loadState = "loading";
    try {
      const result = await operatorApi.getSupportContracts(tenantId, employeeId);
      contracts = result.items;
      loadState = "ready";
    } catch (err) {
      if (err instanceof OperatorApiError && err.code === SUPPORT_ACCESS_REQUIRED) {
        void goto(supportLeavePath(tenantId, SUPPORT_ACCESS_REQUIRED));
        return;
      }
      if (err instanceof OperatorApiError && err.status === 404) {
        loadState = "not-found";
        return;
      }
      errorText = failureText(err, { overrides: SUPPORT_READ_OVERRIDES });
      loadState = "error";
    }
  }

  // The tenant name is only for the breadcrumb; a failure leaves the neutral word.
  onMount(() => {
    void operatorApi
      .getTenant(tenantId)
      .then((tenant) => (tenantName = tenant.name))
      .catch(() => undefined);
    void load();
  });
</script>

<svelte:head>
  <title>Verträge – Support – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-support-contracts-page">
  <div>
    <Breadcrumb
      crumbs={[
        { label: "Mandanten", href: "/betreiber" },
        { label: tenantName || "Mandant", href: tenantPagePath(tenantId) },
        { label: "Support", href: supportBasePath(tenantId) },
        { label: "Mitarbeitende Person", href: supportMonthPath(tenantId, employeeId) },
        { label: "Verträge" },
      ]}
    />
    <PageHead eyebrow="Support-Zugriff" title="Verträge">
      {#snippet actions()}
        <a
          class="btn btn-outline"
          href={supportMonthPath(tenantId, employeeId)}
          data-testid="op-support-month-link">Monatsansicht</a
        >
      {/snippet}
    </PageHead>
  </div>

  {#if loadState === "loading"}
    <div data-testid="op-support-contracts-loading">
      <Skeleton shape="block" count={3} height="48px" />
    </div>
  {:else if loadState === "not-found"}
    <div data-testid="op-support-contracts-not-found">
      <p class="message">{REASON_TEXTS[EMPLOYEE_NOT_FOUND]}</p>
      <a class="btn btn-outline" href={supportBasePath(tenantId)}>Zur Mitarbeitendenliste</a>
    </div>
  {:else if loadState === "error"}
    <div class="alert alert-error" role="alert" data-testid="op-support-contracts-error">
      <p class="message">{errorText}</p>
      <button type="button" class="btn btn-outline" onclick={() => void load()}>Erneut laden</button
      >
    </div>
  {:else}
    <Section title="Vertragsverlauf" sub="Neueste zuerst" animate>
      <SupportContracts {contracts} />
    </Section>
  {/if}
</div>

<style>
  .message {
    margin: 0 0 16px;
    font-size: 16px;
  }
</style>
