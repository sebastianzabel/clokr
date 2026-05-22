<script lang="ts">
  import { api } from "$api/client";
  import ToolPage from "$lib/components/admin/ToolPage.svelte";
  import Section from "$lib/components/admin/Section.svelte";

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
  let importError = $state("");
  let importResponse: ImportResponse | null = $state(null);
  let preview: Record<string, string>[] = $state([]);
  let showPreview = $state(false);

  const exampleEmployees = `email;firstName;lastName;employeeNumber;hireDate;role;weeklyHours;password
max@firma.de;Max;Mustermann;1001;01.01.2024;EMPLOYEE;40;Passwort1!
anna@firma.de;Anna;Schmidt;1002;15.03.2024;MANAGER;38.5;`;

  const exampleTimeEntries = `employeeNumber;date;startTime;endTime;breakMinutes;note
1001;01.03.2024;08:00;16:30;30;Normaler Arbeitstag
1001;02.03.2024;09:00;17:00;45;Meeting-Tag`;

  let exampleText = $derived(mode === "employees" ? exampleEmployees : exampleTimeEntries);

  const importStep = $derived(importResponse ? 2 : showPreview ? 1 : 0);

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
    importError = "";
    importResponse = null;
    if (!csvText.trim()) {
      importError = "Bitte CSV-Daten eingeben oder eine Datei hochladen.";
      return;
    }
    const rows = parseCsvLocal(csvText);
    if (rows.length === 0) {
      importError = "Keine Datenzeilen gefunden. Mindestens Header + 1 Zeile erforderlich.";
      return;
    }
    preview = rows;
    showPreview = true;
  }

  async function handleImport() {
    importError = "";
    importResponse = null;
    loading = true;
    try {
      const res = await api.post<ImportResponse>(`/imports/${mode}`, { csv: csvText });
      importResponse = res;
      showPreview = false;
    } catch (e: unknown) {
      importError = e instanceof Error ? e.message : "Fehler beim Import";
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
      importResponse = null;
      importError = "";
    };
    reader.readAsText(file);
  }

  function reset() {
    csvText = "";
    preview = [];
    showPreview = false;
    importResponse = null;
    importError = "";
  }

  function switchMode(newMode: ImportMode) {
    mode = newMode;
    reset();
  }
</script>

<svelte:head>
  <title>CSV Import – Clokr</title>
</svelte:head>

<ToolPage
  eyebrow="Daten"
  title="CSV Import"
  sub="Mitarbeiter und Zeiteinträge importieren"
  steps={["Datei wählen", "Vorschau", "Übernehmen"]}
  currentStep={importStep}
  animate
>
  {#snippet form()}
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

    {#if importError}
      <div class="alert alert-error error-banner" role="alert">
        <span>&#x26A0;</span><span>{importError}</span>
      </div>
    {/if}

    <!-- CSV Input -->
    <Section title="CSV-Daten" sub="Datei laden oder Inhalt einfügen">
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

      {#snippet footer()}
        <span class="foot-meta">
          {csvText.trim() ? "Bereit für Vorschau oder Import." : "Noch keine Daten geladen."}
        </span>
        <span class="spacer"></span>
        <button
          class="btn btn-outline sm"
          onclick={handlePreview}
          disabled={!csvText.trim() || loading}
        >
          Vorschau
        </button>
        <button
          class="btn btn-primary sm"
          onclick={handleImport}
          disabled={!csvText.trim() || loading}
        >
          {#if loading}
            Importiere…
          {:else}
            Importieren
          {/if}
        </button>
      {/snippet}
    </Section>

    <!-- Preview Table -->
    {#if showPreview && preview.length > 0}
      <Section
        title="Vorschau"
        sub={`${preview.length} Zeile${preview.length === 1 ? "" : "n"} erkannt`}
      >
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
      </Section>
    {/if}
  {/snippet}

  {#snippet result()}
    {#if importResponse}
      <Section title="Import-Ergebnis" sub="Zeilenweise Auswertung">
        <div class="result-summary">
          <span class="badge badge-gray">{importResponse.total} Gesamt</span>
          <span class="badge badge-green">{importResponse.imported} Importiert</span>
          {#if importResponse.errors > 0}
            <span class="badge badge-red">{importResponse.errors} Fehler</span>
          {/if}
        </div>

        {#if importResponse.details.length > 0}
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
                {#each importResponse.details as detail (detail.row)}
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
      </Section>
    {/if}
  {/snippet}
</ToolPage>

<style>
  .mode-tabs {
    margin-bottom: 1.5rem;
  }

  .error-banner {
    margin-bottom: 1rem;
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
