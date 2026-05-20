<script lang="ts">
  import { onMount } from "svelte";
  import { toasts } from "$stores/toast";
  import { authStore } from "$stores/auth";
  import PageHead from "$components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";

  type ExportFormat = "datev" | "pdf" | "ical";

  let format: ExportFormat = $state("datev");
  let exporting = $state(false);
  let lastExportLabel: string | null = $state(null);

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
    // Page render-only — no API preload required for v1.5
  });
</script>

<svelte:head><title>DATEV-Export – Clokr</title></svelte:head>

<div class="page">
  <PageHead
    eyebrow="Administration"
    title="DATEV-Export"
    accent="DATEV"
    sub="Lohndaten an die Steuerkanzlei übergeben — DATEV-LODAS / PDF-Berichte / iCal. Audit-Log wird beim Export fortgeschrieben."
  />

  <div class="grid grid-12">
    <!-- Configure (col-7) -->
    <Card animate class="col-7">
      <CardHeader title="Export konfigurieren" sub="Format · Zeitraum · Empfänger" />

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

      <div class="card-foot">
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
      </div>
    </Card>

    <!-- Preview (col-5) -->
    <Card animate class="col-5 preview-card">
      <CardHeader title="Vorschau" sub="DATEV-LODAS · {selectedPeriod.label}" />
      <pre class="csv-preview"><span class="csv-section">[Allgemein]</span>
Beraternummer;{advisorNumber}
Mandantennummer;{clientNumber}
Abrechnungsmonat;{selectedPeriod.value.replace("-", "")}

<span class="csv-section">[Lohn-Daten]</span>
PersNr;Name;StundenSoll;StundenIst;Urlaub;Krank;Mehrarbeit
… wird beim Export erzeugt</pre>
      <div class="card-foot foot-meta">
        Schreibgeschützte Vorschau — Signatur wird beim Export erzeugt.
      </div>
    </Card>
  </div>
</div>

<style>
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

  @media (max-width: 720px) {
    .format-picker {
      grid-template-columns: 1fr;
    }
    .field-row {
      grid-template-columns: 1fr;
    }
  }
</style>
