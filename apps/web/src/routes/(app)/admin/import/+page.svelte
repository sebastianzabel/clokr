<script lang="ts">
  import { api } from "$api/client";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";

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
    const headers = lines[0].split(sep).map((h) => h.trim().replace(/^["']|["']$/g, ""));
    return lines
      .slice(1)
      .filter((l) => l.trim())
      .map((line) => {
        const values = line.split(sep).map((v) => v.trim().replace(/^["']|["']$/g, ""));
        const row: Record<string, string> = {};
        headers.forEach((h, i) => {
          row[h] = values[i] ?? "";
        });
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
  <title>CSV Import – Clokr</title>
</svelte:head>

<div class="page">
<PageHead
  eyebrow="Administration"
  title="CSV Import"
  accent="Import"
  sub="Mitarbeiter oder Zeiteinträge per CSV importieren — Vorschau prüfen, dann übernehmen. Jeder Import wird im Audit-Log protokolliert."
/>

<!-- Mode Toggle -->
<div class="view-tabs mode-tabs">
  <button
    class="view-tab"
    class:view-tab--active={mode === "employees"}
    onclick={() => switchMode("employees")}
  >
    Mitarbeiter
  </button>
  <button
    class="view-tab"
    class:view-tab--active={mode === "time-entries"}
    onclick={() => switchMode("time-entries")}
  >
    Zeiteinträge
  </button>
</div>

{#if error}
  <div class="alert alert-error error-banner" role="alert">
    <span>&#x26A0;</span><span>{error}</span>
  </div>
{/if}

<!-- CSV Input -->
<Card animate class="csv-card">
  <CardHeader title="CSV-Daten" sub="Datei laden oder Inhalt einfügen">
    {#snippet actions()}
      <label class="btn btn-ghost sm file-label">
        Datei laden
        <input
          type="file"
          accept=".csv,.txt"
          onchange={handleFileUpload}
          class="file-input-hidden"
        />
      </label>
      {#if csvText}
        <button class="btn btn-ghost sm" onclick={reset}>Leeren</button>
      {/if}
    {/snippet}
  </CardHeader>

  <div class="form-group">
    <label for="csv-input" class="form-label">CSV-Inhalt</label>
    <textarea
      id="csv-input"
      class="form-input csv-textarea"
      bind:value={csvText}
      placeholder="CSV hier einfügen oder Datei hochladen..."
      rows="10"
    ></textarea>
  </div>

  <details class="example-hint">
    <summary class="example-summary"> Beispielformat anzeigen </summary>
    <pre class="example-pre">{exampleText}</pre>
  </details>

  <div class="card-foot">
    <span class="foot-meta">
      {csvText.trim() ? "Bereit für Vorschau oder Import." : "Noch keine Daten geladen."}
    </span>
    <span class="spacer"></span>
    <button class="btn btn-outline sm" onclick={handlePreview} disabled={!csvText.trim() || loading}>
      Vorschau
    </button>
    <button class="btn btn-primary sm" onclick={handleImport} disabled={!csvText.trim() || loading}>
      {#if loading}
        Importiere…
      {:else}
        Importieren
      {/if}
    </button>
  </div>
</Card>

<!-- Preview Table -->
{#if showPreview && preview.length > 0}
  <Card animate class="preview-card">
    <CardHeader
      title="Vorschau"
      sub={`${preview.length} Zeile${preview.length === 1 ? "" : "n"} erkannt`}
    />
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            {#each Object.keys(preview[0]) as col (col)}
              <th>{col}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each preview as row, i (i)}
            <tr>
              <td class="row-num">{i + 1}</td>
              {#each Object.values(row) as val, j (j)}
                <td class="cell-data">{val}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
{/if}

<!-- Results -->
{#if result}
  <Card animate>
    <CardHeader title="Import-Ergebnis" sub="Zeilenweise Auswertung" />

    <div class="result-summary">
      <span class="badge badge-gray">{result.total} Gesamt</span>
      <span class="badge badge-green">{result.imported} Importiert</span>
      {#if result.errors > 0}
        <span class="badge badge-red">{result.errors} Fehler</span>
      {/if}
    </div>

    {#if result.details.length > 0}
      <div class="table-wrapper result-table">
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
            {#each result.details as detail (detail.row)}
              <tr>
                <td class="cell-data">{detail.row}</td>
                <td>
                  <span class="badge {detail.status === 'ok' ? 'badge-green' : 'badge-red'}">
                    {detail.status === "ok" ? "OK" : "Fehler"}
                  </span>
                </td>
                {#if mode === "employees"}
                  <td class="cell-data">{detail.email ?? "–"}</td>
                {/if}
                <td class="cell-detail">
                  {detail.error ?? "–"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
{/if}
</div>

<style>
  .mode-tabs {
    margin-bottom: 1.5rem;
  }

  .error-banner {
    margin-bottom: 1rem;
  }

  :global(.csv-card) {
    margin-bottom: 1.25rem;
  }

  :global(.preview-card) {
    margin-bottom: 1.5rem;
  }

  .file-label {
    cursor: pointer;
  }

  .file-input-hidden {
    display: none;
  }

  .example-hint {
    margin-top: 0.75rem;
  }

  .csv-textarea {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    resize: vertical;
    min-height: 120px;
  }

  .example-summary {
    color: var(--text-muted);
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .example-pre {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background-color: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.75rem;
    overflow-x: auto;
    white-space: pre;
    margin-top: 0.5rem;
    color: var(--text-muted);
  }

  .foot-meta {
    color: var(--text-muted);
    font-size: 12.5px;
  }

  .spacer {
    flex: 1;
  }

  .result-summary {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .result-table {
    margin-top: 1rem;
  }

  .row-num {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .cell-data {
    font-size: 0.875rem;
    color: var(--text);
  }

  .cell-detail {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
</style>
