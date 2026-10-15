<!--
  Layout of the support area (Issue #93, D-09, D-21, AC-93-3, AC-93-8).

  It reads the operator's own grant once and keeps the persistent banner above every read view. The
  views below are rendered only while the grant is running: without one, at expiry, or when a view
  reports `SUPPORT_ACCESS_REQUIRED`, the operator returns to the tenant page with the notice code
  and stays signed in. Nothing is cached here - the API answers every read afresh.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import SupportBanner from "$lib/components/operator/SupportBanner.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import {
    failureText,
    SUPPORT_ACCESS_EXPIRED,
    SUPPORT_ACCESS_REQUIRED,
  } from "$lib/operator/reasons";
  import { supportLeavePath } from "$lib/operator/support-nav";
  import type { OperatorSupportAccess } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "not-found" | "error";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  let loadState = $state<LoadState>("loading");
  let grant = $state<OperatorSupportAccess | null>(null);
  let errorText = $state("");

  const tenantId = $derived($page.params.id ?? "");

  function leave(code: string) {
    void goto(supportLeavePath(tenantId, code));
  }

  async function load(id: string) {
    loadState = "loading";
    grant = null;
    try {
      const state = await operatorApi.getSupportAccess(id);
      const running = state.active;
      if (running === null || Date.parse(running.expiresAt) <= Date.now()) {
        leave(SUPPORT_ACCESS_REQUIRED);
        return;
      }
      grant = running;
      loadState = "ready";
    } catch (err) {
      // A 401/403 was already handled by the client (session cleared, redirect to the sign-in).
      if (err instanceof OperatorApiError && err.status === 404) {
        loadState = "not-found";
      } else {
        errorText = failureText(err);
        loadState = "error";
      }
    }
  }

  onMount(() => {
    void load(tenantId);
  });
</script>

<svelte:head>
  {#if loadState !== "ready"}
    <title>Support – Betreiber – Clokr</title>
  {/if}
</svelte:head>

{#if loadState === "ready" && grant}
  {#key grant.id}
    <SupportBanner
      expiresAt={grant.expiresAt}
      reason={grant.reason}
      onExpired={() => leave(SUPPORT_ACCESS_EXPIRED)}
    />
  {/key}
  {@render children?.()}
{:else}
  <div data-testid="op-support-layout-state">
    <PageHead eyebrow="Support-Zugriff" title="Support" />

    {#if loadState === "not-found"}
      <div data-testid="op-support-not-found">
        <p class="message">Mandant nicht gefunden.</p>
        <a class="btn btn-outline" href="/betreiber">Zur Mandantenliste</a>
      </div>
    {:else if loadState === "error"}
      <div class="alert alert-error" role="alert" data-testid="op-support-error">
        <p class="message">{errorText}</p>
        <button type="button" class="btn btn-outline" onclick={() => void load(tenantId)}
          >Erneut laden</button
        >
      </div>
    {:else}
      <div aria-busy="true" data-testid="op-support-loading">
        <span class="sr-only" role="status">Wird geladen …</span>
        <div class="skeleton row"></div>
        <div class="skeleton row"></div>
        <div class="skeleton row"></div>
      </div>
    {/if}
  </div>
{/if}

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
