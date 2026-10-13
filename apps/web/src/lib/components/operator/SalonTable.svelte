<!--
  SalonTable - the salons of one tenant as seen by the operator (Issue #89).

  Read-only: name (with the Standardsalon badge), address line, Bundesland, coupling and status.
  Row actions arrive with the salon management plans. Up to 639 px the table becomes a stacked
  list by CSS only (same markup), so a phone never scrolls sideways.
-->
<script lang="ts">
  import { federalStateLabel } from "$lib/operator/labels";
  import type { OperatorSalon } from "$lib/operator/types";

  interface Props {
    salons: OperatorSalon[];
  }

  let { salons }: Props = $props();

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
              <span class="text">{federalStateLabel(salon.federalState)}</span>
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
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
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

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .muted {
    color: var(--text-muted);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow-wrap: anywhere;
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

    .salon-table td:not(.cell-name)::before {
      content: attr(data-label) ": ";
      font-weight: 600;
      color: var(--text-muted);
    }
  }
</style>
