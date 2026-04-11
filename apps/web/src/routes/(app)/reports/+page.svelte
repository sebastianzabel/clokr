<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { get as getStore } from "svelte/store";
  import Pagination from "$components/ui/Pagination.svelte";
  import {
    Chart,
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
    Tooltip,
    Legend,
  } from "chart.js";

  Chart.register(
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
    Tooltip,
    Legend,
  );

  // ── Types ──────────────────────────────────────────────────────────────────

  interface MonthlyRow {
    employeeId: string;
    employeeName: string;
    workedHours: number;
    shouldHours: number;
    sickDays: number;
    sickDaysWithAttest: number;
    sickDaysWithoutAttest: number;
    vacationDays: number;
  }

  interface MonthlyReport {
    month: number;
    year: number;
    rows: MonthlyRow[];
  }

  type TodayEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    status: "present" | "absent" | "clocked_in" | "missing" | "scheduled" | "none" | "holiday";
    reason: string | null;
  };

  type TodayAttendance = {
    date: string;
    employees: TodayEmployee[];
    summary: { present: number; absent: number; clockedIn: number; missing: number; holiday: number };
  };

  type OvertimeEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    balanceHours: number;
    status: "NORMAL" | "ELEVATED" | "CRITICAL";
    snapshots: Array<{ periodStart: string; balanceMinutes: number; carryOver: number }>;
  };

  type OvertimeOverview = { employees: OvertimeEmployee[] };

  type LeaveOverviewRow = {
    employee: { firstName: string; lastName: string; employeeNumber: string };
    leaveType: { id: string; name: string };
    year: number;
    totalDays: number;
    carriedOverDays: number;
    usedDays: number;
    remainingDays: number;
    pendingDays: number;
  };

  // ── Existing state ─────────────────────────────────────────────────────────

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  let reportMonth = $state(currentMonth);
  let reportYear = $state(currentYear);
  let datevMonth = $state(currentMonth);
  let datevYear = $state(currentYear);

  let monthlyReport: MonthlyReport | null = $state(null);
  let reportLoading = $state(false);
  let reportError = $state("");

  let datevLoading = $state(false);
  let datevError = $state("");

  // Urlaubsbericht PDF (kombiniert: Urlaubsliste + Urlaubsübersicht)
  let leaveYear = $state(currentYear);
  let leaveLoading = $state(false);
  let leaveError = $state("");

  // Company monthly PDF (Firmenweiter Monatsbericht) — PDF-01 / PDF-03
  let companyPdfMonth = $state(currentMonth);
  let companyPdfYear = $state(currentYear);
  let companyPdfRole = $state<"all" | "EMPLOYEE" | "MANAGER">("all");
  let companyPdfLoading = $state(false);
  let companyPdfError = $state("");

  let pdfDownloading = $state<string | null>(null);

  // Pagination for monthly report rows
  let reportPage = $state(1);
  let reportPageSize = $state(10);
  let reportRows: MonthlyRow[] = $derived(monthlyReport !== null ? (monthlyReport as MonthlyReport).rows : []);
  let pagedReportRows = $derived(
    reportRows.slice((reportPage - 1) * reportPageSize, reportPage * reportPageSize),
  );

  $effect(() => {
    const _len = reportRows.length;
    reportPage = 1;
  });

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

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  // ── Role guard ─────────────────────────────────────────────────────────────

  let currentRole = $state<string | null>(null);
  let isManager = $derived(currentRole === "ADMIN" || currentRole === "MANAGER");

  // ── Heutige Anwesenheit state (RPT-03) ─────────────────────────────────────

  let todayAttendance: TodayAttendance | null = $state(null);
  let todayLoading = $state(false);
  let todayError = $state("");

  // ── Überstunden-Übersicht state (RPT-01 + SALDO-03) ───────────────────────

  let overtimeOverview: OvertimeOverview | null = $state(null);
  let overtimeLoading = $state(false);
  let overtimeError = $state("");

  let sortColumn: "name" | "balance" = $state("name");
  let sortDir: "asc" | "desc" = $state("asc");

  let sortedOvertime = $derived.by(() => {
    const rows = overtimeOverview?.employees ?? [];
    const copy = rows.slice();
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortColumn === "name") cmp = a.name.localeCompare(b.name, "de");
      else cmp = a.balanceHours - b.balanceHours;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  });

  // ── Urlaubsübersicht state (RPT-02) ──────────────────────────────────────

  let leaveOverviewYear = $state(currentYear);
  let leaveOverview: LeaveOverviewRow[] | null = $state(null);
  let leaveOverviewLoading = $state(false);
  let leaveOverviewError = $state("");

  let leaveOverviewRows = $derived.by(() => {
    const rows = leaveOverview ?? [];
    return rows.slice().sort((a, b) => {
      const ln = a.employee.lastName.localeCompare(b.employee.lastName, "de");
      if (ln !== 0) return ln;
      const fn = a.employee.firstName.localeCompare(b.employee.firstName, "de");
      if (fn !== 0) return fn;
      return a.leaveType.name.localeCompare(b.leaveType.name, "de");
    });
  });

  // Map<employeeId, Chart> — key is employeeId so re-sort doesn't break identity
  const sparklineCharts = new Map<string, Chart>();
  // Canvas refs captured via use:registerCanvas action in {#each}
  const sparklineCanvases = new Map<string, HTMLCanvasElement>();

  function registerCanvas(el: HTMLCanvasElement, empId: string) {
    sparklineCanvases.set(empId, el);
    return {
      destroy() {
        sparklineCanvases.delete(empId);
      },
    };
  }

  // ── onMount ────────────────────────────────────────────────────────────────

  onMount(async () => {
    const auth = getStore(authStore);
    currentRole = auth.user?.role ?? null;
    if (isManager) {
      await loadTodayAttendance();
      await loadOvertimeOverview();
      await loadLeaveOverview();
    }
  });

  onDestroy(() => {
    for (const chart of sparklineCharts.values()) chart.destroy();
    sparklineCharts.clear();
    sparklineCanvases.clear();
  });

  // ── Sparkline lifecycle ────────────────────────────────────────────────────

  $effect(() => {
    const rows = sortedOvertime;
    void tick().then(() => {
      // Destroy charts for employees that disappeared
      for (const [empId, chart] of sparklineCharts.entries()) {
        if (!rows.some((r) => r.id === empId)) {
          chart.destroy();
          sparklineCharts.delete(empId);
        }
      }
      // (Re)create chart for every visible row with >=2 snapshots
      for (const row of rows) {
        const canvas = sparklineCanvases.get(row.id);
        if (!canvas) continue;
        if (row.snapshots.length < 2) {
          const stale = sparklineCharts.get(row.id);
          if (stale) {
            stale.destroy();
            sparklineCharts.delete(row.id);
          }
          continue;
        }
        // Always destroy previous Chart before creating a new one
        const existing = sparklineCharts.get(row.id);
        if (existing) {
          existing.destroy();
          sparklineCharts.delete(row.id);
        }

        const labels = row.snapshots.map((s) => s.periodStart.slice(0, 7));
        const data = row.snapshots.map((s) => s.carryOver / 60);

        const brandColor =
          getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() ||
          "#8b5a8c";

        const chart = new Chart(canvas, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                data,
                borderColor: brandColor,
                backgroundColor: brandColor + "22",
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5,
              },
            ],
          },
          options: {
            responsive: false,
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
          },
        });
        sparklineCharts.set(row.id, chart);
      }
    });
  });

  // ── Loaders ────────────────────────────────────────────────────────────────

  async function loadTodayAttendance() {
    todayLoading = true;
    todayError = "";
    try {
      todayAttendance = await api.get<TodayAttendance>("/dashboard/today-attendance");
    } catch (e: unknown) {
      todayError = e instanceof Error ? e.message : "Fehler beim Laden der Anwesenheit";
    } finally {
      todayLoading = false;
    }
  }

  async function loadOvertimeOverview() {
    overtimeLoading = true;
    overtimeError = "";
    try {
      overtimeOverview = await api.get<OvertimeOverview>("/dashboard/overtime-overview");
    } catch (e: unknown) {
      overtimeError = e instanceof Error ? e.message : "Fehler beim Laden der Überstunden-Übersicht";
    } finally {
      overtimeLoading = false;
    }
  }

  async function loadLeaveOverview() {
    if (!isManager) return;
    leaveOverviewLoading = true;
    leaveOverviewError = "";
    try {
      leaveOverview = await api.get<LeaveOverviewRow[]>(
        `/reports/leave-overview?year=${leaveOverviewYear}`,
      );
    } catch (e: unknown) {
      leaveOverviewError =
        e instanceof Error ? e.message : "Fehler beim Laden der Urlaubsübersicht";
      leaveOverview = null;
    } finally {
      leaveOverviewLoading = false;
    }
  }

  function formatDays(n: number): string {
    return n.toLocaleString("de-DE", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    });
  }

  async function loadMonthlyReport() {
    reportLoading = true;
    reportError = "";
    monthlyReport = null;
    try {
      monthlyReport = await api.get<MonthlyReport>(
        `/reports/monthly?month=${reportMonth}&year=${reportYear}`,
      );
    } catch (e: unknown) {
      reportError = e instanceof Error ? e.message : "Fehler beim Laden des Berichts";
    } finally {
      reportLoading = false;
    }
  }

  async function downloadDatev() {
    datevLoading = true;
    datevError = "";
    try {
      const { authStore: authSt } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authSt);

      const res = await fetch(`/api/v1/reports/datev?month=${datevMonth}&year=${datevYear}`, {
        headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_${datevYear}_${String(datevMonth).padStart(2, "0")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Download fehlgeschlagen";
    } finally {
      datevLoading = false;
    }
  }

  async function downloadPdf(url: string, filename: string) {
    const { authStore: authSt } = await import("$stores/auth");
    const { get } = await import("svelte/store");
    const auth = get(authSt);

    const res = await fetch(`/api/v1${url}`, {
      headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick to ensure the download has started
    setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
  }

  async function downloadMonthlyPdf(employeeId: string, employeeName: string) {
    pdfDownloading = employeeId;
    reportError = "";
    try {
      const m = monthlyReport?.month ?? reportMonth;
      const y = monthlyReport?.year ?? reportYear;
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${employeeId}&month=${m}&year=${y}`,
        `Monatsbericht_${employeeName.replace(/\s+/g, "_")}_${y}_${String(m).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      reportError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      pdfDownloading = null;
    }
  }

  async function downloadVacationPdf() {
    leaveLoading = true;
    leaveError = "";
    try {
      await downloadPdf(
        `/reports/vacation/pdf?year=${leaveYear}`,
        `Urlaubsbericht_${leaveYear}.pdf`,
      );
    } catch (e: unknown) {
      leaveError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      leaveLoading = false;
    }
  }

  async function downloadCompanyMonthlyPdf() {
    companyPdfLoading = true;
    companyPdfError = "";
    try {
      await downloadPdf(
        `/reports/monthly/pdf/all?month=${companyPdfMonth}&year=${companyPdfYear}&role=${companyPdfRole}`,
        `Monatsbericht_Alle_${companyPdfYear}_${String(companyPdfMonth).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      companyPdfError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      companyPdfLoading = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatHours(h: number): string {
    const hours = Math.floor(h);
    const minutes = Math.round((h - hours) * 60);
    return `${hours}:${String(minutes).padStart(2, "0")} h`;
  }

  function formatBalance(n: number): string {
    return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function diffColor(worked: number, should: number): string {
    const diff = worked - should;
    if (diff > 1) return "text-green";
    if (diff < -1) return "text-red";
    return "";
  }

  function statusLabel(row: TodayEmployee): string {
    switch (row.status) {
      case "present":
        return "Anwesend";
      case "clocked_in":
        return "Eingestempelt";
      case "absent":
        return row.reason ?? "Abwesend";
      case "missing":
        return "Fehlend";
      case "scheduled":
        return "Geplant";
      case "holiday":
        return row.reason ?? "Feiertag";
      default:
        return "—";
    }
  }

  function statusClass(status: TodayEmployee["status"]): string {
    return `status-badge status-${status.replace("_", "-")}`;
  }

  function toggleSort(column: "name" | "balance") {
    if (sortColumn === column) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortColumn = column;
      sortDir = "asc";
    }
  }

  function statusBadgeClass(s: OvertimeEmployee["status"]): string {
    return `status-badge status-saldo-${s.toLowerCase()}`;
  }

  function statusBadgeLabel(s: OvertimeEmployee["status"]): string {
    return s === "NORMAL" ? "Normal" : s === "ELEVATED" ? "Erhöht" : "Kritisch";
  }
</script>

<svelte:head>
  <title>Berichte – Clokr</title>
</svelte:head>

<div class="page-header">
  <h1>Berichte &amp; Auswertungen</h1>
  <p>Monatsberichte, Urlaubslisten und DATEV-Exporte erstellen</p>
</div>

<div class="reports-grid">
  <!-- Monthly Report Card -->
  <div class="card card-body report-card">
    <div class="report-card-icon-section report-card-icon-section--purple">
      <span class="report-icon-lg">📊</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">Monatsbericht</h2>
        <p class="report-card-desc text-muted">Übersicht aller Mitarbeiter für einen Monat</p>
      </div>
    </div>

    <div class="report-controls">
      <div class="form-group">
        <label class="form-label" for="report-month">Monat</label>
        <select id="report-month" bind:value={reportMonth} class="form-input">
          {#each months as name, i (i)}
            <option value={i + 1}>{name}</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="report-year">Jahr</label>
        <select id="report-year" bind:value={reportYear} class="form-input">
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </div>
    </div>

    <button class="btn btn-primary" onclick={loadMonthlyReport} disabled={reportLoading}>
      {reportLoading ? "Laden…" : "Bericht anzeigen"}
    </button>

    {#if reportError}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{reportError}</span>
      </div>
    {/if}
  </div>

  <!-- DATEV Export Card -->
  <div class="card card-body report-card">
    <div class="report-card-icon-section report-card-icon-section--green">
      <span class="report-icon-lg">📁</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">DATEV Export</h2>
        <p class="report-card-desc text-muted">TXT-Datei für DATEV-Lohnabrechnung herunterladen</p>
      </div>
    </div>

    <div class="report-controls">
      <div class="form-group">
        <label class="form-label" for="datev-month">Monat</label>
        <select id="datev-month" bind:value={datevMonth} class="form-input">
          {#each months as name, i (i)}
            <option value={i + 1}>{name}</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="datev-year">Jahr</label>
        <select id="datev-year" bind:value={datevYear} class="form-input">
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </div>
    </div>

    <button class="btn btn-primary" onclick={downloadDatev} disabled={datevLoading}>
      {#if datevLoading}
        <span class="btn-spinner"></span>
        Vorbereiten…
      {:else}
        ↓ TXT herunterladen
      {/if}
    </button>

    {#if datevError}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{datevError}</span>
      </div>
    {/if}
  </div>

  <!-- Urlaubsbericht PDF Card (kombiniert: Urlaubsliste + Urlaubsübersicht) -->
  <div class="card card-body report-card">
    <div class="report-card-icon-section report-card-icon-section--blue">
      <span class="report-icon-lg">🏖</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">Urlaubsbericht PDF</h2>
        <p class="report-card-desc text-muted">
          Urlaubsliste &amp; Jahresübersicht der Ansprüche in einem PDF
        </p>
      </div>
    </div>

    <div class="report-controls">
      <div class="form-group">
        <label class="form-label" for="leave-year">Jahr</label>
        <select id="leave-year" bind:value={leaveYear} class="form-input">
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </div>
    </div>

    <button class="btn btn-primary" onclick={downloadVacationPdf} disabled={leaveLoading}>
      {#if leaveLoading}
        <span class="btn-spinner"></span>
        Vorbereiten…
      {:else}
        PDF herunterladen
      {/if}
    </button>

    {#if leaveError}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{leaveError}</span>
      </div>
    {/if}
  </div>

  <!-- Company Monthly PDF Card (PDF-01 / PDF-03) -->
  <div class="card card-body report-card">
    <div class="report-card-icon-section report-card-icon-section--purple">
      <span class="report-icon-lg">📑</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">Firmenweiter Monatsbericht</h2>
        <p class="report-card-desc text-muted">
          Alle Mitarbeiter in einer PDF — optional nach Rolle gefiltert
        </p>
      </div>
    </div>

    <div class="report-controls">
      <div class="form-group">
        <label class="form-label" for="company-pdf-month">Monat</label>
        <select id="company-pdf-month" bind:value={companyPdfMonth} class="form-input">
          {#each months as name, i (i)}
            <option value={i + 1}>{name}</option>
          {/each}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="company-pdf-year">Jahr</label>
        <select id="company-pdf-year" bind:value={companyPdfYear} class="form-input">
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="company-pdf-role">Rolle</label>
      <select id="company-pdf-role" bind:value={companyPdfRole} class="form-input">
        <option value="all">Alle Mitarbeiter</option>
        <option value="EMPLOYEE">Nur Mitarbeiter</option>
        <option value="MANAGER">Nur Manager</option>
      </select>
    </div>

    <button
      class="btn btn-primary"
      onclick={downloadCompanyMonthlyPdf}
      disabled={companyPdfLoading}
    >
      {#if companyPdfLoading}
        <span class="btn-spinner"></span>
        Vorbereiten…
      {:else}
        PDF herunterladen
      {/if}
    </button>

    {#if companyPdfError}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{companyPdfError}</span>
      </div>
    {/if}
  </div>
</div>

<!-- Heutige Anwesenheit (RPT-03) — ADMIN / MANAGER only -->
{#if isManager}
  <section class="section card-animate">
    <header class="section-head">
      <h2>Heutige Anwesenheit</h2>
      {#if todayAttendance}
        <span class="section-date">{todayAttendance.date}</span>
      {/if}
    </header>

    {#if todayLoading}
      <p class="section-placeholder">Lade Anwesenheit…</p>
    {:else if todayError}
      <p class="section-error">{todayError}</p>
    {:else if todayAttendance}
      <div class="attendance-summary">
        <div class="summary-chip">
          <span class="label">Anwesend</span>
          <span class="value">{todayAttendance.summary.present}</span>
        </div>
        <div class="summary-chip">
          <span class="label">Eingestempelt</span>
          <span class="value">{todayAttendance.summary.clockedIn}</span>
        </div>
        <div class="summary-chip">
          <span class="label">Abwesend</span>
          <span class="value">{todayAttendance.summary.absent}</span>
        </div>
        <div class="summary-chip">
          <span class="label">Fehlend</span>
          <span class="value">{todayAttendance.summary.missing}</span>
        </div>
        {#if todayAttendance.summary.holiday > 0}
          <div class="summary-chip">
            <span class="label">Feiertag</span>
            <span class="value">{todayAttendance.summary.holiday}</span>
          </div>
        {/if}
      </div>

      <div class="table-wrap">
        <table class="attendance-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Nr.</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each todayAttendance.employees as row (row.id)}
              <tr>
                <td>{row.name}</td>
                <td>{row.employeeNumber}</td>
                <td><span class={statusClass(row.status)}>{statusLabel(row)}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<!-- Überstunden-Übersicht (RPT-01 + SALDO-03) — ADMIN / MANAGER only -->
{#if isManager}
  <section class="section card-animate">
    <header class="section-head">
      <h2>Überstunden-Übersicht</h2>
    </header>

    {#if overtimeLoading}
      <p class="section-placeholder">Lade Überstunden-Saldo…</p>
    {:else if overtimeError}
      <p class="section-error">{overtimeError}</p>
    {:else if overtimeOverview}
      <div class="table-wrap">
        <table class="overtime-table">
          <thead>
            <tr>
              <th class="sortable" onclick={() => toggleSort("name")}>
                Mitarbeiter
                {#if sortColumn === "name"}<span class="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>{/if}
              </th>
              <th>Nr.</th>
              <th class="sortable numeric" onclick={() => toggleSort("balance")}>
                Saldo (h)
                {#if sortColumn === "balance"}<span class="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>{/if}
              </th>
              <th>Status</th>
              <th>Verlauf (6 Monate)</th>
            </tr>
          </thead>
          <tbody>
            {#each sortedOvertime as row (row.id)}
              <tr>
                <td>{row.name}</td>
                <td>{row.employeeNumber}</td>
                <td class="numeric">{formatBalance(row.balanceHours)}</td>
                <td><span class={statusBadgeClass(row.status)}>{statusBadgeLabel(row.status)}</span></td>
                <td class="sparkline-cell">
                  {#if row.snapshots.length >= 2}
                    <canvas
                      width="100"
                      height="28"
                      use:registerCanvas={row.id}
                    ></canvas>
                  {:else}
                    <span class="no-trend">(kein Verlauf)</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<!-- Urlaubsübersicht (RPT-02) — ADMIN / MANAGER only -->
{#if isManager}
  <section class="section card-animate">
    <header class="section-head">
      <h2>Urlaubsübersicht</h2>
      <label class="year-selector">
        <span>Jahr</span>
        <select bind:value={leaveOverviewYear} onchange={loadLeaveOverview}>
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </label>
    </header>

    {#if leaveOverviewLoading}
      <p class="section-placeholder">Lade Urlaubsübersicht…</p>
    {:else if leaveOverviewError}
      <p class="section-error">{leaveOverviewError}</p>
    {:else if leaveOverviewRows.length === 0}
      <p class="section-placeholder">Keine Einträge für dieses Jahr</p>
    {:else}
      <div class="table-wrap">
        <table class="leave-overview-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Nr.</th>
              <th>Urlaubsart</th>
              <th class="numeric">Gesamt</th>
              <th class="numeric">Übertrag</th>
              <th class="numeric">Genommen</th>
              <th class="numeric">Geplant</th>
              <th class="numeric">Rest</th>
            </tr>
          </thead>
          <tbody>
            {#each leaveOverviewRows as row (row.employee.employeeNumber + ":" + row.leaveType.id)}
              <tr>
                <td>{row.employee.firstName} {row.employee.lastName}</td>
                <td>{row.employee.employeeNumber}</td>
                <td>{row.leaveType.name}</td>
                <td class="numeric">{formatDays(row.totalDays)}</td>
                <td class="numeric">{formatDays(row.carriedOverDays)}</td>
                <td class="numeric">{formatDays(row.usedDays)}</td>
                <td class="numeric">{formatDays(row.pendingDays)}</td>
                <td class="numeric strong">{formatDays(row.remainingDays)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

<!-- Monthly Report Results -->
{#if monthlyReport}
  <div class="report-results">
    <div class="section-header">
      <h2>
        Monatsbericht: {months[monthlyReport.month - 1]}
        {monthlyReport.year}
      </h2>
    </div>

    {#if monthlyReport.rows.length === 0}
      <div class="empty-state card card-body">
        <span class="empty-icon">📊</span>
        <h3>Keine Daten vorhanden</h3>
        <p class="text-muted">Für diesen Zeitraum sind keine Daten verfügbar.</p>
      </div>
    {:else}
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Ist-Stunden</th>
              <th>Soll-Stunden</th>
              <th>Differenz</th>
              <th title="Kranktage mit Attest">Krank m. Attest</th>
              <th title="Kranktage ohne Attest">Krank o. Attest</th>
              <th>Urlaubstage</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each pagedReportRows as row (row.employeeId)}
              <tr>
                <td class="font-medium">{row.employeeName}</td>
                <td class="font-mono">{formatHours(row.workedHours)}</td>
                <td class="font-mono text-muted">{formatHours(row.shouldHours)}</td>
                <td class="font-mono font-medium {diffColor(row.workedHours, row.shouldHours)}">
                  {row.workedHours - row.shouldHours >= 0 ? "+" : ""}
                  {formatHours(Math.abs(row.workedHours - row.shouldHours))}
                </td>
                <td class={row.sickDaysWithAttest > 0 ? "text-green" : "text-muted"}
                  >{row.sickDaysWithAttest}</td
                >
                <td class={row.sickDaysWithoutAttest > 0 ? "text-yellow" : "text-muted"}
                  >{row.sickDaysWithoutAttest}</td
                >
                <td>{row.vacationDays}</td>
                <td>
                  <button
                    class="btn btn-ghost btn-sm"
                    onclick={() => downloadMonthlyPdf(row.employeeId, row.employeeName)}
                    disabled={pdfDownloading === row.employeeId}
                    title="PDF herunterladen"
                  >
                    {pdfDownloading === row.employeeId ? "..." : "PDF"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <Pagination total={monthlyReport?.rows.length ?? 0} bind:page={reportPage} bind:pageSize={reportPageSize} />
      </div>
    {/if}
  </div>
{/if}

<style>
  .reports-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.25rem;
    margin-bottom: 1.75rem;
  }

  .report-card {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
    overflow: hidden;
    transition:
      transform 0.2s var(--ease-out, ease),
      box-shadow 0.2s ease;
  }

  .report-card:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-md, 0 8px 20px rgba(0, 0, 0, 0.12));
  }

  .report-card-icon-section {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: var(--radius-sm, 8px);
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .report-card:hover .report-card-icon-section {
    transform: scale(1.05);
  }

  .report-card-icon-section--purple {
    background: var(--color-brand-tint, rgba(124, 58, 237, 0.1));
  }

  .report-card-icon-section--green {
    background: var(--color-green-bg, rgba(22, 163, 74, 0.1));
  }

  .report-card-icon-section--blue {
    background: var(--color-blue-bg, rgba(37, 99, 235, 0.1));
  }

  .report-icon-lg {
    font-size: 1.5rem;
    line-height: 1;
  }

  .report-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
  }

  .report-card-title {
    font-size: 1.0625rem;
    margin-bottom: 0.25rem;
  }

  .report-card-desc {
    font-size: 0.875rem;
  }

  .report-controls {
    display: flex;
    gap: 0.875rem;
  }

  .report-controls .form-group {
    flex: 1;
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: var(--color-surface, #fff);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .report-results {
    margin-top: 0;
  }

  .section-header {
    margin-bottom: 0.875rem;
  }

  .section-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
  }

  .empty-icon {
    font-size: 2.5rem;
    margin-bottom: 0.25rem;
  }

  .empty-state h3 {
    font-size: 1.0625rem;
  }

  /* ── Manager sections ─────────────────────────────────────────────────── */

  .section.card-animate {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
    border-radius: 16px;
    padding: 1.5rem;
    margin-top: 2rem;
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-head h2 {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--color-text-heading);
    margin: 0;
  }

  .section-date {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }

  .section-placeholder,
  .section-error {
    color: var(--color-text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  .section-error {
    color: var(--color-red, var(--color-brand));
  }

  /* Heutige Anwesenheit */

  .attendance-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .summary-chip {
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-chip .label {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .summary-chip .value {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-text-heading);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .attendance-table th,
  .attendance-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }

  .attendance-table th {
    color: var(--color-text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .status-present,
  .status-clocked-in {
    background: var(--color-green-bg, var(--color-brand-tint));
    color: var(--color-green, var(--color-brand));
  }

  .status-absent {
    background: var(--color-yellow-bg, var(--color-bg-subtle));
    color: var(--color-yellow, var(--color-text-muted));
  }

  .status-holiday {
    background: var(--color-blue-bg, var(--color-bg-subtle));
    color: var(--color-blue, var(--color-text-muted));
  }

  .status-missing {
    background: var(--color-red-bg, var(--color-bg-subtle));
    color: var(--color-red, var(--color-text));
  }

  .status-scheduled,
  .status-none {
    background: var(--color-bg-subtle);
    color: var(--color-text-muted);
  }

  /* Überstunden-Übersicht */

  .overtime-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .overtime-table th,
  .overtime-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }

  .overtime-table th {
    color: var(--color-text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .overtime-table th.sortable {
    cursor: pointer;
    user-select: none;
  }

  .overtime-table th.sortable:hover {
    color: var(--color-text-heading);
  }

  .overtime-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .sort-arrow {
    margin-left: 0.25rem;
    color: var(--color-brand);
  }

  .status-saldo-normal {
    background: var(--color-green-bg, var(--color-brand-tint));
    color: var(--color-green, var(--color-brand));
  }

  .status-saldo-elevated {
    background: var(--color-yellow-bg, var(--color-bg-subtle));
    color: var(--color-yellow, var(--color-text));
  }

  .status-saldo-critical {
    background: var(--color-red-bg, var(--color-bg-subtle));
    color: var(--color-red, var(--color-text));
  }

  .sparkline-cell {
    width: 120px;
  }

  .no-trend {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    font-style: italic;
  }

  @media (max-width: 720px) {
    .attendance-summary {
      grid-template-columns: repeat(2, 1fr);
    }

    .sparkline-cell {
      display: none;
    }

    .overtime-table th:last-child,
    .overtime-table td:last-child {
      display: none;
    }
  }

  @media (max-width: 700px) {
    .reports-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Urlaubsübersicht */

  .year-selector {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  .year-selector select {
    background: var(--color-bg-subtle);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
    font-family: inherit;
  }

  .year-selector select:focus {
    outline: 2px solid var(--color-brand);
    outline-offset: 1px;
  }

  .leave-overview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .leave-overview-table th,
  .leave-overview-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--color-border);
  }

  .leave-overview-table th {
    color: var(--color-text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .leave-overview-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .leave-overview-table .numeric.strong {
    font-weight: 700;
    color: var(--color-text-heading);
  }
</style>
