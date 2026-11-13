<script lang="ts">
  // Issue #612 (D-612-6, ADD-5) rebuilt on Dialog + List for Issue #854 (D-854-22): the one dialog
  // behind the page head's „Exportieren“ button. It offers the Monatsexport (PDF), the CSV of the
  // table „Zeiten & Konten“ and (Issue #713) the CSV of the table „Abwesenheiten je Person“. It
  // starts NO DATEV download any more: the payroll export lives only in Daten › Export, and the
  // DATEV row links there with the chosen month preselected. For a period of several months it
  // asks for the month of the Monatsexport and the DATEV link (default: the last); both CSVs always
  // cover the whole period. The § 9 note belongs to the Monatsexport block and follows the month.
  //
  // The component names no download route and owns no download: the page injects the three
  // downloads, the § 9 loader and the error report, so the salon rules (Monatsexport and CSV carry
  // the header salon, DATEV is never narrowed) stay in ONE place - the page - and are pinned there.
  import { untrack } from "svelte";
  import Icon from "$components/Icon.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Note from "$components/ui/Note.svelte";
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
    /** The CSV covers the whole period of the page. */
    onCsv: () => Promise<void>;
    /** The CSV of the table „Abwesenheiten je Person“ covers the whole period of the page (#713). */
    onAbsenceCsv: () => Promise<void>;
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
    onCsv,
    onAbsenceCsv,
    onError,
  }: Props = $props();

  const ERROR_TEXT = {
    monthly: "Der Monatsexport konnte nicht erstellt werden. Bitte versuch es noch einmal.",
    csv: "Die CSV-Datei konnte nicht erstellt werden. Bitte versuch es noch einmal.",
    // Issue #713: new text speaks to the reader as „du“.
    absences: "Die Abwesenheiten-CSV konnte nicht erstellt werden. Versuch es bitte noch einmal.",
  } as const;

  type Kind = keyof typeof ERROR_TEXT;

  const keyOf = (ym: YearMonth) => `${ym.year}-${String(ym.month).padStart(2, "0")}`;

  // ── The month of Monatsexport and the DATEV link ─────────────────────────────────────────────

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

  let busy = $state<Record<Kind, boolean>>({
    monthly: false,
    csv: false,
    absences: false,
  });

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

<Dialog bind:open eyebrow={periodLabel} title="Exportieren">
  {#if months.length > 1}
    <div class="export-month">
      <FormField
        label="Monat für Monatsexport und DATEV"
        help="Monatsexport und DATEV gelten für einen Monat."
      >
        {#snippet field({ id, describedBy })}
          <select
            {id}
            aria-describedby={describedBy}
            data-autofocus
            value={keyOf(selected)}
            onchange={(e) => (chosen = e.currentTarget.value)}
          >
            {#each months as m (keyOf(m))}
              <option value={keyOf(m)}>{monthNameDe(m.year, m.month)}</option>
            {/each}
          </select>
        {/snippet}
      </FormField>
    </div>
  {/if}

  <div class="export-blocks">
    <div class="export-block" data-export-block="monthly">
      <List ariaLabel="Monatsexport (PDF)">
        <ListRow
          avatar={false}
          wrap
          title="Monatsexport (PDF)"
          subtitle="Lesbare Fassung des DATEV-Exports – alle Personen eines Monats, ohne Tagesliste."
        >
          {#snippet trailing()}
            <button
              type="button"
              class="btn btn-outline"
              data-autofocus={months.length === 1 ? "" : undefined}
              aria-label="Monatsexport herunterladen"
              disabled={busy.monthly}
              onclick={() => run("monthly", () => onMonthlyExport(selected.year, selected.month))}
            >
              {#if busy.monthly}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
              Herunterladen
            </button>
          {/snippet}
        </ListRow>
      </List>
      {#if filterActive}
        <p class="form-hint" data-testid="export-salon-persons-note">
          {SALON_EXPORT_PERSONS_NOTE} · {PERSON_SALDO_NOT_SPLIT_LABEL}. {EXPORT_NO_STAMMSALON_NOTE}
        </p>
      {/if}
      {#if note}
        <div data-testid="report-section9-note">
          <Note tone="brand">{note}</Note>
        </div>
      {/if}
    </div>

    <div class="export-block" data-export-block="datev">
      <List ariaLabel="DATEV-Lohnexport">
        <ListRow
          avatar={false}
          wrap
          title="DATEV-Lohnexport"
          subtitle="Den DATEV-Export findest du unter Daten › Export – mit diesem Monat vorbelegt."
        >
          {#snippet trailing()}
            <a
              class="btn btn-outline"
              data-testid="export-datev-link"
              href={`/verwalten/daten/export?year=${selected.year}&month=${selected.month}`}
              >Zu Daten › Export</a
            >
          {/snippet}
        </ListRow>
      </List>
      {#if filterActive}
        <p class="form-hint" data-testid="datev-all-salons-note">{DATEV_ALL_SALONS_NOTE}</p>
      {/if}
    </div>

    <div class="export-block" data-export-block="csv">
      <List ariaLabel="Tabelle als CSV">
        <ListRow
          avatar={false}
          wrap
          title="Tabelle als CSV"
          subtitle="Die Tabelle „Zeiten & Konten“ für den ganzen Zeitraum, Semikolon-getrennt, für Excel."
        >
          {#snippet trailing()}
            <button
              type="button"
              class="btn btn-outline"
              aria-label="CSV-Datei herunterladen"
              disabled={busy.csv}
              onclick={() => run("csv", () => onCsv())}
            >
              {#if busy.csv}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
              Herunterladen
            </button>
          {/snippet}
        </ListRow>
      </List>
      {#if filterActive}
        <!-- Issue #714 (D-09): who the file lists under a salon filter. -->
        <p class="form-hint" data-testid="export-csv-salon-note">{SALON_CSV_PERSONS_NOTE}</p>
      {/if}
    </div>

    <div class="export-block" data-export-block="absences-csv">
      <List ariaLabel="Abwesenheiten als CSV">
        <ListRow
          avatar={false}
          wrap
          title="Abwesenheiten als CSV"
          subtitle="Die Tabelle „Abwesenheiten je Person“ für den ganzen Zeitraum, alle Spalten, Semikolon-getrennt, für Excel."
        >
          {#snippet trailing()}
            <button
              type="button"
              class="btn btn-outline"
              aria-label="Abwesenheiten-CSV herunterladen"
              disabled={busy.absences}
              onclick={() => run("absences", () => onAbsenceCsv())}
            >
              {#if busy.absences}<Spinner size={13} />{:else}<Icon name="download" size={14} />{/if}
              Herunterladen
            </button>
          {/snippet}
        </ListRow>
      </List>
      {#if filterActive}
        <!-- Issue #713 (D-11): the same persons as the times CSV under a salon filter. -->
        <p class="form-hint" data-testid="export-absences-csv-salon-note">
          {SALON_CSV_PERSONS_NOTE}
        </p>
      {/if}
    </div>
  </div>

  {#if salonRejected}
    <SalonScopeLabel label={null} rejected={true} />
  {/if}

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Schließen</button>
  {/snippet}
</Dialog>

<style>
  .export-month {
    margin-bottom: var(--s-4);
  }

  .export-blocks {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .export-block {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
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
