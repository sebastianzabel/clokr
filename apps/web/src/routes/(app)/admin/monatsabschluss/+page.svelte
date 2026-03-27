<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$api/client";

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }

  interface Snapshot {
    id: string;
    employeeId: string;
    periodType: "MONTHLY" | "YEARLY";
    periodStart: string;
    periodEnd: string;
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    carryOver: number;
    closedAt: string;
    closedBy: string | null;
    note: string | null;
  }

  let employees: Employee[] = $state([]);
  let selectedEmployeeId = $state("");
  let selectedYear = $state(new Date().getFullYear());
  let selectedMonth = $state(new Date().getMonth()); // Previous month (0-indexed for closing)
  let snapshots: Snapshot[] = $state([]);
  let loading = $state(false);
  let closing = $state(false);
  let error = $state("");
  let success = $state("");

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

  const years = $derived(Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i));

  onMount(async () => {
    try {
      const res =
        await api.get<
          {
            id: string;
            firstName: string;
            lastName: string;
            employeeNumber: string;
            user: { isActive: boolean };
          }[]
        >("/employees");
      employees = res.filter((e) => e.user.isActive);
      // Default to previous month
      const now = new Date();
      if (now.getMonth() === 0) {
        selectedMonth = 12;
        selectedYear = now.getFullYear() - 1;
      } else {
        selectedMonth = now.getMonth(); // getMonth() is 0-based, so this is prev month (1-based)
      }
    } catch {
      error = "Mitarbeiter konnten nicht geladen werden";
    }
  });

  async function loadSnapshots() {
    if (!selectedEmployeeId) return;
    loading = true;
    error = "";
    try {
      snapshots = await api.get<Snapshot[]>(`/overtime/snapshots/${selectedEmployeeId}`);
    } catch {
      error = "Snapshots konnten nicht geladen werden";
    } finally {
      loading = false;
    }
  }

  async function closeMonth() {
    if (!selectedEmployeeId || !selectedMonth) return;
    closing = true;
    error = "";
    success = "";
    try {
      await api.post("/overtime/close-month", {
        employeeId: selectedEmployeeId,
        year: selectedYear,
        month: selectedMonth,
      });
      success = `${months[selectedMonth - 1]} ${selectedYear} erfolgreich abgeschlossen`;
      await loadSnapshots();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Monatsabschluss";
    } finally {
      closing = false;
    }
  }

  async function closeYear() {
    if (!selectedEmployeeId) return;
    closing = true;
    error = "";
    success = "";
    try {
      await api.post("/overtime/close-year", {
        employeeId: selectedEmployeeId,
        year: selectedYear,
      });
      success = `Jahresübertrag ${selectedYear} erfolgreich erstellt`;
      await loadSnapshots();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Jahresabschluss";
    } finally {
      closing = false;
    }
  }

  async function closeMonthForAll() {
    closing = true;
    error = "";
    success = "";
    let succeeded = 0;
    let failed = 0;
    for (const emp of employees) {
      try {
        await api.post("/overtime/close-month", {
          employeeId: emp.id,
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
    if (selectedEmployeeId) await loadSnapshots();
  }

  function isMonthClosed(month: number): boolean {
    return snapshots.some(
      (s) =>
        s.periodType === "MONTHLY" &&
        new Date(s.periodStart).getUTCFullYear() === selectedYear &&
        new Date(s.periodStart).getUTCMonth() + 1 === month,
    );
  }

  let yearClosed = $derived(
    snapshots.some(
      (s) => s.periodType === "YEARLY" && new Date(s.periodStart).getUTCFullYear() === selectedYear,
    ),
  );

  function fmtHours(minutes: number): string {
    const h = Math.floor(Math.abs(minutes) / 60);
    const m = Math.abs(minutes) % 60;
    const sign = minutes < 0 ? "-" : "+";
    return `${sign}${h}:${String(Math.round(m)).padStart(2, "0")}`;
  }
</script>

<svelte:head><title>Monatsabschluss – Clokr</title></svelte:head>

<div class="ma-page">
  <div class="ma-controls">
    <div class="control-row">
      <label class="control-group">
        <span class="control-label">Mitarbeiter</span>
        <select
          class="form-select"
          bind:value={selectedEmployeeId}
          onchange={() => loadSnapshots()}
        >
          <option value="">Bitte wählen...</option>
          {#each employees as emp}
            <option value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNumber})</option>
          {/each}
        </select>
      </label>

      <label class="control-group">
        <span class="control-label">Jahr</span>
        <select class="form-select" bind:value={selectedYear} onchange={() => loadSnapshots()}>
          {#each years as y}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </label>

      <label class="control-group">
        <span class="control-label">Monat</span>
        <select class="form-select" bind:value={selectedMonth}>
          {#each months as m, i}
            <option value={i + 1}>{m}</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="action-row">
      <button
        class="btn btn-primary"
        onclick={closeMonth}
        disabled={closing || !selectedEmployeeId}
      >
        {closing ? "Wird abgeschlossen..." : "Monat abschließen"}
      </button>
      <button class="btn btn-ghost" onclick={closeMonthForAll} disabled={closing}>
        Alle Mitarbeiter abschließen
      </button>
      <button class="btn btn-ghost" onclick={closeYear} disabled={closing || !selectedEmployeeId}>
        Jahresübertrag {selectedYear}
      </button>
    </div>
  </div>

  {#if error}
    <div class="alert alert-error">{error}</div>
  {/if}
  {#if success}
    <div class="alert alert-success">{success}</div>
  {/if}

  {#if selectedEmployeeId}
    <!-- Month overview grid -->
    <div class="month-grid">
      <h3>Monatsübersicht {selectedYear}</h3>
      <div class="month-cards">
        {#each months as m, i}
          {@const closed = isMonthClosed(i + 1)}
          {@const snap = snapshots.find(
            (s) =>
              s.periodType === "MONTHLY" &&
              new Date(s.periodStart).getUTCFullYear() === selectedYear &&
              new Date(s.periodStart).getUTCMonth() + 1 === i + 1,
          )}
          <div
            class="month-card"
            class:month-card--closed={closed}
            class:month-card--open={!closed}
          >
            <span class="month-name">{m.slice(0, 3)}</span>
            {#if snap}
              <span
                class="month-balance"
                class:positive={snap.balanceMinutes >= 0}
                class:negative={snap.balanceMinutes < 0}
              >
                {fmtHours(snap.balanceMinutes)}
              </span>
              <span class="month-status">Abgeschlossen</span>
            {:else}
              <span class="month-status month-status--open">Offen</span>
            {/if}
          </div>
        {/each}
      </div>
      {#if yearClosed}
        <div class="year-badge">Jahresübertrag erstellt</div>
      {/if}
    </div>

    <!-- Snapshot history -->
    {#if snapshots.length > 0}
      <div class="snapshot-table">
        <h3>Snapshot-Verlauf</h3>
        <table class="table">
          <thead>
            <tr>
              <th>Zeitraum</th>
              <th>Typ</th>
              <th class="text-right">Ist</th>
              <th class="text-right">Soll</th>
              <th class="text-right">Saldo</th>
              <th class="text-right">Übertrag</th>
              <th>Abgeschlossen</th>
              <th>Notiz</th>
            </tr>
          </thead>
          <tbody>
            {#each snapshots as snap (snap.id)}
              <tr>
                <td class="font-mono">
                  {new Date(snap.periodStart).toLocaleDateString("de-DE")} – {new Date(
                    snap.periodEnd,
                  ).toLocaleDateString("de-DE")}
                </td>
                <td>
                  <span class="badge" class:badge--yearly={snap.periodType === "YEARLY"}>
                    {snap.periodType === "MONTHLY" ? "Monat" : "Jahr"}
                  </span>
                </td>
                <td class="text-right font-mono">{(snap.workedMinutes / 60).toFixed(1)}h</td>
                <td class="text-right font-mono">{(snap.expectedMinutes / 60).toFixed(1)}h</td>
                <td
                  class="text-right font-mono"
                  class:positive={snap.balanceMinutes >= 0}
                  class:negative={snap.balanceMinutes < 0}
                >
                  {fmtHours(snap.balanceMinutes)}
                </td>
                <td
                  class="text-right font-mono"
                  class:positive={snap.carryOver >= 0}
                  class:negative={snap.carryOver < 0}
                >
                  {fmtHours(snap.carryOver)}
                </td>
                <td class="font-mono">{new Date(snap.closedAt).toLocaleDateString("de-DE")}</td>
                <td class="text-muted">{snap.note ?? ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if !loading}
      <p class="text-muted">Noch keine Snapshots für diesen Mitarbeiter.</p>
    {/if}
  {:else}
    <p class="text-muted">Bitte einen Mitarbeiter auswählen.</p>
  {/if}
</div>

<style>
  .ma-page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
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
  }

  .control-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 180px;
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

  .action-row {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
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

  /* Month grid */
  .month-grid {
    margin-top: 0.5rem;
  }

  .month-grid h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
  }

  .month-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 0.5rem;
  }

  .month-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.75rem 0.5rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-border);
    text-align: center;
  }

  .month-card--closed {
    background: var(--green-50, #f0fdf4);
    border-color: var(--green-200, #bbf7d0);
  }

  .month-card--open {
    background: var(--gray-50, #f9fafb);
  }

  .month-name {
    font-weight: 600;
    font-size: 0.8rem;
  }

  .month-balance {
    font-size: 0.85rem;
    font-weight: 600;
    font-family: var(--font-mono, monospace);
  }

  .month-status {
    font-size: 0.7rem;
    color: var(--green-600, #16a34a);
  }

  .month-status--open {
    color: var(--color-text-muted);
  }

  .positive {
    color: var(--green-600, #16a34a);
  }

  .negative {
    color: var(--red-600, #dc2626);
  }

  .year-badge {
    margin-top: 0.75rem;
    padding: 0.5rem 1rem;
    background: var(--blue-50, #eff6ff);
    border: 1px solid var(--blue-200, #bfdbfe);
    color: var(--blue-700, #1d4ed8);
    border-radius: 0.375rem;
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
  }

  /* Snapshot table */
  .snapshot-table {
    margin-top: 0.5rem;
  }

  .snapshot-table h3 {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
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
  }

  .text-right {
    text-align: right;
  }

  .font-mono {
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
  }

  .text-muted {
    color: var(--color-text-muted);
    font-size: 0.85rem;
  }

  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.7rem;
    font-weight: 600;
    background: var(--gray-100, #f3f4f6);
    color: var(--gray-600, #4b5563);
  }

  .badge--yearly {
    background: var(--blue-100, #dbeafe);
    color: var(--blue-700, #1d4ed8);
  }
</style>
