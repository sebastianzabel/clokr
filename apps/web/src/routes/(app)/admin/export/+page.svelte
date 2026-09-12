<script lang="ts">
  import { onMount } from "svelte";
  import { toasts } from "$stores/toast";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { api } from "$api/client";
  import ToolPage from "$lib/components/admin/ToolPage.svelte";
  import Section from "$lib/components/admin/Section.svelte";

  type ExportFormat = "datev" | "pdf" | "ical";

  // ── Tabs (Phase 58: separate "run an export" from "configure Lohnarten") ───
  const TABS = [
    { id: "export", label: "Export erstellen" },
    { id: "konfiguration", label: "Lohnartennummern" },
  ];
  let activeTab = $state<string>("export");

  let format: ExportFormat = $state("datev");
  let exporting = $state(false);
  let lastExportLabel: string | null = $state(null);

  // ── DATEV Lohnartennummern (moved from /admin/system in Phase 58) ──────────
  interface DatevConfig {
    datevNormalstundenNr?: number;
    datevUrlaubNr?: number;
    datevKrankNr?: number;
    datevSonderurlaubNr?: number;
    [k: string]: unknown;
  }
  let datevNormalstundenNr = $state(100);
  let datevUrlaubNr = $state(300);
  let datevKrankNr = $state(200);
  let datevSonderurlaubNr = $state(302);
  let datevSaving = $state(false);
  let datevSaved = $state(false);
  let datevError = $state("");
  // Hold the full /settings/work payload so we don't partial-overwrite on save.
  let _gOtherFields: Record<string, unknown> | null = $state(null);

  // ── Unsaved-section tracking (Phase 109, D-11/D-12 · AK-06/AK-07) ──────────────
  function snap(...values: unknown[]): string {
    return JSON.stringify(values);
  }

  let datevSnapshot = $state("");
  let datevDirty = $derived(
    snap(datevNormalstundenNr, datevUrlaubNr, datevKrankNr, datevSonderurlaubNr) !== datevSnapshot,
  );

  // Gate the registration on "the baseline has been taken" (WR-01). loadDatev swallows its error
  // ("non-blocking: keep defaults"), and saveDatev then provably cannot write at all
  // (`if (!_gOtherFields) return;`) — a "Nicht gespeichert" marker on a page whose save button is
  // a no-op would be a lie, and the guard would trap the user on it.
  let snapshotsReady = $state(false);

  $effect(() => {
    markUnsaved("admin-export", snapshotsReady && datevDirty);
    return () => markUnsaved("admin-export", false);
  });

  async function loadDatev() {
    try {
      const cfg = await api.get<DatevConfig>("/settings/work");
      datevNormalstundenNr = Number(cfg.datevNormalstundenNr ?? 100);
      datevUrlaubNr = Number(cfg.datevUrlaubNr ?? 300);
      datevKrankNr = Number(cfg.datevKrankNr ?? 200);
      datevSonderurlaubNr = Number(cfg.datevSonderurlaubNr ?? 302);
      _gOtherFields = cfg as Record<string, unknown>;
      datevSnapshot = snap(datevNormalstundenNr, datevUrlaubNr, datevKrankNr, datevSonderurlaubNr);
      snapshotsReady = true;
    } catch {
      // non-blocking: keep defaults
    }
  }

  async function saveDatev() {
    if (!_gOtherFields) return;
    datevSaving = true;
    datevError = "";
    datevSaved = false;
    try {
      await api.put("/settings/work", {
        ..._gOtherFields,
        datevNormalstundenNr,
        datevUrlaubNr,
        datevKrankNr,
        datevSonderurlaubNr,
      });
      datevSaved = true;
      datevSnapshot = snap(datevNormalstundenNr, datevUrlaubNr, datevKrankNr, datevSonderurlaubNr); // Phase 109 — section is clean again
      setTimeout(() => (datevSaved = false), 3000);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Fehler";
    } finally {
      datevSaving = false;
    }
  }

  // Period options: last 12 months (excluding current) as { value: 'YYYY-MM', label: 'Monat YYYY' }
  const now = new Date();
  const periods = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    return {
      value: `${y}-${String(m).padStart(2, "0")}`,
      label: d.toLocaleDateString("de-DE", { month: "long", year: "numeric" }),
      year: y,
      month: m,
    };
  });
  let period = $state(periods[0].value);
  const selectedPeriod = $derived(periods.find((p) => p.value === period) ?? periods[0]);

  // Configuration fields (display only — values stored in TenantConfig; v1.5 surfaces them for review)
  let advisorNumber = $state("71034");
  let clientNumber = $state("3082");
  let taxOffice = $state("Steuerkanzlei · Standardberater");

  // Step indicator: period (0) → employees (1) → format (2) → generate (3)
  // Since period and employees are pre-selected by default, we start at step 2 (format ready).
  // Step advances to 3 after a successful export.
  const exportStep = $derived(lastExportLabel ? 3 : format ? 2 : period ? 1 : 0);

  async function doExport() {
    if (format !== "datev") {
      toasts.info("Dieses Format folgt in einem späteren Milestone.");
      return;
    }
    exporting = true;
    try {
      const token = $authStore.accessToken;
      const res = await fetch(
        `/api/v1/reports/datev?year=${selectedPeriod.year}&month=${selectedPeriod.month}`,
        {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (!res.ok) throw new Error(`Export fehlgeschlagen (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_LODAS_${selectedPeriod.value}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      lastExportLabel = `${selectedPeriod.label} · ${new Date().toLocaleString("de-DE")}`;
      toasts.success("DATEV-CSV erstellt");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Export fehlgeschlagen");
    } finally {
      exporting = false;
    }
  }

  onMount(() => {
    void loadDatev();
  });
</script>

<svelte:head><title>DATEV Export – Clokr</title></svelte:head>

<ToolPage
  eyebrow="Daten"
  title="DATEV Export"
  sub="Lohnabrechnungs-Daten für DATEV exportieren"
  tabs={TABS}
  bind:activeTab
  steps={activeTab === "export" ? ["Zeitraum", "Mitarbeiter", "Format", "Generieren"] : undefined}
  currentStep={exportStep}
  animate
>
  {#snippet form()}
    {#if activeTab === "konfiguration"}
      <Section
        title="Lohnartennummern"
        sub="Zuordnung der DATEV-LODAS-Lohnarten — wirkt sich auf alle generierten Exporte aus."
        dirty={datevDirty}
      >
        {#if datevError}
          <div class="alert alert-error" role="alert">
            <span>⚠</span><span>{datevError}</span>
          </div>
        {/if}
        {#if datevSaved}
          <div class="alert alert-success" role="alert">
            <span>✓</span><span><span translate="no">DATEV</span>-Konfiguration gespeichert.</span>
          </div>
        {/if}

        <div class="lohnart-grid">
          <div class="form-group">
            <label class="form-label" for="datev-normal">Normalstunden</label>
            <input
              id="datev-normal"
              type="number"
              min="1"
              max="9999"
              step="1"
              bind:value={datevNormalstundenNr}
              class="form-input"
            />
            <p class="form-hint">LODAS-Lohnart für reguläre Arbeitsstunden.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="datev-urlaub">Urlaub</label>
            <input
              id="datev-urlaub"
              type="number"
              min="1"
              max="9999"
              step="1"
              bind:value={datevUrlaubNr}
              class="form-input"
            />
            <p class="form-hint">Lohnart für genommene Urlaubstage.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="datev-krank">Krank / AU</label>
            <input
              id="datev-krank"
              type="number"
              min="1"
              max="9999"
              step="1"
              bind:value={datevKrankNr}
              class="form-input"
            />
            <p class="form-hint">Lohnart für entgeltfortzahlungspflichtige Krankheitstage.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="datev-sonder" translate="no">Sonderurlaub</label>
            <input
              id="datev-sonder"
              type="number"
              min="1"
              max="9999"
              step="1"
              bind:value={datevSonderurlaubNr}
              class="form-input"
            />
            <p class="form-hint">Lohnart für Sonderurlaub nach § 616 BGB / Tarif.</p>
          </div>
        </div>

        {#snippet footer()}
          <button
            class="btn btn-primary"
            onclick={saveDatev}
            disabled={datevSaving || !_gOtherFields}
          >
            {datevSaving ? "Speichert…" : "Speichern"}
          </button>
        {/snippet}
      </Section>
    {:else}
      <div class="export-grid">
        <!-- Configure (col-7) -->
        <div class="col-7">
          <!-- No `dirty=` prop here on purpose: advisorNumber/clientNumber/taxOffice/period/
               format are parameters of a single download, never persisted (Phase 109, D-01) — an
               "unsaved" marker for them would be noise, and a navigation guard would train the
               operator to click through the dialog. -->
          <Section title="Export konfigurieren" sub="Format · Zeitraum · Empfänger">
            <div class="field field-format">
              <span class="field-label">Format</span>
              <div class="format-picker">
                <button
                  type="button"
                  class="format-tile"
                  class:active={format === "datev"}
                  onclick={() => (format = "datev")}
                >
                  <div class="format-name" translate="no">DATEV-LODAS</div>
                  <div class="format-meta">Lohnabrechnung · <span class="tabular">.csv</span></div>
                </button>
                <button
                  type="button"
                  class="format-tile disabled"
                  onclick={() => toasts.info("Bald verfügbar")}
                >
                  <div class="format-name">PDF-Bericht</div>
                  <div class="format-meta">
                    <span translate="no">Monatsabschluss</span> · <span class="tabular">.pdf</span>
                  </div>
                  <span class="chip chip-warn"><span class="dot"></span>Bald</span>
                </button>
                <button
                  type="button"
                  class="format-tile disabled"
                  onclick={() => toasts.info("Bald verfügbar")}
                >
                  <div class="format-name">iCal</div>
                  <div class="format-meta">Abwesenheiten · <span class="tabular">.ics</span></div>
                  <span class="chip chip-warn"><span class="dot"></span>Bald</span>
                </button>
              </div>
            </div>

            <div class="field-row">
              <label class="field">
                <span class="field-label">Zeitraum</span>
                <select class="select" bind:value={period}>
                  {#each periods as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
                </select>
              </label>
              <label class="field">
                <span class="field-label">Berater-Nr.</span>
                <input class="input tabular" bind:value={advisorNumber} />
              </label>
            </div>
            <div class="field-row">
              <label class="field">
                <span class="field-label">Mandanten-Nr.</span>
                <input class="input tabular" bind:value={clientNumber} />
              </label>
              <label class="field">
                <span class="field-label">Beratungsbüro</span>
                <input class="input" bind:value={taxOffice} />
              </label>
            </div>

            {#snippet footer()}
              <span class="foot-meta">
                {#if lastExportLabel}
                  Letzter Export: <b>{lastExportLabel}</b>
                {:else}
                  Noch kein Export in dieser Sitzung
                {/if}
              </span>
              <span class="spacer"></span>
              <button class="btn btn-primary" onclick={doExport} disabled={exporting}>
                {exporting ? "Erstelle…" : "Export erstellen"}
              </button>
            {/snippet}
          </Section>
        </div>

        <!-- Preview (col-5) -->
        <div class="col-5">
          <Section title="Vorschau" sub="DATEV-LODAS · {selectedPeriod.label}">
            <pre class="csv-preview"><span class="csv-section">[Allgemein]</span>
Beraternummer;{advisorNumber}
Mandantennummer;{clientNumber}
Abrechnungsmonat;{selectedPeriod.value.replace("-", "")}

<span class="csv-section">[Lohn-Daten]</span>
PersNr;Name;StundenSoll;StundenIst;Urlaub;Krank;Mehrarbeit
… wird beim Export erzeugt</pre>
            <p class="foot-meta preview-note">
              Schreibgeschützte Vorschau — Signatur wird beim Export erzeugt.
            </p>
          </Section>
        </div>
      </div>
    {/if}
  {/snippet}
</ToolPage>

<style>
  .export-grid {
    display: grid;
    grid-template-columns: 7fr 5fr;
    gap: var(--s-5);
  }

  .field-format {
    margin-top: 12px;
  }
  .format-picker {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 10px;
  }
  .format-tile {
    padding: 18px 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--bg-card);
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition:
      background 160ms var(--ease),
      border-color 160ms var(--ease),
      transform 160ms var(--ease);
  }
  .format-tile.active {
    border: 1.5px solid var(--brand-light);
    background: var(--brand-soft);
  }
  .format-tile.disabled {
    opacity: 0.7;
    cursor: default;
  }
  .format-tile:hover:not(.disabled) {
    transform: translateY(-1px);
  }
  .format-name {
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .format-meta {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .format-tile .chip {
    align-self: flex-start;
    margin-top: 4px;
    font-size: 10px;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }

  .foot-meta {
    color: var(--text-muted);
    font-size: 12.5px;
  }

  .preview-note {
    margin-top: var(--s-3);
  }

  .csv-preview {
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.7;
    overflow-x: auto;
    margin: 8px 0 0;
    white-space: pre;
  }

  .csv-section {
    color: var(--brand-light);
  }

  @media (max-width: 900px) {
    .export-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 720px) {
    .format-picker {
      grid-template-columns: 1fr;
    }
    .field-row {
      grid-template-columns: 1fr;
    }
  }

  /* ── Lohnartennummern grid (Konfiguration tab) ──────────────────────────── */
  .lohnart-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-5) var(--s-6);
    max-width: 720px;
  }
  .lohnart-grid .form-group {
    margin: 0;
  }

  @media (max-width: 720px) {
    .lohnart-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
