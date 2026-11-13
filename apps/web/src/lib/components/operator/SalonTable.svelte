<!--
  SalonTable - the salons of one tenant as seen by the operator (Issue #89).

  Name (with the Standardsalon badge), address line, Bundesland, coupling and status. With `onEdit`
  each row ends in a "Bearbeiten" action (always visible, 44 px), with `onDeactivate` / `onActivate` in
  the same cell: an active salon offers "Deaktivieren", a deactivated one "Salon aktivieren". There is
  deliberately no destructive row action (D-08). With exactly one active salon its "Deaktivieren" is
  aria-disabled (the server's LAST_ACTIVE_SALON stays authoritative) and a note says why. `frozen`
  (deactivated tenant) disables every action. Rendered by the DataTable block (Issue #899), which
  becomes a card list below 760 px of container width, so a phone never scrolls sideways.
-->
<script lang="ts">
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import { federalStateLabel } from "$lib/operator/labels";
  import type { OperatorSalon } from "$lib/operator/types";

  interface Props {
    salons: OperatorSalon[];
    /** Opens the edit dialog for a salon; without it the table has no action column. */
    onEdit?: (salon: OperatorSalon) => void;
    /** Asks to deactivate an active salon. */
    onDeactivate?: (salon: OperatorSalon) => void;
    /** Reactivates a deactivated salon. */
    onActivate?: (salon: OperatorSalon) => void;
    /** The tenant is deactivated: every action is disabled. */
    frozen?: boolean;
    /** Id of the element that explains why the actions are disabled (`aria-describedby`). */
    frozenHintId?: string;
  }

  let { salons, onEdit, onDeactivate, onActivate, frozen = false, frozenHintId }: Props = $props();

  const LAST_ACTIVE_NOTE_ID = "op-salons-last-active-note";

  const showActions = $derived(Boolean(onEdit || onDeactivate || onActivate));
  // The action column has no visible head label; the cell carries the buttons, whose accessible
  // names are their own aria-labels.
  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Name", primary: true },
    { key: "address", label: "Adresse" },
    { key: "federalState", label: "Bundesland" },
    { key: "coupling", label: "Kopplung" },
    { key: "status", label: "Status" },
    ...(showActions ? [{ key: "actions", label: "Aktionen" }] : []),
  ]);
  const soleActive = $derived(salons.filter((s) => s.isActive).length === 1);
  const describedBy = $derived(frozen ? frozenHintId : undefined);

  function deactivate(salon: OperatorSalon) {
    // aria-disabled keeps the control focusable and announced, so it must not act.
    if (soleActive) return;
    onDeactivate?.(salon);
  }

  /** "Straße, PLZ Ort" with missing parts omitted; null when nothing is known. */
  function addressLine(salon: OperatorSalon): string | null {
    const place = [salon.postalCode, salon.city].filter((part) => part && part.trim()).join(" ");
    const parts = [salon.street?.trim() ?? "", place].filter((part) => part !== "");
    return parts.length > 0 ? parts.join(", ") : null;
  }

  /** Display name of a coupling provider; the code is the control value, this is text only. */
  function providerLabel(provider: string): string {
    return provider === "PHOREST" ? "Phorest" : provider;
  }
</script>

{#if salons.length === 0}
  <p class="empty" data-testid="op-salons-empty">Keine Salons gefunden.</p>
{:else}
  <div data-testid="op-salons-table">
    <DataTable
      caption="Salons"
      {columns}
      rows={salons}
      rowKey={(salon) => salon.id}
      rowTestId={(salon) => `op-salon-row-${salon.id}`}
    >
      {#snippet cell(salon, column)}
        {#if column.key === "name"}
          <span class="cell-name">
            <span class="name" data-testid={`op-salon-name-${salon.id}`}>{salon.name}</span>
            {#if salon.isDefault}
              <span class="badge badge-purple" data-testid={`op-salon-default-badge-${salon.id}`}
                >Standardsalon</span
              >
            {/if}
          </span>
        {:else if column.key === "address"}
          {@const address = addressLine(salon)}
          {#if address}
            <span class="text">{address}</span>
          {:else}
            <span class="text muted">Keine Adresse hinterlegt</span>
          {/if}
        {:else if column.key === "federalState"}
          <span class="text federal-state" data-testid={`op-salon-federal-label-${salon.id}`}
            >{federalStateLabel(salon.federalState)}</span
          >
        {:else if column.key === "coupling"}
          <span data-testid={`op-salon-coupling-${salon.id}`}>
            {#if salon.coupling}
              <span class="text"
                >{providerLabel(salon.coupling.provider)} ·
                <span class="mono">{salon.coupling.externalBranchId}</span></span
              >
            {:else}
              <span class="text muted">Keine</span>
            {/if}
          </span>
        {:else if column.key === "status"}
          <span
            class="badge"
            class:badge-green={salon.isActive}
            class:badge-gray={!salon.isActive}
            data-testid={`op-salon-status-${salon.id}`}
            data-state={salon.isActive ? "active" : "deactivated"}
            >{salon.isActive ? "Aktiv" : "Deaktiviert"}</span
          >
        {:else}
          <span class="cell-actions">
            {#if onEdit}
              <button
                type="button"
                class="btn btn-outline btn-sm"
                aria-haspopup="dialog"
                aria-label={`Salon ${salon.name} bearbeiten`}
                aria-describedby={describedBy}
                disabled={frozen}
                data-testid={`op-salon-edit-${salon.id}`}
                onclick={() => onEdit(salon)}>Bearbeiten</button
              >
            {/if}
            {#if salon.isActive && onDeactivate}
              <button
                type="button"
                class="btn btn-ghost btn-sm danger"
                aria-haspopup="dialog"
                aria-label={`Salon ${salon.name} deaktivieren`}
                aria-describedby={frozen
                  ? frozenHintId
                  : soleActive
                    ? LAST_ACTIVE_NOTE_ID
                    : undefined}
                aria-disabled={soleActive ? "true" : undefined}
                disabled={frozen}
                data-testid={`op-salon-deactivate-${salon.id}`}
                onclick={() => deactivate(salon)}>Deaktivieren</button
              >
            {:else if !salon.isActive && onActivate}
              <button
                type="button"
                class="btn btn-outline btn-sm"
                aria-label={`Salon ${salon.name} aktivieren`}
                aria-describedby={describedBy}
                disabled={frozen}
                data-testid={`op-salon-activate-${salon.id}`}
                onclick={() => onActivate(salon)}>Salon aktivieren</button
              >
            {/if}
          </span>
        {/if}
      {/snippet}
    </DataTable>
  </div>
  {#if onDeactivate && soleActive}
    <p class="note" id={LAST_ACTIVE_NOTE_ID} data-testid="op-salons-last-active-note">
      Der letzte aktive Salon lässt sich nicht deaktivieren.
    </p>
  {/if}
{/if}

<style>
  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-2);
  }

  /* The block keeps a cell on one line; long free text wraps inside its own width instead. */
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
    white-space: normal;
    max-width: 32ch;
    min-width: 0;
  }

  .cell-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .cell-actions {
    white-space: nowrap;
  }

  .cell-actions .btn + .btn {
    margin-left: 8px;
  }

  .danger {
    color: var(--bad);
  }

  .btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .note {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--text-2);
  }

  /* The v1.5 .btn recipe resets min-height to 0; row actions keep the 44 px touch target. */
  .cell-actions :global(.btn) {
    min-height: 44px;
  }

  .text {
    display: inline-block;
    overflow-wrap: anywhere;
    white-space: normal;
    max-width: 40ch;
    min-width: 0;
  }

  .muted {
    color: var(--text-2);
  }

  /* A Bundesland is a short fixed name: `overflow-wrap: anywhere` (above) lowers the column's
     min-content to one character, so the auto table layout squeezed it and split "Niedersachsen"
     inside the word. Normal wrapping breaks only at spaces and hyphens. */
  .text.federal-state {
    overflow-wrap: normal;
  }

  .mono {
    font-family: var(--font-code);
    font-size: 13px;
    overflow-wrap: anywhere;
  }
</style>
