<!--
  Verwalten › Daten › Export (Issue #593, #854, D-854-12/-13/-22): the one page that STARTS a DATEV export - the
  whole company for a month (`GET /reports/datev`) or one person (`GET /reports/datev/employee`) - and where the
  other files are reachable: the times and absences of a period as CSV (`GET /reports/period/csv`), the
  Monatsexport as PDF (`GET /reports/monthly-export/pdf`) and the iCal files of the leave area.

  Before a month that is not closed is exported, a warning says so (advisory: the API decides, the button stays
  usable). „Letzte Exporte“ lists the company's recent `EXPORT` audit rows in German words (only with
  `audit-log:read`). The DATEV numbers (Berater-, Mandantennummer and the four Lohnarten) are set here and only
  here (registry section `export-datev-einrichtung`); the save sends exactly those six keys and the page keeps
  no copy of the other settings (#878).

  The DATEV file is never narrowed by a salon (§ 41 EStG, CLAUDE.md "Two report documents"): there is no salon
  choice on this page. The rules (hint, history, preselection) live in `$lib/export/export-centre`.
-->
<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, untrack } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { downloadFromApi } from "$api/download";
  import { authStore } from "$stores/auth";
  import { markUnsaved } from "$stores/unsaved";
  import { toasts } from "$stores/toast";
  import { salonContext, showSalonOptions } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions";
  import { addMonths, compareMonths } from "$lib/reports/period-state";
  import { periodAbsencesCsvPath, periodCsvPath, type YearMonth } from "$lib/reports/period-report";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { settingsSection } from "$lib/settings/settings-pages";
  import {
    csvPeriodProblem,
    exportHistoryRows,
    exportPreselection,
    monthName,
    openMonthHint,
    wholeNumberProblem,
    type ExportHistoryRow,
    type ExportLogLike,
  } from "$lib/export/export-centre";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import Combobox from "$components/ui/Combobox.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Note from "$components/ui/Note.svelte";
  import PeriodPicker from "$components/ui/PeriodPicker.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";

  const user = $derived($authStore.user);
  const canReadMonthClose = $derived(hasPermission(user, "month-close:read:ZUGEWIESEN"));
  const canReadAudit = $derived(hasPermission(user, "audit-log:read:ZUGEWIESEN"));
  const canPickPerson = $derived(hasPermission(user, "employee:read:ZUGEWIESEN"));
  const canReadTeamLeave = $derived(hasPermission(user, "leave-request:read:ZUGEWIESEN"));
  const canEditSettings = $derived(hasPermission(user, "tenant-settings:update:ZUGEWIESEN"));

  // ── The months: browser-local "today" (the API judges by the tenant zone) ──
  const now = new Date();
  const thisMonth: YearMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const lastMonth = addMonths(thisMonth, -1);

  // A link may preselect person and month (`?person=&year=&month=`); every malformed value is dropped.
  const preselection = untrack(() => exportPreselection($page.url));
  const preselectedMonth: YearMonth | null =
    preselection.year !== null && preselection.month !== null
      ? { year: preselection.year, month: preselection.month }
      : null;

  /** The month of the DATEV file and the Monatsexport; never later than the current month. */
  let exportMonth = $state<YearMonth>(
    preselectedMonth !== null && compareMonths(preselectedMonth, thisMonth) <= 0
      ? preselectedMonth
      : lastMonth,
  );
  let personId = $state(preselection.personId ?? "");

  /** The period of the CSV files. */
  let csvFrom = $state<YearMonth>(lastMonth);
  let csvTo = $state<YearMonth>(lastMonth);
  const csvProblem = $derived(csvPeriodProblem(csvFrom, csvTo, thisMonth));

  const mm = (ym: YearMonth) => String(ym.month).padStart(2, "0");

  // ── The hint before an open month ──
  // The status of every month of a year, loaded once per year. Without `month-close:read` (or after a failed
  // read) nothing is requested or shown: there is neither a hint nor an error.
  let statusByYear = $state<Record<number, Record<number, string>>>({});

  async function loadYearStatus(year: number) {
    if (statusByYear[year] !== undefined) return;
    // Claimed first, so a quick second change of month does not request the same year twice.
    statusByYear[year] = {};
    try {
      const res = await api.get<{ months: { month: number; status: string }[] }>(
        `/overtime/close-month/year-status?year=${year}`,
      );
      statusByYear[year] = Object.fromEntries(res.months.map((m) => [m.month, m.status]));
    } catch {
      // Advisory only: the export itself is decided by the API.
    }
  }

  $effect(() => {
    const year = exportMonth.year;
    if (canReadMonthClose) untrack(() => void loadYearStatus(year));
  });

  const monthHint = $derived(
    openMonthHint(
      canReadMonthClose ? statusByYear[exportMonth.year]?.[exportMonth.month] : undefined,
      exportMonth.year,
      exportMonth.month,
    ),
  );

  // ── The downloads ──
  let busy = $state<string | null>(null);

  async function download(key: string, path: string, fallbackFilename: string, done: string) {
    if (busy !== null) return;
    busy = key;
    try {
      await downloadFromApi(path, fallbackFilename);
      toasts.success(done);
      void loadHistory();
    } catch (e: unknown) {
      // A refused export carries a German explanation (e.g. the missing Berater- or Mandantennummer, or the
      // personnel numbers the DATEV format cannot take) - show it, not a status code.
      toasts.error(e instanceof Error ? e.message : "Der Export ist fehlgeschlagen.");
    } finally {
      busy = null;
    }
  }

  const exportYear = $derived(exportMonth.year);

  function exportDatev() {
    return download(
      "datev",
      `/reports/datev?year=${exportMonth.year}&month=${exportMonth.month}`,
      `DATEV_${exportYear}_${mm(exportMonth)}.txt`,
      "Die DATEV-Datei wurde heruntergeladen.",
    );
  }

  function exportDatevPerson() {
    if (personId === "") return;
    return download(
      "datev-person",
      `/reports/datev/employee?employeeId=${encodeURIComponent(personId)}&year=${exportMonth.year}&month=${exportMonth.month}`,
      `DATEV_${exportYear}_${mm(exportMonth)}_Person.txt`,
      "Die DATEV-Datei der Person wurde heruntergeladen.",
    );
  }

  function exportTimesCsv() {
    if (csvProblem !== null) return;
    return download(
      "csv-times",
      periodCsvPath(csvFrom, csvTo, null),
      "zeiten.csv",
      "Die Datei mit den Zeiten wurde heruntergeladen.",
    );
  }

  function exportAbsencesCsv() {
    if (csvProblem !== null) return;
    return download(
      "csv-absences",
      periodAbsencesCsvPath(csvFrom, csvTo, null),
      "abwesenheiten.csv",
      "Die Datei mit den Abwesenheiten wurde heruntergeladen.",
    );
  }

  function exportMonthlyPdf() {
    return download(
      "monthly-pdf",
      `/reports/monthly-export/pdf?year=${exportMonth.year}&month=${exportMonth.month}`,
      `Monatsexport_${exportYear}_${mm(exportMonth)}.pdf`,
      "Das Monatsexport wurde heruntergeladen.",
    );
  }

  function exportIcal(kind: "team" | "personal") {
    return download(
      `ical-${kind}`,
      `/leave/ical/${kind}`,
      kind === "team" ? "clokr-team-abwesenheiten.ics" : "clokr-abwesenheiten.ics",
      "Die Kalenderdatei wurde heruntergeladen.",
    );
  }

  // ── The person for the single-person DATEV file (reach-scoped `GET /employees`) ──
  type PersonOption = { id: string; firstName: string; lastName: string; employeeNumber: string };
  let people = $state<PersonOption[]>([]);

  async function loadPeople() {
    try {
      people = await api.get<PersonOption[]>("/employees");
    } catch {
      // The picker then offers nobody; the whole-company export is unaffected.
      people = [];
    }
  }

  const personItems = $derived.by(() => {
    const items = people
      .map((p) => ({ value: p.id, label: `${p.lastName}, ${p.firstName} (${p.employeeNumber})` }))
      .sort((a, b) => a.label.localeCompare(b.label, "de"));
    // A person named by a link but not in the offered list stays visible.
    if (personId !== "" && !items.some((item) => item.value === personId)) {
      items.push({ value: personId, label: "Ausgewählte Person" });
    }
    return items;
  });

  // ── „Letzte Exporte“ ──
  type Loaded<T> =
    { status: "loading" } | { status: "ready"; data: T } | { status: "failed"; message: string };
  let history = $state<Loaded<ExportHistoryRow[]>>({ status: "loading" });

  async function loadHistory() {
    if (!canReadAudit) return;
    try {
      const res = await api.get<{ logs: ExportLogLike[] }>("/audit-logs?action=EXPORT&limit=20");
      history = { status: "ready", data: exportHistoryRows(res.logs) };
    } catch (e: unknown) {
      history = {
        status: "failed",
        message:
          e instanceof Error ? e.message : "Die letzten Exporte konnten nicht geladen werden.",
      };
    }
  }

  // ── DATEV-Einrichtung (registry section `export-datev-einrichtung`) ──
  interface DatevConfig {
    datevNormalstundenNr?: number;
    datevUrlaubNr?: number;
    datevKrankNr?: number;
    datevSonderurlaubNr?: number;
    // No default: null means "not configured", and the export refuses to run (409) rather than shipping 0/0.
    datevBeraterNr?: number | null;
    datevMandantenNr?: number | null;
  }
  type DatevValues = {
    datevBeraterNr: number | null;
    datevMandantenNr: number | null;
    datevNormalstundenNr: number | null;
    datevUrlaubNr: number | null;
    datevKrankNr: number | null;
    datevSonderurlaubNr: number | null;
  };

  const datevFrom = (c: DatevConfig): DatevValues => ({
    datevBeraterNr: typeof c.datevBeraterNr === "number" ? c.datevBeraterNr : null,
    datevMandantenNr: typeof c.datevMandantenNr === "number" ? c.datevMandantenNr : null,
    datevNormalstundenNr: Number(c.datevNormalstundenNr ?? 100),
    datevUrlaubNr: Number(c.datevUrlaubNr ?? 300),
    datevKrankNr: Number(c.datevKrankNr ?? 200),
    datevSonderurlaubNr: Number(c.datevSonderurlaubNr ?? 302),
  });

  let datev = $state<DatevValues>(datevFrom({}));
  let datevSnapshot = $state<DatevValues>(datevFrom({}));
  let datevSaving = $state(false);
  let datevLoadError = $state("");
  // Gated on "the baseline has been taken": a failed load must not arm the navigation guard on a page whose
  // save provably cannot write.
  let snapshotsReady = $state(false);

  const datevKeys = settingsSection("export-datev-einrichtung")
    .keys as readonly (keyof DatevValues)[];
  const datevChanges = $derived(countChanges(datevSnapshot, datev, datevKeys));

  const datevProblems = $derived({
    datevBeraterNr: wholeNumberProblem("Berater-Nr.", datev.datevBeraterNr, {
      min: 1,
      max: 9999999,
      optional: true,
    }),
    datevMandantenNr: wholeNumberProblem("Mandantennummer", datev.datevMandantenNr, {
      min: 1,
      max: 99999,
      optional: true,
    }),
    datevNormalstundenNr: wholeNumberProblem("Normalstunden", datev.datevNormalstundenNr, {
      min: 1,
      max: 9999,
    }),
    datevUrlaubNr: wholeNumberProblem("Urlaub", datev.datevUrlaubNr, { min: 1, max: 9999 }),
    datevKrankNr: wholeNumberProblem("Krank / AU", datev.datevKrankNr, { min: 1, max: 9999 }),
    datevSonderurlaubNr: wholeNumberProblem("Sonderurlaub", datev.datevSonderurlaubNr, {
      min: 1,
      max: 9999,
    }),
  });
  const datevErrorCount = $derived(Object.values(datevProblems).filter((p) => p !== null).length);

  // The saved numbers decide the hint, not the draft: the API refuses the export while either is unset.
  const kanzleiMissing = $derived(
    snapshotsReady &&
      (datevSnapshot.datevBeraterNr === null || datevSnapshot.datevMandantenNr === null),
  );

  $effect(() => {
    markUnsaved("admin-export", snapshotsReady && datevChanges > 0);
    return () => markUnsaved("admin-export", false);
  });

  async function loadDatev() {
    try {
      const cfg = await api.get<DatevConfig>("/settings/work");
      datev = datevFrom(cfg);
      datevSnapshot = datevFrom(cfg);
      snapshotsReady = true;
    } catch (e: unknown) {
      datevLoadError =
        e instanceof Error ? e.message : "Die DATEV-Einrichtung konnte nicht geladen werden.";
    }
  }

  async function saveDatev() {
    if (!snapshotsReady || datevErrorCount > 0) return;
    datevSaving = true;
    try {
      // Exactly the six keys of the registry section: a cleared Berater- or Mandantennummer is an explicit
      // null ("not configured"), which the API accepts for these two only.
      await api.put(
        "/settings/work",
        pickSection(
          datev as Record<string, unknown>,
          settingsSection("export-datev-einrichtung").keys,
        ),
      );
      datevSnapshot = $state.snapshot(datev);
      toasts.success("DATEV-Einrichtung gespeichert.");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
    } finally {
      datevSaving = false;
    }
  }

  function discardDatev() {
    datev = $state.snapshot(datevSnapshot);
  }

  const multiSalon = $derived(showSalonOptions($salonContext));

  onMount(() => {
    void loadDatev();
    void loadHistory();
    if (untrack(() => canPickPerson)) void loadPeople();
  });
</script>

<svelte:head>
  <title>{pageLabel("/admin/export")} – Clokr</title>
</svelte:head>

<div data-testid="admin-export-page" style="display: contents;">
  <PageHead
    title={pageLabel("/admin/export")}
    sub="Hier lädst du die Lohndaten für DATEV, Zeiten, Abwesenheiten, das Monatsexport und Kalenderdateien herunter."
  />

  <section class="settings-group" aria-labelledby="export-datev-title">
    <h2 class="settings-group-title" id="export-datev-title">DATEV-Lohnexport</h2>
    <p class="settings-group-desc">
      Die Datei für die Lohnbuchhaltung, für alle Personen eines Monats oder für eine einzelne
      Person.
    </p>

    <PeriodPicker
      label={monthName(exportMonth)}
      eyebrow="Abrechnungsmonat"
      testIdPrefix="export-month"
      prevLabel="Vorheriger Monat"
      nextLabel="Nächster Monat"
      nextDisabled={compareMonths(exportMonth, thisMonth) >= 0}
      onPrev={() => (exportMonth = addMonths(exportMonth, -1))}
      onNext={() => (exportMonth = addMonths(exportMonth, 1))}
    />

    {#if monthHint}
      <div data-testid="export-open-month-hint"><Note tone="warn">{monthHint}</Note></div>
    {/if}
    {#if kanzleiMissing}
      <div data-testid="export-kanzlei-missing">
        <Note tone="warn">
          Berater-Nr. und Mandantennummer fehlen. Der DATEV-Export wird abgelehnt, bis beide unter
          <a href="#datev-einrichtung">DATEV-Einrichtung</a> hinterlegt sind.
        </Note>
      </div>
    {/if}

    <div class="export-actions">
      <button
        type="button"
        class="btn btn-primary"
        onclick={exportDatev}
        disabled={busy !== null}
        data-testid="export-datev"
      >
        {#if busy === "datev"}<Spinner size={14} label="Datei wird erstellt" />{/if}
        Alle Personen exportieren
      </button>
    </div>

    {#if canPickPerson}
      <FormField
        label="Einzelne Person"
        help="Die Datei enthält nur diese Person im gewählten Monat."
      >
        {#snippet field({ id, describedBy })}
          <Combobox
            items={personItems}
            bind:value={personId}
            label="Einzelne Person"
            placeholder="Person wählen"
            {id}
            {describedBy}
          />
        {/snippet}
      </FormField>
      <div class="export-actions">
        <button
          type="button"
          class="btn btn-secondary"
          onclick={exportDatevPerson}
          disabled={busy !== null || personId === ""}
          data-testid="export-datev-person"
        >
          {#if busy === "datev-person"}<Spinner size={14} label="Datei wird erstellt" />{/if}
          Person exportieren
        </button>
      </div>
    {:else}
      <Note tone="info">
        Um die Datei einer einzelnen Person zu erstellen, musst du Personen sehen dürfen.
      </Note>
    {/if}
  </section>

  <section class="settings-group" aria-labelledby="export-csv-title">
    <h2 class="settings-group-title" id="export-csv-title">Zeiten und Abwesenheiten (CSV)</h2>
    <p class="settings-group-desc">
      Eine Zeile pro Person für den gewählten Zeitraum, höchstens 12 Monate, mit Semikolon getrennt.
    </p>

    <div class="export-periods">
      <PeriodPicker
        label={monthName(csvFrom)}
        eyebrow="Von"
        testIdPrefix="export-csv-from"
        prevLabel="Vorheriger Monat (Von)"
        nextLabel="Nächster Monat (Von)"
        nextDisabled={compareMonths(csvFrom, thisMonth) >= 0}
        onPrev={() => (csvFrom = addMonths(csvFrom, -1))}
        onNext={() => (csvFrom = addMonths(csvFrom, 1))}
      />
      <PeriodPicker
        label={monthName(csvTo)}
        eyebrow="Bis"
        testIdPrefix="export-csv-to"
        prevLabel="Vorheriger Monat (Bis)"
        nextLabel="Nächster Monat (Bis)"
        nextDisabled={compareMonths(csvTo, thisMonth) >= 0}
        onPrev={() => (csvTo = addMonths(csvTo, -1))}
        onNext={() => (csvTo = addMonths(csvTo, 1))}
      />
    </div>
    {#if csvProblem}
      <div role="alert"><Note tone="bad">{csvProblem}</Note></div>
    {/if}

    <div class="export-actions">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={exportTimesCsv}
        disabled={busy !== null || csvProblem !== null}
        data-testid="export-csv-times"
      >
        {#if busy === "csv-times"}<Spinner size={14} label="Datei wird erstellt" />{/if}
        Zeiten als CSV
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        onclick={exportAbsencesCsv}
        disabled={busy !== null || csvProblem !== null}
        data-testid="export-csv-absences"
      >
        {#if busy === "csv-absences"}<Spinner size={14} label="Datei wird erstellt" />{/if}
        Abwesenheiten als CSV
      </button>
    </div>
  </section>

  <section class="settings-group" aria-labelledby="export-pdf-title">
    <h2 class="settings-group-title" id="export-pdf-title">Monatsexport (PDF)</h2>
    <p class="settings-group-desc">
      Die lesbare Fassung des DATEV-Exports: alle Personen eines Monats, ohne Tagesliste. Der Monat
      ist der Abrechnungsmonat von oben ({monthName(exportMonth)}).
    </p>
    {#if multiSalon}
      <Note tone="info">
        Das Monatsexport enthält alle Salons. Für einen einzelnen Salon exportierst du es unter
        <a href="/verwalten/berichte">{pageLabel("/reports")}</a>.
      </Note>
    {/if}
    <div class="export-actions">
      <button
        type="button"
        class="btn btn-secondary"
        onclick={exportMonthlyPdf}
        disabled={busy !== null}
        data-testid="export-monthly-pdf"
      >
        {#if busy === "monthly-pdf"}<Spinner size={14} label="Datei wird erstellt" />{/if}
        Monatsexport herunterladen
      </button>
    </div>
  </section>

  <section class="settings-group" aria-labelledby="export-ical-title">
    <h2 class="settings-group-title" id="export-ical-title">Kalender (iCal)</h2>
    <p class="settings-group-desc">
      Abwesenheiten als Kalenderdatei für Outlook, Google Kalender oder Apple Kalender.
    </p>
    <div class="export-actions">
      {#if canReadTeamLeave}
        <button
          type="button"
          class="btn btn-secondary"
          onclick={() => exportIcal("team")}
          disabled={busy !== null}
          data-testid="export-ical-team"
        >
          {#if busy === "ical-team"}<Spinner size={14} label="Datei wird erstellt" />{/if}
          Team-Abwesenheiten
        </button>
      {/if}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={() => exportIcal("personal")}
        disabled={busy !== null}
        data-testid="export-ical-personal"
      >
        {#if busy === "ical-personal"}<Spinner size={14} label="Datei wird erstellt" />{/if}
        Meine Abwesenheiten
      </button>
    </div>
  </section>

  <section class="settings-group" aria-labelledby="export-history-title">
    <h2 class="settings-group-title" id="export-history-title">Letzte Exporte</h2>
    <p class="settings-group-desc">Die 20 neuesten Exporte deines Unternehmens.</p>
    {#if !canReadAudit}
      <Note tone="info">Die letzten Exporte siehst du mit dem Recht, das Protokoll zu lesen.</Note>
    {:else if history.status === "loading"}
      <Skeleton shape="row" count={3} />
    {:else if history.status === "failed"}
      <div role="alert"><Note tone="bad">{history.message}</Note></div>
    {:else if history.data.length === 0}
      <Note tone="info">Es gibt noch keinen Export.</Note>
    {:else}
      <List ariaLabel="Letzte Exporte">
        {#each history.data as row (row.id)}
          <ListRow title={row.kind} subtitle={row.scope} avatar={false}>
            {#snippet trailing()}
              <span class="export-when">{row.when} · {row.who}</span>
            {/snippet}
          </ListRow>
        {/each}
      </List>
    {/if}
  </section>

  <SettingsGroup
    id="datev-einrichtung"
    title="DATEV-Einrichtung"
    description="Berater-Nr., Mandantennummer und die Lohnarten für DATEV LODAS. Die Nummern gelten für jede erzeugte Datei."
    changes={datevChanges}
    errors={datevErrorCount}
    saving={datevSaving}
    saveLabel="DATEV-Einrichtung speichern"
    onSave={saveDatev}
    onDiscard={discardDatev}
  >
    {#if datevLoadError}
      <div role="alert"><Note tone="bad">{datevLoadError}</Note></div>
    {:else if !snapshotsReady}
      <Skeleton shape="card" lines={3} />
    {:else}
      {#if !canEditSettings}
        <Note tone="info"
          >Die Nummern kannst du nur ändern, wenn du die Einstellungen ändern darfst.</Note
        >
      {/if}
      <FormField
        label="Berater-Nr."
        help="Nummer der Steuerkanzlei im DATEV-Kopf. Ohne sie wird der Export abgelehnt."
        error={datevProblems.datevBeraterNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="9999999"
            step="1"
            class="form-input"
            bind:value={datev.datevBeraterNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Mandantennummer"
        help="Nummer dieses Unternehmens bei der Kanzlei. Ohne sie lässt sich die Datei keinem Unternehmen zuordnen."
        error={datevProblems.datevMandantenNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="99999"
            step="1"
            class="form-input"
            bind:value={datev.datevMandantenNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Normalstunden"
        help="Lohnart für reguläre Arbeitsstunden."
        error={datevProblems.datevNormalstundenNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="9999"
            step="1"
            class="form-input"
            bind:value={datev.datevNormalstundenNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Urlaub"
        help="Lohnart für genommene Urlaubstage."
        error={datevProblems.datevUrlaubNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="9999"
            step="1"
            class="form-input"
            bind:value={datev.datevUrlaubNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Krank / AU"
        help="Lohnart für entgeltfortzahlungspflichtige Krankheitstage."
        error={datevProblems.datevKrankNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="9999"
            step="1"
            class="form-input"
            bind:value={datev.datevKrankNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
      <FormField
        label="Sonderurlaub"
        help="Lohnart für Sonderurlaub nach § 616 BGB oder Tarif."
        error={datevProblems.datevSonderurlaubNr ?? undefined}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="number"
            min="1"
            max="9999"
            step="1"
            class="form-input"
            bind:value={datev.datevSonderurlaubNr}
            disabled={!canEditSettings || datevSaving}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        {/snippet}
      </FormField>
    {/if}
  </SettingsGroup>
</div>

<style>
  .export-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .export-periods {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
  }

  .export-when {
    font-size: var(--fs-sm);
    color: var(--text-2);
    white-space: nowrap;
  }
</style>
