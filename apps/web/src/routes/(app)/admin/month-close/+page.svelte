<!--
  Verwalten › Monatsabschluss (Issue #854, D-854-10): the close WORKFLOW (status per month, closing,
  unlocking). The settings that decide when a month may be closed live at Regeln › Monatsabschluss.

  Built from the #843 blocks: PageHead, the four-step indicator (CloseStepper, kept on purpose), the year
  in a PeriodPicker, the status filter in the URL, a KpiStrip of the year, a DataTable of months with the
  persons of the month in view below it (MonthStatusTable), Dialogs for closing and unlocking. No rule of
  the close changed: the same reads and writes, the same gap acknowledgement, the same unlock reason.
  Day lists stay withheld outside the reader's reach (Issue #86, D-02): dates come from
  `$lib/month-close/day-lists`, which prints the server's count when `dayDetailsWithheld` is set.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { pageLabel } from "$lib/nav/page-labels";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import Note from "$components/ui/Note.svelte";
  import PeriodPicker from "$components/ui/PeriodPicker.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import CloseStepper from "$lib/components/admin/monatsabschluss/CloseStepper.svelte";
  import MonthStatusTable from "$lib/components/admin/monatsabschluss/MonthStatusTable.svelte";
  import { daysWithoutEntryText, gapCountOf, missingDaysText } from "$lib/month-close/day-lists";
  import { READY_KPI, autoCloseHintText, closesBlind } from "$lib/month-close/next-step";
  import type {
    DeferredState,
    EmployeeStatus,
    MonthDetailResponse,
    MonthStatus,
    YearStatusResponse,
  } from "$lib/month-close/types";
  import { int, oneOf, urlState } from "$lib/table/url-state";
  import { MONTH_STATUS_LABEL } from "$lib/saldo/month-status"; // Issue #598: one status wording

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentDay = now.getDate();

  // ── Filters in the URL (Issue #854, D-854-03) ───────────────────────────────────────────────
  // `year` and `month` also carry the deep link of the Monatsabschluss notifications
  // (/admin/month-close?year=2026&month=5, Phase 292); `status` is the filter of the month list.
  // Every value goes through an allow-list parser, other keys of the URL are left alone.
  const STATUS_FILTERS = ["all", "open", "closed", "actionable"] as const;
  const urlSchema = {
    year: int({ min: 2000, max: 2999 }, currentYear),
    month: int({ min: 0, max: 12 }, 0),
    status: oneOf(STATUS_FILTERS, "all"),
  };
  const url = urlState(urlSchema);
  const initialUrl = url.read();

  const filterOptions = [
    { value: "all", label: "Alle" },
    { value: "open", label: "Offen / Fehlend" },
    { value: "closed", label: MONTH_STATUS_LABEL.CLOSED },
    { value: "actionable", label: "Handlungsbedarf" },
  ];

  let selectedYear = $state(initialUrl.year);
  let statusFilter = $state<(typeof STATUS_FILTERS)[number]>(initialUrl.status);
  let selectedMonth = $state<number | null>(null);

  // Starts true: `onMount` loads the year before the first paint of anything but the Skeleton.
  let loading = $state(true);
  let loadError = $state("");
  let loaded = $state(false);
  let refreshing = $state(false);
  let monthStatuses: MonthStatus[] = $state([]);
  let earliestYear = $state(currentYear);

  // Phase 292 (issue #292): the deferred-Monatsabschluss state, shown as a note on the page an admin
  // opens for exactly this question. A failing side read never takes the page down.
  let deferred = $state<DeferredState | null>(null);

  const MONTH_NAMES_DE = [
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

  function monthLabel(m: { year: number; month: number } | null): string {
    if (!m) return "";
    return `${MONTH_NAMES_DE[m.month - 1]} ${m.year}`;
  }

  const deferredTone = $derived(
    deferred?.severity === "CRITICAL" ? "bad" : deferred?.severity === "INFO" ? "info" : "warn",
  );

  // The persons of the month in view
  let detailLoading = $state(false);
  let detailEmployees: EmployeeStatus[] = $state([]);

  // Writes
  let closing = $state(false);
  let closingProgress = $state(0);
  let closingTotal = $state(0);
  let closingEmployee = $state<string | null>(null);
  let unlocking = $state<string | null>(null);

  // Close dialog
  let confirmOpen = $state(false);
  let confirmMonth = $state<number | null>(null);
  let confirmEmployeeId = $state<string | null>(null);
  let gapAcknowledged = $state(false);
  let confirmError = $state("");
  const confirmBusy = $derived(closing || closingEmployee !== null);

  // Unlock dialog
  let unlockOpen = $state(false);
  let unlockEmployeeId = $state<string | null>(null);
  let unlockMonth = $state<number | null>(null);
  let unlockReason = $state("");
  let unlockError = $state("");

  /** The server's own text of a refused call, else `fallback`. */
  function errorText(e: unknown, fallback: string): string {
    const apiErr = e as { data?: { error?: string }; message?: string };
    return apiErr?.data?.error ?? apiErr?.message ?? fallback;
  }

  // pendingGapCount is the server's count (Issue #86, D-02): a closer without time-entry:read reach
  // gets no dates, but the acknowledgement of the gaps still applies. Derived from the status
  // endpoint, never computed in the client (A1 parity).
  const pendingGapCount = $derived.by<number>(() => {
    if (confirmEmployeeId) {
      const emp = detailEmployees.find((e) => e.employeeId === confirmEmployeeId);
      return emp ? gapCountOf(emp) : 0;
    }
    return detailEmployees
      .filter((e) => e.status === "missing")
      .reduce((sum, e) => sum + gapCountOf(e), 0);
  });
  const pendingGaps = $derived.by<string[]>(() => {
    if (confirmEmployeeId) {
      const emp = detailEmployees.find((e) => e.employeeId === confirmEmployeeId);
      return emp?.missingDates ?? [];
    }
    // Month close: the union of the dates of every person with a gap
    return detailEmployees
      .filter((e) => e.status === "missing")
      .flatMap((e) => e.missingDates ?? []);
  });

  // Issue #947: closing days the reader cannot see (withheld lists) is named in the dialog.
  const closesBlindNow = $derived.by(() => {
    if (confirmEmployeeId) {
      return closesBlind(detailEmployees.filter((e) => e.employeeId === confirmEmployeeId));
    }
    return closesBlind(detailEmployees.filter((e) => e.status === "missing"));
  });

  const visibleMonths = $derived.by(() => {
    if (statusFilter === "open") {
      return monthStatuses.filter((ms) =>
        ["open", "partial", "ready", "blocked"].includes(ms.status),
      );
    }
    if (statusFilter === "closed") return monthStatuses.filter((ms) => ms.status === "closed");
    if (statusFilter === "actionable") {
      return monthStatuses.filter((ms) => ["open", "partial", "ready"].includes(ms.status));
    }
    return monthStatuses;
  });

  const kpiItems = $derived([
    {
      label: MONTH_STATUS_LABEL.CLOSED,
      value: monthStatuses.filter((ms) => ms.status === "closed").length,
      explanation: "Monate dieses Jahres",
    },
    {
      label: READY_KPI.label,
      value: monthStatuses.filter((ms) => ms.status === "ready").length,
      explanation: READY_KPI.explanation,
    },
    {
      label: MONTH_STATUS_LABEL.OPEN,
      value: monthStatuses.filter((ms) => ["open", "partial"].includes(ms.status)).length,
      explanation: "Noch nicht abgeschlossen",
    },
    {
      label: "Blockiert",
      value: monthStatuses.filter((ms) => ms.status === "blocked").length,
      explanation: "Ein früherer Monat ist offen",
    },
  ]);

  // The first month still open (open/ready/partial) is the one the close button is offered for.
  const firstActionableMonth = $derived.by(() => {
    for (const ms of monthStatuses) {
      if (ms.status === "open" || ms.status === "ready" || ms.status === "partial") return ms.month;
    }
    return null;
  });

  // Active step, from the month in view or the first actionable one.
  // 0=Prüfen, 1=Korrigieren, 2=Bestätigen, 3=Sperren
  const activeStepIndex = $derived.by(() => {
    const target = selectedMonth ?? firstActionableMonth;
    const ms = target === null ? undefined : monthStatuses.find((m) => m.month === target);
    if (!ms) return 0;
    if (ms.status === "closed") return 3; // Sperren (done)
    if (ms.status === "ready") return 2; // Bestätigen (current)
    if (ms.status === "partial") return 1; // Korrigieren
    return 0; // Prüfen (default for open/blocked/no_data)
  });

  const autoCloseHint = $derived(
    autoCloseHintText(
      currentDay,
      monthStatuses.some(
        (ms) => ms.status === "open" || ms.status === "ready" || ms.status === "partial",
      ),
    ),
  );

  const monthName = (month: number) =>
    monthStatuses.find((ms) => ms.month === month)?.name ?? `Monat ${month}`;

  function writeUrl() {
    url.write({ year: selectedYear, month: selectedMonth ?? 0, status: statusFilter });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────
  async function fetchYear() {
    const res = await api.get<YearStatusResponse>(
      `/overtime/close-month/year-status?year=${selectedYear}`,
    );
    monthStatuses = res.months;
    if (res.earliestYear) earliestYear = res.earliestYear;
  }

  async function fetchDetail(month: number) {
    const res = await api.get<MonthDetailResponse>(
      `/overtime/close-month/status?year=${selectedYear}&month=${month}`,
    );
    // A slower answer of a month that is no longer in view is dropped.
    if (selectedMonth === month) detailEmployees = res.employees;
  }

  async function loadDeferred() {
    try {
      deferred = await api.get<DeferredState>("/overtime/close-month/deferred?detailed=true");
    } catch {
      deferred = null;
    }
  }

  /** First load and year change: the whole list is replaced by the Skeleton meanwhile. */
  async function loadYearStatus() {
    loading = true;
    loadError = "";
    loaded = false;
    try {
      await fetchYear();
      loaded = true;
    } catch {
      loadError = "Der Jahresstatus konnte nicht geladen werden.";
    } finally {
      loading = false;
    }
  }

  /** After a write and for „Aktualisieren“: year, persons of the month in view and the deferred note. */
  async function refresh() {
    refreshing = true;
    try {
      await fetchYear();
      if (selectedMonth !== null) await fetchDetail(selectedMonth);
      await loadDeferred();
    } catch (e) {
      toasts.error(errorText(e, "Die Daten konnten nicht aktualisiert werden."));
    } finally {
      refreshing = false;
    }
  }

  /** Opens the persons of `month` (or closes them when it is already in view). False when the load failed. */
  async function selectMonth(month: number): Promise<boolean> {
    if (selectedMonth === month) {
      selectedMonth = null;
      detailEmployees = [];
      writeUrl();
      return true;
    }
    selectedMonth = month;
    detailEmployees = [];
    detailLoading = true;
    writeUrl();
    try {
      await fetchDetail(month);
      return true;
    } catch (e) {
      toasts.error(errorText(e, "Die Details konnten nicht geladen werden."));
      return false;
    } finally {
      if (selectedMonth === month) detailLoading = false;
    }
  }

  async function changeYear(delta: number) {
    const next = selectedYear + delta;
    if (next > currentYear || next < earliestYear) return;
    selectedYear = next;
    selectedMonth = null;
    detailEmployees = [];
    writeUrl();
    await loadYearStatus();
  }

  function setStatusFilter(value: string) {
    statusFilter = urlSchema.status.parse(value);
    writeUrl();
  }

  function resetFilters() {
    setStatusFilter("all");
  }

  /** Jump straight to the oldest month that is still open, and show its persons. */
  async function openOldestDeferredMonth() {
    const target = deferred?.oldestOpenMonth;
    if (!target) return;
    if (selectedYear !== target.year) {
      selectedYear = target.year;
      selectedMonth = null;
      detailEmployees = [];
      await loadYearStatus();
    }
    if (selectedMonth !== target.month) await selectMonth(target.month);
  }

  // ── Close dialog ────────────────────────────────────────────────────────────────────────────
  const confirmTitle = $derived.by(() => {
    if (confirmMonth == null) return "Monat sperren";
    const name = monthName(confirmMonth);
    if (confirmEmployeeId) {
      const emp = detailEmployees.find((e) => e.employeeId === confirmEmployeeId);
      return `${name} ${selectedYear}: ${emp?.employeeName ?? "Mitarbeiter"} sperren?`;
    }
    return `${name} ${selectedYear} sperren?`;
  });

  async function openConfirmCloseMonth(month: number) {
    // The gap acknowledgement applies to the persons that will be closed, so their status must be
    // loaded before the dialog opens.
    if (selectedMonth !== month && !(await selectMonth(month))) return;
    confirmMonth = month;
    confirmEmployeeId = null;
    confirmError = "";
    gapAcknowledged = false;
    confirmOpen = true;
  }

  function openConfirmCloseEmployee(employeeId: string, month: number) {
    confirmMonth = month;
    confirmEmployeeId = employeeId;
    confirmError = "";
    gapAcknowledged = false;
    confirmOpen = true;
  }

  function closeConfirmDialog() {
    confirmOpen = false;
    confirmMonth = null;
    confirmEmployeeId = null;
    confirmError = "";
    gapAcknowledged = false; // synchronous reset - no $effect (avoids the v1.8.17 loop trap)
  }

  /** The dialog refuses to close while a close is running. */
  function setConfirmOpen(next: boolean) {
    if (!next && confirmBusy) return;
    if (next) confirmOpen = true;
    else closeConfirmDialog();
  }

  async function onConfirmProceed() {
    if (confirmMonth == null) return;
    const month = confirmMonth;
    const empId = confirmEmployeeId;
    confirmError = "";
    const done = empId ? await closeEmployee(empId, month) : await closeMonth(month);
    if (!done) return;
    // The dialog closes first so it never shows the refreshed (already closed) state.
    closeConfirmDialog();
    await refresh();
  }

  /** True when the dialog may close; a refusal stays in the dialog as the server's text. */
  async function closeMonth(month: number): Promise<boolean> {
    closing = true;
    closingProgress = 0;
    closingTotal = 0;
    try {
      // The status is read fresh: a person may have become ready or closed since the list was loaded.
      const res = await api.get<MonthDetailResponse>(
        `/overtime/close-month/status?year=${selectedYear}&month=${month}`,
      );
      // "missing" persons are included: the single dialog covers them with the gap acknowledgement.
      const closable = res.employees.filter((e) => e.status === "ready" || e.status === "missing");
      closingTotal = closable.length;
      if (closable.length === 0) {
        confirmError = "Keine Mitarbeiter zum Abschluss.";
        return false;
      }

      let succeeded = 0;
      let failed = 0;
      let firstRefusal = "";
      for (const emp of closable) {
        try {
          await api.post("/overtime/close-month", {
            employeeId: emp.employeeId,
            year: selectedYear,
            month,
            confirmGaps: gapCountOf(emp) > 0,
          });
          succeeded++;
        } catch (e) {
          failed++;
          if (!firstRefusal) firstRefusal = errorText(e, "Abschluss fehlgeschlagen");
        }
        closingProgress = succeeded + failed;
      }

      if (succeeded === 0) {
        confirmError = firstRefusal;
        return false;
      }
      const text = `${monthName(month)} ${selectedYear}: ${succeeded} abgeschlossen`;
      if (failed > 0) toasts.error(`${text}, ${failed} fehlgeschlagen. ${firstRefusal}`);
      else toasts.success(`${text}.`);
      return true;
    } catch (e) {
      confirmError = errorText(e, "Fehler beim Monatsabschluss");
      return false;
    } finally {
      closing = false;
      closingProgress = 0;
      closingTotal = 0;
    }
  }

  async function closeEmployee(employeeId: string, month: number): Promise<boolean> {
    closingEmployee = employeeId;
    try {
      await api.post("/overtime/close-month", {
        employeeId,
        year: selectedYear,
        month,
        confirmGaps: pendingGapCount > 0,
      });
      toasts.success(`${monthName(month)} ${selectedYear} ist für die Person abgeschlossen.`);
      return true;
    } catch (e) {
      confirmError = errorText(e, "Abschluss fehlgeschlagen");
      return false;
    } finally {
      closingEmployee = null;
    }
  }

  // ── Unlock dialog (Revisionssicherheit: the admin must say why) ─────────────────────────────
  const unlockTitle = $derived.by(() => {
    if (unlockMonth == null) return "Monat entsperren";
    const emp = detailEmployees.find((e) => e.employeeId === unlockEmployeeId);
    return `${monthName(unlockMonth)} ${selectedYear}: ${emp?.employeeName ?? "Mitarbeiter"} entsperren?`;
  });

  function openUnlockDialog(employeeId: string, month: number) {
    unlockEmployeeId = employeeId;
    unlockMonth = month;
    unlockReason = "";
    unlockError = "";
    unlockOpen = true;
  }

  function closeUnlockDialog() {
    unlockOpen = false;
    unlockEmployeeId = null;
    unlockMonth = null;
    unlockReason = "";
    unlockError = "";
  }

  function setUnlockOpen(next: boolean) {
    if (!next && unlocking !== null) return;
    if (next) unlockOpen = true;
    else closeUnlockDialog();
  }

  async function onUnlockProceed() {
    if (unlockEmployeeId == null || unlockMonth == null || !unlockReason.trim()) return;
    const employeeId = unlockEmployeeId;
    const month = unlockMonth;
    unlocking = employeeId;
    unlockError = "";
    try {
      await api.post("/overtime/unlock-month", {
        employeeId,
        year: selectedYear,
        month,
        reason: unlockReason.trim(),
      });
      toasts.success(`${monthName(month)} ${selectedYear} ist für die Person entsperrt.`);
      closeUnlockDialog();
      await refresh();
    } catch (e) {
      unlockError = errorText(e, "Entsperren fehlgeschlagen");
    } finally {
      unlocking = null;
    }
  }

  onMount(() => {
    void loadDeferred();
    void loadYearStatus().then(() => {
      if (initialUrl.month >= 1 && loaded) void selectMonth(initialUrl.month);
    });
  });
</script>

<svelte:head><title>{pageLabel("/admin/month-close")} – Clokr</title></svelte:head>

<!-- Phase 73-05 (D-05): data-testid surface for the admin Monatsabschluss flows. `display: contents`
     keeps the page layout intact while exposing a stable page-root selector to the e2e specs. -->
<div data-testid="month-close-page" style="display: contents;">
  <PageHead title={pageLabel("/admin/month-close")} sub="Monat prüfen, korrigieren und sperren">
    {#snippet actions()}
      <button
        type="button"
        class="btn btn-secondary"
        onclick={refresh}
        disabled={loading || refreshing}
        aria-busy={refreshing}
      >
        {#if refreshing}<Spinner size={14} />{/if}
        Aktualisieren
      </button>
    {/snippet}
  </PageHead>

  <CloseStepper
    steps={["Prüfen", "Korrigieren", "Bestätigen", "Sperren"]}
    current={activeStepIndex}
  />

  {#if deferred && deferred.employeeCount > 0}
    <div class="mc-deferred" role="status" data-testid="month-close-deferred">
      <Note tone={deferredTone}>
        <b>{deferred.severity === "CRITICAL" ? "Dringend: " : ""}Monatsabschluss überfällig.</b>
        {deferred.employeeCount === 1
          ? "1 Mitarbeiter hat"
          : `${deferred.employeeCount} Mitarbeiter haben`}
        einen offenen Monatsabschluss. Ältester offener Monat:
        <b>{monthLabel(deferred.oldestOpenMonth)}</b>
        ({deferred.monthsBehind === 1 ? "1 Monat" : `${deferred.monthsBehind} Monate`} Rückstand).
        {#if deferred.gapCount > 0}
          {deferred.gapCount === 1
            ? "1 fehlender Tageseintrag blockiert"
            : `${deferred.gapCount} fehlende Tageseinträge blockieren`} den Abschluss.
        {/if}
      </Note>
      <ul class="mc-deferred-list">
        {#each deferred.employees.slice(0, 8) as e (e.employeeId)}
          <li>
            {e.employeeName}: offen seit {monthLabel(e.oldestOpenMonth)}
            {#if e.reason === "EXIT_DATE_MISSING"}
              · Austrittsdatum fehlt, bitte prüfen
            {:else if gapCountOf(e) > 0}
              · {e.dayDetailsWithheld ? "" : "fehlende Tage: "}{missingDaysText(e, {
                iso: true,
              })}
            {:else}
              · keine Tageslücken gefunden
            {/if}
          </li>
        {/each}
        {#if deferred.employees.length > 8}
          <li>… und {deferred.employees.length - 8} weitere.</li>
        {/if}
      </ul>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        onclick={openOldestDeferredMonth}
        data-testid="month-close-deferred-jump"
      >
        {monthLabel(deferred.oldestOpenMonth)} öffnen
      </button>
    </div>
  {/if}

  <!-- The year is the PeriodPicker in the shape of Zeiten (#854 owner review): no eyebrow, „Heute“ jumps to
       the current year, and the status filter sits in the same bar. -->
  <div class="mc-controls">
    <PeriodPicker
      label={String(selectedYear)}
      testIdPrefix="month-close-year"
      prevLabel="Vorheriges Jahr"
      nextLabel="Nächstes Jahr"
      prevDisabled={loading || selectedYear <= earliestYear}
      nextDisabled={loading || selectedYear >= currentYear}
      onPrev={() => changeYear(-1)}
      onNext={() => changeYear(1)}
      onToday={selectedYear === currentYear
        ? undefined
        : () => changeYear(currentYear - selectedYear)}
    >
      {#snippet aside()}
        <!-- A select, not a Segment: four options do not fit a 360 px phone; the bar wraps it into
             its own row on a narrow screen. -->
        <div class="mc-filter">
          <FormField label="Status">
            {#snippet field({ id, describedBy })}
              <select
                {id}
                class="form-input"
                value={statusFilter}
                aria-describedby={describedBy}
                data-testid="month-close-status"
                onchange={(event) => setStatusFilter(event.currentTarget.value)}
              >
                {#each filterOptions as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            {/snippet}
          </FormField>
        </div>
      {/snippet}
    </PeriodPicker>
  </div>

  {#if loading}
    <Skeleton shape="card" lines={3} />
  {:else if loadError}
    <ErrorState message={loadError} onRetry={loadYearStatus} />
  {:else if loaded}
    <!-- Hint, figures and the month list keep the section distance of the other Verwalten pages. -->
    <div class="mc-stack">
      {#if autoCloseHint}
        <Note tone="brand">{autoCloseHint}</Note>
      {/if}
      <KpiStrip items={kpiItems} ariaLabel={`Stand der Monatsabschlüsse ${selectedYear}`} />
      <MonthStatusTable
        year={selectedYear}
        months={monthStatuses}
        {visibleMonths}
        filtered={statusFilter !== "all"}
        onResetFilters={resetFilters}
        {selectedMonth}
        {firstActionableMonth}
        employees={detailEmployees}
        {detailLoading}
        busy={closing}
        {closingEmployee}
        {unlocking}
        onSelectMonth={selectMonth}
        onCloseMonth={openConfirmCloseMonth}
        onCloseEmployee={openConfirmCloseEmployee}
        onUnlockEmployee={openUnlockDialog}
      />
    </div>
  {/if}
</div>

<!-- Close dialog: the final lock, with the gap acknowledgement where days have no entry. -->
<Dialog
  bind:open={() => confirmOpen, setConfirmOpen}
  eyebrow="Endgültiger Monatsabschluss"
  title={confirmTitle}
>
  <div class="mc-dialog" data-testid="month-close-modal">
    <Note tone="warn">
      Diese Aktion ist nicht rückgängig. Alle Zeiteinträge dieses Monats werden gesperrt.
      Korrekturen sind danach nur noch durch Storno-Buchungen möglich.
    </Note>

    {#if pendingGapCount > 0}
      {#if closesBlindNow}
        <Note tone="info"
          >Du siehst nicht, welche Tage fehlen. Bitte die Salonleitung, die Zeiten zu prüfen, bevor
          du abschließt.</Note
        >
      {/if}
      <div class="mc-gaps" role="alert" data-testid="month-close-gap-warning">
        <Note tone="warn">
          <b
            >{daysWithoutEntryText(pendingGapCount)}
            {pendingGapCount === 1 ? "wird" : "werden"} als 0h gewertet.</b
          >
          Diese Tage zählen mit vollem Soll (kein Abzug). Der Saldo wird entsprechend negativ.
        </Note>
        {#if pendingGaps.length > 0}
          <ul class="mc-gap-list">
            {#each pendingGaps as d (d)}
              <li>{missingDaysText({ missingDates: [d] })}</li>
            {/each}
          </ul>
        {/if}
      </div>
      <label class="mc-ack">
        <input type="checkbox" bind:checked={gapAcknowledged} data-testid="month-close-gap-ack" />
        <span>
          Ich habe {pendingGapCount === 1
            ? "den fehlenden Tag"
            : `die ${pendingGapCount} fehlenden Tage`}
          zur Kenntnis genommen.
        </span>
      </label>
    {/if}

    <p class="mc-hint">
      Stelle sicher, dass alle Salden und fehlenden Einträge vor dem Sperren geprüft sind.
    </p>

    {#if closing && closingTotal > 0}
      <div class="mc-progress">
        <progress
          max={closingTotal}
          value={closingProgress}
          aria-label="Fortschritt des Abschlusses"
        ></progress>
        <span>{closingProgress} von {closingTotal} Mitarbeitern verarbeitet</span>
      </div>
    {/if}

    {#if confirmError}
      <div role="alert"><Note tone="bad">{confirmError}</Note></div>
    {/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="btn btn-ghost"
      onclick={() => setConfirmOpen(false)}
      disabled={confirmBusy}
      data-testid="month-close-cancel"
    >
      Abbrechen
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={onConfirmProceed}
      disabled={confirmBusy || (pendingGapCount > 0 && !gapAcknowledged)}
      data-testid="month-close-confirm"
    >
      {#if confirmBusy}<Spinner size={14} />{/if}
      Monat abschließen
    </button>
  {/snippet}
</Dialog>

<!-- Unlock dialog: lifting a close needs a reason, which is stored for good (Revisionssicherheit). -->
<Dialog bind:open={() => unlockOpen, setUnlockOpen} eyebrow="Monat entsperren" title={unlockTitle}>
  <div class="mc-dialog">
    <Note tone="warn">
      Eine Entsperrung erfordert einen Grund. Das Entsperren hebt den Monatsabschluss auf und wird
      im Audit-Log festgehalten. Der Grund wird dauerhaft gespeichert.
    </Note>
    <FormField label="Grund für die Entsperrung" required>
      {#snippet field({ id, describedBy })}
        <textarea
          {id}
          class="form-input"
          bind:value={unlockReason}
          placeholder="z. B. Fehlerhafte Buchung, Korrektur erforderlich"
          rows="3"
          maxlength="500"
          aria-describedby={describedBy}
        ></textarea>
      {/snippet}
    </FormField>
    {#if unlockError}
      <div role="alert"><Note tone="bad">{unlockError}</Note></div>
    {/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="btn btn-ghost"
      onclick={() => setUnlockOpen(false)}
      disabled={unlocking !== null}
    >
      Abbrechen
    </button>
    <button
      type="button"
      class="btn btn-primary"
      onclick={onUnlockProceed}
      disabled={unlocking !== null || !unlockReason.trim()}
      data-testid="month-close-unlock-confirm"
    >
      {#if unlocking !== null}<Spinner size={14} />{/if}
      Monat entsperren
    </button>
  {/snippet}
</Dialog>

<style>
  .mc-controls {
    margin: var(--s-4) 0;
  }

  .mc-filter {
    min-width: min(100%, 220px);
  }

  .mc-stack {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
  }

  .mc-deferred {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
    margin: var(--s-4) 0;
  }

  .mc-deferred-list {
    margin: 0;
    padding-left: var(--s-5);
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text-2);
  }

  .mc-dialog {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .mc-gaps {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .mc-gap-list {
    margin: 0;
    padding-left: var(--s-5);
    font-size: var(--fs-sm);
  }

  .mc-ack {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    font-size: var(--fs-base);
  }

  .mc-hint {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text-2);
  }

  .mc-progress {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .mc-progress progress {
    width: 100%;
    height: 8px;
  }
</style>
