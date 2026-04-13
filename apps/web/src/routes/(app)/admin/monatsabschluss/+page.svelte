<script lang="ts">
  import { api } from "$api/client";
  import Pagination from "$components/ui/Pagination.svelte";

  interface MissingEmployee {
    employeeName: string;
    employeeNumber: string;
    missingDates: string[];
  }

  interface MonthStatus {
    month: number;
    name: string;
    status: "closed" | "partial" | "ready" | "open" | "blocked" | "future" | "no_data";
    closedCount: number;
    totalCount: number;
    missing?: MissingEmployee[];
  }

  interface YearStatusResponse {
    year: number;
    months: MonthStatus[];
    autoCloseDeadline: number;
    earliestYear: number;
  }

  interface EmployeeStatus {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    status: "ready" | "missing" | "closed";
    missingDates?: string[];
  }

  interface MonthDetailResponse {
    year: number;
    month: number;
    employees: EmployeeStatus[];
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();

  let selectedYear = $state(currentYear);
  let loading = $state(false);
  let error = $state("");
  let success = $state("");
  let monthStatuses: MonthStatus[] = $state([]);
  let loaded = $state(false);
  let earliestYear = $state(currentYear);

  // Expanded month detail
  let expandedMonth = $state<number | null>(null);
  let detailLoading = $state(false);
  let detailEmployees: EmployeeStatus[] = $state([]);

  // Closing state
  let closing = $state(false);
  let closingProgress = $state(0);
  let closingTotal = $state(0);

  // Unlocking state (tracks employeeId being unlocked)
  let unlocking = $state<string | null>(null);

  const years = $derived(
    Array.from({ length: currentYear - earliestYear + 1 }, (_, i) => currentYear - i),
  );

  // Status filter
  let statusFilter = $state("all");
  const filterOptions = [
    { value: "all", label: "Alle" },
    { value: "open", label: "Offen / Fehlend" },
    { value: "closed", label: "Abgeschlossen" },
    { value: "actionable", label: "Handlungsbedarf" },
  ];

  let filteredMonths = $derived.by(() => {
    if (statusFilter === "all") return monthStatuses;
    if (statusFilter === "open")
      return monthStatuses.filter((ms) =>
        ["open", "partial", "ready", "blocked"].includes(ms.status),
      );
    if (statusFilter === "closed") return monthStatuses.filter((ms) => ms.status === "closed");
    if (statusFilter === "actionable")
      return monthStatuses.filter((ms) => ["open", "partial", "ready"].includes(ms.status));
    return monthStatuses;
  });

  // Pagination for month status list
  let maPage = $state(1);
  let maPageSize = $state(10);
  let pagedMonths = $derived(filteredMonths.slice((maPage - 1) * maPageSize, maPage * maPageSize));

  $effect(() => {
    const _len = filteredMonths.length;
    maPage = 1;
  });

  // Summary counts
  let closedMonthCount = $derived(monthStatuses.filter((ms) => ms.status === "closed").length);
  let openMonthCount = $derived(
    monthStatuses.filter((ms) => ["open", "partial", "ready"].includes(ms.status)).length,
  );

  // Determine the first actionable month (first open/ready/partial month)
  let firstActionableMonth = $derived.by(() => {
    for (const ms of monthStatuses) {
      if (ms.status === "open" || ms.status === "ready" || ms.status === "partial") {
        return ms.month;
      }
    }
    return null;
  });

  // Auto-close hint
  let autoCloseHint = $derived.by(() => {
    const hasOpenMonths = monthStatuses.some(
      (ms) => ms.status === "open" || ms.status === "ready" || ms.status === "partial",
    );
    if (!hasOpenMonths) return null;
    if (currentDay <= 10) {
      return "Automatischer Abschluss versucht es bis zum 10.";
    }
    return "Nur noch manuell möglich";
  });

  async function loadYearStatus() {
    loading = true;
    error = "";
    success = "";
    loaded = false;
    expandedMonth = null;
    detailEmployees = [];
    try {
      const res = await api.get<YearStatusResponse>(
        `/overtime/close-month/year-status?year=${selectedYear}`,
      );
      monthStatuses = res.months;
      if (res.earliestYear) earliestYear = res.earliestYear;
      loaded = true;
    } catch {
      error = "Jahresstatus konnte nicht geladen werden";
    } finally {
      loading = false;
    }
  }

  function onYearChange() {
    loadYearStatus();
  }

  async function toggleMonthDetail(month: number) {
    if (expandedMonth === month) {
      expandedMonth = null;
      detailEmployees = [];
      return;
    }

    expandedMonth = month;
    detailLoading = true;
    detailEmployees = [];
    try {
      const res = await api.get<MonthDetailResponse>(
        `/overtime/close-month/status?year=${selectedYear}&month=${month}`,
      );
      detailEmployees = res.employees;
    } catch {
      error = "Details konnten nicht geladen werden";
    } finally {
      detailLoading = false;
    }
  }

  async function closeMonth(month: number) {
    closing = true;
    closingProgress = 0;
    error = "";
    success = "";

    // Load the month detail to find ready employees
    try {
      const res = await api.get<MonthDetailResponse>(
        `/overtime/close-month/status?year=${selectedYear}&month=${month}`,
      );
      const readyEmployees = res.employees.filter((e) => e.status === "ready");
      closingTotal = readyEmployees.length;

      if (readyEmployees.length === 0) {
        error = "Keine Mitarbeiter bereit zum Abschluss";
        closing = false;
        return;
      }

      let succeeded = 0;
      let failed = 0;

      for (const emp of readyEmployees) {
        try {
          await api.post("/overtime/close-month", {
            employeeId: emp.employeeId,
            year: selectedYear,
            month,
          });
          succeeded++;
        } catch {
          failed++;
        }
        closingProgress = succeeded + failed;
      }

      const monthName = monthStatuses.find((ms) => ms.month === month)?.name ?? `Monat ${month}`;
      success = `${monthName} ${selectedYear}: ${succeeded} abgeschlossen${failed > 0 ? `, ${failed} fehlgeschlagen` : ""}`;

      // Reload year status and detail
      await loadYearStatus();
      if (expandedMonth === month) {
        await toggleMonthDetail(month);
      }
    } catch {
      error = "Fehler beim Monatsabschluss";
    } finally {
      closing = false;
      closingProgress = 0;
      closingTotal = 0;
    }
  }

  function formatMissingDates(dates: string[]): string {
    return dates
      .map((d) => {
        const parts = d.split("-");
        return `${parts[2]}.${parts[1]}.`;
      })
      .join(", ");
  }

  function formatMissingShort(dates: string[]): string {
    if (dates.length <= 3) {
      return formatMissingDates(dates);
    }
    const first3 = dates.slice(0, 3);
    return formatMissingDates(first3) + ` (+${dates.length - 3})`;
  }

  function statusLabel(status: string): string {
    switch (status) {
      case "closed":
        return "Abgeschlossen";
      case "partial":
        return "Teilweise";
      case "ready":
        return "Bereit";
      case "open":
        return "Offen";
      case "blocked":
        return "Blockiert";
      case "future":
        return "Zukunft";
      case "no_data":
        return "Keine Daten";
      default:
        return status;
    }
  }

  function statusIcon(status: string): string {
    switch (status) {
      case "closed":
        return "\u2705";
      case "partial":
        return "\u26a0\ufe0f";
      case "ready":
        return "\ud83d\udfe2";
      case "open":
        return "\u274c";
      case "blocked":
        return "\ud83d\udd12";
      case "future":
        return "\u2014";
      case "no_data":
        return "\u2014";
      default:
        return "";
    }
  }

  function reasonText(ms: MonthStatus): string {
    if (ms.status === "closed") return "\u2014";
    if (ms.status === "future") return "\u2014";
    if (ms.status === "no_data") return "Keine Erfassung in diesem Zeitraum";
    if (ms.status === "blocked") {
      // Find the first non-closed month before this one
      const prev = monthStatuses.find(
        (p) => p.month < ms.month && p.status !== "closed" && p.status !== "future",
      );
      return prev ? `${prev.name} noch offen` : "Vorheriger Monat noch offen";
    }
    if (ms.status === "open" && ms.missing && ms.missing.length > 0) {
      return ms.missing
        .map((m) => `${shortenName(m.employeeName)}: ${formatMissingShort(m.missingDates)}`)
        .join("; ");
    }
    if (ms.status === "partial") {
      return `${ms.closedCount} von ${ms.totalCount} abgeschlossen`;
    }
    if (ms.status === "ready") {
      return "Alle Mitarbeiter bereit";
    }
    return "\u2014";
  }

  async function unlockEmployee(employeeId: string, month: number) {
    unlocking = employeeId;
    error = "";
    success = "";
    try {
      await api.post("/overtime/unlock-month", {
        employeeId,
        year: selectedYear,
        month,
      });
      const monthName = monthStatuses.find((ms) => ms.month === month)?.name ?? `Monat ${month}`;
      success = `${monthName} ${selectedYear} für Mitarbeiter entsperrt`;
      await loadYearStatus();
      if (expandedMonth === month) {
        await toggleMonthDetail(month);
      }
    } catch {
      error = "Entsperren fehlgeschlagen";
    } finally {
      unlocking = null;
    }
  }

  function shortenName(name: string): string {
    const parts = name.split(" ");
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
    }
    return name;
  }

  loadYearStatus();
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
        <span class="control-label">Filter</span>
        <select class="form-select" bind:value={statusFilter}>
          {#each filterOptions as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>

      <div class="control-group control-action">
        <span class="control-label">&nbsp;</span>
        <button class="btn btn-primary" onclick={loadYearStatus} disabled={loading}>
          {loading ? "Wird geladen..." : "Aktualisieren"}
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

  {#if closing}
    <div class="progress-bar-wrapper">
      <div class="progress-bar-label">
        Abschluss läuft... {closingProgress}/{closingTotal}
      </div>
      <div class="progress-bar-track">
        <div
          class="progress-bar-fill"
          style="width: {closingTotal > 0 ? (closingProgress / closingTotal) * 100 : 0}%"
        ></div>
      </div>
    </div>
  {/if}

  {#if autoCloseHint && loaded}
    <div class="auto-close-hint">
      {autoCloseHint}
    </div>
  {/if}

  {#if loading}
    <div class="card card-body" style="height:200px;"></div>
  {:else if loaded}
    {#if monthStatuses.length === 0}
      <p class="text-muted">Keine Daten verfügbar.</p>
    {:else}
      <div class="summary-bar card-animate">
        <span class="summary-item summary-closed">{closedMonthCount} abgeschlossen</span>
        <span class="summary-item summary-open">{openMonthCount} offen</span>
        <span class="summary-item summary-total">{monthStatuses.length} gesamt</span>
      </div>

      <div class="table-wrapper card-animate">
        <table class="table">
          <thead>
            <tr>
              <th>Monat</th>
              <th>Status</th>
              <th>Grund</th>
              <th class="text-right">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {#each pagedMonths as ms (ms.month)}
              <tr
                class="month-row"
                class:row-closed={ms.status === "closed"}
                class:row-future={ms.status === "future" || ms.status === "no_data"}
                class:row-blocked={ms.status === "blocked"}
                class:row-clickable={ms.status !== "future" && ms.status !== "no_data"}
                onclick={() => {
                  if (ms.status !== "future" && ms.status !== "no_data")
                    toggleMonthDetail(ms.month);
                }}
              >
                <td class="month-name">
                  <span class="month-expand-icon">
                    {#if expandedMonth === ms.month}
                      &#9660;
                    {:else if ms.status !== "future" && ms.status !== "no_data"}
                      &#9654;
                    {/if}
                  </span>
                  {ms.name}
                  {selectedYear}
                </td>
                <td>
                  <span class="status-badge status-{ms.status}">
                    {statusIcon(ms.status)}
                    {statusLabel(ms.status)} ({ms.closedCount}/{ms.totalCount})
                  </span>
                </td>
                <td class="reason-cell">
                  <span class="reason-text">{reasonText(ms)}</span>
                </td>
                <td class="text-right">
                  {#if (ms.status === "ready" || ms.status === "partial" || ms.status === "open") && ms.month === firstActionableMonth}
                    <button
                      class="btn btn-sm btn-primary"
                      disabled={closing}
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        closeMonth(ms.month);
                      }}
                    >
                      Abschließen
                    </button>
                  {:else}
                    <span class="text-muted text-sm">&mdash;</span>
                  {/if}
                </td>
              </tr>
              {#if expandedMonth === ms.month}
                <tr class="detail-row">
                  <td colspan="4">
                    {#if detailLoading}
                      <div class="detail-loading">Lade Details...</div>
                    {:else if detailEmployees.length === 0}
                      <div class="detail-empty">Keine Mitarbeiter gefunden.</div>
                    {:else}
                      <div class="detail-table-wrapper">
                        <table class="detail-table">
                          <thead>
                            <tr>
                              <th>Name</th>
                              <th>Personalnummer</th>
                              <th>Status</th>
                              <th>Fehlende Tage</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each detailEmployees as emp (emp.employeeId)}
                              <tr class:detail-row-closed={emp.status === "closed"}>
                                <td class="employee-name">{emp.employeeName}</td>
                                <td class="font-mono">{emp.employeeNumber}</td>
                                <td>
                                  {#if emp.status === "closed"}
                                    <span class="status-badge status-closed">Abgeschlossen</span>
                                  {:else if emp.status === "ready"}
                                    <span class="status-badge status-ready">Bereit</span>
                                  {:else}
                                    <span class="status-badge status-open">Fehlend</span>
                                  {/if}
                                </td>
                                <td class="missing-dates">
                                  {#if emp.missingDates && emp.missingDates.length > 0}
                                    <span class="dates-text"
                                      >{formatMissingDates(emp.missingDates)}</span
                                    >
                                    <span class="dates-count">({emp.missingDates.length})</span>
                                  {:else}
                                    <span class="text-muted">-</span>
                                  {/if}
                                </td>
                                <td class="text-right">
                                  {#if emp.status === "closed"}
                                    <button
                                      class="btn btn-sm btn-ghost"
                                      disabled={unlocking === emp.employeeId}
                                      onclick={() => unlockEmployee(emp.employeeId, expandedMonth!)}
                                    >
                                      {unlocking === emp.employeeId ? "..." : "Entsperren"}
                                    </button>
                                  {/if}
                                </td>
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
        <Pagination total={filteredMonths.length} bind:page={maPage} bind:pageSize={maPageSize} />
      </div>
    {/if}
  {:else}
    <p class="text-muted">Lade Jahresstatus...</p>
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
    border-radius: var(--radius-sm, 8px);
    background: var(--color-surface, var(--color-bg));
    font-size: 0.875rem;
    color: var(--color-text);
    font-family: var(--font-sans);
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .form-select:focus {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 3px var(--color-brand-tint);
    outline: none;
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

  .auto-close-hint {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    background: var(--yellow-50, #fefce8);
    color: var(--yellow-800, #854d0e);
    border: 1px solid var(--yellow-200, #fef08a);
  }

  /* Progress bar */
  .progress-bar-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .progress-bar-label {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-text-muted);
  }

  .progress-bar-track {
    height: 0.5rem;
    background: var(--gray-200, #e5e7eb);
    border-radius: 0.25rem;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--blue-500, #3b82f6);
    border-radius: 0.25rem;
    transition: width 0.3s ease;
  }

  /* Table */
  .table-wrapper {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    border-radius: var(--radius-md, 14px);
    border: 1px solid var(--glass-border, var(--color-border));
    box-shadow: var(--shadow-xs, 0 1px 3px rgba(0, 0, 0, 0.06));
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .table th {
    text-align: left;
    padding: 0.75rem 1rem;
    border-bottom: 2px solid var(--color-border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    background: var(--gray-50, #f9fafb);
  }

  .table td {
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
    vertical-align: middle;
  }

  .table tbody tr:nth-child(even) {
    background-color: var(--gray-50, #f9fafb);
  }

  .month-row {
    transition: background 0.15s ease;
  }

  .row-clickable {
    cursor: pointer;
  }

  .row-clickable:hover {
    background: var(--color-brand-tint, #f5f3ff) !important;
  }

  .row-closed {
    opacity: 0.7;
  }

  .row-future {
    opacity: 0.5;
  }

  .row-blocked {
    opacity: 0.6;
  }

  .month-name {
    font-weight: 500;
    white-space: nowrap;
  }

  .month-expand-icon {
    display: inline-block;
    width: 1rem;
    font-size: 0.65rem;
    color: var(--color-text-muted);
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
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.01em;
    transition: all 0.15s ease;
  }

  .status-closed {
    background: var(--color-green-bg, #dcfce7);
    color: var(--color-green, #15803d);
    border: 1px solid var(--color-green-border, #bbf7d0);
  }

  .status-partial {
    background: var(--color-yellow-bg, #fef9c3);
    color: var(--color-yellow, #854d0e);
    border: 1px solid var(--color-yellow-border, #fef08a);
  }

  .status-ready {
    background: var(--color-blue-bg, #dbeafe);
    color: var(--color-blue, #1d4ed8);
    border: 1px solid var(--color-blue-border, #bfdbfe);
  }

  .status-open {
    background: var(--color-red-bg, #fee2e2);
    color: var(--color-red, #b91c1c);
    border: 1px solid var(--color-red-border, #fecaca);
  }

  .status-blocked {
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-500, #6b7280);
    border: 1px solid var(--gray-200, #e5e7eb);
  }

  .status-future {
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-400, #9ca3af);
    border: 1px solid var(--gray-200, #e5e7eb);
  }

  .status-no_data {
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-400, #9ca3af);
    border: 1px solid var(--gray-200, #e5e7eb);
  }

  /* Reason column */
  .reason-cell {
    max-width: 400px;
  }

  .reason-text {
    font-size: 0.8rem;
    color: var(--color-text-muted);
  }

  /* Detail row */
  .detail-row td {
    padding: 0;
    background: var(--gray-50, #f9fafb);
    border-bottom: 2px solid var(--color-border);
  }

  .detail-loading,
  .detail-empty {
    padding: 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }

  .detail-table-wrapper {
    padding: 0.5rem 1rem 1rem;
  }

  .detail-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  .detail-table th {
    text-align: left;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  .detail-table td {
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    vertical-align: middle;
  }

  .detail-row-closed {
    opacity: 0.6;
  }

  .employee-name {
    font-weight: 500;
  }

  /* Missing dates */
  .missing-dates {
    max-width: 320px;
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

  /* Buttons */
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8rem;
  }

  /* Summary bar */
  .summary-bar {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }
  .summary-item {
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm, 8px);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    box-shadow: var(--shadow-xs, 0 1px 3px rgba(0, 0, 0, 0.06));
  }
  .summary-closed {
    background: var(--color-green-bg, #f0fdf4);
    color: var(--color-green, #15803d);
    border: 1px solid var(--color-green-border, #bbf7d0);
  }
  .summary-open {
    background: var(--color-red-bg, #fef2f2);
    color: var(--color-red, #b91c1c);
    border: 1px solid var(--color-red-border, #fecaca);
  }
  .summary-total {
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-600, #4b5563);
    border: 1px solid var(--gray-200, #e5e7eb);
  }

  @media (max-width: 640px) {
    .control-row {
      flex-direction: column;
      align-items: stretch;
    }

    .control-group {
      min-width: 0;
    }

    .summary-bar {
      flex-wrap: wrap;
    }

    .reason-cell {
      max-width: none;
    }
  }
</style>
