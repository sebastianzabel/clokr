<script lang="ts">
  import { api } from "$api/client";

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

  let leaveYear = $state(currentYear);
  let leaveLoading = $state(false);
  let leaveError = $state("");

  let pdfDownloading = $state<string | null>(null);

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
      // We need to call the raw fetch here for the blob download
      const { authStore } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authStore);

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
      a.download = `DATEV_${datevYear}_${String(datevMonth).padStart(2, "0")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Download fehlgeschlagen";
    } finally {
      datevLoading = false;
    }
  }

  async function downloadPdf(url: string, filename: string) {
    const { authStore } = await import("$stores/auth");
    const { get } = await import("svelte/store");
    const auth = get(authStore);

    const res = await fetch(`/api/v1${url}`, {
      headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
    }

    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
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

  async function downloadLeaveOverviewPdf() {
    leaveLoading = true;
    leaveError = "";
    try {
      await downloadPdf(
        `/reports/leave-overview/pdf?year=${leaveYear}`,
        `Urlaubsuebersicht_${leaveYear}.pdf`,
      );
    } catch (e: unknown) {
      leaveError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      leaveLoading = false;
    }
  }

  function formatHours(h: number): string {
    const hours = Math.floor(h);
    const minutes = Math.round((h - hours) * 60);
    return `${hours}:${String(minutes).padStart(2, "0")} h`;
  }

  function diffColor(worked: number, should: number): string {
    const diff = worked - should;
    if (diff > 1) return "text-green";
    if (diff < -1) return "text-red";
    return "";
  }
</script>

<svelte:head>
  <title>Berichte – Clokr</title>
</svelte:head>

<div class="page-header">
  <h1>Berichte &amp; Auswertungen</h1>
  <p>Monatsberichte und DATEV-Exporte erstellen</p>
</div>

<div class="reports-grid">
  <!-- Monthly Report Card -->
  <div class="card card-body report-card report-card--purple">
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
  <div class="card card-body report-card report-card--green">
    <div class="report-card-icon-section report-card-icon-section--green">
      <span class="report-icon-lg">📁</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">DATEV Export</h2>
        <p class="report-card-desc text-muted">CSV-Datei für DATEV-Lohnabrechnung herunterladen</p>
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

    <button class="btn btn-secondary" onclick={downloadDatev} disabled={datevLoading}>
      {#if datevLoading}
        <span class="btn-spinner-dark"></span>
        Vorbereiten…
      {:else}
        ↓ CSV herunterladen
      {/if}
    </button>

    {#if datevError}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>{datevError}</span>
      </div>
    {/if}
  </div>

  <!-- Leave Overview PDF Card -->
  <div class="card card-body report-card report-card--blue">
    <div class="report-card-icon-section report-card-icon-section--blue">
      <span class="report-icon-lg">🏖</span>
    </div>
    <div class="report-card-header">
      <div>
        <h2 class="report-card-title">Urlaubsübersicht PDF</h2>
        <p class="report-card-desc text-muted">Jahresübersicht aller Urlaubsansprüche als PDF</p>
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

    <button class="btn btn-secondary" onclick={downloadLeaveOverviewPdf} disabled={leaveLoading}>
      {#if leaveLoading}
        <span class="btn-spinner-dark"></span>
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
</div>

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
            {#each monthlyReport.rows as row (row.employeeId)}
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
    border-top: 3px solid transparent;
    overflow: hidden;
    transition:
      transform 0.2s var(--ease-out, ease),
      box-shadow 0.2s ease;
  }

  .report-card:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-md, 0 8px 20px rgba(0,0,0,0.12));
  }

  .report-card--purple {
    border-top-color: var(--color-brand, #7c3aed);
  }

  .report-card--green {
    border-top-color: var(--color-green, #16a34a);
  }

  .report-card--blue {
    border-top-color: var(--color-blue, #2563eb);
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

  .btn-spinner-dark {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(128, 55, 123, 0.3);
    border-top-color: var(--color-brand);
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

  @media (max-width: 700px) {
    .reports-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
