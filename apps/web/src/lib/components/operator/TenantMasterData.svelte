<!--
  TenantMasterData - the "Mandant" section body of the operator's tenant page (Issue #89, D-14).

  Shows the tenant's master data and status and offers the lifecycle actions of #88: rename,
  deactivate, reactivate and re-send the first administration's invitation. The component only
  asks; the page owns the API calls, the toast and the reload from the server, and hands them in
  as callbacks. Actions are never placed in a header slot: they sit in one wrapping row below the
  facts so they stay inside 360 px (UI-SPEC Screen 3).
-->
<script lang="ts">
  import TenantRenameDialog from "./TenantRenameDialog.svelte";
  import { federalStateLabel, formatOperatorDate } from "$lib/operator/labels";
  import type { OperatorTenant } from "$lib/operator/types";

  interface Props {
    tenant: OperatorTenant;
    /** Receives the trimmed new name; rejects with the client's error on failure. */
    onRename: (name: string) => Promise<void>;
  }

  let { tenant, onRename }: Props = $props();

  type Requested = "deactivate" | "reactivate" | "resend" | null;

  let renameOpen = $state(false);
  let requested = $state<Requested>(null);

  const deactivated = $derived(tenant.deactivatedAt !== null);
</script>

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

<div class="actions" data-testid="op-tenant-actions" data-requested={requested ?? undefined}>
  <button
    type="button"
    class="btn btn-outline"
    data-testid="op-tenant-rename"
    onclick={() => (renameOpen = true)}>Umbenennen</button
  >
  {#if deactivated}
    <button
      type="button"
      class="btn btn-outline"
      data-testid="op-tenant-reactivate"
      onclick={() => (requested = "reactivate")}>Mandant reaktivieren</button
    >
  {:else}
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="op-tenant-resend"
      onclick={() => (requested = "resend")}>Einladung erneut senden</button
    >
    <button
      type="button"
      class="btn btn-ghost danger"
      data-testid="op-tenant-deactivate"
      onclick={() => (requested = "deactivate")}>Deaktivieren</button
    >
  {/if}
</div>

<TenantRenameDialog bind:open={renameOpen} currentName={tenant.name} {onRename} />

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
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  .danger {
    color: var(--bad-text);
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
