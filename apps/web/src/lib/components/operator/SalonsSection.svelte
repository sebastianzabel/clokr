<!--
  SalonsSection - the "Salons" section of the operator tenant page (Issue #89, AC-89-02/03/04).

  Orchestrates the salon table, the create / edit dialog and the deactivate / activate actions. The API calls arrive as callbacks, so
  the section mounts without the operator client. A saved salon closes the dialog, reloads the list
  from the server (no optimistic edits), toasts, and gives focus back to the element that opened the
  dialog. A refusal that means "the list is stale" (the salon is already coupled, the tenant got
  deactivated, the salon is gone) reloads the list while the dialog stays open and shows the reason.

  Deactivating asks first (danger dialog naming the consequences) and shows a refusal by its machine
  code inside the open dialog; activating is reversible and has no side effect, so it asks nothing. A
  refusal that only says "already in that state" or "salon gone" lands in one page-level notice above
  the table and reloads the list; the next successful action dismisses it. There is deliberately no
  destructive action (D-08). A deactivated tenant freezes every control, with the reason in a visible hint.
-->
<script lang="ts">
  import { tick } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import { SALON_NOT_FOUND, failureText, REASON_TEXTS } from "$lib/operator/reasons";
  import { toasts } from "$stores/toast";
  import type { CreateSalonBody, OperatorSalon, UpdateSalonBody } from "$lib/operator/types";
  import SalonDialog from "./SalonDialog.svelte";
  import SalonTable from "./SalonTable.svelte";

  interface Props {
    tenantId: string;
    salons: OperatorSalon[];
    onCreate: (tenantId: string, body: CreateSalonBody) => Promise<unknown>;
    onUpdate: (tenantId: string, salonId: string, patch: UpdateSalonBody) => Promise<unknown>;
    onDeactivate: (tenantId: string, salonId: string) => Promise<unknown>;
    onActivate: (tenantId: string, salonId: string) => Promise<unknown>;
    /** Re-reads the salon list from the server. */
    onReload: () => Promise<void> | void;
    /** The tenant is deactivated: every salon control is disabled. */
    tenantDeactivated?: boolean;
  }

  let {
    tenantId,
    salons,
    onCreate,
    onUpdate,
    onDeactivate,
    onActivate,
    onReload,
    tenantDeactivated = false,
  }: Props = $props();

  /** Refusals after which the list on screen is out of date. */
  const STALE_CODES = ["SALON_ALREADY_COUPLED", "TENANT_DEACTIVATED"];
  /** Refusals of a lifecycle action that only say the salon is already in the wanted state or gone. */
  const NOTICE_CODES = ["ALREADY_ACTIVE", "ALREADY_INACTIVE", SALON_NOT_FOUND];
  const FROZEN_HINT_ID = "op-salons-tenant-frozen-hint";

  let dialogOpen = $state(false);
  let mode = $state<"create" | "edit">("create");
  let editing = $state<OperatorSalon | null>(null);
  let triggerTestId = "op-salon-create";

  let deactivateOpen = $state(false);
  let deactivating = $state<OperatorSalon | null>(null);
  let deactivateError = $state<{ code?: string; text: string } | null>(null);
  let notice = $state<{ code: string; text: string } | null>(null);
  let activatingId = $state<string | null>(null);

  const defaultSalon = $derived(salons.find((s) => s.isDefault) ?? null);

  function openCreate() {
    mode = "create";
    editing = null;
    triggerTestId = "op-salon-create";
    dialogOpen = true;
  }

  function openEdit(salon: OperatorSalon) {
    mode = "edit";
    editing = salon;
    triggerTestId = `op-salon-edit-${salon.id}`;
    dialogOpen = true;
  }

  async function reloadQuietly() {
    try {
      await onReload();
    } catch {
      // The page reports its own load problems; the saved change must not turn into a dialog error.
    }
  }

  /** The machine code of a refusal; a code-less 404 is a missing salon. */
  function codeOf(error: unknown): string | undefined {
    const shaped = error as { code?: unknown; status?: unknown } | null;
    if (typeof shaped?.code === "string") return shaped.code;
    return shaped?.status === 404 ? SALON_NOT_FOUND : undefined;
  }

  function showNotice(salon: OperatorSalon, code: string, error: unknown) {
    const reason = failureText(error, { notFoundCode: SALON_NOT_FOUND });
    notice = { code, text: `Salon „${salon.name}“: ${reason}` };
  }

  function openDeactivate(salon: OperatorSalon) {
    deactivating = salon;
    deactivateError = null;
    triggerTestId = `op-salon-deactivate-${salon.id}`;
    deactivateOpen = true;
  }

  async function confirmDeactivate() {
    const salon = deactivating;
    if (!salon) return;
    try {
      await onDeactivate(tenantId, salon.id);
    } catch (error) {
      const code = codeOf(error);
      if (code !== undefined && NOTICE_CODES.includes(code)) {
        // Nothing left to confirm: the salon is already inactive or gone. Say so and close.
        showNotice(salon, code, error);
        await reloadQuietly();
        return;
      }
      deactivateError = {
        ...(code !== undefined ? { code } : {}),
        text: failureText(error, { notFoundCode: SALON_NOT_FOUND }),
      };
      if (code !== undefined && STALE_CODES.includes(code)) void reloadQuietly();
      throw error;
    }
    notice = null;
    toasts.success("Salon deaktiviert.");
    await reloadQuietly();
  }

  async function activate(salon: OperatorSalon) {
    if (activatingId !== null) return;
    activatingId = salon.id;
    try {
      await onActivate(tenantId, salon.id);
      notice = null;
      toasts.success("Salon aktiviert.");
    } catch (error) {
      const code = codeOf(error);
      if (code !== undefined && (NOTICE_CODES.includes(code) || code === "TENANT_DEACTIVATED")) {
        showNotice(salon, code, error);
      } else {
        // Anything else (connection, rate limit, server fault) has no dialog to live in.
        notice = { code: code ?? "ERROR", text: failureText(error) };
      }
    } finally {
      activatingId = null;
    }
    await reloadQuietly();
  }

  async function submit(body: CreateSalonBody | UpdateSalonBody) {
    try {
      if (mode === "create") {
        await onCreate(tenantId, body as CreateSalonBody);
        notice = null;
        toasts.success("Salon angelegt.");
      } else if (editing) {
        await onUpdate(tenantId, editing.id, body as UpdateSalonBody);
        notice = null;
        toasts.success("Salon gespeichert.");
      }
    } catch (error) {
      const shaped = error as { code?: unknown; status?: unknown } | null;
      const stale =
        shaped?.status === 404 ||
        (typeof shaped?.code === "string" && STALE_CODES.includes(shaped.code));
      if (stale) void reloadQuietly();
      throw error;
    }
    await reloadQuietly();
  }

  // The element that opened the dialog gets focus back, whichever way the dialog closed.
  let wasOpen = false;
  $effect(() => {
    const isOpen = dialogOpen || deactivateOpen;
    if (wasOpen && !isOpen) {
      void tick().then(() =>
        document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`)?.focus(),
      );
    }
    wasOpen = isOpen;
  });
</script>

<Section title="Salons" sub="Standorte des Mandanten" animate>
  {#snippet actions()}
    <button
      type="button"
      class="btn btn-primary"
      aria-haspopup="dialog"
      aria-describedby={tenantDeactivated ? FROZEN_HINT_ID : undefined}
      disabled={tenantDeactivated}
      data-testid="op-salon-create"
      onclick={openCreate}>Salon anlegen</button
    >
  {/snippet}

  <div data-testid="op-salons-section">
    {#if tenantDeactivated}
      <div class="callout brand frozen-hint" id={FROZEN_HINT_ID} data-testid={FROZEN_HINT_ID}>
        <p>{REASON_TEXTS.TENANT_DEACTIVATED}</p>
      </div>
    {/if}
    {#if notice}
      <div
        class="callout brand notice"
        role="alert"
        data-code={notice.code}
        data-testid="op-salons-notice"
      >
        <p>{notice.text}</p>
      </div>
    {/if}
    <SalonTable
      {salons}
      onEdit={openEdit}
      onDeactivate={openDeactivate}
      onActivate={activate}
      frozen={tenantDeactivated}
      frozenHintId={FROZEN_HINT_ID}
    />
  </div>
</Section>

<ConfirmDialog
  bind:open={deactivateOpen}
  danger
  title="Salon deaktivieren?"
  description={`„${deactivating?.name ?? ""}“ wird deaktiviert. Laufende Einsatzsalon-Zuordnungen enden. Beim Aktivieren werden sie nicht wiederhergestellt. Zeiteinträge und alle anderen Daten bleiben erhalten.`}
  confirmLabel="Salon deaktivieren"
  onConfirm={confirmDeactivate}
>
  {#snippet body()}
    {#if deactivateError}
      <div
        class="callout brand"
        role="alert"
        data-code={deactivateError.code}
        data-testid="op-salon-deactivate-error"
      >
        <p>{deactivateError.text}</p>
      </div>
    {/if}
  {/snippet}
</ConfirmDialog>

<SalonDialog bind:open={dialogOpen} {mode} salon={editing} {defaultSalon} onSubmit={submit} />

<style>
  .frozen-hint,
  .notice {
    margin-bottom: 16px;
  }
</style>
