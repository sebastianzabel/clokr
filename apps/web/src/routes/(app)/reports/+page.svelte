<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext, showSalonOptions } from "$stores/salon-context"; // Issues #542, #612
  import { get as getStore } from "svelte/store";
  import { reportRights } from "$lib/page-rights";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte"; // Issue #542
  import {
    ALL_SALONS_BLOCK_NOTE,
    DATEV_ALL_SALONS_NOTE,
    EXPORT_NO_STAMMSALON_NOTE,
    PERSON_SALDO_NOT_SPLIT_LABEL,
    SALON_EXPORT_PERSONS_NOTE,
    SALON_HOME_PERSONS_NOTE,
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    withSalonId,
  } from "$lib/salons/page-scope"; // Issue #542
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte"; // Phase 97-07
  import ExitedFinalSaldoSection from "$lib/components/reports/ExitedFinalSaldoSection.svelte"; // Issue #613
  import PeriodBar from "$lib/components/reports/PeriodBar.svelte"; // Issue #612
  import PeriodKpis from "$lib/components/reports/PeriodKpis.svelte"; // Issue #612
  import PeriodRangeDialog from "$lib/components/reports/PeriodRangeDialog.svelte"; // Issue #612
  import {
    periodLabel,
    parsePeriodState,
    periodSearch,
    type PeriodState,
    type PeriodTab,
  } from "$lib/reports/period-state"; // Issue #612 (D-612-1)
  import {
    periodReportPath,
    ymKey,
    type PeriodReport,
    type YearMonth,
  } from "$lib/reports/period-report"; // Issue #612
  import { partitionOvertimeOverview } from "$lib/reports/overtime-overview-sections"; // Issue #613
  import {
    TEAM_SALDO_EXCLUSION_LABEL,
    forecastColumnLabel,
    teamSaldoCells,
    teamSaldoExclusion,
    teamSaldoFigures,
  } from "$lib/reports/team-saldo"; // Issue #588
  import { fmtBalance } from "$lib/utils/format-minutes"; // Issue #588
  import Icon from "$components/Icon.svelte"; // Issue #588
  import { VACATION_YEAR_COLUMNS } from "$lib/reports/vacation-columns"; // Issue #617
  import { DAY_STATUS_LABEL, attendanceStatusText } from "$lib/dashboard/day-status-label"; // Issue #587
  import { teamDayHref, teamLeaveCreateHref } from "$lib/dashboard/team-day-links"; // Issue #587
  import {
    buildEmployeeMonthRows,
    type EmployeeMonthRow,
    type SnapshotAnswerRow,
  } from "$lib/reports/employee-months";
  // ── Types ──────────────────────────────────────────────────────────────────

  type TodayEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    status:
      | "present"
      | "absent"
      | "clocked_in"
      | "missing"
      | "scheduled"
      | "requested"
      | "none"
      | "holiday";
    reason: string | null;
    // Issue #542 (AC-542-7): set by the server under a salon filter when the person worked in
    // another salon today; a boolean, never a salon or a time.
    workedElsewhere?: boolean;
    // Issue #587 (D-587-3): the planned start of today's first shift and the minutes since it
    // (only for a missing row); finished values from the API, nothing is computed here.
    expectedStart?: string | null;
    lateMinutes?: number | null;
  };

  type TodayAttendance = {
    date: string;
    // Issue #542: present only under a salon filter.
    salonId?: string;
    employees: TodayEmployee[];
    summary: {
      present: number;
      absent: number;
      clockedIn: number;
      missing: number;
      holiday: number;
    };
  };

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

  // Issue #416: a discriminated union — `missingEntitlement: true` marks a placeholder row (an
  // active employee with no VACATION LeaveEntitlement row for this year yet), whose
  // leaveType/totalDays/… fields are all null. Keeping the two shapes distinct (rather than one
  // type with every non-employee field `| null`) lets the `{#if row.missingEntitlement}` branch
  // below narrow without a non-null assertion on the real-row fields.
  type LeaveOverviewEmployee = {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  };
  type LeaveOverviewRealRow = {
    employee: LeaveOverviewEmployee;
    leaveType: { id: string; name: string };
    year: number;
    totalDays: number;
    carriedOverDays: number;
    usedDays: number;
    remainingDays: number;
    pendingDays: number;
    // Issue #451 (D-07) — additive; an older cached response has neither field, hence `??`
    // fallback to the pre-#451 raw carriedOverDays at every call site below.
    carriedOverEffectiveDays?: number;
    // Issue #617 (D-617-2) - additive; an older cached response has none of the three, hence the
    // `??` fallback in the cells below.
    availableDays?: number;
    takenDays?: number;
    approvedUpcomingDays?: number;
    missingEntitlement?: false;
  };
  type LeaveOverviewMissingRow = {
    employee: LeaveOverviewEmployee;
    leaveType: null;
    year: number;
    totalDays: null;
    carriedOverDays: null;
    usedDays: null;
    remainingDays: null;
    pendingDays: null;
    availableDays: null;
    takenDays: null;
    approvedUpcomingDays: null;
    missingEntitlement: true;
  };
  type LeaveOverviewRow = LeaveOverviewRealRow | LeaveOverviewMissingRow;

  // ── State ──────────────────────────────────────────────────────────────────

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  // DATEV export card — own period selector
  let datevMonth = $state(currentMonth);
  let datevYear = $state(currentYear);
  let datevLoading = $state(false);
  let datevError = $state("");

  // Monatsexport card (Issue #617) — own period selector, same defaults as the DATEV card
  let exportMonth = $state(currentMonth);
  let exportYear = $state(currentYear);
  let exportLoading = $state(false);
  let exportError = $state("");
  // § 9-Hinweis (Phase 104, D-30) — erklärt, warum im gewählten Monat Tage von Urlaub nach
  // Krankheit gewandert sind. Kommt vom Server (GET /reports/monthly's section9Note field),
  // wird NICHT clientseitig hergeleitet, und ist nur gesetzt, wenn der Monat tatsächlich
  // bestätigte § 9-Tage trägt. Issue #617: sits on the Monatsexport card, driven by its own period.
  let exportSection9Note = $state<string | null>(null);

  const months = [
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

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

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
  let showAttendanceActions = $derived(canAddTeamEntry || canRecordTeamAbsence);
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

  // Bridge until 612-06 replaces the two vacation blocks (carry-over warnings, Urlaubsübersicht):
  // they read the vacation year of the period's end.
  const selectedYear = $derived(urlState.to.year);
  const selectedMonth = $derived(urlState.to.month);

  const TAB_LABEL: Record<PeriodTab, string> = {
    zeiten: "Zeiten & Konten",
    urlaub: "Urlaub & Abwesenheit",
    heute: "Heute",
  };

  function writeState(next: PeriodState): void {
    void goto(`${$page.url.pathname}?${periodSearch(next)}`, {
      replaceState: true,
      keepFocus: true,
      noScroll: true,
    });
  }

  async function selectTab(tab: PeriodTab, moveFocus = false): Promise<void> {
    writeState({ ...urlState, tab });
    if (moveFocus) {
      await tick();
      document.getElementById(`reports-tab-${tab}`)?.focus();
    }
  }

  // ARIA tabs with one tab stop: ArrowLeft/ArrowRight wrap, Home/End jump, all of them activate.
  function onTabKeydown(e: KeyboardEvent): void {
    const tabs = rights.periodTabs;
    if (tabs.length < 2 || activeTab === null) return;
    const i = tabs.indexOf(activeTab);
    let next: PeriodTab | null = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next === null) return;
    e.preventDefault();
    void selectTab(next, true);
  }

  function onPeriodChange(from: YearMonth, to: YearMonth): void {
    writeState({ ...urlState, from, to });
  }

  // Dialogs (rendered after `.period-content`, never inside an animated Card, Issue #570).
  let rangeOpen = $state(false);
  let focusReturnTo: HTMLElement | null = null;
  let rangeWasOpen = false;

  function openRange(trigger: HTMLElement): void {
    focusReturnTo = trigger;
    rangeOpen = true;
  }

  // The Modal primitive traps focus but does not give it back: the page remembers the trigger.
  $effect(() => {
    const open = rangeOpen;
    untrack(() => {
      if (rangeWasOpen && !open) {
        focusReturnTo?.focus();
        focusReturnTo = null;
      }
      rangeWasOpen = open;
    });
  });

  // The export dialog arrives with 612-06; until then the cards above the tabs stay the export path.
  function openExport(): void {}

  // ── Salon filter (Issue #542, CTX-5) ───────────────────────────────────────

  // The header salon narrows three places: today's attendance, the Saldenübersicht and the
  // Monatsexport download. The page decides only through `salonPageFilter` (never the store's raw
  // selection); the loaders read `pageSalonId` when they are called and one effect below reruns
  // the two list loads on a change. Presentation only: the API validates every `salonId` and
  // answers one 404 for every rejection cause. The DATEV file, the per-person documents, the
  // vacation overview and the carry-over warnings never send a salon (pinned with their reasons
  // in `salon-filter-exempt-pages-558.test.ts`), and neither does the § 9 hint of the Monatsexport
  // card: it comes from `/reports/monthly`, whose person rule is not the export's.
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

  let todayAttendance: TodayAttendance | null = $state(null);
  let todayLoading = $state(false);
  let todayError = $state("");

  let todayPage = $state(1);
  let todayPageSize = $state(10);
  let pagedTodayRows = $derived(
    (todayAttendance?.employees ?? []).slice(
      (todayPage - 1) * todayPageSize,
      todayPage * todayPageSize,
    ),
  );

  $effect(() => {
    const _len = todayAttendance?.employees?.length ?? 0;
    todayPage = 1;
  });

  // ── Überstunden-Übersicht state (RPT-01 + SALDO-03) ───────────────────────

  let overtimeOverview: OvertimeOverview | null = $state(null);
  let overtimeLoading = $state(false);
  let overtimeError = $state("");

  let sortColumn: "name" | "balance" = $state("name");
  let sortDir: "asc" | "desc" = $state("asc");

  // Phase 97-07 — sort by the CONFIRMED figure (the entitlement), not the forecast-inclusive
  // balanceHours: a team's Saldo ordering should reflect what's actually owed, not a number
  // that moves during the open month. Falls back to balanceHours (converted to minutes, so
  // the two branches never mix units within one comparison) for a row lacking the split —
  // an older cached response, per the same fallback shape as the Saldo cell itself.
  function overtimeSortBalance(r: OvertimeEmployee): number {
    return r.confirmedMinutes !== undefined ? r.confirmedMinutes : r.balanceHours * 60;
  }

  // Issue #613: the server flags the exited persons with an open final saldo; the team table, its
  // sorting, paging and the KPIs below read the active rows only.
  let overtimeSections = $derived(partitionOvertimeOverview(overtimeOverview?.employees ?? []));

  let sortedOvertime = $derived.by(() => {
    const rows = overtimeSections.active;
    const copy = rows.slice();
    copy.sort((a, b) => {
      const cmp =
        sortColumn === "name"
          ? a.name.localeCompare(b.name, "de")
          : overtimeSortBalance(a) - overtimeSortBalance(b);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  });

  let overtimePage = $state(1);
  let overtimePageSize = $state(10);
  let pagedOvertimeRows = $derived(
    sortedOvertime.slice((overtimePage - 1) * overtimePageSize, overtimePage * overtimePageSize),
  );

  $effect(() => {
    const _len = sortedOvertime.length;
    overtimePage = 1;
  });

  // ── Verfall-Warnungen state (Phase 44 — BUrlG § 7 Hinweispflicht) ─────────

  type CarryoverRow = {
    entitlementId: string;
    employee: { id: string; firstName: string; lastName: string; employeeNumber: string };
    leaveType: { id: string; name: string };
    year: number;
    carriedOverDays: number;
    // Issue #451 (D-08) — additive; an older cached response has no field, hence `??` fallback
    // to the pre-#451 raw carriedOverDays at the call site below.
    atRiskDays?: number;
    deadline: string; // ISO
    daysUntilDeadline: number;
    lastWarningSentAt: string | null;
  };

  type CarryoverAtRisk = {
    horizonDays: number;
    summary: { employeesAtRisk: number; totalDaysAtRisk: number; warnedLast30: number };
    rows: CarryoverRow[];
  };

  let carryover: CarryoverAtRisk | null = $state(null);
  let carryoverLoading = $state(false);
  let carryoverError = $state("");
  let carryoverHorizon = $state(60);
  let carryoverWarnBusy = $state<Record<string, boolean>>({});
  let carryoverRowMsg = $state<Record<string, string>>({});

  let carryoverPage = $state(1);
  let carryoverPageSize = $state(10);
  let pagedCarryoverRows = $derived(
    (carryover?.rows ?? []).slice(
      (carryoverPage - 1) * carryoverPageSize,
      carryoverPage * carryoverPageSize,
    ),
  );

  $effect(() => {
    const _len = carryover?.rows.length ?? 0;
    carryoverPage = 1;
  });

  // ── Urlaubsübersicht state (RPT-02) ──────────────────────────────────────

  let leaveOverview: LeaveOverviewRow[] | null = $state(null);
  let leaveOverviewLoading = $state(false);
  let leaveOverviewError = $state("");

  let leaveOverviewRows = $derived.by(() => {
    const rows = leaveOverview ?? [];
    return rows.slice().sort((a, b) => {
      const ln = a.employee.lastName.localeCompare(b.employee.lastName, "de");
      if (ln !== 0) return ln;
      const fn = a.employee.firstName.localeCompare(b.employee.firstName, "de");
      if (fn !== 0) return fn;
      // Issue #416: a missingEntitlement placeholder row carries leaveType: null — fall back to
      // an empty string so the comparator never dereferences .name on it (a placeholder sorts
      // before every real leave-type name for the same employee, which is fine — there's at
      // most one placeholder row per employee).
      return (a.leaveType?.name ?? "").localeCompare(b.leaveType?.name ?? "", "de");
    });
  });

  let leaveOverviewPage = $state(1);
  let leaveOverviewPageSize = $state(10);
  let pagedLeaveOverviewRows = $derived(
    leaveOverviewRows.slice(
      (leaveOverviewPage - 1) * leaveOverviewPageSize,
      leaveOverviewPage * leaveOverviewPageSize,
    ),
  );

  $effect(() => {
    const _len = leaveOverviewRows.length;
    leaveOverviewPage = 1;
  });

  // Per-employee download error state
  let empDownloadErrors = $state<Record<string, string>>({});

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

  // ── Reactive reload when period changes ────────────────────────────────────

  $effect(() => {
    const _m = selectedMonth;
    const _y = selectedYear;
    if (canReportRead) {
      void loadLeaveOverview();
      void loadCarryoverAtRisk();
    }
  });

  // Issue #542: this effect owns the two salon-filtered list loads. It waits for the salon context
  // so the first request is already filtered, and reruns when the header salon (or the period)
  // changes. The leave overview and the carry-over warnings above ignore the header salon.
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
  const PERIOD_TIMEOUT_MS = 120_000;
  let period: PeriodReport | null = $state(null);
  let periodLoading = $state(false);
  let periodFailure: "INVALID" | "FAILED" | null = $state(null);
  let periodSalonRejected = $state(false);
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

  // Refresh when horizon changes (independent of selectedMonth/selectedYear)
  $effect(() => {
    const _h = carryoverHorizon;
    if (canReportRead) void loadCarryoverAtRisk();
  });

  // The § 9 note follows the Monatsexport card's OWN period selection, not the team overview's
  // selectedMonth/selectedYear.
  $effect(() => {
    const _m = exportMonth;
    const _y = exportYear;
    if (canReportRead) void loadExportSection9Note();
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
      const answer = await api.get<TodayAttendance>(
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
    overtimeLoading = true;
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
    } finally {
      if (generation === overviewGeneration) overtimeLoading = false;
    }
  }

  async function loadCarryoverAtRisk() {
    if (!canReportRead) return;
    carryoverLoading = true;
    carryoverError = "";
    try {
      carryover = await api.get<CarryoverAtRisk>(
        `/reports/carryover-at-risk?days=${carryoverHorizon}`,
      );
    } catch (e: unknown) {
      carryoverError = e instanceof Error ? e.message : "Fehler beim Laden der Verfall-Warnungen";
      carryover = null;
    } finally {
      carryoverLoading = false;
    }
  }

  async function sendCarryoverWarning(row: CarryoverRow) {
    carryoverWarnBusy = { ...carryoverWarnBusy, [row.entitlementId]: true };
    carryoverRowMsg = { ...carryoverRowMsg, [row.entitlementId]: "" };
    try {
      const res = await api.post<{ ok: boolean; warned: number; skippedDedup: number }>(
        "/reports/carryover-warn",
        { entitlementId: row.entitlementId },
      );
      if (res.warned > 0) {
        carryoverRowMsg = {
          ...carryoverRowMsg,
          [row.entitlementId]: "Hinweis gesendet",
        };
        // Refresh to pick up new lastWarningSentAt
        void loadCarryoverAtRisk();
      } else {
        carryoverRowMsg = {
          ...carryoverRowMsg,
          [row.entitlementId]: "Bereits gewarnt (kein neuer Schwellwert erreicht)",
        };
      }
    } catch (e: unknown) {
      carryoverRowMsg = {
        ...carryoverRowMsg,
        [row.entitlementId]: e instanceof Error ? e.message : "Hinweis fehlgeschlagen",
      };
    } finally {
      carryoverWarnBusy = { ...carryoverWarnBusy, [row.entitlementId]: false };
    }
  }

  function formatDeDate(iso: string): string {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getFullYear()}`;
  }

  function formatLastWarning(iso: string | null): string {
    if (!iso) return "—";
    return formatDeDate(iso);
  }

  async function loadLeaveOverview() {
    if (!canReportRead) return;
    leaveOverviewLoading = true;
    leaveOverviewError = "";
    try {
      leaveOverview = await api.get<LeaveOverviewRow[]>(
        `/reports/leave-overview?year=${selectedYear}`,
      );
    } catch (e: unknown) {
      leaveOverviewError =
        e instanceof Error ? e.message : "Fehler beim Laden der Urlaubsübersicht";
      leaveOverview = null;
    } finally {
      leaveOverviewLoading = false;
    }
  }

  async function downloadDatev() {
    datevLoading = true;
    datevError = "";
    try {
      const { authStore: authSt } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authSt);

      const res = await fetch(`/api/v1/reports/datev?month=${datevMonth}&year=${datevYear}`, {
        headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_${datevYear}_${String(datevMonth).padStart(2, "0")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Download fehlgeschlagen";
    } finally {
      datevLoading = false;
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

  async function downloadMonthlyExport() {
    exportLoading = true;
    exportError = "";
    exportSalonRejected = false;
    try {
      await downloadPdf(
        withSalonId(
          `/reports/monthly-export/pdf?year=${exportYear}&month=${exportMonth}`,
          pageSalonId,
        ),
        `Monatsexport_${exportYear}_${String(exportMonth).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      if (pageSalonId !== null && isSalonFilterRejected(e)) {
        exportSalonRejected = true;
      } else {
        exportError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
      }
    } finally {
      exportLoading = false;
    }
  }

  async function loadExportSection9Note() {
    try {
      const res = await api.get<{ section9Note?: string }>(
        `/reports/monthly?year=${exportYear}&month=${exportMonth}`,
      );
      exportSection9Note = res.section9Note ?? null;
    } catch {
      // Fail-safe: the note explains, it never blocks — on an error we show nothing instead of
      // writing an error message into a plain download card.
      exportSection9Note = null;
    }
  }

  async function downloadEmployeePdf(employeeId: string, name: string) {
    const key = `pdf-${employeeId}`;
    empDownloadErrors = { ...empDownloadErrors, [key]: "" };
    try {
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${employeeId}&year=${selectedYear}&month=${selectedMonth}`,
        `Stundennachweis_${name.replace(/\s+/g, "_")}_${selectedYear}_${String(selectedMonth).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      empDownloadErrors = {
        ...empDownloadErrors,
        [key]: e instanceof Error ? e.message : "PDF-Download fehlgeschlagen",
      };
    }
  }

  async function downloadEmployeeDatev(employeeId: string, name: string) {
    const key = `datev-${employeeId}`;
    empDownloadErrors = { ...empDownloadErrors, [key]: "" };
    try {
      const { authStore: authSt } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authSt);
      const res = await fetch(
        `/api/v1/reports/datev/employee?employeeId=${employeeId}&year=${selectedYear}&month=${selectedMonth}`,
        {
          headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_${name.replace(/\s+/g, "_")}_${selectedYear}_${String(selectedMonth).padStart(2, "0")}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      empDownloadErrors = {
        ...empDownloadErrors,
        [`datev-${employeeId}`]: e instanceof Error ? e.message : "DATEV-Download fehlgeschlagen",
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatDays(n: number): string {
    return n.toLocaleString("de-DE", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    });
  }

  function statusClass(status: TodayEmployee["status"]): string {
    return `status-badge status-${status.replace("_", "-")}`;
  }

  function toggleSort(column: "name" | "balance") {
    if (sortColumn === column) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortColumn = column;
      sortDir = "asc";
    }
  }

  function statusBadgeClass(s: OvertimeEmployee["status"]): string {
    return `status-badge status-saldo-${s.toLowerCase()}`;
  }

  function statusBadgeLabel(s: OvertimeEmployee["status"]): string {
    return s === "NORMAL" ? "Normal" : s === "ELEVATED" ? "Erhöht" : "Kritisch";
  }

  // ── KPI summaries (v1.5) ───────────────────────────────────────────────────

  // Issue #588 (D-588-1): the median and the persons outside it come from the one team saldo
  // module, over the active rows only (#613). Until 612-05 Task 2 moves the line into the period
  // table, the old overview card shows it.
  let teamSaldo = $derived(teamSaldoFigures(overtimeSections.active));

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
</script>

<svelte:head>
  <title>Berichte – Clokr</title>
</svelte:head>

<PageHead
  eyebrow={showTeamArea ? "Team" : "Mein Bereich"}
  title="Berichte & Auswertungen"
  accent="Auswertungen"
  sub={showTeamArea
    ? "Zeiten, Konten und Urlaub für einen Zeitraum – bis zu 12 Monate."
    : "Persönliche Monatsabschlüsse — als PDF zum Download."}
/>

{#if showTeamArea}
  <SalonScopeLabel label={scopeLabel} />
  <!-- The export cards keep their place until 612-06 replaces them with the export dialog. -->
  <div class="reports-grid">
    <!-- DATEV Export Card -->
    {#if canReportExport}
      <div class="card card-body card-animate report-card">
        <div class="report-card-icon-section report-card-icon-section--green">
          <span class="report-icon-lg">📁</span>
        </div>
        <div class="report-card-header">
          <div>
            <h2 class="report-card-heading">DATEV Export</h2>
            <p class="report-card-desc text-muted">
              TXT-Datei für DATEV-Lohnabrechnung herunterladen
            </p>
          </div>
        </div>

        <div class="report-controls">
          <div class="form-group">
            <label class="form-label" for="datev-month">Monat</label>
            <select id="datev-month" bind:value={datevMonth} class="form-input">
              {#each months as name, i (i)}
                <option value={i + 1}>{name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="datev-year">Jahr</label>
            <select id="datev-year" bind:value={datevYear} class="form-input">
              {#each years as y (y)}
                <option value={y}>{y}</option>
              {/each}
            </select>
          </div>
        </div>

        {#if pageSalonId !== null}
          <p class="form-hint" data-testid="datev-all-salons-note">{DATEV_ALL_SALONS_NOTE}</p>
        {/if}

        <button class="btn btn-primary" onclick={downloadDatev} disabled={datevLoading}>
          {#if datevLoading}
            <span class="btn-spinner"></span>
            Vorbereiten…
          {:else}
            ↓ TXT herunterladen
          {/if}
        </button>

        {#if datevError}
          <div class="alert alert-error" role="alert">
            <span>⚠</span>
            <span>{datevError}</span>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Monatsexport Card (Issue #617) -->
    {#if canReportExport}
      <div class="card card-body card-animate report-card">
        <div class="report-card-icon-section report-card-icon-section--green">
          <span class="report-icon-lg">📄</span>
        </div>
        <div class="report-card-header">
          <div>
            <h2 class="report-card-heading">Monatsexport</h2>
            <p class="report-card-desc text-muted">
              Lesbare Fassung des DATEV-Exports: Soll, Ist, Saldo, Abwesenheiten und Urlaub je
              Person — ohne Tagesliste
            </p>
          </div>
        </div>

        <div class="report-controls">
          <div class="form-group">
            <label class="form-label" for="export-month">Monat</label>
            <select id="export-month" bind:value={exportMonth} class="form-input">
              {#each months as name, i (i)}
                <option value={i + 1}>{name}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="export-year">Jahr</label>
            <select id="export-year" bind:value={exportYear} class="form-input">
              {#each years as y (y)}
                <option value={y}>{y}</option>
              {/each}
            </select>
          </div>
        </div>

        {#if pageSalonId !== null}
          <p class="form-hint" data-testid="export-salon-persons-note">
            {SALON_EXPORT_PERSONS_NOTE} · {PERSON_SALDO_NOT_SPLIT_LABEL}. {EXPORT_NO_STAMMSALON_NOTE}
          </p>
        {/if}

        <button class="btn btn-primary" onclick={downloadMonthlyExport} disabled={exportLoading}>
          {#if exportLoading}
            <span class="btn-spinner"></span>
            Vorbereiten…
          {:else}
            ↓ PDF herunterladen
          {/if}
        </button>

        {#if exportSection9Note}
          <div class="alert alert-info" data-testid="report-section9-note">
            <span aria-hidden="true">§</span>
            <span>{exportSection9Note}</span>
          </div>
        {/if}

        {#if exportSalonRejected}
          <SalonScopeLabel label={null} rejected={true} />
        {:else if exportError}
          <div class="alert alert-error" role="alert">
            <span>⚠</span>
            <span>{exportError}</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if rights.periodTabs.length > 0}
    <div
      class="view-tabs"
      role="tablist"
      aria-label="Berichtsbereich"
      tabindex="-1"
      onkeydown={onTabKeydown}
    >
      {#each rights.periodTabs as tab (tab)}
        <button
          type="button"
          class="view-tab"
          class:view-tab--active={tab === activeTab}
          role="tab"
          id="reports-tab-{tab}"
          aria-selected={tab === activeTab}
          aria-controls="reports-panel-{tab}"
          tabindex={tab === activeTab ? 0 : -1}
          onclick={() => selectTab(tab)}>{TAB_LABEL[tab]}</button
        >
      {/each}
    </div>
  {/if}

  {#if periodTabActive || exportOnly}
    <div
      class="page period-content"
      style="--period-bar-h: {barHeight}px"
      role={periodTabActive ? "tabpanel" : undefined}
      id={periodTabActive ? `reports-panel-${activeTab}` : undefined}
      aria-labelledby={periodTabActive ? `reports-tab-${activeTab}` : undefined}
    >
      <PeriodBar
        onHeight={(px) => (barHeight = px)}
        from={urlState.from}
        to={urlState.to}
        {today}
        loading={periodLoading}
        canExport={canReportExport}
        onChange={onPeriodChange}
        onOpenRange={openRange}
        onOpenExport={openExport}
      />

      {#if exportOnly}
        <p class="period-note" data-testid="period-export-only-note">
          Keine Auswertung freigegeben – Exporte verfügbar
        </p>
      {:else if periodSalonRejected}
        <SalonScopeLabel label={null} rejected={true} />
      {:else if periodFailure === "INVALID"}
        <div class="callout error" role="alert" data-testid="period-invalid">
          <p>Dieser Zeitraum lässt sich nicht auswerten – höchstens 12 Monate auf einmal.</p>
          <button
            type="button"
            class="btn btn-outline sm"
            onclick={() => onPeriodChange({ ...today }, { ...today })}>Zum aktuellen Monat</button
          >
        </div>
      {:else if periodFailure === "FAILED"}
        <div class="callout error" role="alert" data-testid="period-error">
          <p>
            Der Bericht konnte nicht geladen werden. Prüfen Sie die Verbindung und versuchen Sie es
            erneut.
          </p>
          <button
            type="button"
            class="btn btn-outline sm"
            onclick={() => void loadPeriod(urlState.from, urlState.to, pageSalonId)}
            >Erneut versuchen</button
          >
        </div>
      {:else}
        <div class="period-body" class:period-body--dim={periodLoading && period !== null}>
          <Card animate>
            <PeriodKpis
              kpis={period?.kpis ?? null}
              filterActive={pageSalonId !== null}
              loading={periodLoading}
            />
          </Card>
        </div>

        <div
          class="page period-tab-content"
          class:period-body--dim={periodLoading && period !== null}
        >
          {#if activeTab === "zeiten"}
            {@render overtimeBlock()}
          {:else if activeTab === "urlaub"}
            {@render carryoverBlock()}
            {@render leaveOverviewBlock()}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if activeTab === "heute"}
    <div class="page" role="tabpanel" id="reports-panel-heute" aria-labelledby="reports-tab-heute">
      {@render attendanceBlock()}
    </div>
  {/if}

  <!-- Dialogs sit after the panels, never inside an animated Card (Issue #570). -->
  <PeriodRangeDialog
    bind:open={rangeOpen}
    from={urlState.from}
    to={urlState.to}
    {today}
    onApply={onPeriodChange}
  />
  <div class="sr-only" role="status" aria-live="polite" data-testid="period-live">{liveText}</div>
{:else}
  <div class="kpi-row">
    <Card animate>
      <KPIStat label="Abgeschlossen" value={String(kpiClosedMonths)} unit="Monate" />
    </Card>
    <Card animate>
      <KPIStat label="Soll" value={fmtHoursFromMin(kpiTotalExpectedMin)} unit="h" />
    </Card>
    <Card animate>
      <KPIStat label="Ist" value={fmtHoursFromMin(kpiTotalWorkedMin)} unit="h" />
    </Card>
    <Card animate>
      <KPIStat
        label="Saldo"
        value={fmtBalance(kpiTotalBalanceMin)}
        unit="h"
        deltaTone={kpiTotalBalanceMin > 0 ? "good" : kpiTotalBalanceMin < 0 ? "bad" : "neutral"}
      />
    </Card>
  </div>

  <!-- EMP-06: Employee personal monthly closes -->
  <Card animate class="emp-closes-card" style="--card-idx: 1;">
    <div class="emp-closes-hd">
      <CardHeader title="Monatsabschlüsse" sub="Persönliche Bilanz je Monat" />
    </div>
    {#if empClosesLoading}
      <div class="emp-closes-loading">Lade Monatsabschlüsse…</div>
    {:else if empClosesError}
      <div class="emp-closes-error" role="alert">{empClosesError}</div>
    {:else}
      <div class="table-scroll">
        <table class="emp-closes-table">
          <thead>
            <tr>
              <th>Monat</th>
              <th class="num">Soll</th>
              <th class="num">Ist</th>
              <th class="num">Saldo (Bestätigt)</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#if empMonthlyCloses.length === 0}
              <tr>
                <td colspan="6" class="emp-closes-empty">Noch keine abgeschlossenen Monate</td>
              </tr>
            {:else}
              {#each empMonthlyCloses as row (`${row.year}-${row.month}`)}
                <tr>
                  <td><b class="emp-month-label">{row.label}</b></td>
                  {#if row.status === "closed"}
                    <td class="num">{fmtMinutesAsHrs(row.expectedMinutes)}</td>
                    <td class="num">{fmtMinutesAsHrs(row.workedMinutes)}</td>
                    <td class="num">
                      <!-- Every closed row is a non-superseded MONTHLY snapshot the server
                           listed (the record the PDF prints), so this figure is final, never a
                           forecast: the column header says confirmed, and it renders through the
                           shared primitive in single-value mode so the U+2212 minus and the
                           sign colouring match every other saldo on the page. -->
                      <SaldoAnzeige
                        variant="compact"
                        saldoMinutes={row.balanceMinutes}
                        isLocked={row.status === "closed"}
                      />
                    </td>
                  {:else}
                    <td class="num" title="Prognose im PDF">—</td>
                    <td class="num" title="Prognose im PDF">—</td>
                    <td class="num" title="Prognose im PDF">—</td>
                  {/if}
                  <td>
                    {#if row.status === "closed"}
                      <span class="chip chip-good">
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          aria-hidden="true"
                        >
                          <rect x="3" y="11" width="18" height="11" rx="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        Abgeschlossen
                      </span>
                    {:else}
                      <span class="chip chip-warn"><span class="dot"></span> Offen</span>
                    {/if}
                  </td>
                  <td class="emp-pdf-cell">
                    <button
                      type="button"
                      class="btn btn-ghost xs"
                      onclick={() => downloadEmployeeMonthlyPdf(row.year, row.month, row.label)}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      PDF
                    </button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
{/if}

{#snippet attendanceBlock()}
  {#if canTeamAttendance}
    <Card animate class="widget-card" style="--card-idx: 1;">
      <CardHeader title="Heutige Anwesenheit" sub="Status aller Mitarbeiter">
        {#snippet actions()}
          {#if todayAttendance}
            <span class="section-date">{todayAttendance.date}</span>
          {/if}
        {/snippet}
      </CardHeader>

      {#if todayLoading}
        <p class="section-placeholder">Lade Anwesenheit…</p>
      {:else if attendanceSalonRejected}
        <SalonScopeLabel label={null} rejected={true} />
      {:else if todayError}
        <p class="section-error">{todayError}</p>
      {:else if todayAttendance}
        <div class="attendance-summary">
          <div class="summary-chip">
            <span class="label">Anwesend</span>
            <span class="value">{todayAttendance.summary.present}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Eingestempelt</span>
            <span class="value">{todayAttendance.summary.clockedIn}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Abwesend</span>
            <span class="value">{todayAttendance.summary.absent}</span>
          </div>
          <div class="summary-chip">
            <span class="label">{DAY_STATUS_LABEL.missing}</span>
            <span class="value">{todayAttendance.summary.missing}</span>
          </div>
          {#if todayAttendance.summary.holiday > 0}
            <div class="summary-chip">
              <span class="label">Feiertag</span>
              <span class="value">{todayAttendance.summary.holiday}</span>
            </div>
          {/if}
        </div>

        <div class="table-wrap">
          <table class="attendance-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Nr.</th>
                <th>Status</th>
                {#if showAttendanceActions}
                  <th>Aktionen</th>
                {/if}
              </tr>
            </thead>
            <tbody>
              {#each pagedTodayRows as row (row.id)}
                <tr>
                  <td>{row.name}</td>
                  <td>{row.employeeNumber}</td>
                  <td
                    ><span class={statusClass(row.status)}>{attendanceStatusText(row)}</span>
                    {#if row.workedElsewhere}
                      <span class="badge badge-gray" title="In einem anderen Salon gearbeitet"
                        >anderer Salon</span
                      >
                    {/if}</td
                  >
                  {#if showAttendanceActions}
                    <td class="attendance-actions">
                      <div class="row-actions__group">
                        {#if row.status === "missing"}
                          {@const entryHref = teamDayHref(row.id, todayAttendance.date)}
                          {@const absenceHref = teamLeaveCreateHref(row.id, todayAttendance.date)}
                          {#if canAddTeamEntry && entryHref !== null}
                            <a class="btn btn-ghost xs" href={entryHref}>Eintrag nachtragen</a>
                          {/if}
                          {#if canRecordTeamAbsence && absenceHref !== null}
                            <a class="btn btn-ghost xs" href={absenceHref}>Abwesenheit erfassen</a>
                          {/if}
                        {/if}
                      </div>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          total={todayAttendance.employees.length}
          bind:page={todayPage}
          bind:pageSize={todayPageSize}
        />
      {/if}
    </Card>
  {/if}
{/snippet}

{#snippet carryoverBlock()}
  {#if canReportRead}
    <!-- Verfall-Warnungen (Phase 44 — BUrlG § 7 Hinweispflicht / EuGH C-684/16) -->
    <Card animate class="widget-card" style="--card-idx: 2;">
      <CardHeader title="Verfall-Warnungen" sub="Resturlaub mit auslaufender Frist (§ 7 BUrlG)">
        {#snippet actions()}
          <label class="carryover-horizon-label" for="carryover-horizon">
            Horizont
            <select id="carryover-horizon" class="period-select" bind:value={carryoverHorizon}>
              <option value={30}>30 Tage</option>
              <option value={60}>60 Tage</option>
              <option value={90}>90 Tage</option>
              <option value={180}>180 Tage</option>
            </select>
          </label>
        {/snippet}
      </CardHeader>

      {#if pageSalonId !== null}
        <p class="form-hint" data-testid="carryover-all-salons-note">{ALL_SALONS_BLOCK_NOTE}</p>
      {/if}

      {#if carryoverLoading}
        <p class="section-placeholder">Lade Verfall-Warnungen…</p>
      {:else if carryoverError}
        <p class="section-error">{carryoverError}</p>
      {:else if carryover}
        <div class="carryover-summary">
          <div class="summary-chip">
            <span class="label">Betroffene MA</span>
            <span class="value">{carryover.summary.employeesAtRisk}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Tage im Risiko</span>
            <span class="value">{formatDays(carryover.summary.totalDaysAtRisk)}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Hinweise (30 T.)</span>
            <span class="value">{carryover.summary.warnedLast30}</span>
          </div>
        </div>

        {#if carryover.rows.length === 0}
          <p class="section-placeholder">
            Kein Resturlaub mit Verfall in den nächsten {carryover.horizonDays} Tagen.
          </p>
        {:else}
          <div class="carryover-callout">
            Hinweispflicht: Mitarbeiter müssen gemäß EuGH C-684/16 ausdrücklich auf verfallenden
            Urlaub hingewiesen werden. Ohne dokumentierten Hinweis verfällt der Urlaub <strong
              >nicht</strong
            >.
          </div>
          <div class="table-wrap">
            <table class="carryover-table">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th>Nr.</th>
                  <th class="numeric">Gefährdet (T.)</th>
                  <th>Verfällt am</th>
                  <th class="numeric">Verbleibend</th>
                  <th>Letzter Hinweis</th>
                  <th class="actions-col">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {#each pagedCarryoverRows as row (row.entitlementId)}
                  <tr>
                    <td>{row.employee.firstName} {row.employee.lastName}</td>
                    <td>{row.employee.employeeNumber}</td>
                    <td class="numeric">{formatDays(row.atRiskDays ?? row.carriedOverDays)}</td>
                    <td>{formatDeDate(row.deadline)}</td>
                    <td class="numeric">
                      <span class={row.daysUntilDeadline <= 14 ? "danger" : ""}>
                        {row.daysUntilDeadline} T.
                      </span>
                    </td>
                    <td>{formatLastWarning(row.lastWarningSentAt)}</td>
                    <td class="row-actions">
                      <div class="row-actions__group">
                        {#if canReportNotify}
                          <button
                            class="btn-ghost btn-warn-now"
                            disabled={carryoverWarnBusy[row.entitlementId]}
                            onclick={() => sendCarryoverWarning(row)}
                          >
                            {carryoverWarnBusy[row.entitlementId]
                              ? "Senden…"
                              : "Hinweis jetzt senden"}
                          </button>
                        {/if}
                        {#if carryoverRowMsg[row.entitlementId]}
                          <span class="row-msg">{carryoverRowMsg[row.entitlementId]}</span>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <Pagination
            total={carryover.rows.length}
            bind:page={carryoverPage}
            bind:pageSize={carryoverPageSize}
          />
        {/if}
      {/if}
    </Card>
  {/if}
{/snippet}

{#snippet overtimeBlock()}
  {#if canTeamOvertime}
    <!-- Überstunden-Übersicht (RPT-01 + SALDO-03) -->
    <Card animate class="widget-card" style="--card-idx: 3;">
      <CardHeader title="Überstunden-Übersicht" sub="Saldo je Mitarbeiter" />

      {#if overtimeOverview}
        <!-- Interim until the period table (612-05 Task 2) carries the median line. -->
        <p class="form-hint" data-testid="team-median-line">
          Median-Saldo {teamSaldo.medianMinutes === null
            ? "—"
            : fmtBalance(teamSaldo.medianMinutes)} h ·
          {teamSaldo.excluded.length > 0
            ? `${teamSaldo.excluded.length} nicht in der Kennzahl`
            : `aus ${teamSaldo.counted} Personen`}
        </p>
      {/if}

      {#if pageSalonId !== null}
        <p class="form-hint" data-testid="overtime-salon-persons-note">
          {SALON_HOME_PERSONS_NOTE} · {PERSON_SALDO_NOT_SPLIT_LABEL}
        </p>
      {/if}

      {#if overtimeLoading}
        <p class="section-placeholder">Lade Überstunden-Saldo…</p>
      {:else if overviewSalonRejected}
        <SalonScopeLabel label={null} rejected={true} />
      {:else if overtimeError}
        <p class="section-error">{overtimeError}</p>
      {:else if overtimeOverview}
        <div class="table-wrap">
          <table class="overtime-table">
            <thead>
              <tr>
                <th class="sortable" onclick={() => toggleSort("name")}>
                  Mitarbeiter
                  {#if sortColumn === "name"}<span class="sort-arrow"
                      >{sortDir === "asc" ? "▲" : "▼"}</span
                    >{/if}
                </th>
                <th>Nr.</th>
                <th class="sortable numeric" onclick={() => toggleSort("balance")}>
                  Abgeschlossen
                  {#if sortColumn === "balance"}<span class="sort-arrow"
                      >{sortDir === "asc" ? "▲" : "▼"}</span
                    >{/if}
                </th>
                <th class="numeric">{forecastColumnLabel(overtimeSections.active)}</th>
                <th class="numeric">Gesamt</th>
                <th>Status</th>
                <th class="actions-col">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedOvertimeRows as row (row.id)}
                {@const cells = teamSaldoCells(row)}
                {@const exclusion = teamSaldoExclusion(row)}
                <tr>
                  <td>
                    {row.name}
                    {#if exclusion !== null}
                      <span class="badge badge-gray" title="Nicht im Median-Saldo"
                        >{TEAM_SALDO_EXCLUSION_LABEL[exclusion]}</span
                      >
                    {/if}
                  </td>
                  <td>{row.employeeNumber}</td>
                  <td
                    class="numeric"
                    data-testid="saldo-cell-confirmed"
                    title={cells.confirmed.title}
                  >
                    {cells.confirmed.text}
                  </td>
                  <td class="numeric" data-testid="saldo-cell-open" title={cells.open.title}>
                    {cells.open.text}
                    {#if row.rosterIncomplete}
                      <span class="roster-dot" data-testid="saldo-roster-badge">
                        <Icon
                          name="circle-fill"
                          size={6}
                          title="Restmonat noch nicht vollständig verplant"
                        />
                      </span>
                    {/if}
                  </td>
                  <td class="numeric" data-testid="saldo-cell-total" title={cells.total.title}>
                    {cells.total.text}
                  </td>
                  <td
                    ><span class={statusBadgeClass(row.status)}>{statusBadgeLabel(row.status)}</span
                    ></td
                  >
                  <td class="row-actions">
                    <div class="row-actions__group">
                      <button
                        class="btn-icon btn-icon-pdf"
                        title="Stundennachweis PDF ({row.name})"
                        onclick={() => downloadEmployeePdf(row.id, row.name)}>PDF</button
                      >
                      <button
                        class="btn-icon btn-icon-datev"
                        title="DATEV LODAS ({row.name})"
                        onclick={() => downloadEmployeeDatev(row.id, row.name)}>TXT</button
                      >
                      {#if empDownloadErrors[`pdf-${row.id}`]}
                        <span class="row-dl-error">{empDownloadErrors[`pdf-${row.id}`]}</span>
                      {/if}
                      {#if empDownloadErrors[`datev-${row.id}`]}
                        <span class="row-dl-error">{empDownloadErrors[`datev-${row.id}`]}</span>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          total={sortedOvertime.length}
          bind:page={overtimePage}
          bind:pageSize={overtimePageSize}
        />
        <ExitedFinalSaldoSection
          rows={overtimeSections.exitedOpen}
          total={overtimeOverview.exitedOpenFinalSaldoCount ?? overtimeSections.exitedOpen.length}
        />
      {/if}
    </Card>
  {/if}
{/snippet}

{#snippet leaveOverviewBlock()}
  {#if canReportRead}
    <!-- Urlaubsübersicht (RPT-02) -->
    <Card animate class="widget-card" style="--card-idx: 4;">
      <CardHeader title="Urlaubsübersicht" sub="Anspruch, genommen, genehmigt und Resturlaub" />

      {#if pageSalonId !== null}
        <p class="form-hint" data-testid="leave-overview-all-salons-note">
          {ALL_SALONS_BLOCK_NOTE}
        </p>
      {/if}

      {#if leaveOverviewLoading}
        <p class="section-placeholder">Lade Urlaubsübersicht…</p>
      {:else if leaveOverviewError}
        <p class="section-error">{leaveOverviewError}</p>
      {:else if leaveOverviewRows.length === 0}
        <p class="section-placeholder">Keine Einträge für dieses Jahr</p>
      {:else}
        <div class="table-wrap">
          <table class="leave-overview-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Nr.</th>
                {#each VACATION_YEAR_COLUMNS as label (label)}
                  <th class="numeric">{label}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each pagedLeaveOverviewRows as row (row.employee.employeeNumber + ":" + (row.leaveType?.id ?? "missing"))}
                <tr>
                  <td>{row.employee.firstName} {row.employee.lastName}</td>
                  <td>{row.employee.employeeNumber}</td>
                  {#if row.missingEntitlement}
                    <td colspan="7">
                      <span class="badge badge-yellow">kein Anspruch hinterlegt</span>
                    </td>
                  {:else}
                    <td class="numeric">{formatDays(row.totalDays)}</td>
                    <td class="numeric"
                      >{formatDays(row.carriedOverEffectiveDays ?? row.carriedOverDays)}</td
                    >
                    <td class="numeric"
                      >{formatDays(
                        row.availableDays ??
                          row.totalDays + (row.carriedOverEffectiveDays ?? row.carriedOverDays),
                      )}</td
                    >
                    <td class="numeric">{formatDays(row.takenDays ?? row.usedDays)}</td>
                    <td class="numeric">{formatDays(row.approvedUpcomingDays ?? 0)}</td>
                    <td class="numeric">{formatDays(row.pendingDays)}</td>
                    <td class="numeric strong">{formatDays(row.remainingDays)}</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="form-hint leave-overview-hint">
          Verfügbar = Anspruch + wirksamer Übertrag. Resturlaub = Verfügbar - Genommen - Genehmigt.
          Beantragte Tage werden nicht abgezogen.
        </p>
        <Pagination
          total={leaveOverviewRows.length}
          bind:page={leaveOverviewPage}
          bind:pageSize={leaveOverviewPageSize}
        />
      {/if}
    </Card>
  {/if}
{/snippet}

<style>
  /* ── KPI cluster (Card + KPIStat grid) ────────────────────────────────── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }

  @media (max-width: 960px) {
    .kpi-row {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 540px) {
    .kpi-row {
      grid-template-columns: 1fr;
    }
  }

  .reports-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.25rem;
    margin-bottom: 1.75rem;
  }

  .report-card {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
    overflow: hidden;
    transition:
      transform 0.2s var(--ease-out, ease),
      box-shadow 0.2s ease;
  }

  .report-card:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-md, 0 8px 20px rgba(0, 0, 0, 0.12));
  }

  .report-card-icon-section {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: var(--r-sm);
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .report-card:hover .report-card-icon-section {
    transform: scale(1.05);
  }

  .report-card-icon-section--purple {
    background: var(--brand-soft);
  }

  .report-card-icon-section--green {
    background: var(--good-soft);
  }

  .report-icon-lg {
    font-size: 1.5rem;
    line-height: 1;
  }

  .report-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
  }

  .report-card-heading {
    font-size: 1.0625rem;
    margin-bottom: 0.25rem;
  }

  .report-card-desc {
    font-size: 0.875rem;
  }

  .report-controls {
    display: flex;
    gap: 0.875rem;
  }

  .report-controls .form-group {
    flex: 1;
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: var(--bg-card);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── Period area (Issue #612) ────────────────────────────────────────────── */

  /* The sticky parent of the period bar: it sticks for the whole panel. */
  .period-content {
    min-width: 0;
  }

  /* The previous figures stay readable while a new period is being fetched. */
  .period-body--dim {
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }

  .period-note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.9375rem;
  }

  .period-select {
    background: var(--bg-subtle);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
    font-family: inherit;
    cursor: pointer;
  }

  .period-select:focus {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  .section-date {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .section-placeholder,
  .section-error {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  .section-error {
    color: var(--bad);
  }

  /* Heutige Anwesenheit */

  .attendance-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .summary-chip {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-chip .label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .summary-chip .value {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .attendance-table th,
  .attendance-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .attendance-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .status-present,
  .status-clocked-in {
    background: var(--good-soft);
    color: var(--good);
  }

  .status-absent {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .status-holiday {
    background: var(--brand-soft);
    color: var(--brand);
  }

  .status-missing {
    background: var(--bad-soft);
    color: var(--bad);
  }

  .status-scheduled,
  .status-none {
    background: var(--bg-subtle);
    color: var(--text-muted);
  }

  .status-requested {
    background: var(--warn-soft);
    color: var(--warn);
  }

  /* Verfall-Warnungen (Phase 44 — BUrlG § 7 Hinweispflicht) */

  .carryover-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 560px) {
    .carryover-summary {
      grid-template-columns: 1fr;
    }
  }

  .carryover-callout {
    background: var(--brand-soft);
    border: 1px solid var(--brand);
    border-radius: var(--r-md);
    color: var(--text);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .carryover-horizon-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .carryover-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .carryover-table th,
  .carryover-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .carryover-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .carryover-table td.numeric,
  .carryover-table th.numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .carryover-table .danger {
    color: var(--bad);
    font-weight: 700;
  }

  .btn-warn-now {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
  }

  .row-msg {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Überstunden-Übersicht */

  .overtime-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .overtime-table th,
  .overtime-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .overtime-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .overtime-table th.sortable {
    cursor: pointer;
    user-select: none;
  }

  .overtime-table th.sortable:hover {
    color: var(--text);
  }

  .overtime-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .sort-arrow {
    margin-left: 0.25rem;
    color: var(--brand);
  }

  .status-saldo-normal {
    background: var(--good-soft);
    color: var(--good);
  }

  .status-saldo-elevated {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .status-saldo-critical {
    background: var(--bad-soft);
    color: var(--bad);
  }

  .roster-dot {
    display: inline-flex;
    align-items: center;
    color: var(--warn);
  }

  /* ── Per-employee action buttons ─────────────────────────────────────────── */

  .actions-col {
    width: 110px;
    text-align: right;
  }

  .row-actions {
    text-align: right;
    white-space: nowrap;
  }
  /* Issue #587: the action cell of the attendance list; the flex layout lives on the inner
     .row-actions__group wrapper (Issue #442), never on the td itself. */
  .attendance-actions {
    text-align: right;
    white-space: nowrap;
  }
  /* Issue #442 — flex layout lives on the inner wrapper, never on the td itself, so the cell
     keeps display: table-cell and lines up with the rest of the row. */
  .row-actions__group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    justify-content: flex-end;
  }

  .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    font-family: var(--font-mono);
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
    line-height: 1;
  }

  .btn-icon:hover {
    background: var(--brand-soft);
    color: var(--brand);
    border-color: var(--brand);
  }

  .btn-icon-pdf {
    color: var(--text-muted);
  }

  .btn-icon-datev {
    color: var(--text-muted);
  }

  .row-dl-error {
    font-size: 0.75rem;
    color: var(--bad);
    display: block;
    margin-top: 0.25rem;
  }

  /* ── Urlaubsübersicht ─────────────────────────────────────────────────────── */

  .leave-overview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .leave-overview-table th,
  .leave-overview-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .leave-overview-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .leave-overview-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .leave-overview-table .numeric.strong {
    font-weight: 700;
    color: var(--text);
  }

  .leave-overview-hint {
    margin: 0.75rem 0 0;
  }

  /* ── Responsive ───────────────────────────────────────────────────────────── */

  @media (max-width: 720px) {
    .attendance-summary {
      grid-template-columns: repeat(2, 1fr);
    }

    .actions-col,
    .row-actions {
      display: none;
    }
  }

  @media (max-width: 700px) {
    .reports-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── EMP-06: Employee monthly closes table ──────────────────────── */
  .emp-closes-card {
    padding: 0;
    overflow: hidden;
  }
  .emp-closes-hd {
    padding: 16px 20px 0;
    margin-bottom: 0;
  }
  .emp-closes-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }
  .emp-closes-table th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .emp-closes-table td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13.5px;
    vertical-align: middle;
  }
  .emp-closes-table tbody tr:last-child td {
    border-bottom: 0;
  }
  .emp-closes-table tbody tr:hover td {
    background: var(--bg-subtle);
  }
  .emp-closes-table .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .emp-month-label {
    font-weight: 600;
  }
  /* Phase 97-07 — the Saldo (Bestätigt) cell now renders through SaldoAnzeige in
     single-value mode; its own scoped <style> intentionally leaves the legacy
     .saldo__value unpainted (colour is only wired for split mode). Reapply the same
     good/bad/muted mapping the old page-local .diff-good/.diff-bad/.diff-zero classes
     provided, keyed off the primitive's own semantic sign class, scoped to this table's
     Saldo column only. :global() is required to reach past the child component boundary. */
  .emp-closes-table .num :global(.saldo--positive .saldo__value) {
    color: var(--good);
  }
  .emp-closes-table .num :global(.saldo--negative .saldo__value) {
    color: var(--bad);
  }
  .emp-closes-table .num :global(.saldo--zero .saldo__value) {
    color: var(--text-muted);
  }
  .emp-pdf-cell {
    text-align: right;
    white-space: nowrap;
  }
  .emp-closes-loading {
    padding: 32px;
    text-align: center;
    color: var(--text-muted);
  }
  .emp-closes-error {
    padding: 16px 24px;
    color: var(--bad);
    background: var(--bad-soft);
    border-bottom: 1px solid var(--border);
  }
  .emp-closes-empty {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
  }
</style>
