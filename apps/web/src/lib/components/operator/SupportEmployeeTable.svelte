<!--
  SupportEmployeeTable - the employees of one tenant in the support area (Issue #93, D-05(1), D-13).

  Personalnummer, name, status, Stammsalon, contract type, entry and exit, and two links per row: the
  month view and the contracts view. An anonymised person is listed with the stored (anonymised)
  values. Labels come from `support-labels`, keyed by control values. Rendered by the DataTable block
  (Issue #899): a card list below 760 px of container width, so a phone never scrolls sideways.
-->
<script lang="ts">
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
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

  const columns: DataTableColumn[] = [
    { key: "employeeNumber", label: "Personalnummer" },
    { key: "name", label: "Name", primary: true },
    { key: "status", label: "Status" },
    { key: "homeSalon", label: "Stammsalon" },
    { key: "scheduleType", label: "Vertragsart" },
    { key: "hireDate", label: "Eintritt" },
    { key: "exitDate", label: "Austritt" },
    { key: "actions", label: "Ansichten" },
  ];

  function fullName(employee: SupportEmployee): string {
    return `${employee.firstName} ${employee.lastName}`.trim();
  }
</script>

{#if employees.length === 0}
  <p class="empty" data-testid="op-support-employees-empty">Keine Mitarbeitenden gefunden.</p>
{:else}
  <div data-testid="op-support-employees">
    <DataTable
      caption="Mitarbeitende des Mandanten"
      {columns}
      rows={employees}
      rowKey={(employee) => employee.id}
      rowTestId={(employee) => `op-support-employee-row-${employee.id}`}
    >
      {#snippet cell(employee, column)}
        {#if column.key === "employeeNumber"}
          <span class="mono">{employee.employeeNumber}</span>
        {:else if column.key === "name"}
          <span class="name">{employee.lastName}, {employee.firstName}</span>
        {:else if column.key === "status"}
          <span
            class={`badge mark ${employeeStatusBadgeClass(employee.status)}`}
            data-testid={`op-support-employee-status-${employee.id}`}
            data-state={employee.status}>{labelFor(EMPLOYEE_STATUS_LABELS, employee.status)}</span
          >
        {:else if column.key === "homeSalon"}
          <span class="text">{employee.homeSalon ? employee.homeSalon.name : "–"}</span>
        {:else if column.key === "scheduleType"}
          <span class="text">{labelFor(SCHEDULE_TYPE_LABELS, employee.scheduleType)}</span>
        {:else if column.key === "hireDate"}
          {formatOperatorDay(employee.hireDate)}
        {:else if column.key === "exitDate"}
          {employee.exitDate ? formatOperatorDay(employee.exitDate) : "–"}
        {:else}
          <span class="cell-actions">
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
          </span>
        {/if}
      {/snippet}
    </DataTable>
  </div>
{/if}

<style>
  /* The tinted label text of the status badges misses 4.5:1 on its own tint (.badge-yellow in light mode,
     measured 4.25:1): the label takes the body text colour, the tint and border still carry the meaning. */
  .mark {
    color: var(--text);
  }

  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-2);
  }

  .name {
    display: inline-block;
    font-weight: 600;
    overflow-wrap: anywhere;
    white-space: normal;
    min-width: 0;
    /* A very long unbroken name wraps inside its own column instead of pushing the action column out of
       the table wrapper (measured at 1440 px with a 100-character name). */
    max-width: 24ch;
  }

  /* Long free text wraps inside its own width; the block keeps a cell on one line. */
  .text {
    display: inline-block;
    white-space: normal;
    max-width: 32ch;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .mono {
    font-family: var(--font-ui);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .cell-actions {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  /* The two links sit side by side and wrap under each other only when the column is too narrow. */
  .cell-actions :global(.btn) {
    margin: 0;
  }

  /* The v1.5 .btn recipe resets min-height to 0; row actions keep the 44 px touch target. */
  .cell-actions :global(.btn) {
    min-height: 44px;
  }
</style>
