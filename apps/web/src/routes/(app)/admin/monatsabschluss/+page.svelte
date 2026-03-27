<script lang="ts">
  import { api } from "$api/client";

  interface EmployeeStatus {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    status: "ready" | "missing" | "closed";
    missingDates?: string[];
    snapshot?: {
      id: string;
      workedMinutes: number;
      expectedMinutes: number;
      balanceMinutes: number;
      carryOver: number;
      closedAt: string;
      closedBy: string | null;
    };
  }

  interface StatusResponse {
    year: number;
    month: number;
    employees: EmployeeStatus[];
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-based

  // Default to previous month
  let selectedYear = $state(currentMonth === 1 ? currentYear - 1 : currentYear);
  let selectedMonth = $state(currentMonth === 1 ? 12 : currentMonth - 1);

  let employeeStatuses: EmployeeStatus[] = $state([]);
  let loading = $state(false);
  let closing = $state(false);
  let closingEmployeeId = $state<string | null>(null);
  let error = $state("");
  let success = $state("");
  let loaded = $state(false);

  const months = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];

  const years = $derived(Array.from({ length: 5 }, (_, i) => currentYear - i));

  // Only past months are selectable
  let availableMonths = $derived(
    months
      .map((name, i) => ({ name, value: i + 1 }))
      .filter((m) => selectedYear < currentYear || m.value < currentMonth),
  );

  // Count helpers for the bottom bar
  let readyCount = $derived(employeeStatuses.filter((e) => e.status === "ready").length);
  let closedCount = $derived(employeeStatuses.filter((e) => e.status === "closed").length);
  let missingCount = $derived(employeeStatuses.filter((e) => e.status === "missing").length);

  // Reset month if it becomes invalid when year changes
  function onYearChange() {
    if (selectedYear === currentYear && selectedMonth >= currentMonth) {
      selectedMonth = currentMonth - 1 || 12;
      if (selectedMonth === 12 && selectedYear === currentYear) {
        selectedYear = currentYear - 1;
      }
    }
    loadStatus();
  }

  async function loadStatus() {
    loading = true;
    error = "";
    success = "";
    loaded = false;
    try {
      const res = await api.get<StatusResponse>(
        `/overtime/close-month/status?year=${selectedYear}&month=${selectedMonth}`,
      );
      employeeStatuses = res.employees;
      loaded = true;
    } catch {
      error = "Status konnte nicht geladen werden";
    } finally {
      loading = false;
    }
  }

  async function closeEmployee(employeeId: string) {
    closingEmployeeId = employeeId;
    closing = true;
    error = "";
    success = "";
    try {
      await api.post("/overtime/close-month", {
        employeeId,
        year: selectedYear,
        month: selectedMonth,
      });
      success = `${months[selectedMonth - 1]} ${selectedYear} erfolgreich abgeschlossen`;
      await loadStatus();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Monatsabschluss";
    } finally {
      closing = false;
      closingEmployeeId = null;
    }
  }

  async function closeAllReady() {
    closing = true;
    error = "";
    success = "";
    const readyEmployees = employeeStatuses.filter((e) => e.status === "ready");
    let succeeded = 0;
    let failed = 0;

    for (const emp of readyEmployees) {
      closingEmployeeId = emp.employeeId;
      try {
        await api.post("/overtime/close-month", {
          employeeId: emp.employeeId,
          year: selectedYear,
          month: selectedMonth,
        });
        succeeded++;
      } catch {
        failed++;
      }
    }

    success = `${months[selectedMonth - 1]} ${selectedYear}: ${succeeded} abgeschlossen${failed > 0 ? `, ${failed} fehlgeschlagen` : ""}`;
    closing = false;
    closingEmployeeId = null;
    await loadStatus();
  }

  function formatMissingDates(dates: string[]): string {
    return dates
      .map((d) => {
        const parts = d.split("-");
        return `${parts[2]}.${parts[1]}.`;
      })
      .join(", ");
  }

  function fmtHours(minutes: number): string {
    const h = Math.floor(Math.abs(minutes) / 60);
    const m = Math.abs(minutes) % 60;
    const sign = minutes < 0 ? "-" : "+";
    return `${sign}${h}:${String(Math.round(m)).padStart(2, "0")}`;
  }
</script>

<svelte:head><title>Monatsabschluss - Clokr</title></svelte:head>

<div class="ma-page">
  <h2 class="page-title">Monatsabschluss</h2>

  <div class="ma-controls">
    <div class="control-row">
      <label class="control-group">
        <span class="control-label">Jahr</span>
        <select class="form-select" bind:value={selectedYear} onchange={onYearChange}>
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </label>

      <label class="control-group">
        <span class="control-label">Monat</span>
        <select class="form-select" bind:value={selectedMonth} onchange={loadStatus}>
          {#each availableMonths as m (m.value)}
            <option value={m.value}>{m.name}</option>
          {/each}
        </select>
      </label>

      <div class="control-group control-action">
        <span class="control-label">&nbsp;</span>
        <button class="btn btn-primary" onclick={loadStatus} disabled={loading}>
          {loading ? "Wird geladen..." : "Status laden"}
        </button>
      </div>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}
  {#if success}
    <div class="alert alert-success">{success}</div>
  {/if}

  {#if loading}
    <div class="loading-indicator">Lade Status...</div>
  {:else if loaded}
    {#if employeeStatuses.length === 0}
      <p class="text-muted">Keine aktiven Mitarbeiter gefunden.</p>
    {:else}
      <!-- Summary bar -->
      <div class="summary-bar">
        <div class="summary-item summary-closed">
          <span class="summary-count">{closedCount}</span>
          <span class="summary-label">Abgeschlossen</span>
        </div>
        <div class="summary-item summary-ready">
          <span class="summary-count">{readyCount}</span>
          <span class="summary-label">Bereit</span>
        </div>
        <div class="summary-item summary-missing">
          <span class="summary-count">{missingCount}</span>
          <span class="summary-label">Fehlend</span>
        </div>
      </div>

      <!-- Employee table -->
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Personalnummer</th>
              <th>Status</th>
              <th>Fehlende Tage</th>
              <th>Saldo</th>
              <th class="text-right">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {#each employeeStatuses as emp (emp.employeeId)}
              <tr class="employee-row" class:row-closed={emp.status === "closed"}>
                <td class="employee-name">{emp.employeeName}</td>
                <td class="font-mono">{emp.employeeNumber}</td>
                <td>
                  {#if emp.status === "closed"}
                    <span class="status-badge status-closed">Abgeschlossen</span>
                  {:else if emp.status === "ready"}
                    <span class="status-badge status-ready">Bereit</span>
                  {:else}
                    <span class="status-badge status-missing">Fehlend</span>
                  {/if}
                </td>
                <td class="missing-dates">
                  {#if emp.missingDates && emp.missingDates.length > 0}
                    <span class="dates-text">{formatMissingDates(emp.missingDates)}</span>
                    <span class="dates-count">({emp.missingDates.length})</span>
                  {:else}
                    <span class="text-muted">-</span>
                  {/if}
                </td>
                <td class="font-mono">
                  {#if emp.snapshot}
                    <span
                      class:positive={emp.snapshot.balanceMinutes >= 0}
                      class:negative={emp.snapshot.balanceMinutes < 0}
                    >
                      {fmtHours(emp.snapshot.balanceMinutes)}
                    </span>
                  {:else}
                    <span class="text-muted">-</span>
                  {/if}
                </td>
                <td class="text-right">
                  {#if emp.status === "ready"}
                    <button
                      class="btn btn-sm btn-primary"
                      onclick={() => closeEmployee(emp.employeeId)}
                      disabled={closing}
                    >
                      {closingEmployeeId === emp.employeeId ? "..." : "Abschliessen"}
                    </button>
                  {:else if emp.status === "closed"}
                    <span class="text-muted text-sm">-</span>
                  {:else}
                    <button class="btn btn-sm btn-ghost" disabled> Fehlend </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <!-- Batch action bar -->
      {#if readyCount > 0}
        <div class="batch-bar">
          <span class="batch-info">
            {readyCount} Mitarbeiter bereit zum Abschluss
          </span>
          <button class="btn btn-primary" onclick={closeAllReady} disabled={closing}>
            {closing ? "Wird abgeschlossen..." : `Alle abschliessen (${readyCount})`}
          </button>
        </div>
      {/if}
    {/if}
  {:else}
    <p class="text-muted">Monat und Jahr auswahlen und "Status laden" klicken.</p>
  {/if}
</div>

<style>
  .ma-page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .page-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
  }

  .ma-controls {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .control-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 160px;
  }

  .control-action {
    min-width: auto;
  }

  .control-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .form-select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    background: var(--color-bg);
    font-size: 0.875rem;
    color: var(--color-text);
  }

  .alert {
    padding: 0.75rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }

  .alert-error {
    background: var(--red-50, #fef2f2);
    color: var(--red-700, #b91c1c);
    border: 1px solid var(--red-200, #fecaca);
  }

  .alert-success {
    background: var(--green-50, #f0fdf4);
    color: var(--green-700, #15803d);
    border: 1px solid var(--green-200, #bbf7d0);
  }

  .loading-indicator {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-muted);
    font-size: 0.9rem;
  }

  /* Summary bar */
  .summary-bar {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .summary-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.85rem;
    border: 1px solid var(--color-border);
  }

  .summary-count {
    font-weight: 700;
    font-size: 1.1rem;
  }

  .summary-label {
    color: var(--color-text-muted);
  }

  .summary-closed {
    background: var(--green-50, #f0fdf4);
    border-color: var(--green-200, #bbf7d0);
  }

  .summary-closed .summary-count {
    color: var(--green-700, #15803d);
  }

  .summary-ready {
    background: var(--blue-50, #eff6ff);
    border-color: var(--blue-200, #bfdbfe);
  }

  .summary-ready .summary-count {
    color: var(--blue-700, #1d4ed8);
  }

  .summary-missing {
    background: var(--red-50, #fef2f2);
    border-color: var(--red-200, #fecaca);
  }

  .summary-missing .summary-count {
    color: var(--red-700, #b91c1c);
  }

  /* Table */
  .table-wrapper {
    overflow-x: auto;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }

  .table th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 2px solid var(--color-border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  .table td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  .employee-row:hover {
    background: var(--gray-50, #f9fafb);
  }

  .row-closed {
    opacity: 0.7;
  }

  .employee-name {
    font-weight: 500;
  }

  .text-right {
    text-align: right;
  }

  .text-sm {
    font-size: 0.8rem;
  }

  .font-mono {
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
  }

  .text-muted {
    color: var(--color-text-muted);
    font-size: 0.85rem;
  }

  /* Status badges */
  .status-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .status-closed {
    background: var(--green-100, #dcfce7);
    color: var(--green-700, #15803d);
  }

  .status-ready {
    background: var(--blue-100, #dbeafe);
    color: var(--blue-700, #1d4ed8);
  }

  .status-missing {
    background: var(--red-100, #fee2e2);
    color: var(--red-700, #b91c1c);
  }

  /* Missing dates */
  .missing-dates {
    max-width: 280px;
  }

  .dates-text {
    font-size: 0.8rem;
    color: var(--red-600, #dc2626);
  }

  .dates-count {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-left: 0.25rem;
  }

  /* Saldo colors */
  .positive {
    color: var(--green-600, #16a34a);
  }

  .negative {
    color: var(--red-600, #dc2626);
  }

  /* Batch action bar */
  .batch-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    background: var(--blue-50, #eff6ff);
    border: 1px solid var(--blue-200, #bfdbfe);
    border-radius: 0.375rem;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .batch-info {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--blue-700, #1d4ed8);
  }

  /* Buttons (inherit from global styles, add size variants) */
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8rem;
  }
</style>
