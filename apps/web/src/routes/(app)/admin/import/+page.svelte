<!--
  Verwalten › Daten › CSV-Import (Issue #854, D-854-10): an operation page, not a settings page. The mode
  choice (Personen · Zeiten) offers each mode only with its own import permission; the file or the pasted
  text goes to POST /imports/employees or /imports/time-entries unchanged. The result is a KpiStrip plus a
  DataTable of the refused rows. Every cell of the preview and of the result is rendered as TEXT only
  (no `{@html}`, T-854-65): a hostile CSV cell never becomes markup.
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import { hasPermission } from "$lib/permissions";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import Note from "$components/ui/Note.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  type ImportMode = "employees" | "time-entries";

  // A type alias (not an interface) so a result row satisfies the DataTable's Record row type.
  type ImportResult = {
    row: number;
    status: "ok" | "error";
    email?: string;
    error?: string;
  };

  interface ImportResponse {
    total: number;
    imported: number;
    errors: number;
    // Issue #356: hints for CSV headers the importer did not recognize — additive,
    // omitted/empty when every header matched a known column.
    warnings?: string[];
    details: ImportResult[];
  }

  /** The preview shows this many rows at most; the import itself always takes the whole text. */
  const PREVIEW_LIMIT = 50;

  const canEmployees = $derived(hasPermission($authStore.user, "employee:import:ZUGEWIESEN"));
  const canTimeEntries = $derived(hasPermission($authStore.user, "time-entry:import:ZUGEWIESEN"));
  const modeOptions = $derived([
    ...(canEmployees ? [{ value: "employees", label: "Personen" }] : []),
    ...(canTimeEntries ? [{ value: "time-entries", label: "Zeiten" }] : []),
  ]);

  let chosenMode: ImportMode = $state("employees");
  // The chosen mode, or the first one the user may use when the choice is not (or no longer) offered.
  const mode = $derived<ImportMode>(
    modeOptions.some((o) => o.value === chosenMode)
      ? chosenMode
      : ((modeOptions[0]?.value as ImportMode | undefined) ?? chosenMode),
  );

  let csvText = $state("");
  let loading = $state(false);
  let csvError = $state("");
  let importResponse = $state<ImportResponse | null>(null);
  let preview: Record<string, string>[] = $state([]);
  let showPreview = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const exampleEmployees = `email;firstName;lastName;employeeNumber;hireDate;role;weeklyHours;password;salonId
max@firma.de;Max;Mustermann;1001;01.01.2024;EMPLOYEE;40;Passwort1!;<Salon-ID>
anna@firma.de;Anna;Schmidt;1002;15.03.2024;MANAGER;38.5;;<Salon-ID>`;

  const exampleTimeEntries = `employeeNumber;date;startTime;endTime;breakMinutes;note
1001;01.03.2024;08:00;16:30;30;Normaler Arbeitstag
1001;02.03.2024;09:00;17:00;45;Meeting-Tag`;

  const exampleText = $derived(mode === "employees" ? exampleEmployees : exampleTimeEntries);

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
    csvError = "";
    importResponse = null;
    if (!csvText.trim()) {
      csvError = "Bitte CSV-Daten eingeben oder eine Datei laden.";
      return;
    }
    const rows = parseCsvLocal(csvText);
    if (rows.length === 0) {
      csvError = "Keine Datenzeilen gefunden. Mindestens Kopfzeile und eine Zeile sind nötig.";
      return;
    }
    preview = rows;
    showPreview = true;
  }

  async function handleImport() {
    csvError = "";
    importResponse = null;
    if (!csvText.trim()) {
      csvError = "Bitte CSV-Daten eingeben oder eine Datei laden.";
      return;
    }
    loading = true;
    try {
      const res = await api.post<ImportResponse>(`/imports/${mode}`, { csv: csvText });
      importResponse = res;
      showPreview = false;
      if (res.imported === 0) {
        toasts.error("Es wurde keine Zeile übernommen. Prüfe die abgelehnten Zeilen unten.");
      } else if (res.errors > 0) {
        toasts.success(
          `${res.imported} von ${res.total} Zeilen übernommen, ${res.errors} abgelehnt.`,
        );
      } else {
        toasts.success(`${res.imported} Zeilen übernommen.`);
      }
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Der Import ist fehlgeschlagen.");
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
      csvError = "";
    };
    reader.readAsText(file);
    // Allow loading the same file twice in a row.
    input.value = "";
  }

  function reset() {
    csvText = "";
    preview = [];
    showPreview = false;
    importResponse = null;
    csvError = "";
  }

  function switchMode(value: string) {
    chosenMode = value as ImportMode;
    reset();
  }

  const previewColumns = $derived<DataTableColumn[]>([
    { key: "__row", label: "Zeile", primary: true },
    ...Object.keys(preview[0] ?? {}).map((key) => ({ key, label: key })),
  ]);
  const previewRows = $derived(
    preview.slice(0, PREVIEW_LIMIT).map((row, i) => ({ ...row, __row: String(i + 1) })),
  );

  const refusedRows = $derived(importResponse?.details.filter((d) => d.status === "error") ?? []);
  const resultColumns = $derived<DataTableColumn[]>([
    { key: "row", label: "Zeile", primary: true, width: "6rem" },
    ...(mode === "employees" ? [{ key: "email", label: "E-Mail" }] : []),
    { key: "error", label: "Grund" },
  ]);
  const resultItems = $derived([
    { label: "Zeilen gesamt", value: importResponse?.total ?? 0 },
    { label: "Übernommen", value: importResponse?.imported ?? 0 },
    { label: "Abgelehnt", value: importResponse?.errors ?? 0 },
  ]);
</script>

<svelte:head>
  <title>{pageLabel("/admin/import")} – Clokr</title>
</svelte:head>

<div data-testid="admin-import-page" style="display: contents;">
  <PageHead
    title={pageLabel("/admin/import")}
    sub="Hier übernimmst du Personen oder Zeiten aus einer CSV-Datei."
  />

  {#if modeOptions.length > 1}
    <div class="import-mode">
      <span class="import-mode-label">Was importierst du?</span>
      <SegmentedControl
        options={modeOptions}
        value={mode}
        name="import-mode"
        ariaLabel="Was importierst du?"
        onchange={switchMode}
      />
    </div>
  {/if}

  <section class="settings-group" aria-labelledby="import-csv-title">
    <h2 class="settings-group-title" id="import-csv-title">CSV-Daten</h2>
    <p class="settings-group-desc">Wähle eine Datei oder füge den Inhalt unten ein.</p>

    <div class="import-actions">
      <button
        type="button"
        class="btn btn-outline"
        onclick={() => fileInput?.click()}
        disabled={loading}
      >
        CSV-Datei laden
      </button>
      <input
        bind:this={fileInput}
        type="file"
        accept=".csv,.txt"
        onchange={handleFileUpload}
        hidden
        tabindex="-1"
        data-testid="import-file"
      />
      {#if csvText}
        <button type="button" class="btn btn-ghost" onclick={reset} disabled={loading}>
          Leeren
        </button>
      {/if}
    </div>

    <FormField label="CSV-Inhalt" required error={csvError}>
      {#snippet field({ id, describedBy, invalid })}
        <textarea
          {id}
          class="form-input csv-textarea"
          bind:value={csvText}
          placeholder="CSV hier einfügen oder Datei laden…"
          rows="10"
          aria-describedby={describedBy}
          aria-invalid={invalid ? "true" : undefined}
        ></textarea>
      {/snippet}
    </FormField>

    <details class="example-hint">
      <summary class="example-summary">Beispielformat anzeigen</summary>
      <pre class="example-pre">{exampleText}</pre>
      {#if mode === "employees"}
        <p class="example-note">
          Die Spalte „salonId“ (Stammsalon) enthält die ID des Salons. Bei mehreren aktiven Salons
          ist sie in jeder Zeile nötig; bei genau einem aktiven Salon darf sie leer bleiben.
        </p>
      {/if}
    </details>

    <div class="import-actions">
      <button
        type="button"
        class="btn btn-outline"
        onclick={handlePreview}
        disabled={!csvText.trim() || loading}
      >
        Vorschau
      </button>
      <button
        type="button"
        class="btn btn-primary"
        onclick={handleImport}
        disabled={!csvText.trim() || loading}
        data-testid="import-submit"
      >
        {#if loading}<Spinner size={14} label="Import läuft" />{/if}
        Importieren
      </button>
    </div>
  </section>

  {#if showPreview && preview.length > 0}
    <section class="settings-group" aria-labelledby="import-preview-title">
      <h2 class="settings-group-title" id="import-preview-title">Vorschau</h2>
      <p class="settings-group-desc">
        {preview.length}
        {preview.length === 1 ? "Zeile" : "Zeilen"} erkannt. Noch ist nichts übernommen.
      </p>
      {#if preview.length > PREVIEW_LIMIT}
        <Note tone="info">
          Die Vorschau zeigt die ersten {PREVIEW_LIMIT} Zeilen. Beim Import werden alle Zeilen übernommen.
        </Note>
      {/if}
      <DataTable
        columns={previewColumns}
        rows={previewRows}
        rowKey={(row) => row.__row}
        caption="Vorschau der erkannten CSV-Zeilen"
      />
    </section>
  {/if}

  {#if importResponse}
    <section
      class="settings-group"
      aria-labelledby="import-result-title"
      data-testid="import-result"
    >
      <h2 class="settings-group-title" id="import-result-title">Ergebnis</h2>
      <KpiStrip items={resultItems} ariaLabel="Ergebnis des Imports" />

      {#if importResponse.warnings && importResponse.warnings.length > 0}
        <Note tone="warn">
          {#each importResponse.warnings as warning (warning)}
            <span class="import-warning">{warning}</span>
          {/each}
        </Note>
      {/if}

      {#if refusedRows.length > 0}
        <DataTable
          columns={resultColumns}
          rows={refusedRows}
          rowKey={(row) => row.row}
          caption="Abgelehnte Zeilen mit dem Grund"
        >
          {#snippet cell(row, column)}
            {#if column.key === "row"}
              {row.row}
            {:else if column.key === "email"}
              {row.email ?? "–"}
            {:else}
              <span class="import-reason">{row.error ?? "–"}</span>
            {/if}
          {/snippet}
        </DataTable>
      {:else}
        <Note tone="ok">Alle Zeilen wurden übernommen.</Note>
      {/if}
    </section>
  {/if}
</div>

<style>
  .import-mode {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    margin-bottom: var(--s-6);
  }

  .import-mode-label {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .import-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .csv-textarea {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
    resize: vertical;
    min-height: 120px;
    width: 100%;
  }

  .example-summary {
    color: var(--text-2);
    font-size: var(--fs-sm);
    cursor: pointer;
  }

  .example-note {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .example-pre {
    font-family: var(--font-code);
    font-size: var(--fs-sm);
    background-color: var(--sunk);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: var(--s-3);
    overflow-x: auto;
    white-space: pre;
    margin: var(--s-2) 0 0;
    color: var(--text-2);
  }

  .import-warning {
    display: block;
  }

  /* A refusal reason can be long; in the table it wraps instead of widening the scroll area. */
  .import-reason {
    white-space: normal;
    overflow-wrap: anywhere;
  }
</style>
