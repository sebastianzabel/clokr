<script lang="ts">
  import { api } from "$api/client";

  type ImportMode = "employees" | "time-entries";

  interface ImportResult {
    row: number;
    status: "ok" | "error";
    email?: string;
    error?: string;
  }

  interface ImportResponse {
    total: number;
    imported: number;
    errors: number;
    details: ImportResult[];
  }

  let mode: ImportMode = $state("employees");
  let csvText = $state("");
  let loading = $state(false);
  let error = $state("");
  let result: ImportResponse | null = $state(null);
  let preview: Record<string, string>[] = $state([]);
  let showPreview = $state(false);

  const exampleEmployees = `email;firstName;lastName;employeeNumber;hireDate;role;weeklyHours;password
max@firma.de;Max;Mustermann;1001;01.01.2024;EMPLOYEE;40;Passwort1!
anna@firma.de;Anna;Schmidt;1002;15.03.2024;MANAGER;38.5;`;

  const exampleTimeEntries = `employeeNumber;date;startTime;endTime;breakMinutes;note
1001;01.03.2024;08:00;16:30;30;Normaler Arbeitstag
1001;02.03.2024;09:00;17:00;45;Meeting-Tag`;

  let exampleText = $derived(mode === "employees" ? exampleEmployees : exampleTimeEntries);

  function parseCsvLocal(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const sep = lines[0].includes(";") ? ";" : ",";
    const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ""));
    return lines.slice(1).filter(l => l.trim()).map(line => {
      const values = line.split(sep).map(v => v.trim().replace(/^["']|["']$/g, ""));
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
      return row;
    });
  }

  function handlePreview() {
    error = "";
    result = null;
    if (!csvText.trim()) {
      error = "Bitte CSV-Daten eingeben oder eine Datei hochladen.";
      return;
    }
    const rows = parseCsvLocal(csvText);
    if (rows.length === 0) {
      error = "Keine Datenzeilen gefunden. Mindestens Header + 1 Zeile erforderlich.";
      return;
    }
    preview = rows;
    showPreview = true;
  }

  async function handleImport() {
    error = "";
    result = null;
    loading = true;
    try {
      const res = await api.post<ImportResponse>(`/imports/${mode}`, { csv: csvText });
      result = res;
      showPreview = false;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Import";
    } finally {
      loading = false;
    }
  }

  function handleFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      csvText = reader.result as string;
      showPreview = false;
      result = null;
      error = "";
    };
    reader.readAsText(file);
  }

  function reset() {
    csvText = "";
    preview = [];
    showPreview = false;
    result = null;
    error = "";
  }

  function switchMode(newMode: ImportMode) {
    mode = newMode;
    reset();
  }
</script>

<svelte:head>
  <title>Import – Clokr</title>
</svelte:head>

<div class="page-header-row" style="margin-bottom:1.5rem">
  <div>
    <h2 style="font-size:1.125rem;font-weight:600;">CSV Import</h2>
    <p class="text-muted" style="font-size:0.875rem;margin-top:0.125rem;">
      Mitarbeiter oder Zeiteintr&auml;ge per CSV importieren
    </p>
  </div>
</div>

<!-- Mode Toggle -->
<div class="mode-toggle" style="margin-bottom:1.5rem">
  <button
    class="btn btn-sm {mode === 'employees' ? 'btn-primary' : 'btn-ghost'}"
    onclick={() => switchMode("employees")}
  >
    Mitarbeiter
  </button>
  <button
    class="btn btn-sm {mode === 'time-entries' ? 'btn-primary' : 'btn-ghost'}"
    onclick={() => switchMode("time-entries")}
  >
    Zeiteintr&auml;ge
  </button>
</div>

{#if error}
  <div class="alert alert-error" role="alert" style="margin-bottom:1rem">
    <span>&#x26A0;</span><span>{error}</span>
  </div>
{/if}

<!-- CSV Input -->
<div class="card card-body" style="margin-bottom:1.25rem">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
    <label for="csv-input" style="font-weight:600;font-size:0.875rem;">CSV-Daten</label>
    <div style="display:flex;gap:0.5rem;align-items:center">
      <label class="btn btn-sm btn-ghost" style="cursor:pointer">
        Datei laden
        <input
          type="file"
          accept=".csv,.txt"
          onchange={handleFileUpload}
          style="display:none"
        />
      </label>
      {#if csvText}
        <button class="btn btn-sm btn-ghost" onclick={reset}>Leeren</button>
      {/if}
    </div>
  </div>

  <textarea
    id="csv-input"
    class="form-input csv-textarea"
    bind:value={csvText}
    placeholder="CSV hier einf&uuml;gen oder Datei hochladen..."
    rows="10"
  ></textarea>

  <details class="example-hint" style="margin-top:0.75rem">
    <summary class="text-muted" style="font-size:0.8125rem;cursor:pointer;">
      Beispielformat anzeigen
    </summary>
    <pre class="example-pre">{exampleText}</pre>
  </details>
</div>

<!-- Actions -->
<div style="display:flex;gap:0.75rem;margin-bottom:1.5rem">
  <button
    class="btn btn-sm btn-ghost"
    onclick={handlePreview}
    disabled={!csvText.trim() || loading}
  >
    Vorschau
  </button>
  <button
    class="btn btn-sm btn-primary"
    onclick={handleImport}
    disabled={!csvText.trim() || loading}
  >
    {#if loading}
      Importiere...
    {:else}
      Importieren
    {/if}
  </button>
</div>

<!-- Preview Table -->
{#if showPreview && preview.length > 0}
  <div class="card card-body" style="margin-bottom:1.5rem">
    <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:0.75rem">
      Vorschau ({preview.length} Zeilen)
    </h3>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            {#each Object.keys(preview[0]) as col}
              <th>{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each preview as row, i}
            <tr>
              <td class="text-muted" style="font-size:0.8125rem">{i + 1}</td>
              {#each Object.values(row) as val}
                <td style="font-size:0.875rem">{val}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<!-- Results -->
{#if result}
  <div class="card card-body">
    <h3 style="font-size:0.9375rem;font-weight:600;margin-bottom:0.75rem">
      Import-Ergebnis
    </h3>

    <div class="result-summary" style="margin-bottom:1rem">
      <span class="badge badge-gray">{result.total} Gesamt</span>
      <span class="badge badge-green">{result.imported} Importiert</span>
      {#if result.errors > 0}
        <span class="badge badge-red">{result.errors} Fehler</span>
      {/if}
    </div>

    {#if result.details.length > 0}
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Zeile</th>
              <th>Status</th>
              {#if mode === "employees"}
                <th>E-Mail</th>
              {/if}
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {#each result.details as detail}
              <tr>
                <td style="font-size:0.875rem">{detail.row}</td>
                <td>
                  <span class="badge {detail.status === 'ok' ? 'badge-green' : 'badge-red'}">
                    {detail.status === "ok" ? "OK" : "Fehler"}
                  </span>
                </td>
                {#if mode === "employees"}
                  <td style="font-size:0.875rem">{detail.email ?? "–"}</td>
                {/if}
                <td style="font-size:0.8125rem" class="text-muted">
                  {detail.error ?? "–"}
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
  .mode-toggle {
    display: flex;
    gap: 0.5rem;
  }

  .csv-textarea {
    font-family: var(--font-mono, monospace);
    font-size: 0.8125rem;
    resize: vertical;
    min-height: 120px;
  }

  .example-pre {
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    background-color: var(--color-bg-subtle, #f5f5f5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 4px);
    padding: 0.75rem;
    overflow-x: auto;
    white-space: pre;
    margin-top: 0.5rem;
    color: var(--color-text-muted);
  }

  .result-summary {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
</style>
