<!--
  SalonsSection - the "Salons" section of the operator tenant page (Issue #89, AC-89-02/03/04).

  Orchestrates the salon table and the create / edit dialog. The API calls arrive as callbacks, so
  the section mounts without the operator client. A saved salon closes the dialog, reloads the list
  from the server (no optimistic edits), toasts, and gives focus back to the element that opened the
  dialog. A refusal that means "the list is stale" (the salon is already coupled, the tenant got
  deactivated, the salon is gone) reloads the list while the dialog stays open and shows the reason.
-->
<script lang="ts">
  import { tick } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import { toasts } from "$stores/toast";
  import type { CreateSalonBody, OperatorSalon, UpdateSalonBody } from "$lib/operator/types";
  import SalonDialog from "./SalonDialog.svelte";
  import SalonTable from "./SalonTable.svelte";

  interface Props {
    tenantId: string;
    salons: OperatorSalon[];
    onCreate: (tenantId: string, body: CreateSalonBody) => Promise<unknown>;
    onUpdate: (tenantId: string, salonId: string, patch: UpdateSalonBody) => Promise<unknown>;
    /** Re-reads the salon list from the server. */
    onReload: () => Promise<void> | void;
  }

  let { tenantId, salons, onCreate, onUpdate, onReload }: Props = $props();

  /** Refusals after which the list on screen is out of date. */
  const STALE_CODES = ["SALON_ALREADY_COUPLED", "TENANT_DEACTIVATED"];

  let dialogOpen = $state(false);
  let mode = $state<"create" | "edit">("create");
  let editing = $state<OperatorSalon | null>(null);
  let triggerTestId = "op-salon-create";

  const defaultSalon = $derived(salons.find((s) => s.isDefault) ?? null);
  const activeSalonCount = $derived(salons.filter((s) => s.isActive).length);

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

  async function submit(body: CreateSalonBody | UpdateSalonBody) {
    try {
      if (mode === "create") {
        await onCreate(tenantId, body as CreateSalonBody);
        toasts.success("Salon angelegt.");
      } else if (editing) {
        await onUpdate(tenantId, editing.id, body as UpdateSalonBody);
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
    const isOpen = dialogOpen;
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
      data-testid="op-salon-create"
      onclick={openCreate}>Salon anlegen</button
    >
  {/snippet}

  <div data-testid="op-salons-section">
    <SalonTable {salons} onEdit={openEdit} />
  </div>
</Section>

<SalonDialog
  bind:open={dialogOpen}
  {mode}
  salon={editing}
  {defaultSalon}
  {activeSalonCount}
  onSubmit={submit}
/>
