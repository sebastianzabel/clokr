<!--
  SupportEmployeeTable - the employees of one tenant in the support area (Issue #93, D-05(1), D-13).

  Personalnummer, name, status, Stammsalon, contract type, entry and exit, and two links per row: the
  month view and the contracts view. An anonymised person is listed with the stored (anonymised)
  values. Labels come from `support-labels`, keyed by control values. Up to 639 px the table becomes
  a stacked list by CSS only (same markup), like SalonTable, so a phone never scrolls sideways.
-->
<script lang="ts">
  import { formatOperatorDay } from "$lib/operator/labels";
  import {
    EMPLOYEE_STATUS_LABELS,
    SCHEDULE_TYPE_LABELS,
    employeeStatusBadgeClass,
    labelFor,
  } from "$lib/operator/support-labels";
  import { supportContractsPath, supportMonthPath } from "$lib/operator/support-nav";
  import type { SupportEmployee } from "$lib/operator/types";

  interface Props {
    tenantId: string;
    employees: SupportEmployee[];
  }

  let { tenantId, employees }: Props = $props();

  function fullName(employee: SupportEmployee): string {
    return `${employee.firstName} ${employee.lastName}`.trim();
  }
</script>

{#if employees.length === 0}
  <p class="empty" data-testid="op-support-employees-empty">Keine Mitarbeitenden gefunden.</p>
{:else}
  <div class="table-wrap">
    <table class="data-table support-table" data-testid="op-support-employees">
      <caption class="sr-only">Mitarbeitende des Mandanten</caption>
      <thead>
        <tr>
          <th scope="col">Personalnummer</th>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Stammsalon</th>
          <th scope="col">Vertragsart</th>
          <th scope="col">Eintritt</th>
          <th scope="col">Austritt</th>
          <th scope="col">Ansichten</th>
        </tr>
      </thead>
      <tbody>
        {#each employees as employee (employee.id)}
          <tr data-testid={`op-support-employee-row-${employee.id}`}>
            <td class="cell-number" data-label="Personalnummer">
              <span class="mono">{employee.employeeNumber}</span>
            </td>
            <td class="cell-name" data-label="Name">
              <span class="name">{employee.lastName}, {employee.firstName}</span>
            </td>
            <td data-label="Status">
              <span
                class={`badge ${employeeStatusBadgeClass(employee.status)}`}
                data-testid={`op-support-employee-status-${employee.id}`}
                data-state={employee.status}
                >{labelFor(EMPLOYEE_STATUS_LABELS, employee.status)}</span
              >
            </td>
            <td data-label="Stammsalon">
              <span class="text">{employee.homeSalon ? employee.homeSalon.name : "–"}</span>
            </td>
            <td data-label="Vertragsart">
              <span class="text">{labelFor(SCHEDULE_TYPE_LABELS, employee.scheduleType)}</span>
            </td>
            <td data-label="Eintritt">{formatOperatorDay(employee.hireDate)}</td>
            <td data-label="Austritt">
              {employee.exitDate ? formatOperatorDay(employee.exitDate) : "–"}
            </td>
            <td class="cell-actions">
              <a
                class="btn btn-outline btn-sm"
                href={supportMonthPath(tenantId, employee.id)}
                aria-label={`Monatsansicht von ${fullName(employee)}`}
                data-testid={`op-support-employee-month-${employee.id}`}>Monatsansicht</a
              >
              <a
                class="btn btn-outline btn-sm"
                href={supportContractsPath(tenantId, employee.id)}
                aria-label={`Verträge von ${fullName(employee)}`}
                data-testid={`op-support-employee-contracts-${employee.id}`}>Verträge</a
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

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .cell-actions {
    white-space: nowrap;
  }

  .cell-actions .btn + .btn {
    margin-left: 8px;
  }

  /* The v1.5 .btn recipe resets min-height to 0; row actions keep the 44 px touch target. */
  .cell-actions :global(.btn) {
    min-height: 44px;
  }

  /* Eight columns do not fit a 768 px page at the .data-table padding: tighten the cell padding and
     let the two links wrap under each other instead of holding the column open. */
  @media (min-width: 640px) and (max-width: 1023px) {
    .support-table th,
    .support-table td {
      padding-inline: 8px;
    }

    .support-table td.cell-actions {
      white-space: normal;
    }

    .cell-actions .btn + .btn {
      margin-left: 0;
      margin-top: 4px;
    }
  }

  @media (max-width: 639px) {
    .support-table thead {
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

    .support-table,
    .support-table tbody {
      display: block;
    }

    .support-table tr {
      display: block;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .support-table tbody tr:last-child {
      border-bottom: 0;
    }

    .support-table td {
      display: block;
      padding: 0;
      border: 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .support-table td + td {
      margin-top: 4px;
    }

    .support-table td.cell-name {
      font-size: 16px;
      margin-bottom: 4px;
    }

    .support-table td.cell-actions {
      margin-top: 8px;
      white-space: normal;
    }

    .support-table td:not(.cell-name):not(.cell-actions)::before {
      content: attr(data-label) ": ";
      font-weight: 600;
      color: var(--text-muted);
    }
  }
</style>
