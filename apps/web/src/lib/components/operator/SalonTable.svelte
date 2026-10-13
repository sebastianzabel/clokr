<!--
  SalonTable - the salons of one tenant as seen by the operator (Issue #89).

  Name (with the Standardsalon badge), address line, Bundesland, coupling and status. With `onEdit`
  each row ends in a "Bearbeiten" action (always visible, 44 px), with `onDeactivate` / `onActivate` in
  the same cell: an active salon offers "Deaktivieren", a deactivated one "Salon aktivieren". There is
  deliberately no destructive row action (D-08). With exactly one active salon its "Deaktivieren" is
  aria-disabled (the server's LAST_ACTIVE_SALON stays authoritative) and a note says why. `frozen`
  (deactivated tenant) disables every action. Up to 639 px the table becomes a stacked list by CSS only
  (same markup), so a phone never scrolls sideways.
-->
<script lang="ts">
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
  <div class="table-wrap">
    <table class="data-table salon-table" data-testid="op-salons-table">
      <caption class="sr-only">Salons</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Adresse</th>
          <th scope="col">Bundesland</th>
          <th scope="col">Kopplung</th>
          <th scope="col">Status</th>
          {#if showActions}<th scope="col"><span class="sr-only">Aktionen</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each salons as salon (salon.id)}
          {@const address = addressLine(salon)}
          <tr data-testid={`op-salon-row-${salon.id}`}>
            <td class="cell-name" data-label="Name">
              <span class="name" data-testid={`op-salon-name-${salon.id}`}>{salon.name}</span>
              {#if salon.isDefault}
                <span class="badge badge-purple" data-testid={`op-salon-default-badge-${salon.id}`}
                  >Standardsalon</span
                >
              {/if}
            </td>
            <td data-label="Adresse">
              {#if address}
                <span class="text">{address}</span>
              {:else}
                <span class="text muted">Keine Adresse hinterlegt</span>
              {/if}
            </td>
            <td data-label="Bundesland">
              <span class="text federal-state" data-testid={`op-salon-federal-label-${salon.id}`}
                >{federalStateLabel(salon.federalState)}</span
              >
            </td>
            <td data-label="Kopplung" data-testid={`op-salon-coupling-${salon.id}`}>
              {#if salon.coupling}
                <span class="text"
                  >{providerLabel(salon.coupling.provider)} ·
                  <span class="mono">{salon.coupling.externalBranchId}</span></span
                >
              {:else}
                <span class="text muted">Keine</span>
              {/if}
            </td>
            <td data-label="Status">
              <span
                class="badge"
                class:badge-green={salon.isActive}
                class:badge-gray={!salon.isActive}
                data-testid={`op-salon-status-${salon.id}`}
                data-state={salon.isActive ? "active" : "deactivated"}
                >{salon.isActive ? "Aktiv" : "Deaktiviert"}</span
              >
            </td>
            {#if showActions}
              <td class="cell-actions">
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
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
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
    color: var(--text-muted);
  }

  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
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
    color: var(--bad-text);
  }

  .btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .note {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  /* The v1.5 .btn recipe resets min-height to 0; row actions keep the 44 px touch target. */
  .cell-actions :global(.btn) {
    min-height: 44px;
  }

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .muted {
    color: var(--text-muted);
  }

  /* A Bundesland is a short fixed name: `overflow-wrap: anywhere` (above) lowers the column's
     min-content to one character, so the auto table layout squeezed it and split "Niedersachsen"
     inside the word. Normal wrapping breaks only at spaces and hyphens. */
  .text.federal-state {
    overflow-wrap: normal;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  /* Six columns do not fit a 768 px Section at the .data-table padding: tighten the cell padding and
     let the two row actions wrap under each other instead of holding the column open. */
  @media (min-width: 640px) and (max-width: 1023px) {
    .salon-table th,
    .salon-table td {
      padding-inline: 8px;
    }

    .salon-table td.cell-actions {
      white-space: normal;
    }
  }

  @media (max-width: 639px) {
    .salon-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .salon-table,
    .salon-table tbody {
      display: block;
    }

    .salon-table tr {
      display: block;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .salon-table tbody tr:last-child {
      border-bottom: 0;
    }

    .salon-table td {
      display: block;
      padding: 0;
      border: 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .salon-table td + td {
      margin-top: 4px;
    }

    .salon-table td.cell-name {
      display: flex;
      font-size: 16px;
      margin-bottom: 4px;
    }

    .salon-table td.cell-actions {
      margin-top: 8px;
      white-space: normal;
    }

    .salon-table td:not(.cell-name):not(.cell-actions)::before {
      content: attr(data-label) ": ";
      font-weight: 600;
      color: var(--text-muted);
    }
  }
</style>
