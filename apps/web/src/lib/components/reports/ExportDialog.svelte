<script lang="ts">
  // Issue #612 (D-612-6, ADD-5, UI-SPEC "Exportieren dialog") - the one dialog behind the period
  // bar's „Exportieren“ button: Monatsexport (PDF), DATEV-Export and the CSV of the table „Zeiten &
  // Konten“. For a period of several months it asks for the month of the first two (default: the
  // last); the CSV always covers the whole period. The § 9 note belongs to the Monatsexport block
  // and follows the chosen month.
  //
  // The component names no route and owns no download: the page injects the three downloads, the
  // § 9 loader and the error report, so the salon rules (Monatsexport and CSV carry the header
  // salon, DATEV never does) stay in ONE place - the page - and are pinned there.
  import { untrack } from "svelte";
  import Icon from "$components/Icon.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import { monthNameDe } from "$lib/reports/period-format";
  import type { YearMonth } from "$lib/reports/period-report";
  import { addMonths, monthsBetween } from "$lib/reports/period-state";
  import {
    DATEV_ALL_SALONS_NOTE,
    EXPORT_NO_STAMMSALON_NOTE,
    PERSON_SALDO_NOT_SPLIT_LABEL,
    SALON_CSV_PERSONS_NOTE,
    SALON_EXPORT_PERSONS_NOTE,
  } from "$lib/salons/page-scope"; // Issue #542, #714

  interface Props {
    /** Two-way bindable open state (Escape, backdrop and „Schließen“ clear it). */
    open: boolean;
    /** The period shown on the page; Monatsexport and DATEV use one month of it. */
    from: YearMonth;
    to: YearMonth;
    /** The period label (the dialog's eyebrow). */
    periodLabel: string;
    /** A salon filter applies: the #542 notes explain who the exports list. */
    filterActive: boolean;
    /** The server answered the one 404 for the chosen salon (Monatsexport or CSV). */
    salonRejected: boolean;
    /** The § 9 note of a month (null when it has none). Never narrowed by the header salon. */
    loadSection9Note: (year: number, month: number) => Promise<string | null>;
    onMonthlyExport: (year: number, month: number) => Promise<void>;
    onDatev: (year: number, month: number) => Promise<void>;
    /** The CSV covers the whole period of the page. */
    onCsv: () => Promise<void>;
    /** A download failed: the copy-deck text (the page shows it as a toast). */
    onError: (message: string) => void;
  }

  let {
    open = $bindable(),
    from,
    to,
    periodLabel,
    filterActive,
    salonRejected,
    loadSection9Note,
    onMonthlyExport,
    onDatev,
    onCsv,
    onError,
  }: Props = $props();

  const ERROR_TEXT = {
    monthly: "Der Monatsexport konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
    datev: "Der DATEV-Export konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
    csv: "Die CSV-Datei konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
  } as const;

  type Kind = keyof typeof ERROR_TEXT;

  const keyOf = (ym: YearMonth) => `${ym.year}-${String(ym.month).padStart(2, "0")}`;

  // ── The month of Monatsexport and DATEV ─────────────────────────────────────────────

  const months = $derived<YearMonth[]>(
    Array.from({ length: Math.max(1, monthsBetween(from, to)) }, (_, i) => addMonths(from, i)),
  );
  let chosen = $state<string | null>(null);
  // The last month of the period unless the reader chose another one of it.
  const selected = $derived<YearMonth>(
    months.find((m) => keyOf(m) === chosen) ?? months[months.length - 1],
  );

  // A new opening (or another period) starts at the last month again.
  $effect(() => {
    void open;
    void from;
    void to;
    untrack(() => {
      chosen = null;
    });
  });

  // ── The § 9 note of the chosen month ────────────────────────────────────────────────

  let note = $state<string | null>(null);
  // Plain let: an older answer never overwrites a newer one (not reactive on purpose).
  let noteGeneration = 0;

  async function readNote(year: number, month: number) {
    const generation = ++noteGeneration;
    try {
      const text = await loadSection9Note(year, month);
      if (generation === noteGeneration) note = text;
    } catch {
      // The note explains, it never blocks: on an error nothing is shown.
      if (generation === noteGeneration) note = null;
    }
  }

  $effect(() => {
    if (!open) return;
    const { year, month } = selected;
    untrack(() => {
      note = null;
      void readNote(year, month);
    });
  });

  // ── Downloads ───────────────────────────────────────────────────────────────────────

  let busy = $state<Record<Kind, boolean>>({ monthly: false, datev: false, csv: false });

  async function run(kind: Kind, download: () => Promise<void>) {
    busy = { ...busy, [kind]: true };
    try {
      await download();
    } catch {
      onError(ERROR_TEXT[kind]);
    } finally {
      busy = { ...busy, [kind]: false };
    }
  }
</script>

{#snippet footerButtons()}
  <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Schließen</button>
{/snippet}

<Modal bind:open eyebrow={periodLabel} title="Exportieren" footer={footerButtons}>
  {#if months.length > 1}
    <div class="export-month">
      <label class="form-label" for="export-dialog-month">Monat für Monatsexport und DATEV</label>
      <select
        id="export-dialog-month"
        class="form-input"
        data-autofocus
        value={keyOf(selected)}
        onchange={(e) => (chosen = e.currentTarget.value)}
      >
        {#each months as m (keyOf(m))}
          <option value={keyOf(m)}>{monthNameDe(m.year, m.month)}</option>
        {/each}
      </select>
      <p class="form-hint">Monatsexport und DATEV gelten für einen Monat.</p>
    </div>
  {/if}

  <section class="export-block" data-export-block="monthly">
    <h4 class="export-title">Monatsexport (PDF)</h4>
    <p class="export-desc">
      Lesbare Fassung des DATEV-Exports – alle Personen eines Monats, ohne Tagesliste.
    </p>
    {#if filterActive}
      <p class="form-hint" data-testid="export-salon-persons-note">
        {SALON_EXPORT_PERSONS_NOTE} · {PERSON_SALDO_NOT_SPLIT_LABEL}. {EXPORT_NO_STAMMSALON_NOTE}
      </p>
    {/if}
    <button
      type="button"
      class="btn btn-outline sm"
      data-autofocus={months.length === 1 ? "" : undefined}
      aria-label="Monatsexport herunterladen"
      disabled={busy.monthly}
      onclick={() => run("monthly", () => onMonthlyExport(selected.year, selected.month))}
    >
      {#if busy.monthly}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
      Monatsexport herunterladen
    </button>
    {#if note}
      <div class="callout brand" data-testid="report-section9-note">
        <span aria-hidden="true">§</span>
        <p>{note}</p>
      </div>
    {/if}
  </section>

  <hr class="divider" />

  <section class="export-block" data-export-block="datev">
    <h4 class="export-title">DATEV-Export</h4>
    <p class="export-desc">Lohndatei für die Übergabe an DATEV, ein Monat.</p>
    {#if filterActive}
      <p class="form-hint" data-testid="datev-all-salons-note">{DATEV_ALL_SALONS_NOTE}</p>
    {/if}
    <button
      type="button"
      class="btn btn-outline sm"
      aria-label="DATEV-Datei herunterladen"
      disabled={busy.datev}
      onclick={() => run("datev", () => onDatev(selected.year, selected.month))}
    >
      {#if busy.datev}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
      DATEV-Datei herunterladen
    </button>
  </section>

  <hr class="divider" />

  <section class="export-block" data-export-block="csv">
    <h4 class="export-title">Tabelle als CSV</h4>
    <p class="export-desc">
      Die Tabelle „Zeiten &amp; Konten“ für den ganzen Zeitraum, Semikolon-getrennt, für Excel.
    </p>
    {#if filterActive}
      <!-- Issue #714 (D-09): who the file lists under a salon filter. -->
      <p class="form-hint" data-testid="export-csv-salon-note">{SALON_CSV_PERSONS_NOTE}</p>
    {/if}
    <button
      type="button"
      class="btn btn-outline sm"
      aria-label="CSV-Datei herunterladen"
      disabled={busy.csv}
      onclick={() => run("csv", () => onCsv())}
    >
      {#if busy.csv}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
      CSV-Datei herunterladen
    </button>
  </section>

  {#if salonRejected}
    <SalonScopeLabel label={null} rejected={true} />
  {/if}
</Modal>

<style>
  .export-month {
    margin-bottom: var(--s-4);
  }

  .export-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-2);
  }

  .export-block .callout {
    align-self: stretch;
  }

  .export-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }

  .export-desc {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .export-block .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }

  @media (pointer: coarse) {
    .export-block .btn {
      min-height: 44px;
    }
  }
</style>
