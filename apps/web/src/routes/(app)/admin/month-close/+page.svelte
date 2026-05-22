<script lang="ts">
  import { api } from "$api/client";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

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

  // Per-employee closing state
  let closingEmployee = $state<string | null>(null);

  // Confirm modal state
  let confirmModalOpen = $state(false);
  let confirmMonth = $state<number | null>(null);
  let confirmEmployeeId = $state<string | null>(null);

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

  // 4-step stepper definitions (Prüfen → Korrigieren → Bestätigen → Sperren)
  const STEPS = [
    { label: "Prüfen", hint: "Vollständigkeit prüfen" },
    { label: "Korrigieren", hint: "Fehlende Einträge nachholen" },
    { label: "Bestätigen", hint: "Salden bestätigen" },
    { label: "Sperren", hint: "Monat isLocked=true setzen" },
  ];

  // Active step derived from the currently expanded month, or the first actionable one.
  // 0=Prüfen, 1=Korrigieren, 2=Bestätigen, 3=Sperren
  const activeStepIndex = $derived.by(() => {
    let ms: MonthStatus | undefined;
    if (expandedMonth != null) {
      ms = monthStatuses.find((m) => m.month === expandedMonth);
    } else if (firstActionableMonth != null) {
      ms = monthStatuses.find((m) => m.month === firstActionableMonth);
    }
    if (!ms) return 0;
    if (ms.status === "closed") return 3; // Sperren (done)
    if (ms.status === "ready") return 2; // Bestätigen (current)
    if (ms.status === "partial") return 1; // Korrigieren
    return 0; // Prüfen (default for open/blocked/no_data)
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

  // Confirm modal helpers
  let confirmTitle = $derived.by(() => {
    if (confirmMonth == null) return "Monat sperren";
    const ms = monthStatuses.find((m) => m.month === confirmMonth);
    const name = ms?.name ?? `Monat ${confirmMonth}`;
    if (confirmEmployeeId) {
      const emp = detailEmployees.find((e) => e.employeeId === confirmEmployeeId);
      return `${name} ${selectedYear} – ${emp?.employeeName ?? "Mitarbeiter"} sperren?`;
    }
    return `${name} ${selectedYear} sperren?`;
  });

  function openConfirmCloseMonth(month: number) {
    confirmMonth = month;
    confirmEmployeeId = null;
    confirmModalOpen = true;
  }

  function openConfirmCloseEmployee(employeeId: string, month: number) {
    confirmMonth = month;
    confirmEmployeeId = employeeId;
    confirmModalOpen = true;
  }

  function closeConfirmModal() {
    confirmModalOpen = false;
    confirmMonth = null;
    confirmEmployeeId = null;
  }

  async function onConfirmProceed() {
    if (confirmMonth == null) return;
    const month = confirmMonth;
    const empId = confirmEmployeeId;
    closeConfirmModal();
    if (empId) {
      await closeEmployee(empId, month);
    } else {
      await closeMonth(month);
    }
  }

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

  function statusChipClass(status: string): string {
    switch (status) {
      case "closed":
        return "chip chip-good";
      case "ready":
        return "chip chip-brand";
      case "partial":
        return "chip chip-warn";
      case "blocked":
        return "chip chip-warn";
      case "open":
        return "chip";
      case "future":
        return "chip";
      case "no_data":
        return "chip";
      default:
        return "chip";
    }
  }

  function reasonText(ms: MonthStatus): string {
    if (ms.status === "closed") return "—";
    if (ms.status === "future") return "—";
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
    return "—";
  }

  async function closeEmployee(employeeId: string, month: number) {
    closingEmployee = employeeId;
    error = "";
    success = "";
    try {
      await api.post("/overtime/close-month", {
        employeeId,
        year: selectedYear,
        month,
      });
      const monthName = monthStatuses.find((ms) => ms.month === month)?.name ?? `Monat ${month}`;
      success = `${monthName} ${selectedYear} für Mitarbeiter abgeschlossen`;
      await loadYearStatus();
      if (expandedMonth === month) {
        await toggleMonthDetail(month);
      }
    } catch {
      error = "Abschluss fehlgeschlagen";
    } finally {
      closingEmployee = null;
    }
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

<div class="page">
  <div class="ma-page">
    <PageHead
      eyebrow="Administration"
      title={`Monatsabschluss ${selectedYear}`}
      accent={String(selectedYear)}
      sub="Audit-proof monatlicher Abschluss: prüfen, Salden berechnen, bestätigen, sperren (isLocked=true). Nach dem Abschluss sind alle Einträge des Monats unveränderlich — Korrekturen nur per Stornobuchung."
    />

    <!-- 4-step visual stepper (v1.5 — circles + 2px rules, brand-soft halo on active, green on done) -->
    <Card animate class="stepper-card">
      <CardHeader title="Ablauf" sub="Vier Schritte zum Monatsabschluss" />
      <ol class="stepper">
        {#each STEPS as step, i (i)}
          <li class="step" class:active={i === activeStepIndex} class:done={i < activeStepIndex}>
            <div class="step-row">
              <span class="step-circle" aria-hidden="true">
                {#if i < activeStepIndex}
                  <svg viewBox="0 0 16 16" width="14" height="14"
                    ><path
                      d="M3 8l3 3 7-7"
                      stroke="currentColor"
                      stroke-width="2.5"
                      fill="none"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    /></svg
                  >
                {:else}
                  {i + 1}
                {/if}
              </span>
              <div class="step-text">
                <div class="step-eyebrow serif-eyebrow">Schritt {i + 1}</div>
                <div class="step-label">{step.label}</div>
                <div class="step-hint">{step.hint}</div>
              </div>
            </div>
            {#if i < STEPS.length - 1}
              <span class="step-connector" class:done={i < activeStepIndex} aria-hidden="true"
              ></span>
            {/if}
          </li>
        {/each}
      </ol>
    </Card>

    <!-- Year + Filter controls inside a v1.5 card -->
    <Card animate class="controls-card">
      <CardHeader title="Filter" sub="Jahr und Status wählen" />
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

        {#if autoCloseHint && loaded}
          <div class="callout brand">
            <div>
              <b>Automatischer Abschluss:</b>
              <p>{autoCloseHint}</p>
            </div>
          </div>
        {/if}
      </div>
    </Card>

    {#if error}
      <div class="callout error" role="alert">
        <div><p>{error}</p></div>
      </div>
    {/if}
    {#if success}
      <div class="callout brand" role="status">
        <div><p>{success}</p></div>
      </div>
    {/if}

    {#if closing}
      <Card animate class="progress-card">
        <CardHeader
          title="Abschluss läuft"
          sub={`${closingProgress} von ${closingTotal} Mitarbeitern verarbeitet`}
        />
        <div class="progress-bar-track">
          <div
            class="progress-bar-fill"
            style="width: {closingTotal > 0 ? (closingProgress / closingTotal) * 100 : 0}%"
          ></div>
        </div>
      </Card>
    {/if}

    {#if loading}
      <Card animate class="loading-placeholder">
        <div class="loading-spacer"></div>
      </Card>
    {:else if loaded}
      {#if monthStatuses.length === 0}
        <Card animate>
          <p class="text-muted">Keine Daten verfügbar.</p>
        </Card>
      {:else}
        <Card animate class="list-card">
          <CardHeader
            title={`Monate ${selectedYear}`}
            sub={`${closedMonthCount} abgeschlossen · ${openMonthCount} offen · ${monthStatuses.length} gesamt`}
          />

          <div class="table-wrapper">
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
                      <span class={statusChipClass(ms.status)}>
                        <span class="dot"></span>
                        {statusLabel(ms.status)} ({ms.closedCount}/{ms.totalCount})
                      </span>
                    </td>
                    <td class="reason-cell">
                      <span class="reason-text">{reasonText(ms)}</span>
                    </td>
                    <td class="text-right">
                      {#if (ms.status === "ready" || ms.status === "partial" || ms.status === "open") && ms.month === firstActionableMonth}
                        <button
                          class="btn btn-primary btn-sm"
                          disabled={closing}
                          onclick={(e: MouseEvent) => {
                            e.stopPropagation();
                            openConfirmCloseMonth(ms.month);
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
                        {#if ms.status === "ready"}
                          <div class="detail-callout-wrapper">
                            <div class="callout warn">
                              <div>
                                <b>Achtung: Endgültiger Abschluss.</b>
                                <p>
                                  Mit dem Abschluss werden alle Zeiteinträge dieses Monats gesperrt
                                  (isLocked=true) und das Audit-Log fortgeschrieben. Änderungen sind
                                  danach nur noch durch Storno-Buchungen möglich (CLAUDE.md
                                  Audit-Proof / Revisionssicherheit).
                                </p>
                              </div>
                            </div>
                          </div>
                        {/if}
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
                                        <span class="chip chip-good">
                                          <span class="dot"></span>
                                          Abgeschlossen
                                        </span>
                                      {:else if emp.status === "ready"}
                                        <span class="chip chip-brand">
                                          <span class="dot"></span>
                                          Bereit
                                        </span>
                                      {:else}
                                        <span class="chip">
                                          <span class="dot"></span>
                                          Fehlend
                                        </span>
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
                                      {#if emp.status === "ready"}
                                        <button
                                          class="btn btn-primary btn-sm"
                                          disabled={closingEmployee === emp.employeeId || closing}
                                          onclick={() =>
                                            openConfirmCloseEmployee(
                                              emp.employeeId,
                                              expandedMonth!,
                                            )}
                                        >
                                          {closingEmployee === emp.employeeId
                                            ? "..."
                                            : "Abschließen"}
                                        </button>
                                      {:else if emp.status === "closed"}
                                        <button
                                          class="btn btn-outline btn-sm"
                                          disabled={unlocking === emp.employeeId}
                                          onclick={() =>
                                            unlockEmployee(emp.employeeId, expandedMonth!)}
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
          </div>
          <div class="list-foot">
            <Pagination
              total={filteredMonths.length}
              bind:page={maPage}
              bind:pageSize={maPageSize}
            />
          </div>
        </Card>
      {/if}
    {:else}
      <Card animate>
        <p class="text-muted">Lade Jahresstatus...</p>
      </Card>
    {/if}
  </div>

  <!-- ── Confirm modal (v1.5 — uses Modal primitive) ─────── -->
  <Modal bind:open={confirmModalOpen} eyebrow="Endgültiger Monatsabschluss" title={confirmTitle}>
    <div class="callout warn" role="alert">
      <div>
        <b>Diese Aktion ist nicht rückgängig.</b>
        <p>
          Alle Zeiteinträge dieses Monats werden gesperrt (<span class="font-mono"
            >isLocked=true</span
          >). Korrekturen sind danach nur noch durch Storno-Buchungen möglich (Audit-Proof /
          Revisionssicherheit).
        </p>
      </div>
    </div>
    <p class="modal-note">
      Bitte stelle sicher, dass alle Salden und fehlenden Einträge vor dem Sperren geprüft wurden.
    </p>
    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeConfirmModal} disabled={closing}>Abbrechen</button
      >
      <button class="btn btn-primary" onclick={onConfirmProceed} disabled={closing}>
        {#if closing}<Spinner />{/if}
        Endgültig sperren
      </button>
    {/snippet}
  </Modal>
</div>

<style>
  .ma-page {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* ─── Stepper (v1.5 — circles + 2px rules, brand-soft halo on active, green on done) ─── */
  .stepper {
    list-style: none;
    margin: 0;
    padding: 4px 0 4px;
    display: flex;
    align-items: flex-start;
    gap: 0;
  }

  .step {
    flex: 1;
    display: flex;
    align-items: stretch;
    position: relative;
    min-width: 0;
  }

  .step-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex: 1;
    min-width: 0;
    position: relative;
    z-index: 1;
  }

  .step-circle {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--bg-subtle);
    color: var(--text-faint);
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 13px;
    border: 1px solid var(--border);
    transition:
      background 180ms var(--ease, ease),
      color 180ms var(--ease, ease),
      border-color 180ms var(--ease, ease),
      border-width 180ms var(--ease, ease);
  }

  .step.active .step-circle {
    background: var(--brand);
    color: var(--text-on-brand);
    border: 3px solid var(--brand-soft);
  }

  .step.done .step-circle {
    background: var(--good);
    color: var(--text-on-brand);
    border-color: var(--good);
  }

  .step-text {
    min-width: 0;
    flex: 1;
  }

  .step-eyebrow {
    font-size: 11px;
    line-height: 1;
    margin-bottom: 2px;
  }

  .step-label {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-top: 2px;
  }

  .step:not(.active):not(.done) .step-label {
    color: var(--text-muted);
  }

  .step-hint {
    font-family: var(--font-sans);
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .step-connector {
    position: absolute;
    left: 42px;
    right: -4px;
    top: 15px;
    height: 2px;
    background: var(--border);
    border-radius: var(--r-pill);
    z-index: 0;
  }

  .step-connector.done {
    background: var(--brand);
  }

  @media (max-width: 720px) {
    .stepper {
      flex-direction: column;
      gap: 12px;
    }
    .step-connector {
      display: none;
    }
  }

  /* ─── Controls card ─────────────────────────────────── */
  .ma-controls {
    display: flex;
    flex-direction: column;
    gap: 12px;
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
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .form-select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--bg-card);
    font-family: var(--font-sans);
    font-size: 0.875rem;
    color: var(--text);
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .form-select:focus {
    border-color: var(--brand);
    box-shadow: 0 0 0 3px var(--brand-soft);
    outline: none;
  }

  /* ─── Progress card ──────────────────────────────────── */
  .progress-bar-track {
    height: 0.5rem;
    background: var(--bg-subtle);
    border-radius: var(--r-pill);
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: var(--brand);
    border-radius: var(--r-pill);
    transition: width 0.3s ease;
  }

  /* ─── List card / table ─────────────────────────────── */
  /* list-card: kill default card padding so the table fills the card; use
     :global() because the .card section is rendered by the Card primitive. */
  :global(.list-card) {
    padding: 0;
  }

  /* CardHeader (also from primitive) needs an inset edge for list-card layout. */
  :global(.list-card .card-hd) {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
  }

  .loading-spacer {
    height: 200px;
  }

  .list-foot {
    padding: 8px 16px 16px;
  }

  .table-wrapper {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-sans);
    font-size: 0.875rem;
  }

  .table th {
    text-align: left;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--bg-subtle);
  }

  .table td {
    padding: 0.625rem 1rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .month-row {
    transition: background 0.15s ease;
  }

  .row-clickable {
    cursor: pointer;
  }

  .row-clickable:hover {
    background: var(--brand-soft);
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
    color: var(--text-muted);
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
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  /* ─── Reason column ─────────────────────────────────── */
  .reason-cell {
    max-width: 400px;
  }

  .reason-text {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* ─── Detail row ────────────────────────────────────── */
  .detail-row td {
    padding: 0;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border);
  }

  .detail-callout-wrapper {
    padding: 12px 16px 0;
  }

  .detail-loading,
  .detail-empty {
    padding: 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .detail-table-wrapper {
    padding: 0.5rem 1rem 1rem;
  }

  .detail-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-sans);
    font-size: 0.8rem;
  }

  .detail-table th {
    text-align: left;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .detail-table td {
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .detail-row-closed {
    opacity: 0.6;
  }

  .employee-name {
    font-weight: 500;
  }

  /* ─── Missing dates ────────────────────────────────── */
  .missing-dates {
    max-width: 320px;
  }

  .dates-text {
    font-size: 0.8rem;
    color: var(--bad, var(--warn));
  }

  .dates-count {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }

  /* ─── Buttons ──────────────────────────────────────── */
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8rem;
  }

  /* ─── Modal body helper (Modal primitive owns backdrop/card/header/footer) ────── */
  .modal-note {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 0.875rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  @media (max-width: 640px) {
    .control-row {
      flex-direction: column;
      align-items: stretch;
    }

    .control-group {
      min-width: 0;
    }

    .reason-cell {
      max-width: none;
    }
  }
</style>
