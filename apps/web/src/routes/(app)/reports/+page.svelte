<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, showSalonOptions } from "$stores/salon-context"; // Issues #542, #612
  import { get as getStore } from "svelte/store";
  import { reportRights } from "$lib/page-rights";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte"; // Issue #542
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope"; // Issue #542
  import Icon from "$components/Icon.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import Note from "$components/ui/Note.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte"; // Phase 97-07
  import ExitedFinalSaldoSection from "$lib/components/reports/ExitedFinalSaldoSection.svelte"; // Issue #613
  import AbsencesByPersonTable from "$lib/components/reports/AbsencesByPersonTable.svelte"; // Issue #713
  import ExportDialog from "$lib/components/reports/ExportDialog.svelte"; // Issue #612
  import PeriodBar from "$lib/components/reports/PeriodBar.svelte"; // Issue #612
  import PeriodKpis from "$lib/components/reports/PeriodKpis.svelte"; // Issue #612
  import PeriodRangeDialog from "$lib/components/reports/PeriodRangeDialog.svelte"; // Issue #612
  import PersonDrilldown from "$lib/components/reports/PersonDrilldown.svelte"; // Issue #612
  import TeamTrendsTab from "$lib/components/reports/TeamTrendsTab.svelte"; // Issue #895
  import TodayAttendance from "$lib/components/reports/TodayAttendance.svelte"; // Issue #612
  import SalonWorkedSection from "$lib/components/reports/SalonWorkedSection.svelte"; // Issue #714
  import TimesAccountsTable from "$lib/components/reports/TimesAccountsTable.svelte"; // Issue #612
  import VacationAbsenceTab from "$lib/components/reports/VacationAbsenceTab.svelte"; // Issue #612
  import { toasts } from "$stores/toast"; // Issue #612
  import {
    isPlainLeftClick,
    periodLabel,
    parsePeriodState,
    periodSearch,
    type PeriodState,
    type PeriodTab,
  } from "$lib/reports/period-state"; // Issue #612 (D-612-1)
  import {
    periodAbsencesCsvPath,
    periodCsvPath,
    periodReportPath,
    ymKey,
    type DayEntry,
    type PeriodReport,
    type PeriodRow,
    type YearMonth,
  } from "$lib/reports/period-report"; // Issue #612
  import type { TodayAttendanceData } from "$lib/reports/today-attendance"; // Issue #612
  import { partitionOvertimeOverview } from "$lib/reports/overtime-overview-sections"; // Issue #613
  import { fmtBalance } from "$lib/utils/format-minutes"; // Issue #588
  import { MONTH_STATUS_LABEL } from "$lib/saldo/month-status"; // Issue #598: one status wording
  import {
    buildEmployeeMonthRows,
    type EmployeeMonthRow,
    type SnapshotAnswerRow,
  } from "$lib/reports/employee-months";
  // ── Types ──────────────────────────────────────────────────────────────────

  type OvertimeEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    balanceHours: number;
    status: "NORMAL" | "ELEVATED" | "CRITICAL";
    // Phase 97-04 — additive split fields from GET /dashboard/overtime-overview. Optional:
    // an older cached response may omit them, in which case the row falls back to a
    // single-value SaldoAnzeige derived from balanceHours (Phase 97-07).
    confirmedMinutes?: number;
    openMonthMinutes?: number | null;
    hasClosedMonth?: boolean;
    rosterIncomplete?: boolean;
    // Issue #613 (AC-613-5) - additive; an older cached response has neither field.
    exitDate?: string | null;
    exitedWithOpenFinalSaldo?: boolean;
    // Issue #588 - additive facts of the overview row, read by the team saldo module. An older
    // cached response has none of them; an absent fact never excludes a person.
    hasRecordedTime?: boolean;
    trackOnly?: boolean | null;
    unconfirmedMonths?: number | null;
  };

  type OvertimeOverview = {
    employees: OvertimeEmployee[];
    // Issue #542: present only under a salon filter.
    salonId?: string;
    // Issue #613 - all exited persons with an open final saldo in the caller's reach (the list holds
    // only the newest ones).
    exitedOpenFinalSaldoCount?: number;
  };

  // ── State ──────────────────────────────────────────────────────────────────

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  // ── Role guard ─────────────────────────────────────────────────────────────

  // Issue #538: each block follows the permission of the endpoint behind it (docs/permissions.md),
  // never the compat role. The API refuses anything beyond these; the page only hides.
  let rights = $derived(reportRights($authStore.user));
  let canTeamAttendance = $derived(rights.canTeamAttendance);
  let canTeamOvertime = $derived(rights.canTeamOvertime);
  let canReportRead = $derived(rights.canReportRead);
  let canReportExport = $derived(rights.canReportExport);
  let canReportNotify = $derived(rights.canReportNotify);
  // Issue #587 (D-587-4): the two action links of a „Fehlt“ row; the target pages and the API
  // enforce their own rules, these only decide whether the link is offered.
  let canAddTeamEntry = $derived(rights.canAddTeamEntry);
  let canRecordTeamAbsence = $derived(rights.canRecordTeamAbsence);
  let showTeamArea = $derived(rights.showTeamArea);

  // ── The period in the URL (Issue #612, D-612-1) ────────────────────────────

  // The tenant-local current month is the browser's local month here; the API's 400 is the backstop
  // (P-09). Everything the page shows about the period comes from this one parse of the URL:
  // `from`, `to`, `tab`, `person` and `salonId` are read ONLY through `parsePeriodState` and
  // written ONLY through `periodSearch` (replaceState; opening the drill-down is the one push).
  const today: YearMonth = { year: currentYear, month: currentMonth };
  const urlState = $derived(parsePeriodState($page.url.searchParams, today, rights.periodTabs));
  const activeTab = $derived(urlState.tab);
  const periodTabActive = $derived(activeTab === "zeiten" || activeTab === "urlaub");
  // A caller who may export but read no report: the bar with the export dialog, no tabs (amendment 5).
  const exportOnly = $derived(showTeamArea && rights.periodTabs.length === 0);
  // Primitive keys, so a tab change or a drill-down push never re-triggers the period request.
  const periodKey = $derived(`${ymKey(urlState.from)}|${ymKey(urlState.to)}`);

  const TAB_LABEL: Record<PeriodTab, string> = {
    zeiten: "Zeiten & Konten",
    urlaub: "Urlaub & Abwesenheit",
    heute: "Heute",
    verlaeufe: "Verläufe",
  };

  function writeState(next: PeriodState): void {
    void goto(`${$page.url.pathname}?${periodSearch(next)}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  // PageTabs reports the selected value; the URL stays the one state (replaceState).
  function onTabChange(value: string): void {
    const tab = rights.periodTabs.find((t) => t === value);
    if (tab !== undefined) writeState({ ...urlState, tab });
  }

  function onPeriodChange(from: YearMonth, to: YearMonth): void {
    writeState({ ...urlState, from, to });
  }

  // The drill-down link of a person: the current URL plus `person=<id>`. It is a real href, so a
  // middle click or a modified click opens it in a new tab.
  function personHref(row: PeriodRow): string {
    return `${$page.url.pathname}?${periodSearch({ ...urlState, person: row.employeeId })}`;
  }

  // Opening a person is the ONE history push of the page (Back closes the drill-down). Only a plain
  // left click is taken over; the trigger is remembered so focus can return to it.
  function openPerson(event: MouseEvent, row: PeriodRow): void {
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    const el = event.currentTarget as HTMLElement | null;
    focusReturnTo =
      el === null
        ? null
        : el.matches("a, button")
          ? el
          : (el.querySelector<HTMLElement>("a, button") ?? el);
    drillPushed = true;
    void goto(personHref(row), { keepFocus: true, noScroll: true });
  }

  // The vacation table names a person by id. The drill-down shows the period series, so only a person
  // with a row in the period answer has a link; any other person has a plain name (null).
  function vacationPersonHref(employeeId: string): string | null {
    const row = period?.rows.find((r) => r.employeeId === employeeId);
    return row ? personHref(row) : null;
  }

  function openVacationPerson(event: MouseEvent, employeeId: string): void {
    const row = period?.rows.find((r) => r.employeeId === employeeId);
    if (row) openPerson(event, row);
  }

  // The browser-local day: the gate of „Hinweis senden“ (a deadline of today or later); the API is the backstop.
  const todayIso = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(currentDate.getDate()).padStart(2, "0")}`;

  // The carry-over notice of one entitlement (BUrlG § 7, EuGH C-684/16); the API dedups per day and
  // audits it. Never sends the header salon: a notice to one named person does not depend on it.
  function sendCarryoverNotice(entitlementId: string) {
    return api.post<{ ok: boolean; warned: number; skippedDedup: number }>(
      "/reports/carryover-warn",
      { entitlementId },
    );
  }

  // The „Exportieren“ button of the period bar opens the one export dialog (report:export only).
  function openExport(trigger: HTMLElement): void {
    focusReturnTo = trigger;
    exportOpen = true;
  }

  // ── Salon filter (Issue #542, CTX-5) ───────────────────────────────────────

  // The header salon narrows today's attendance, the Saldenübersicht (exited section), the period
  // answer and the Monatsexport and CSV downloads. The page decides only through `salonPageFilter`
  // (never the store's raw selection); the loaders read `pageSalonId` when they are called and one
  // effect below reruns the two list loads on a change. Presentation only: the API validates every
  // `salonId` and answers one 404 for every rejection cause. This page starts no tenant DATEV
  // download any more (Daten › Export is the one place, Issue #854), and the per-person documents
  // and the carry-over notice never send a salon (pinned with their reasons in
  // `salon-filter-exempt-pages-558.test.ts`), and neither does the § 9 hint of the Monatsexport:
  // it comes from `/reports/monthly`, whose person rule is not the export's.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  let attendanceSalonRejected = $state(false);
  let overviewSalonRejected = $state(false);
  let exportSalonRejected = $state(false);
  // Plain lets: an older response never overwrites a newer one (not reactive on purpose).
  let attendanceGeneration = 0;
  let overviewGeneration = 0;

  // ── Heutige Anwesenheit state (RPT-03) ─────────────────────────────────────

  let todayAttendance: TodayAttendanceData | null = $state(null);
  let todayLoading = $state(false);
  let todayError = $state("");

  // ── Exited persons with an open final saldo (Issue #613, from the saldo overview) ──

  let overtimeOverview = $state<OvertimeOverview | null>(null);
  let overtimeError = $state("");

  // Issue #613: the server flags the exited persons with an open final saldo. Issue #612: the period
  // table carries the active persons; this answer feeds only the exited section below it, which is
  // the state of today and independent of the period.
  let overtimeSections = $derived(partitionOvertimeOverview(overtimeOverview?.employees ?? []));

  // ── EMP-06: Employee monthly closes view ─────────────────────────────────
  let empMonthlyCloses: EmployeeMonthRow[] = $state([]);
  let empClosesLoading = $state(false);
  let empClosesError = $state("");

  async function loadEmployeeMonthlyCloses() {
    const auth = getStore(authStore);
    const myEmployeeId = auth.user?.employeeId;
    if (!myEmployeeId) {
      empMonthlyCloses = [];
      return;
    }
    empClosesLoading = true;
    empClosesError = "";
    try {
      const rows = await api.get<SnapshotAnswerRow[]>(`/overtime/snapshots/${myEmployeeId}`);
      // Issue #595 (D-02/D-03): the months and the closed state come from the server answer
      // (snapshotMonthOf). Only "now" is the browser's clock - it is no stored date.
      empMonthlyCloses = buildEmployeeMonthRows(rows, {
        year: currentYear,
        month: currentMonth,
      });
    } catch (e: unknown) {
      empClosesError =
        e instanceof Error ? e.message : "Monatsabschlüsse konnten nicht geladen werden";
      empMonthlyCloses = [];
    } finally {
      empClosesLoading = false;
    }
  }

  function fmtMinutesAsHrs(min: number): string {
    const sign = min < 0 ? "−" : "";
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${sign}${h}:${String(m).padStart(2, "0")} h`;
  }

  async function downloadEmployeeMonthlyPdf(year: number, month: number, label: string) {
    const auth = getStore(authStore);
    const myEmployeeId = auth.user?.employeeId;
    if (!myEmployeeId) return;
    try {
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${myEmployeeId}&year=${year}&month=${month}`,
        `Stundennachweis_${label.replace(/\s+/g, "_")}.pdf`,
      );
    } catch (e: unknown) {
      empClosesError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    }
  }

  // ── The salon-filtered list loads (Issue #542) ─────────────────────────────

  // Issue #542: this effect owns the two salon-filtered list loads. It waits for the salon context
  // so the first request is already filtered, and reruns when the header salon (or the period)
  // changes.
  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    const attendance = canTeamAttendance;
    const overview = canTeamOvertime;
    untrack(() => {
      if (attendance) void loadTodayAttendance();
      if (overview) void loadOvertimeOverview();
    });
  });

  // ── The period answer (Issue #612, D-612-2, Pattern 3) ──────────────────────

  // ONE request per (from, to, salon) feeds the KPIs, the tables and the drill-down; the page
  // renders what the server sums and recomputes nothing. A slow read is abandoned when the question
  // changes (amendment 2): only the latest request may apply its answer.
  // Issue #688: below the 30 s abort of the API proxy (hooks.server.ts), so a read that cannot
  // finish ends here as the calm error state instead of a proxy 503.
  const PERIOD_TIMEOUT_MS = 28_000;
  let period = $state<PeriodReport | null>(null);
  let periodLoading = $state(false);
  let periodFailure: "INVALID" | "FAILED" | null = $state(null);
  let periodSalonRejected = $state(false);
  // Which (from, to, salon) the held answer belongs to; a stale answer never decides about `person`.
  let periodLoadedKey = $state("");
  // One polite live region: the period after a change, the person count after the answer.
  let liveText = $state("");
  let barHeight = $state(0);
  // Plain lets: an older response never overwrites a newer one (not reactive on purpose).
  let periodGeneration = 0;
  let periodAbort: AbortController | null = null;

  async function loadPeriod(from: YearMonth, to: YearMonth, salon: string | null) {
    const generation = ++periodGeneration;
    periodAbort?.abort();
    const controller = new AbortController();
    periodAbort = controller;
    const timer = setTimeout(() => controller.abort(), PERIOD_TIMEOUT_MS);
    periodLoading = true;
    periodFailure = null;
    liveText = `Zeitraum: ${periodLabel(from, to, today)}`;
    try {
      const answer = await api.get<PeriodReport>(periodReportPath(from, to, salon), {
        signal: controller.signal,
      });
      if (generation !== periodGeneration) return;
      period = answer;
      periodLoadedKey = `${ymKey(from)}|${ymKey(to)}|${salon ?? ""}`;
      periodSalonRejected = false;
      const n = answer.rows.length;
      liveText = `Bericht geladen: ${n} ${n === 1 ? "Person" : "Personen"}`;
    } catch (e: unknown) {
      // A superseded request was aborted on purpose: nothing to show for it.
      if (generation !== periodGeneration) return;
      period = null;
      if (salon !== null && isSalonFilterRejected(e)) {
        // The one 404: a calm state instead of the data, never the server's text (T-542-18).
        periodSalonRejected = true;
      } else {
        periodSalonRejected = false;
        periodFailure = e instanceof ApiError && e.status === 400 ? "INVALID" : "FAILED";
      }
    } finally {
      clearTimeout(timer);
      if (generation === periodGeneration) periodLoading = false;
    }
  }

  // Waits for the salon context so the first request is already filtered, and reruns when the
  // period or the header salon changes. Not on the "Heute" tab: it has no period.
  $effect(() => {
    if (!contextLoaded) return;
    void periodKey;
    const salon = pageSalonId;
    const wanted = canReportRead && periodTabActive;
    untrack(() => {
      if (wanted) void loadPeriod(urlState.from, urlState.to, salon);
    });
  });

  // ── The person drill-down (D-612-4, ADD-4) ─────────────────────────────────────

  // The URL decides whether a person is open: `person=<id>` that names a row of the answer. The
  // modal reads its figures from that same answer; only the day list is a request of its own, and
  // only the component can make it (with time-entry:read).
  const drillRow = $derived(
    periodTabActive && urlState.person !== null
      ? (period?.rows.find((r) => r.employeeId === urlState.person) ?? null)
      : null,
  );
  const drillVacationRow = $derived.by(() => {
    const answer = period;
    if (drillRow === null || answer === null) return null;
    const year = answer.vacation.years.find((y) => y.year === answer.vacation.year);
    return year?.rows.find((r) => r.employeeId === drillRow.employeeId) ?? null;
  });
  // Writable derived: open exactly while the URL names a row; the modal may close itself (Escape,
  // backdrop, Schließen) before the navigation it triggers has settled.
  let drillOpen = $derived(drillRow !== null);
  // True while the open drill-down was opened by THIS page's own history push.
  let drillPushed = false;

  // Closing: Back pops the entry this page pushed; a drill-down opened by a reload or a shared link
  // has no entry of ours to pop, so `person` is dropped with a replaceState instead.
  function closeDrill(): void {
    if (urlState.person === null) {
      drillPushed = false;
      return;
    }
    if (drillPushed) {
      drillPushed = false;
      history.back();
      return;
    }
    writeState({ ...urlState, person: null });
  }

  function loadDayEntries(employeeId: string, fromDay: string, toDay: string) {
    return api.get<DayEntry[]>(
      `/time-entries?employeeId=${encodeURIComponent(employeeId)}&from=${fromDay}&to=${toDay}`,
    );
  }

  // Dialogs (rendered after `.period-content`, never inside an animated Card, Issue #570).
  let rangeOpen = $state(false);
  let exportOpen = $state(false);
  let focusReturnTo: HTMLElement | null = null;
  let dialogWasOpen = false;

  function openRange(trigger: HTMLElement): void {
    focusReturnTo = trigger;
    rangeOpen = true;
  }

  // The Modal primitive traps focus but does not give it back: the page remembers the trigger
  // (the period bar's button, the person's name link) and returns focus to it on close.
  $effect(() => {
    const open = rangeOpen || exportOpen || drillOpen;
    untrack(() => {
      if (dialogWasOpen && !open) {
        focusReturnTo?.focus();
        focusReturnTo = null;
      }
      dialogWasOpen = open;
    });
  });

  // A reloaded `person=` that names nobody in the answer (left the population, other salon, a
  // hand-edited link): the modal does not open and `person` is dropped quietly (amendment 6).
  $effect(() => {
    const person = urlState.person;
    if (person === null || !periodTabActive || period === null || periodLoading) return;
    if (periodFailure !== null) return;
    if (periodLoadedKey !== `${periodKey}|${pageSalonId ?? ""}`) return;
    if (period.rows.some((r) => r.employeeId === person)) return;
    untrack(() => writeState({ ...urlState, person: null }));
  });

  // ── The salon in the URL (Issue #612, P-10) ──────────────────────────────────

  // The header context stays the one source of the selection. The URL mirrors it while the page
  // filter applies; a `salonId` of an OPENED link selects that salon once, but only when it is one
  // of the caller's own choosable salons - anything else is dropped (T-612-21). The API validates
  // every salon id again.
  let salonUrlConsumed = false;
  $effect(() => {
    if (!contextLoaded) return;
    const wanted = urlState.salonId;
    const current = pageSalonId;
    untrack(() => {
      if (!salonUrlConsumed) {
        salonUrlConsumed = true;
        const ctx = getStore(salonContext);
        if (wanted !== null && wanted !== current) {
          if (showSalonOptions(ctx) && ctx.salons.some((salon) => salon.id === wanted)) {
            salonContext.setSelection(wanted);
            return; // the selection changes `pageSalonId`; this effect reruns and mirrors it
          }
        }
      }
      if (wanted !== current) writeState({ ...urlState, salonId: current });
    });
  });

  // ── onMount ────────────────────────────────────────────────────────────────

  onMount(async () => {
    // Permission-aware: a caller without any team-report right sees the personal monthly closes
    // table; the others keep the $effect-driven loads above.
    if (!showTeamArea) {
      await loadEmployeeMonthlyCloses();
    }
  });

  // ── Loaders ────────────────────────────────────────────────────────────────

  async function loadTodayAttendance() {
    const generation = ++attendanceGeneration;
    todayLoading = true;
    todayError = "";
    try {
      const answer = await api.get<TodayAttendanceData>(
        withSalonId("/dashboard/today-attendance", pageSalonId),
      );
      if (generation !== attendanceGeneration) return;
      todayAttendance = answer;
      attendanceSalonRejected = false;
    } catch (e: unknown) {
      if (generation !== attendanceGeneration) return;
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        // The one 404: a calm state instead of the data, never the server's text (T-542-18).
        todayAttendance = null;
        attendanceSalonRejected = true;
      } else {
        attendanceSalonRejected = false;
        todayError = e instanceof Error ? e.message : "Fehler beim Laden der Anwesenheit";
      }
    } finally {
      if (generation === attendanceGeneration) todayLoading = false;
    }
  }

  async function loadOvertimeOverview() {
    const generation = ++overviewGeneration;
    overtimeError = "";
    try {
      const answer = await api.get<OvertimeOverview>(
        withSalonId("/dashboard/overtime-overview", pageSalonId),
      );
      if (generation !== overviewGeneration) return;
      overtimeOverview = answer;
      overviewSalonRejected = false;
    } catch (e: unknown) {
      if (generation !== overviewGeneration) return;
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        overtimeOverview = null;
        overviewSalonRejected = true;
      } else {
        overviewSalonRejected = false;
        overtimeError =
          e instanceof Error ? e.message : "Fehler beim Laden der Überstunden-Übersicht";
      }
    }
  }

  async function downloadPdf(url: string, filename: string) {
    const { authStore: authSt } = await import("$stores/auth");
    const { get } = await import("svelte/store");
    const auth = get(authSt);

    const res = await fetch(`/api/v1${url}`, {
      headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // An ApiError so a caller can tell the one salon 404 apart (Issue #542); the message is unchanged.
      throw new ApiError(
        res.status,
        (data as { error?: string }).error ?? "Download fehlgeschlagen",
      );
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick to ensure the download has started
    setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
  }

  // The one 404 of the chosen salon is a calm state in the dialog, never an error toast; any other
  // failure is thrown to the export dialog, which reports it.
  async function downloadMonthlyExport(year: number, month: number) {
    exportSalonRejected = false;
    try {
      await downloadPdf(
        withSalonId(`/reports/monthly-export/pdf?year=${year}&month=${month}`, pageSalonId),
        `Monatsexport_${year}_${String(month).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        exportSalonRejected = true;
      } else {
        throw e;
      }
    }
  }

  // The CSV of the table „Zeiten & Konten“ for the whole period: the same query as the table, so the
  // header salon narrows it exactly like the page; saved under the name the server proposes.
  async function downloadPeriodCsv() {
    exportSalonRejected = false;
    try {
      await downloadPdf(
        periodCsvPath(urlState.from, urlState.to, pageSalonId),
        `Zeiten-und-Konten_${ymKey(urlState.from)}_${ymKey(urlState.to)}.csv`,
      );
    } catch (e: unknown) {
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        exportSalonRejected = true;
      } else {
        throw e;
      }
    }
  }

  // Issue #713 (D-11): the CSV of the table „Abwesenheiten je Person“ for the whole period - the same
  // query as the table plus `table=absences`, so the header salon narrows it exactly like the page.
  async function downloadAbsencesCsv() {
    exportSalonRejected = false;
    try {
      await downloadPdf(
        periodAbsencesCsvPath(urlState.from, urlState.to, pageSalonId),
        `Abwesenheiten-je-Person_${ymKey(urlState.from)}_${ymKey(urlState.to)}.csv`,
      );
    } catch (e: unknown) {
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        exportSalonRejected = true;
      } else {
        throw e;
      }
    }
  }

  // § 9-Hinweis (Phase 104, D-30): explains why days of a closed month moved from leave to sickness.
  // It comes from the server (`GET /reports/monthly`'s section9Note), is NOT derived here, and is
  // never narrowed by the header salon: that route's person rule is not the export's, and an
  // unfiltered hint is a superset that may over-warn, the safe direction.
  async function loadExportSection9Note(year: number, month: number): Promise<string | null> {
    // The route needs report:read; an exporter without it simply has no note.
    if (!canReportRead) return null;
    try {
      const res = await api.get<{ section9Note?: string }>(
        `/reports/monthly?year=${year}&month=${month}`,
      );
      return res.section9Note ?? null;
    } catch {
      // Fail-safe: the note explains, it never blocks - on an error nothing is shown.
      return null;
    }
  }

  // Issue #612: the person documents of the drill-down (report:export), for the month selected
  // there. Never the header salon: a document of one named person does not change with it.
  async function downloadEmployeePdf(employeeId: string, name: string, target: YearMonth) {
    try {
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${employeeId}&year=${target.year}&month=${target.month}`,
        `Stundennachweis_${name.replace(/\s+/g, "_")}_${target.year}_${String(target.month).padStart(2, "0")}.pdf`,
      );
    } catch {
      toasts.error(
        "Der Stundennachweis konnte nicht erstellt werden. Bitte versuch es noch einmal.",
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // ── The personal view (callers without a team report right) ────────────────

  // Employee KPIs - derived from the CLOSED months only (open months carry no figures)
  let empClosedRows = $derived(empMonthlyCloses.flatMap((r) => (r.status === "closed" ? [r] : [])));
  let kpiClosedMonths = $derived(empClosedRows.length);
  let kpiTotalWorkedMin = $derived(empClosedRows.reduce((acc, r) => acc + r.workedMinutes, 0));
  let kpiTotalExpectedMin = $derived(empClosedRows.reduce((acc, r) => acc + r.expectedMinutes, 0));
  let kpiTotalBalanceMin = $derived(empClosedRows.reduce((acc, r) => acc + r.balanceMinutes, 0));

  function fmtHoursFromMin(min: number): string {
    const sign = min < 0 ? "−" : "";
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${sign}${h}:${String(m).padStart(2, "0")}`;
  }

  const empKpiItems = $derived<KpiItem[]>([
    { label: MONTH_STATUS_LABEL.CLOSED, value: String(kpiClosedMonths), unit: "Monate" },
    { label: "Soll", value: fmtHoursFromMin(kpiTotalExpectedMin), unit: "h" },
    { label: "Ist", value: fmtHoursFromMin(kpiTotalWorkedMin), unit: "h" },
    { label: "Saldo", value: fmtBalance(kpiTotalBalanceMin), unit: "h" },
  ]);

  // One flat row per month for the DataTable (a closed month carries its figures, an open one none).
  type EmpTableRow = {
    key: string;
    year: number;
    month: number;
    label: string;
    closed: boolean;
    expectedMinutes: number;
    workedMinutes: number;
    balanceMinutes: number;
  };

  const empRows = $derived<EmpTableRow[]>(
    empMonthlyCloses.map((r) => ({
      key: `${r.year}-${r.month}`,
      year: r.year,
      month: r.month,
      label: r.label,
      closed: r.status === "closed",
      expectedMinutes: r.status === "closed" ? r.expectedMinutes : 0,
      workedMinutes: r.status === "closed" ? r.workedMinutes : 0,
      balanceMinutes: r.status === "closed" ? r.balanceMinutes : 0,
    })),
  );

  const EMP_COLUMNS: DataTableColumn[] = [
    { key: "label", label: "Monat", primary: true },
    { key: "expectedMinutes", label: "Soll", align: "end" },
    { key: "workedMinutes", label: "Ist", align: "end" },
    // Every closed row is a non-superseded MONTHLY snapshot the server listed (the record the PDF
    // prints), so the figure is final, never a forecast: the header says confirmed.
    { key: "balanceMinutes", label: "Saldo (Bestätigt)", align: "end" },
    { key: "status", label: "Status" },
    { key: "pdf", label: "Stundennachweis", align: "end" },
  ];
</script>

<svelte:head>
  <title>{pageLabel("/reports")} – Clokr</title>
</svelte:head>

{#snippet exportAction()}
  <button
    type="button"
    class="btn btn-outline"
    data-testid="reports-period-export"
    onclick={(e) => openExport(e.currentTarget)}
  >
    <Icon name="download" size={14} />
    Exportieren
  </button>
{/snippet}

<PageHead
  title={pageLabel("/reports")}
  sub={showTeamArea
    ? "Zeiten, Konten und Urlaub für einen Zeitraum – bis zu 12 Monate."
    : "Persönliche Monatsabschlüsse — als PDF zum Download."}
  actions={showTeamArea && canReportExport && (periodTabActive || exportOnly)
    ? exportAction
    : undefined}
/>

{#if showTeamArea}
  <SalonScopeLabel label={scopeLabel} />
  {#if rights.periodTabs.length > 0 && activeTab !== null}
    <PageTabs
      tabs={rights.periodTabs.map((t) => ({ value: t, label: TAB_LABEL[t] }))}
      tab={activeTab}
      {onTabChange}
      tabsLabel="Berichtsbereich"
    >
      {#snippet panel(value)}
        <!-- Every panel is rendered by the tab block; only the selected one holds content. -->
        {#if value === activeTab}
          {#if value === "heute"}
            {@render heutePanel()}
          {:else if value === "verlaeufe"}
            {@render verlaeufePanel()}
          {:else}
            {@render periodPanel()}
          {/if}
        {/if}
      {/snippet}
    </PageTabs>
  {:else if exportOnly}
    {@render periodPanel()}
  {/if}

  <!-- Dialogs sit after the panels, never inside an animated block (Issue #570). -->
  <PeriodRangeDialog
    bind:open={rangeOpen}
    from={urlState.from}
    to={urlState.to}
    {today}
    onApply={onPeriodChange}
  />
  {#if canReportExport}
    <ExportDialog
      bind:open={exportOpen}
      from={urlState.from}
      to={urlState.to}
      periodLabel={periodLabel(urlState.from, urlState.to, today)}
      filterActive={pageSalonId !== null}
      salonRejected={exportSalonRejected}
      loadSection9Note={loadExportSection9Note}
      onMonthlyExport={downloadMonthlyExport}
      onCsv={downloadPeriodCsv}
      onAbsenceCsv={downloadAbsencesCsv}
      onError={(message) => toasts.error(message)}
    />
  {/if}
  <PersonDrilldown
    bind:open={drillOpen}
    row={drillRow}
    vacationRow={drillVacationRow}
    periodLabel={periodLabel(urlState.from, urlState.to, today)}
    canTimeEntryRead={rights.canTimeEntryRead}
    {canReportExport}
    showSalonColumn={showSalonOptions($salonContext)}
    {loadDayEntries}
    onDownloadPdf={(target) =>
      drillRow
        ? downloadEmployeePdf(drillRow.employeeId, drillRow.employeeName, target)
        : undefined}
    onClose={closeDrill}
  />
  <div class="sr-only" role="status" aria-live="polite" data-testid="period-live">{liveText}</div>
{:else}
  <div class="report-stack">
    <KpiStrip items={empKpiItems} ariaLabel="Persönliche Bilanz der abgeschlossenen Monate" />

    <!-- EMP-06: Employee personal monthly closes -->
    <section class="settings-group" aria-labelledby="emp-closes-title">
      <h2 class="settings-group-title" id="emp-closes-title">Monatsabschlüsse</h2>
      <p class="settings-group-desc">Persönliche Bilanz je Monat</p>
      {#if empClosesError}
        <div role="alert">
          <Note tone="bad">{empClosesError}</Note>
        </div>
      {:else}
        <DataTable
          columns={EMP_COLUMNS}
          rows={empRows}
          rowKey={(row) => row.key}
          cell={empCell}
          caption="Monatsabschlüsse"
          loading={empClosesLoading}
        />
      {/if}
    </section>
  </div>
{/if}

{#snippet empCell(row: EmpTableRow, column: DataTableColumn)}
  {#if column.key === "label"}
    <b>{row.label}</b>
  {:else if column.key === "status"}
    {#if row.closed}
      <Chip tone="ok">{MONTH_STATUS_LABEL.CLOSED}</Chip>
    {:else}
      <Chip tone="warn">{MONTH_STATUS_LABEL.OPEN}</Chip>
    {/if}
  {:else if column.key === "pdf"}
    <button
      type="button"
      class="btn btn-ghost"
      onclick={() => downloadEmployeeMonthlyPdf(row.year, row.month, row.label)}
    >
      <Icon name="download" size={14} />
      PDF
    </button>
  {:else if !row.closed}
    <span title="Prognose im PDF">—</span>
  {:else if column.key === "balanceMinutes"}
    <!-- The shared primitive in single-value mode: the U+2212 minus and the sign colouring match
         every other saldo on the page. -->
    <SaldoAnzeige variant="compact" saldoMinutes={row.balanceMinutes} isLocked={row.closed} />
  {:else if column.key === "expectedMinutes"}
    {fmtMinutesAsHrs(row.expectedMinutes)}
  {:else if column.key === "workedMinutes"}
    {fmtMinutesAsHrs(row.workedMinutes)}
  {/if}
{/snippet}

{#snippet periodPanel()}
  <div class="period-content" style="--period-bar-h: {barHeight}px">
    <PeriodBar
      onHeight={(px) => (barHeight = px)}
      from={urlState.from}
      to={urlState.to}
      {today}
      loading={periodLoading}
      onChange={onPeriodChange}
      onOpenRange={openRange}
    />

    {#if exportOnly}
      <p class="period-note" data-testid="period-export-only-note">
        Keine Auswertung freigegeben – Exporte verfügbar
      </p>
    {:else if periodSalonRejected}
      <SalonScopeLabel label={null} rejected={true} />
    {:else if periodFailure === "INVALID"}
      <div class="period-refusal" role="alert" data-testid="period-invalid">
        <Note tone="bad"
          >Dieser Zeitraum lässt sich nicht auswerten – höchstens 12 Monate auf einmal.</Note
        >
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onclick={() => onPeriodChange({ ...today }, { ...today })}>Zum aktuellen Monat</button
        >
      </div>
    {:else if periodFailure === "FAILED"}
      <div data-testid="period-error">
        <ErrorState
          message="Der Bericht konnte nicht geladen werden. Prüf die Verbindung und versuch es noch einmal."
          hint=""
          retrying={periodLoading}
          onRetry={() => void loadPeriod(urlState.from, urlState.to, pageSalonId)}
        />
      </div>
    {:else}
      <div class="period-body" class:period-body--dim={periodLoading && period !== null}>
        <PeriodKpis
          kpis={period?.kpis ?? null}
          filterActive={pageSalonId !== null}
          withoutHomeSalonCount={period?.withoutHomeSalonCount ?? null}
          loading={periodLoading}
        />
      </div>

      <div class="period-tab-content" class:period-body--dim={periodLoading && period !== null}>
        {#if activeTab === "zeiten"}
          <TimesAccountsTable
            rows={period?.rows ?? null}
            loading={periodLoading}
            periodLabel={periodLabel(urlState.from, urlState.to, today)}
            filterActive={pageSalonId !== null}
            {personHref}
            onOpenPerson={openPerson}
            exited={exitedBlock}
          />
          {#if period?.helpers !== undefined}
            <!-- Issue #714: the salon viewpoint (names + hours only), only under a salon filter. -->
            <SalonWorkedSection
              rows={period.rows}
              helpers={period.helpers}
              totalMinutes={period.kpis.salonWorkedMinutes ?? null}
              helpersReach={period.helpersReach ?? null}
              periodLabel={periodLabel(urlState.from, urlState.to, today)}
              loading={periodLoading}
            />
          {/if}
        {:else if activeTab === "urlaub"}
          <VacationAbsenceTab
            vacation={period?.vacation ?? null}
            absences={period?.absences ?? null}
            filterActive={pageSalonId !== null}
            loading={periodLoading}
            today={todayIso}
            canNotify={canReportNotify}
            periodLabel={periodLabel(urlState.from, urlState.to, today)}
            personHref={vacationPersonHref}
            onOpenPerson={openVacationPerson}
            onNotify={sendCarryoverNotice}
          />
          <AbsencesByPersonTable
            rows={period?.rows ?? null}
            loading={periodLoading}
            periodLabel={periodLabel(urlState.from, urlState.to, today)}
            filterActive={pageSalonId !== null}
            {personHref}
            onOpenPerson={openPerson}
          />
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet heutePanel()}
  {#if canTeamAttendance}
    <TodayAttendance
      attendance={todayAttendance}
      loading={todayLoading}
      error={todayError}
      rejected={attendanceSalonRejected}
      {canAddTeamEntry}
      {canRecordTeamAbsence}
    />
  {/if}
{/snippet}

{#snippet verlaeufePanel()}
  <!-- Issue #895: the team trends and the saldo card; not period-driven, the salon filter applies. -->
  {#if canTeamAttendance}
    <TeamTrendsTab
      salonId={pageSalonId}
      ready={contextLoaded}
      saldoRows={overtimeSections.active}
      saldoFiltered={overtimeOverview?.salonId !== undefined}
      saldoLoading={overtimeOverview === null && overtimeError === "" && !overviewSalonRejected}
      saldoError={overtimeError}
    />
  {/if}
{/snippet}

{#snippet exitedBlock()}
  <!-- Issue #613 / #612: persons who left with an open final saldo - today's state, not the period. -->
  {#if canTeamOvertime}
    {#if overviewSalonRejected}
      <SalonScopeLabel label={null} rejected={true} />
    {:else if overtimeError}
      <Note tone="bad">{overtimeError}</Note>
    {:else if overtimeOverview}
      <ExitedFinalSaldoSection
        rows={overtimeSections.exitedOpen}
        total={overtimeOverview.exitedOpenFinalSaldoCount ?? overtimeSections.exitedOpen.length}
        asOfNote="Stand heute, unabhängig vom Zeitraum"
      />
    {/if}
  {/if}
{/snippet}

<style>
  .report-stack,
  .period-content,
  .period-tab-content {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
  }

  /* The previous figures stay readable while a new period is being fetched. */
  .period-body--dim {
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }

  .period-refusal {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
  }

  .period-note {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-base);
  }
</style>
