<!--
  TenantMasterData - the "Mandant" section body of the operator's tenant page (Issue #89, D-14).

  Shows the tenant's master data and status and offers the lifecycle actions of #88: rename,
  deactivate, reactivate and re-send the first administration's invitation. The component only
  asks and words the failures; the page owns the API calls, the toast and the reload from the
  server, and hands them in as callbacks. Actions are never placed in a header slot: they sit in one wrapping row below the
  facts so they stay inside 360 px (UI-SPEC Screen 3).
-->
<script lang="ts">
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte";
  import TenantRenameDialog from "./TenantRenameDialog.svelte";
  import { federalStateLabel, formatOperatorDate } from "$lib/operator/labels";
  import { RESEND_REASON_TEXTS, failureText } from "$lib/operator/reasons";
  import type { OperatorTenant, ResendInvitationResult } from "$lib/operator/types";

  interface Props {
    tenant: OperatorTenant;
    /** Receives the trimmed new name; rejects with the client's error on failure. */
    onRename: (name: string) => Promise<void>;
    /** Receives the id and the trimmed reason; rejects with the client's error on failure. */
    onDeactivate: (id: string, reason: string) => Promise<void>;
    onReactivate: () => Promise<void>;
    /** Resolves with the mail outcome; rejects with the client's error on failure. */
    onResend: () => Promise<ResendInvitationResult>;
  }

  let { tenant, onRename, onDeactivate, onReactivate, onResend }: Props = $props();

  // Mirrors `deactivateTenantSchema` of the API (trimmed 3 to 500 characters), so the server's raw
  // validation answer never reaches the operator.
  const REASON_MIN = 3;
  const REASON_MAX = 500;
  const REASON_LENGTH_MESSAGE = "Die Begründung muss 3 bis 500 Zeichen lang sein.";

  interface Notice {
    code: string | undefined;
    text: string;
  }

  let renameOpen = $state(false);
  let deactivateOpen = $state(false);
  let reactivateOpen = $state(false);
  let resendOpen = $state(false);
  let notice = $state<Notice | null>(null);
  let mailNotSent = $state(false);

  const deactivated = $derived(tenant.deactivatedAt !== null);

  function noticeFor(error: unknown, overrides?: Readonly<Record<string, string>>): Notice {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return {
      code: typeof code === "string" ? code : undefined,
      text: failureText(error, { overrides }),
    };
  }

  function openReactivate() {
    notice = null;
    reactivateOpen = true;
  }

  function openResend() {
    notice = null;
    resendOpen = true;
  }

  async function confirmDeactivate(reason: string) {
    // ReasonDialog hands over the trimmed text; a throw keeps the dialog open and is shown inline.
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      throw new Error(REASON_LENGTH_MESSAGE);
    }
    try {
      await onDeactivate(tenant.id, reason);
    } catch (error) {
      throw new Error(failureText(error), { cause: error });
    }
  }

  async function confirmReactivate() {
    notice = null;
    try {
      await onReactivate();
    } catch (error) {
      notice = noticeFor(error);
      throw error;
    }
  }

  async function confirmResend() {
    notice = null;
    mailNotSent = false;
    try {
      const result = await onResend();
      mailNotSent = !result.invitationMailSent;
    } catch (error) {
      notice = noticeFor(error, RESEND_REASON_TEXTS);
      throw error;
    }
  }
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

{#if mailNotSent}
  <div class="alert alert-warning notice" role="status" data-testid="op-tenant-mail-warning">
    Die Einladung konnte nicht gesendet werden.
  </div>
{/if}

{#snippet noticeBlock()}
  {#if notice}
    <div
      class="alert alert-error notice-in-dialog"
      role="alert"
      data-testid="op-tenant-notice"
      data-code={notice.code}
    >
      {notice.text}
    </div>
  {/if}
{/snippet}

<div class="actions" data-testid="op-tenant-actions">
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
      onclick={openReactivate}>Mandant reaktivieren</button
    >
  {:else}
    <button type="button" class="btn btn-ghost" data-testid="op-tenant-resend" onclick={openResend}
      >Einladung erneut senden</button
    >
    <button
      type="button"
      class="btn btn-ghost danger"
      data-testid="op-tenant-deactivate"
      onclick={() => (deactivateOpen = true)}>Deaktivieren</button
    >
  {/if}
</div>

<TenantRenameDialog bind:open={renameOpen} currentName={tenant.name} {onRename} />

<ReasonDialog
  bind:open={deactivateOpen}
  danger
  title="Mandant deaktivieren?"
  description={`„${tenant.name}“ wird deaktiviert. Mitarbeitende können sich nicht mehr anmelden, bestehende Sitzungen enden, geplante Abläufe wie der Monatsabschluss pausieren. Alle Daten bleiben erhalten; der Mandant lässt sich reaktivieren.`}
  confirmLabel="Mandant deaktivieren"
  onConfirm={confirmDeactivate}
/>

<ConfirmDialog
  bind:open={reactivateOpen}
  title="Mandant reaktivieren?"
  description={`„${tenant.name}“ ist danach wieder nutzbar. Anmeldungen sind wieder möglich.`}
  confirmLabel="Mandant reaktivieren"
  onConfirm={confirmReactivate}
>
  {#snippet body()}
    {@render noticeBlock()}
  {/snippet}
</ConfirmDialog>

<ConfirmDialog
  bind:open={resendOpen}
  title="Einladung erneut senden?"
  description="Die erste Administration erhält eine neue Einladung per E-Mail."
  confirmLabel="Einladung senden"
  onConfirm={confirmResend}
>
  {#snippet body()}
    {@render noticeBlock()}
  {/snippet}
</ConfirmDialog>

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

  .notice-in-dialog {
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
