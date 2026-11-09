<script lang="ts" module>
  function getWeekNumber(dateStr: string): number {
    const d = new Date(dateStr + "T00:00:00");
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    return (
      1 +
      Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
    );
  }

  function formatShortDate(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return `${d.getDate()}.${d.getMonth() + 1}.`;
  }
</script>

<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { startVisiblePoll } from "$lib/dashboard/visible-poll";
  import { AREA_LABELS } from "$lib/nav/routes";
  import { matchesRoute } from "$lib/nav/active-route";

  // Issue #844 (D-844-06/07): "me" = Ich › Mein Tag (the personal blocks), "team" = Team › Heute im Salon
  // (`routes/(app)/team/heute` renders this file, the team block only). Until #845 / #846 build the two start
  // pages, both render from this one file, each showing and loading only its own part; the URL decides (a
  // route component takes no props of its own).
  const view = $derived<"me" | "team">(
    matchesRoute("/team/heute", $page.url.pathname) ? "team" : "me",
  );
  const pageKey = $derived(view === "team" ? "/team/heute" : "/dashboard");
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { goto, afterNavigate, replaceState } from "$app/navigation"; // Issue #588 (P-11): a bar of the saldo card opens a person; #609: reminder arrival
  import { page } from "$app/stores"; // Issue #609: the ?clock=1 reminder parameter
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import { toasts } from "$stores/toast";
  import Pagination from "$components/ui/Pagination.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import ClockSalonSelect from "$lib/components/dashboard/ClockSalonSelect.svelte"; // Issue #87
  import ClockOtherSalon from "$lib/components/dashboard/ClockOtherSalon.svelte"; // Issue #70
  import TodayEntriesList from "$lib/components/dashboard/TodayEntriesList.svelte"; // Issue #70
  import TeamSaldoCard from "$lib/components/dashboard/TeamSaldoCard.svelte"; // Issue #588
  import Icon from "$lib/components/Icon.svelte";
  import {
    summarizeKarenzOverrun,
    karenzNudgeHref,
    KARENZ_NUDGE_EMPTY,
    KARENZ_NUDGE_TOOLTIP,
    type KarenzOverrunResponse,
    type KarenzNudgeSummary,
  } from "$lib/leave/karenz-nudge";
  import { summarizeUnconfirmedBreakDays, breakNudgeHref } from "$lib/breaks/break-nudge";
  import {
    resolveDayState,
    upsertDayEntry,
    primaryClockLabel,
    canReopenFinishedDay,
    reopenGapStartLabel,
    dayTotals,
    entryCountLabel,
    entryWorkedMinutes,
    type ClockDayEntry,
  } from "$lib/dashboard/day-state";
  import { interpretClockOut, type ClockOutResponse } from "$lib/dashboard/clock-out-result"; // Phase 307 Plan 02 (D-04)
  import { breakFindingSaveNotice } from "$lib/breaks/day-break-violation"; // Issue #80 (D-09a), #511 (D-10)
  import {
    DAY_STATUS_LABEL,
    attendanceStatusText,
    teamMissingTitle,
  } from "$lib/dashboard/day-status-label"; // Issue #587 (P-06)
  import { teamDayHref, teamCellAriaLabel, teamPersonHref } from "$lib/dashboard/team-day-links"; // Issue #587 (D-587-4), #588
  import { mayOpenTeamPage } from "$lib/nav/team-nav";
  import { mayReadTeamSaldo } from "$lib/page-rights"; // Issue #588 (P-10)
  import { reportRights } from "$lib/page-rights"; // Issue #591 (P-591-05)
  import { partitionOvertimeOverview } from "$lib/reports/overtime-overview-sections"; // Issue #613, #588
  import type { TeamSaldoRow } from "$lib/reports/team-saldo"; // Issue #588
  import {
    clockInBlocked,
    clockInBody,
    clockSalonView,
    fixedSalonNoteLabel,
    initialClockSalonSelection,
    loadClockSalonChoice,
    otherSalonBlocked,
    otherSalonName,
    otherSalonOptions,
    type ClockInAction,
    type ClockSalonChoice,
  } from "$lib/dashboard/clock-salon"; // Issue #87, #70
  import {
    clockReminderAction,
    clockReminderDialog,
    stripClockParam,
    type ClockReminderAction,
  } from "$lib/dashboard/clock-reminder"; // Issue #609 (D-09, D-14)
  import { format, addDays } from "date-fns";
  import Stage from "$components/ui/Stage.svelte"; // Issue #845: the clock stage
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import {
    dayGoalMinutes,
    saldoFigure,
    nextOwnShift,
    historySentences,
    saldoMonthsLine,
    nextPlannedDay,
    plannedDaysCount,
    weekStripText,
    recentDays,
    type MyWeekStripDay,
    type OvertimeAnswer,
    type MyShiftWeek,
    type NextShift,
  } from "$lib/dashboard/mein-tag"; // Issue #845
  import { isTravelRow } from "$lib/time-entries/travel-entry-form";
  import { fmtBalance } from "$lib/utils/format-minutes";
  import { de } from "date-fns/locale";
  import { salonContext } from "$stores/salon-context"; // Issue #84 (D-01)
  import {
    breakEnded,
    breakStarted,
    clockedIn as clockedInMessage,
    clockedOut as clockedOutMessage,
    clockTime,
  } from "$lib/feedback/action-messages"; // #843 (D-843-08, D-843-19): the acknowledgement texts
  import {
    TEAM_SALON_UNAVAILABLE_TEXT,
    isTeamSalonRejected,
    teamSalonFilter,
    teamTrendView,
    teamViewLabel,
    teamWeekHasElsewhere,
    upcomingFromResponse,
    withSalonId,
    type TeamTrendResponse,
    type TeamTrendView,
    type TeamUpcomingLeaveResponse,
  } from "$lib/dashboard/team-view"; // Issue #84 (D-07, D-11, D-12), #85 (D-04, D-06)
  import {
    TEAM_CHART_REPORT_TAB,
    TEAM_SALDO_TREND_CHART,
    TEAM_SICK_DAYS_CHART,
    reportMonthHref,
    reportPeriodHref,
    teamHoursChartConfig,
    teamHoursChartDescriptor,
    teamSaldoTrendChartConfig,
    teamSickDaysChartConfig,
  } from "$lib/dashboard/team-charts"; // Issue #591
  import type { PeriodTab } from "$lib/reports/period-state"; // Issue #591 (D-591-3)
  import { chartAriaLabel, getChartTheme } from "$lib/utils/chart-theme"; // Issue #591
  import {
    Chart,
    BarController,
    LineController,
    BarElement,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
  } from "chart.js";

  Chart.register(
    BarController,
    LineController,
    BarElement,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
  );

  // ── Types ──────────────────────────────────────────────────────────────────
  interface DashboardStats {
    today: { workedHours: number; entries: number };
    // Issue #451 (D-06) — additive, through-yesterday pair (issue #438: today never counts);
    // absent on an older cached response, in which case the tile degrades to the previous
    // whole-week delta (see weekProgressDelta()'s own docblock).
    week: {
      workedHours: number;
      targetHours: number;
      workedToDateHours?: number;
      targetToDateHours?: number;
    };
    periodType?: "week" | "month";
    // Phase 49.1 — schedule type for per-model widget branching
    scheduleType?: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
    month?: { workedHours: number; targetHours: number };
    // Phase 97-04 (SALDO-DISP-01/02/04) — additive confirmed/forecast split fields. Optional
    // so an older cached response (or the API-only no-employeeId branch) still type-checks;
    // the Überstundenkonto tile falls back to the single-value primitive when undefined.
    //
    // Phase 76b (Issue #76), CR-01/WR-01 (code review): `null` when the caller holds no
    // overtime:read:EIGENE / leave-entitlement:read:EIGENE permission respectively (e.g. a bare
    // Salonmanager/Ausbilder template holder) — the corresponding card is hidden, never rendered
    // with a fabricated zero.
    overtime: {
      balanceHours: number;
      confirmedMinutes?: number;
      openMonthMinutes?: number | null;
      hasClosedMonth?: boolean;
      // Issue #588 (P-14): how many calendar months the forecast spans; null = unknown.
      unconfirmedMonths?: number | null;
      rosterIncomplete?: boolean;
    } | null;
    vacation: { remaining: number; total: number; used: number; pending?: number } | null; // #845: pending = undecided days
  }

  interface TeamDay {
    date: string;
    status:
      | "present"
      | "absent"
      | "clocked_in"
      | "missing"
      | "scheduled"
      | "requested"
      | "none"
      | "holiday";
    workedHours: number;
    reason: string | null;
    // Additive, rename-stable companions to `reason` (Issue #205, finding 3): leaveTypeCode
    // comes from a tenant-renamable LeaveRequest, absenceType from the stable Absence path.
    // Icon selection compares these, never `reason` — see the branch chain below.
    leaveTypeCode: string | null;
    absenceType: string | null;
    shift?: { startTime: string; endTime: string; label: string | null; color: string | null };
    isWorkday?: boolean;
    expectedHours?: number;
    // Issue #84 (D-03/D-15): present only under a salon filter — the person has valid working time
    // on this day in another salon (so a 0 h cell is not an absence).
    workedElsewhere?: boolean;
  }

  interface TeamMember {
    id: string;
    name: string;
    // Issue #85 D-05: null for a person whose number the caller's reach does not cover.
    employeeNumber: string | null;
    days: TeamDay[];
  }

  interface TeamWeek {
    weekStart: string;
    weekEnd: string;
    weekDays: string[];
    team: TeamMember[];
  }

  // Phase 76.2 (ARCH-V19-01) — D-03 unified clock response shapes.
  // Backend adapters land in Plans 2 (/clock-in) + 3 (/:id/clock-out).
  // CONFLICT branches surface as thrown ApiError (HTTP 409) and never reach here.
  //
  // Phase 115 (issue #118): the resolver's REOPEN branch (services/clock/resolver.ts:115-142)
  // ALSO resolves to kind "CLOCKED_IN" — but it returns the EXISTING entry with endTime
  // nulled and breakMinutes recomputed from all Break rows, NOT a fresh row. The comment
  // that used to stand here claimed a fresh entry was guaranteed, and that assumption is
  // what made the timer restart at `new Date()` on a reopened day. It has been retired:
  // `entry` is the full TimeEntry row in both cases.
  type ClockInResponse = {
    resolution: {
      kind: "CLOCKED_IN";
      entry: ClockDayEntry & { employeeId: string; source: string };
    };
    audit?: { id: string };
  };

  // /:id/clock-out's response type — Phase 307 Plan 02 (D-04): imported from
  // $lib/dashboard/clock-out-result instead of declared here, so there is exactly ONE
  // definition, not this hand-written copy plus the server's ClockResolution union drifting
  // apart from it. That drift is what let DEBOUNCE_NOOP go unread in the first place: this type
  // used to declare `resolution.kind: "CLOCKED_OUT" | "CONSOLIDATED"` only and `resolution.entry`
  // as required, so evaluating the response was not even compilable without lying about the
  // shape a DEBOUNCE_NOOP body actually has.

  // ── State ──────────────────────────────────────────────────────────────────
  // ── Clock state (Phase 115, GitHub issue #118) ────────────────────────────
  // ONE source: today's rows exactly as GET /api/v1/time-entries returned them.
  // Everything the hero card and the "Heutiger Eintrag" card show derives from it,
  // so the two cards cannot contradict each other the way they did in issue #118.
  let todayEntries = $state<ClockDayEntry[]>([]);
  let day = $derived(resolveDayState(todayEntries));
  // DERIVED alias, never assigned — kept for the nine existing readers.
  let clockedIn = $derived(day.kind === "running");
  let activeEntryId = $derived(day.kind === "running" ? (day.entry?.id ?? null) : null);
  // Issue #118 Lösungsvorschlag 3: the running timer must start at the ENTRY's own
  // startTime. A REOPEN returns the ORIGINAL entry (08:55 in the report), not a fresh
  // one — deriving this instead of assigning `new Date()` makes that correct by
  // construction, for START and REOPEN alike.
  let clockStart = $derived(
    day.kind === "running" && day.entry ? new Date(day.entry.startTime) : null,
  );

  // Issue #87: re-fetched only when the day state changes, never by the 30 s poll (a pick survives it).
  let clockSalon = $state<ClockSalonChoice | null>(null);
  let clockSalonId = $state<string | null>(null);
  let dayKind = $derived(day.kind);
  let clockSalonViewState = $derived(clockSalonView(clockSalon, dayKind));
  // Issue #609: true once the first salon-choice load has answered (also with null on a failure),
  // so a reminder arrival never judges "salon choice required" before it is known.
  let clockSalonLoaded = $state(false);
  $effect(() => {
    void dayKind;
    untrack(() => {
      void loadClockSalonChoice().then((choice) => {
        clockSalon = choice;
        clockSalonId = initialClockSalonSelection(choice);
        clockSalonLoaded = true;
      });
    });
  });
  // Phase 116 (issue #119) — starts TRUE. `onMount` (:339) awaits `loadData()` unconditionally and
  // `loadData` is `loading = true` → try → `finally { loading = false }` with no early return, so
  // the page cannot be stranded. This also removes the only real defect at the single consumer
  // below (:1540): `<SaldoAnzeige {loading} error={!loading} />` renders in the `stats === null`
  // branch, so with `loading` starting false the FIRST frame claimed a failed fetch before any
  // request had been made. `error={!loading}` itself is correct in that branch and is left alone.
  let loading = $state(true);
  let chartsLoading = $state(true);
  // Phase 76b (Issue #76), D-15: whether the caller holds overtime:read (the trend endpoint's own
  // gate, added by Phase 76b). No client-side permission list exists ($stores/auth carries only
  // `role`), so a 403 from the endpoint itself is how we learn this — tolerated silently, never
  // logged, never toasted (a missing overtime:read is expected for e.g. a Mitarbeiter or a
  // Salonmanager template). Starts false so the card stays hidden until a successful load flips it.
  let overtimeTrendAvailable = $state(false);
  let clockLoading = $state(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- written by the clock handlers, kept for their sync
  let breakMinutes = $state(0);
  let currentTime = $state(new Date());

  // ── Open break (dashboard pause toggle) ──────────────────────────────────
  // Open breaks are not persisted on the server (Break records are always
  // closed segments — see CLAUDE.md "Break model"). We track the active
  // break-start time in localStorage keyed by the active TimeEntry id so it
  // survives page reloads. On "Pause beenden" we POST a complete Break
  // segment (start + end) to /api/v1/time-entries/:id/breaks.
  let breakStartedAt: Date | null = $state(null);
  let breakLoading = $state(false);
  const OPEN_BREAK_STORAGE_KEY = "clokr.dashboard.openBreak";

  let stats: DashboardStats | null = $state(null);
  let teamWeek = $state<TeamWeek | null>(null);
  let teamPage = $state(1);
  let teamPageSize = $state(10);
  let pagedTeam = $derived(
    teamWeek ? teamWeek.team.slice((teamPage - 1) * teamPageSize, teamPage * teamPageSize) : [],
  );
  let weekOffset = $state(0);
  // Phase 267 (#267, D-04): shaped after `GET /shifts/my-week`'s `ownShifts[]`, which is already
  // narrowed to the caller server-side. The former `template: { name, color }` is gone — /my-week
  // returns `templateName`/`templateColor` flat, and the markup below renders only label,
  // startTime and endTime anyway.
  let todayShift = $state<{
    startTime: string;
    endTime: string;
    label: string | null;
  } | null>(null);

  // Next personal absence
  let myNextLeave: { startDate: string; endDate: string; days: number; type: string } | null =
    $state(null);

  // Open items widget
  let openItems = $state<{
    pendingApprovals: number;
    missingDays: string[];
    pendingRequests: number;
    invalidEntries: number;
    unconfirmedBreakDays: string[];
    total: number;
  } | null>(null);

  // ── Pausen-Bestätigung Nudge (BREAK-05/07) ───────────────────────────────
  // Phase 126 (issue #126): the count is SERVER-COMPUTED. `openItems.unconfirmedBreakDays`
  // comes from findUnconfirmedBreakDays — the same detector that gates the Monatsabschluss,
  // the auto-close defer and the BREAK_UNCONFIRMED cron — so the card and the backend can no
  // longer disagree.
  //
  // Deleted here, deliberately (D-06): a 12-month `GET /time-entries` fetch plus a client-side
  // breakStatus/isLocked predicate. It counted days outside the current month, which trigger no
  // notification and block no Monatsabschluss, and it counted FLEXTIME/MONTHLY_HOURS employees,
  // for whom the detector returns nothing at all.
  //
  // D-09: no `enforceBreakConfirmation` state any more. The detector returns [] for a tenant
  // that has not opted in, so the dormancy gate is inherited — the extra `/settings/work` fetch
  // that existed only to read that flag is gone too.
  //
  // D-08 fail-safe: when the open-items fetch fails, `openItems` stays null, this derives to
  // BREAK_NUDGE_EMPTY and the whole card is skipped by the `{#if openItems}` below. The card
  // must render NOTHING rather than a "0" — a "0" is a factual claim the client cannot support.

  // ── Karenztage-Hinweis (Phase 104, D-21) ────────────────────────────────────
  // § 5 EFZG: Krankheitstage über die tenant-konfigurierte Karenzzeit hinaus ohne Attest.
  // Reiner Hinweis, keine Blockade — und ausdrücklich NICHT der § 9-BUrlG-Pfad
  // (Urlaubsgutschrift gibt es ausschließlich gegen ärztliches Zeugnis, R5/D-23).
  let karenzNudge = $state<KarenzNudgeSummary>(KARENZ_NUDGE_EMPTY);

  // "Keine offenen Vorgänge" must only render when there is genuinely nothing to show —
  // openItems.total (server-computed) has no knowledge of either client-side nudge rendered
  // below it in the same list (this Karenz nudge, and the Phase-92 break-confirmation nudge).
  // See hasNoOpenItems() in $lib/leave/karenz-nudge.ts for the rationale and its unit tests.

  // ── Heutiger Eintrag (row 2 col-7) ────────────────────────────────────────
  // The "Heutiger Eintrag" card reads the SAME entry the hero card describes
  // (Phase 115, issue #118 — the two used to be derived independently and disagreed).
  let todayEntry = $derived(day.entry);
  // Issue #70 (D-07, D-12): the entry count and the compact list exist only for a multi-salon tenant
  // (the clock-salon answer names a salon only there) with two or more entries today.
  let showEntryList = $derived(clockSalon?.fixedSalon != null && todayEntries.length >= 2);
  let entryCount = $derived(showEntryList ? entryCountLabel(todayEntries.length) : null);

  // ── Aktivität (row 2 col-5) ───────────────────────────────────────────────
  interface ActivityItem {
    id: string;
    icon: "check" | "clock" | "inbox" | "edit" | "lock" | "info" | "x";
    who: string;
    what: string;
    when: string; // ISO
    category: "time" | "leave" | "close" | "audit";
  }
  let activityItems = $state<ActivityItem[]>([]);

  // Charts
  let weeklyChartEl: HTMLCanvasElement;
  let overtimeChartEl: HTMLCanvasElement;
  let sickChartEl: HTMLCanvasElement;
  let weeklyChart: Chart | null = null;
  let overtimeChart: Chart | null = null;
  let sickChart: Chart | null = null;

  interface UpcomingLeave {
    id: string;
    employeeName: string;
    startDate: string;
    endDate: string;
    days: number;
    type: string;
  }
  let upcomingLeaves: UpcomingLeave[] = $state([]);

  // Issue #84 (D-01, D-11): the Team block follows the salon context of #82 through ONE guarded
  // decision. `teamFilter` is a primitive (a salon id or null), so a navigation reload that sets an
  // equal context state re-runs nothing. `teamGeneration` lets every loader drop a result that
  // belongs to an older selection (also the 30 s poll).
  const teamFilter = $derived(teamSalonFilter($salonContext));
  const teamContextReady = $derived($salonContext.loaded);
  let teamGeneration = 0;
  let lastTeamFilterKey: string | null | undefined = undefined;
  let trendView = $state<TeamTrendView | null>(null);
  const teamLabel = $derived(teamViewLabel($salonContext));
  // D-16: the server rejected the selected salon (404); calm empty state, no further polling.
  let teamUnavailable = $state(false);

  // Issue #588 (P-10): the card "Salden" reads GET /dashboard/overtime-overview with the same salon
  // filter as the rest of the Team block. `teamSaldoFiltered` is the filter of the LOADED request,
  // not the live selection, so the note always matches the rows shown. A 403 hides the card.
  let teamSaldoRows = $state<TeamSaldoRow[]>([]);
  let teamSaldoLoading = $state(false);
  let teamSaldoFiltered = $state(false);
  let teamSaldoHidden = $state(false);

  interface OvertimeTrendResponse {
    snapshots: { month: string; teamCarryOverMinutes: number }[];
    currentTeamBalanceMinutes: number;
  }

  let timer: ReturnType<typeof setInterval>;
  // Issue #576: calm refresh — every 30 s, paused while the tab is hidden ($lib/dashboard/visible-poll).
  let stopPoll: (() => void) | undefined;

  // Phase 378 (#378): permission-based, not role-based — a Salonmanager (Salon-Scope role
  // assignment, #76) holds `team-overview:read:ZUGEWIESEN` but resolves to compat role EMPLOYEE
  // (#357), so the old check (compat role in the ADMIN/MANAGER set) never saw them. The
  // Überstunden-Trend saldo card inside this block already handles a holder without
  // `overtime:read` gracefully (see `loadTeamCharts()`'s `overtimeTrendAvailable` below, Phase 76b
  // D-15) — opening this gate to `team-overview:read` therefore satisfies AK-378-1's "keine
  // Saldo-Karten" via that EXISTING fail-safe, not a new one.
  // #844: the team block lives on Team › Heute im Salon only (view "team").
  const canSeeTeamBereich = $derived(
    view === "team" && hasPermission($authStore.user, "team-overview:read:ZUGEWIESEN"),
  );
  // Issue #588 (P-10): the saldo card needs the two permissions of its endpoint.
  const canSeeTeamSaldo = $derived(mayReadTeamSaldo($authStore.user));
  // Issue #591 (P-591-05): a chart month opens a report tab only for a caller who may read it, so
  // there is never a dead link. The target URL comes from `periodSearch` (team-charts.ts) only.
  const reportTabs = $derived(reportRights($authStore.user).periodTabs);

  /** The click handler of a month chart for this report tab, or null when the tab is not offered. */
  function monthOpener(tab: PeriodTab, view: TeamTrendView): ((index: number) => void) | null {
    if (!reportTabs.includes(tab)) return null;
    return (index) => {
      const key = view.months[index]?.month;
      const href = key ? reportMonthHref(key, tab) : null;
      if (href !== null) void goto(href);
    };
  }

  /**
   * The keyboard path of a month chart (P-591-06): a header link to the report of the chart's months
   * under the same rule as the click, and only while the chart itself is drawn (no skeleton, no
   * note in its place).
   */
  function reportLinkFor(tab: PeriodTab, shown: boolean): string | null {
    if (!shown || !reportTabs.includes(tab) || trendView === null) return null;
    return reportPeriodHref(
      trendView.months.map((m) => m.month),
      tab,
    );
  }
  const hoursReportHref = $derived(reportLinkFor(TEAM_CHART_REPORT_TAB.hours, !chartsLoading));
  const trendReportHref = $derived(
    reportLinkFor(
      TEAM_CHART_REPORT_TAB.saldoTrend,
      !chartsLoading && !trendView?.trendNote && overtimeTrendAvailable,
    ),
  );
  const sickReportHref = $derived(reportLinkFor(TEAM_CHART_REPORT_TAB.sickDays, !chartsLoading));

  // Phase 76.7 (D-15, UI-V19-04) — § 18 ArbZG-exempt: when the current
  // employee's `isTimeTrackingExempt` flag is true, fully HIDE the Timer-Card
  // (no Stempeluhr CTA) and render the Saldo-KPI value as "—" instead of a
  // misleading number. Default false so a fetch failure does not lock an
  // exempt user OUT — but it does mean a non-exempt user is never falsely
  // hidden from clocking in. The personal Time-Entries page mirrors this.
  let isExempt = $state(false);

  // ── Load ───────────────────────────────────────────────────────────────────
  onMount(async () => {
    await loadData();
    timer = setInterval(() => {
      currentTime = new Date();
    }, 1000);
    stopPoll = startVisiblePoll(pollDashboard);
  });

  onDestroy(() => {
    clearInterval(timer);
    stopPoll?.();
    weeklyChart?.destroy();
    overtimeChart?.destroy();
    sickChart?.destroy();
  });

  async function loadData() {
    loading = true;
    try {
      const today = format(new Date(), "yyyy-MM-dd");

      // Parallel laden — allSettled so a stats failure doesn't break clock state
      const [entriesResult, statsResult] = await Promise.allSettled([
        api.get<ClockDayEntry[]>(`/time-entries?from=${today}&to=${today}`),
        api.get<DashboardStats>("/dashboard"),
      ]);

      if (entriesResult.status === "fulfilled") {
        todayEntries = entriesResult.value;
      } else {
        console.error("Failed to load time entries:", entriesResult.reason);
        toasts.error("Zeiteinträge konnten nicht geladen werden");
      }

      if (statsResult.status === "fulfilled") {
        stats = statsResult.value;
      } else {
        console.error("Failed to load dashboard stats:", statsResult.reason);
      }

      // Load today's shift — only for SHIFT_BASED employees. Other schedule types
      // (FIXED_SCHEDULE / FLEXTIME / MONTHLY_HOURS) may still have shift records in
      // the DB from a previous schedule type (audit-proof: we don't delete shifts on
      // schedule-type change), but those records are not relevant to the current model
      // and should not surface in the employee's own dashboard.
      if (stats?.scheduleType === "SHIFT_BASED") {
        try {
          // Phase 267 (#267, D-04/D-05): this used to read the tenant-wide week endpoint, which
          // answers with EVERY employee's shifts ordered by date then startTime — so `[0]` picked
          // the earliest shift of the day in the salon rather than the caller's own. Live repro:
          // a user whose shift ran 14:00–18:00 was shown a colleague's 08:00–12:00 one.
          // `GET /shifts/my-week` has answered exactly this question since Phase 49; `ownShifts`
          // is narrowed to the caller server-side, so there is nothing left to filter here.
          // `days[].date` is a plain ISO day, hence `===` and not `startsWith`.
          // Note: the Mein-Tag loader reads the same endpoint for the week strip, so the
          // page requests it twice. Left as-is deliberately — merging the two is a restructuring
          // of the dashboard's data loading, not part of this fix.
          const myWeek = await api.get<{
            weekStart: string;
            days: Array<{
              date: string;
              ownShifts: Array<{
                startTime: string;
                endTime: string;
                label: string | null;
              }>;
            }>;
          }>(`/shifts/my-week?date=${today}`);
          const ownToday = myWeek.days.find((d) => d.date === today)?.ownShifts ?? [];
          todayShift = ownToday.length > 0 ? ownToday[0] : null;
        } catch (err) {
          console.error("Failed to load today's shift:", err);
          todayShift = null;
        }
      } else {
        todayShift = null;
      }

      // Issue #845: the figures of Ich › Mein Tag (not needed on Heute im Salon).
      if (view === "me") await loadMeinTag(today);

      try {
        openItems = await api.get<typeof openItems>("/dashboard/open-items");
      } catch {
        /* ignore */
      }

      // Phase 76.7 (D-15, UI-V19-04) — fetch § 18 ArbZG exemption flag.
      // Failure is fail-SAFE to false so a network blip never locks a
      // non-exempt user out of the Timer-Card; the backend skip paths
      // (Phase 76.7 Plan 01) are the source of truth for saldo/ArbZG.
      try {
        const employeeId = $authStore.user?.employeeId;
        if (employeeId) {
          const me = await api.get<{ isTimeTrackingExempt?: boolean }>(`/employees/${employeeId}`);
          isExempt = me.isTimeTrackingExempt === true;
        }
      } catch {
        isExempt = false;
      }

      // Karenztage-Hinweis (D-21) — self-scoped, fail-safe: any error renders nothing.
      try {
        const karenzRes = await api
          .get<KarenzOverrunResponse>("/leave/karenz-overrun")
          .catch(() => null);
        karenzNudge = summarizeKarenzOverrun(karenzRes);
      } catch {
        karenzNudge = KARENZ_NUDGE_EMPTY;
      }

      // Today's entry (row 2 / col-7) derives from todayEntries — see the clock-state block above (issue #118).

      // Activity feed (row 2 / col-5) — role-gated server-side
      try {
        const res = await api.get<{ items: ActivityItem[] }>("/activity?limit=5");
        activityItems = res.items ?? [];
      } catch {
        activityItems = [];
      }

      // Issue #84: the Team block (charts, upcoming leave, week grid) is loaded by the salon-context
      // effect above, not here; only the personal next leave belongs to this load.
      loadMyNextLeave();
    } finally {
      loading = false;
    }
  }

  // ── Issue #845: Ich › Mein Tag ─────────────────────────────────────────────────────────────
  // Every figure comes from an existing endpoint; `$lib/dashboard/mein-tag` only selects and words it.
  let ownOvertime = $state<OvertimeAnswer | null>(null);
  let myWeekDays = $state<MyWeekStripDay[]>([]);
  let nextWeekDays = $state<MyWeekStripDay[]>([]);
  let ownShiftByDate = $state<Map<string, string>>(new Map());
  let cumulativeByDate = $state<Map<string, number>>(new Map());
  let myWeekScheduleType = $state<string | null>(null);
  let nextShift = $state<NextShift | null>(null);
  let recentEntries = $state<ClockDayEntry[]>([]);
  let meinTagLoaded = $state(false);

  async function loadMeinTag(today: string) {
    const employeeId = $authStore.user?.employeeId;
    const base = new Date(today + "T12:00:00");
    const weekAhead = format(addDays(base, 7), "yyyy-MM-dd");
    const twoWeeksBack = format(addDays(base, -14), "yyyy-MM-dd");
    const yesterday = format(addDays(base, -1), "yyyy-MM-dd");
    // „Letzte Tage“ reach back two weeks: the day series of this and the previous month
    const months = [base, addDays(base, -14)].map((d) => ({
      y: d.getFullYear(),
      m: d.getMonth() + 1,
    }));
    const monthKeys = [...new Map(months.map((x) => [`${x.y}-${x.m}`, x])).values()];
    const canOvertime = employeeId && stats !== null && (stats as DashboardStats).overtime !== null;
    const [overtimeR, myWeekR, myWeekNextR, shiftsNowR, shiftsNextR, recentR, ...saldoR] =
      await Promise.allSettled([
        // D-845-03: the endpoint the Zeiten page shows — one figure, one source
        employeeId && stats !== null && (stats as DashboardStats).overtime !== null
          ? api.get<OvertimeAnswer>(`/overtime/${employeeId}`)
          : Promise.resolve(null),
        api.get<{ scheduleType: string | null; days: MyWeekStripDay[] }>(
          `/dashboard/my-week?date=${today}`,
        ),
        api.get<{ scheduleType: string | null; days: MyWeekStripDay[] }>(
          `/dashboard/my-week?date=${weekAhead}`,
        ),
        api.get<MyShiftWeek>(`/shifts/my-week?date=${today}`),
        api.get<MyShiftWeek>(`/shifts/my-week?date=${weekAhead}`),
        api.get<ClockDayEntry[]>(`/time-entries?from=${twoWeeksBack}&to=${yesterday}`),
        ...monthKeys.map((k) =>
          canOvertime
            ? api.get<{ days: { date: string; cumulativeSaldoMinutes: number }[] }>(
                `/overtime/month-saldo/${employeeId}?year=${k.y}&month=${k.m}`,
              )
            : Promise.resolve({ days: [] }),
        ),
      ]);
    ownOvertime = overtimeR.status === "fulfilled" ? overtimeR.value : null;
    if (myWeekR.status === "fulfilled") {
      myWeekDays = myWeekR.value.days ?? [];
      myWeekScheduleType = myWeekR.value.scheduleType;
    }
    nextWeekDays = myWeekNextR.status === "fulfilled" ? (myWeekNextR.value.days ?? []) : [];
    const weeks = [shiftsNowR, shiftsNextR]
      .filter((r): r is PromiseFulfilledResult<MyShiftWeek> => r.status === "fulfilled")
      .map((r) => r.value);
    nextShift = nextOwnShift(weeks, today, format(new Date(), "HH:mm"));
    ownShiftByDate = new Map(
      weeks.flatMap((w) =>
        w.days
          .filter((d) => d.ownShifts.length > 0)
          .map((d) => [d.date, `${d.ownShifts[0].startTime}–${d.ownShifts[0].endTime}`] as const),
      ),
    );
    recentEntries =
      recentR.status === "fulfilled"
        ? recentR.value.filter((e) => e.endTime !== null && !isTravelRow(e))
        : [];
    cumulativeByDate = new Map(
      saldoR.flatMap((r) =>
        r.status === "fulfilled"
          ? (r.value as { days: { date: string; cumulativeSaldoMinutes: number }[] }).days.map(
              (d) => [d.date, d.cumulativeSaldoMinutes] as const,
            )
          : [],
      ),
    );
    meinTagLoaded = true;
  }

  async function pollDashboard() {
    // only Team-Bereich holders need team-week data, once the salon context is known; a salon
    // the server rejected is not polled again until the selection changes
    if (canSeeTeamBereich && teamContextReady && !teamUnavailable) {
      await loadTeamWeek();
    }
    // Also refresh clock-in status
    try {
      const today = format(new Date(), "yyyy-MM-dd");
      todayEntries = await api.get<ClockDayEntry[]>(`/time-entries?from=${today}&to=${today}`);
    } catch (err) {
      console.error("Failed to poll clock status:", err);
    }
  }

  // Issue #84 (D-01): reloads the whole Team block for the current salon selection. Bumping the
  // generation makes every loader still in flight drop its result (also the 30 s poll).
  async function reloadTeam() {
    teamGeneration++;
    teamUnavailable = false;
    teamWeek = null;
    teamPage = 1;
    upcomingLeaves = [];
    teamSaldoRows = [];
    teamSaldoFiltered = false;
    teamSaldoHidden = false;
    teamSaldoLoading = canSeeTeamSaldo;
    const generation = teamGeneration;
    await Promise.allSettled([loadTeamWeek(), loadTeamCharts(), loadUpcomingLeaves()]);
    // Issue #588 (orchestrator amendment 2): the saldo overview computes a live saldo per person on
    // the server, so it starts only after the figures the team block is made of have resolved and is
    // not awaited here - the card shows its skeleton, the team week never waits for it.
    if (generation !== teamGeneration) return;
    if (teamUnavailable) {
      teamSaldoLoading = false;
      return;
    }
    void loadTeamSaldo();
  }

  // The first team load waits until the salon context is known (no unfiltered-then-filtered double
  // load); afterwards it runs only when the guarded filter value actually changes. `untrack`
  // because the loaders read `weekOffset` and other state synchronously.
  $effect(() => {
    if (!canSeeTeamBereich || !teamContextReady) return;
    const key = teamFilter;
    if (key === lastTeamFilterKey) return;
    lastTeamFilterKey = key;
    untrack(() => {
      void reloadTeam();
    });
  });

  async function loadTeamWeek() {
    const filter = teamFilter;
    const generation = teamGeneration;
    try {
      const refDate = new Date();
      refDate.setDate(refDate.getDate() + weekOffset * 7);
      const dateParam = refDate.toISOString().split("T")[0];
      const week = await api.get<TeamWeek>(
        withSalonId(`/dashboard/team-week?date=${dateParam}`, filter),
      );
      if (generation !== teamGeneration) return;
      teamWeek = week;
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) {
          teamUnavailable = true;
        }
        return;
      }
      console.error("Failed to load team week:", err);
    }
  }

  // Issue #588 (P-10, D-588-3): one read of the overview for the card, in the caller's saldo reach and
  // the team block's salon selection. Follows the loader idiom of loadTeamWeek (generation, calm 404);
  // a 403 hides the card silently. The 30 s poll never calls it.
  async function loadTeamSaldo() {
    const filter = teamFilter;
    const generation = teamGeneration;
    if (!canSeeTeamSaldo) {
      teamSaldoLoading = false;
      return;
    }
    teamSaldoLoading = true;
    try {
      const answer = await api.get<{ employees: TeamSaldoRow[] }>(
        withSalonId("/dashboard/overtime-overview", filter),
      );
      if (generation !== teamGeneration) return;
      teamSaldoRows = partitionOvertimeOverview(answer.employees ?? []).active;
      teamSaldoFiltered = filter !== null;
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) {
          teamUnavailable = true;
        }
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        if (generation === teamGeneration) teamSaldoHidden = true;
        return;
      }
      console.error("Failed to load team saldo:", err);
      if (generation === teamGeneration) teamSaldoRows = [];
    } finally {
      if (generation === teamGeneration) teamSaldoLoading = false;
    }
  }

  function prevWeek() {
    weekOffset--;
    loadTeamWeek();
  }
  function nextWeek() {
    weekOffset++;
    loadTeamWeek();
  }
  function currentWeek() {
    weekOffset = 0;
    loadTeamWeek();
  }

  // Issue #84 (D-07): the three team charts come from ONE server call; the browser sums nothing.
  async function loadTeamCharts() {
    const filter = teamFilter;
    const generation = teamGeneration;
    chartsLoading = true;
    let view: TeamTrendView | null = null;
    let labels: string[] = [];
    let overtimeTrend: OvertimeTrendResponse = {
      snapshots: [],
      currentTeamBalanceMinutes: 0,
    };

    try {
      const resp = await api.get<TeamTrendResponse>(
        withSalonId("/dashboard/team-trend?months=6", filter),
      );
      if (generation !== teamGeneration) return;
      view = teamTrendView(resp);
      trendView = view;
      const months = view.months;

      // D-05: the saldo is a contract figure of a person and cannot be attributed to a salon, so
      // under a filter the trend card shows a note instead and the endpoint is not requested.
      if (filter !== null) {
        overtimeTrendAvailable = false;
        overtimeChart?.destroy();
        overtimeChart = null;
      }
      if (filter === null) {
        // Load team overtime trend from the dedicated endpoint
        try {
          overtimeTrend = await api.get<OvertimeTrendResponse>("/dashboard/overtime-trend");
          overtimeTrendAvailable = true;
        } catch (err) {
          overtimeTrendAvailable = false;
          // Phase 76b (Issue #76), D-15: the endpoint now requires overtime:read, and a 403 for a
          // caller without it is expected (Mitarbeiter, Salonmanager template, …) — not an error to
          // report. Every other failure (network, 500, …) still logs as before.
          if (!(err instanceof ApiError && err.status === 403)) {
            console.error("Failed to load overtime trend:", err);
          }
        }
      }
      if (generation !== teamGeneration) return;

      labels = months.map((m) => m.label);
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) {
          teamUnavailable = true;
        }
      } else {
        console.error("Failed to load chart data:", err);
      }
    } finally {
      // CRITICAL: flip loading flag BEFORE Chart.js instantiation so canvases render into the DOM.
      // A superseded load leaves the flag to the newer one.
      if (generation === teamGeneration) chartsLoading = false;
    }
    if (generation !== teamGeneration) return;
    if (view === null) {
      trendView = null;
      return;
    }
    const drawn: TeamTrendView = view;

    // ── Phase 2: wait for Svelte to render the {:else} branch (canvases) ──────
    // Without this tick(), chartsLoading has been set to false but the DOM has not
    // yet been updated — bind:this refs (weeklyChartEl etc.) are still undefined.
    await tick();
    if (generation !== teamGeneration) return;

    // ── Phase 3: instantiate charts ────────────────────────────────────────────

    // One theme read for the three builds: colours come from the tokens only (Issue #591).
    const theme = getChartTheme();

    // Arbeitsstunden: Soll and Ist as grouped columns, drawn by the one chart builder.
    if (weeklyChartEl) {
      weeklyChart?.destroy();
      weeklyChart = new Chart(
        weeklyChartEl,
        teamHoursChartConfig(drawn, theme, monthOpener(TEAM_CHART_REPORT_TAB.hours, drawn)),
      );
    }

    // Overtime trend line chart — absolute team saldo from SaldoSnapshots + live OvertimeAccount
    if (overtimeChartEl) {
      // Build a lookup of snapshot month → teamCarryOverMinutes
      const snapshotByMonth = new Map<string, number>();
      for (const s of overtimeTrend.snapshots) {
        // API returns "YYYY-MM-DD" (day is always 01); key by "YYYY-MM"
        snapshotByMonth.set(s.month.slice(0, 7), s.teamCarryOverMinutes);
      }

      // Align to the same 6-month window as `labels` (months[].month = "YYYY-MM")
      // For each month:
      //   - If it's the LAST month (current open month) → use currentTeamBalanceMinutes / 60
      //   - Else if a snapshot exists for that month → use teamCarryOverMinutes / 60
      //   - Else → fill-forward from the previous resolved value (or 0 for the leading edge)
      let lastKnown = 0;
      const absoluteHours: number[] = [];
      for (let i = 0; i < drawn.months.length; i++) {
        const isCurrent = i === drawn.months.length - 1;
        if (isCurrent) {
          lastKnown = overtimeTrend.currentTeamBalanceMinutes / 60;
        } else {
          const snap = snapshotByMonth.get(drawn.months[i].month);
          if (snap !== undefined) lastKnown = snap / 60;
          // else: fill-forward — lastKnown stays unchanged
        }
        absoluteHours.push(+lastKnown.toFixed(1));
      }

      overtimeChart?.destroy();
      overtimeChart = new Chart(
        overtimeChartEl,
        teamSaldoTrendChartConfig(
          labels,
          absoluteHours,
          theme,
          monthOpener(TEAM_CHART_REPORT_TAB.saldoTrend, drawn),
        ),
      );
    }

    // Krankheitstage: columns in calendar days, drawn by the one chart builder (Issue #591).
    if (sickChartEl) {
      sickChart?.destroy();
      sickChart = new Chart(
        sickChartEl,
        teamSickDaysChartConfig(drawn, theme, monthOpener(TEAM_CHART_REPORT_TAB.sickDays, drawn)),
      );
    }
  }

  // Own next leave (personal, for all users) — unrelated to the salon filter.
  async function loadMyNextLeave() {
    // Load own next leave (for all users)
    try {
      const myEmployeeId = $authStore.user?.employeeId;
      const myLeaves = await api.get<
        { startDate: string; endDate: string; days: number; leaveType: { name: string } }[]
      >(
        `/leave/requests?status=APPROVED&upcoming=true${myEmployeeId ? `&employeeId=${myEmployeeId}` : ""}`,
      );
      const next = (myLeaves ?? []).find((l) => new Date(l.startDate) > new Date());
      myNextLeave = next
        ? {
            startDate: next.startDate.split("T")[0],
            endDate: next.endDate.split("T")[0],
            days: Number(next.days),
            type: next.leaveType?.name ?? "Urlaub",
          }
        : null;
    } catch {
      /* ignore */
    }
  }

  async function loadUpcomingLeaves() {
    const filter = teamFilter;
    const generation = teamGeneration;
    if (!canSeeTeamBereich) return;
    try {
      const resp = await api.get<TeamUpcomingLeaveResponse>(
        withSalonId("/dashboard/team-upcoming-leave", filter),
      );
      if (generation !== teamGeneration) return;
      upcomingLeaves = upcomingFromResponse(resp.items);
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) {
          teamUnavailable = true;
        }
        return;
      }
      console.error("Failed to load upcoming leaves:", err);
      if (generation === teamGeneration) upcomingLeaves = [];
    }
  }

  // ── Clock In/Out ───────────────────────────────────────────────────────────
  // Phase 115 (issue #118): the single POST /clock-in call site. Used by the primary
  // "Einstempeln" action on a not-started day AND by the confirmed "Erneut einstempeln"
  // action on a finished day. The server decides which of the two it is — START or
  // REOPEN (services/clock/state-machine.ts:18-22) — and we simply adopt the entry it
  // returns, which is what makes the timer correct in both cases.
  // Issue #70: `action` decides whether a salon may travel with the request — only the idle select
  // ("start", the default) and the finished-day other-salon action send one. The REOPEN of a finished
  // day goes through the default too: its view is `fixed`, never `select`, so no salon is attached
  // (#87 D-13).
  async function performClockIn(action: ClockInAction = "start"): Promise<void> {
    const body = clockInBody(clockSalonViewState, clockSalonId, action);
    const res = await api.post<ClockInResponse>("/time-entries/clock-in", body);
    // Phase 76.2 D-03 unified shape — reads from res.resolution.entry
    // (the legacy `res.entry` shape is gone, see Plan 2 SUMMARY).
    // CONFLICT branches reach us as thrown ApiError (HTTP 409) — defensive
    // check guards against any unexpected resolver shape drift.
    if (res.resolution.kind !== "CLOCKED_IN") {
      throw new Error("Unerwartete Antwort beim Einstempeln");
    }
    const entry = res.resolution.entry;
    // Optimistic: adopt the SERVER's row so `day`, `activeEntryId` and `clockStart`
    // all follow from it before loadData() returns. upsertDayEntry replaces by id,
    // so a REOPEN updates the same row instead of appending a phantom second one.
    // A new second-salon entry is adopted with the display name of the salon it was started in; the
    // reload that follows replaces it with the list row (which carries `salonName` itself).
    const startedIn = body.salonId ? otherSalonName(clockSalonViewState, body.salonId) : undefined;
    // #843 (D-843-19): the salon name is read BEFORE the entry is adopted - adopting it changes the
    // day state, and with it the clock-salon view this reads from. Order: the response's own name,
    // the second salon this request started in, the salon picked on the idle select view, the salon
    // a re-open continues (the fixed one); none known = no salon part in the text.
    const pickedSalon =
      clockSalonViewState.kind === "select" && body.salonId
        ? clockSalonViewState.salons.find((s) => s.id === body.salonId)?.name
        : undefined;
    const bookedSalon =
      clockSalonViewState.kind === "fixed" && !body.salonId
        ? clockSalonViewState.salon.name
        : undefined;
    const salonName = entry.salonName ?? startedIn ?? pickedSalon ?? bookedSalon;
    todayEntries = upsertDayEntry(
      todayEntries,
      startedIn ? { ...entry, salonName: startedIn } : entry,
    );
    // A REOPEN arrives with breakMinutes already recomputed from ALL Break rows
    // (resolver.ts:130-136). Adopting it keeps the local *display* in sync with the
    // value the server recomputed — the client never sends it back (Phase 129).
    breakMinutes = entry.breakMinutes ?? 0;
    // #843 (D-843-08, D-843-19): the server answered, say so.
    toasts.success(clockedInMessage(clockTime(entry.startTime), salonName));
  }

  async function handleClock() {
    if (clockLoading) return; // D-02a: idempotency guard — touch events can fire before disabled={clockLoading} applies
    // Phase 115 (issue #118): a FINISHED day has no primary clock action. Reopening it is
    // a separate, confirmed path (openReopenDialog / confirmReopen) — never this one.
    // This is a usability guard, NOT an authorisation control: a crafted POST /clock-in
    // still reaches REOPEN by design (the Umfangsgrenze forbids a server-side gate, and
    // REOPEN is a deliberate NFC/WIFI fix). Do not mistake it for security.
    if (day.kind === "finished") return;
    clockLoading = true;
    try {
      if (!clockedIn) {
        await performClockIn();
      } else if (activeEntryId) {
        // If a break is open, close it first so the time gets recorded before
        // we ask the server to clock out (otherwise the time would silently
        // be lost when activeEntryId is cleared).
        if (breakStartedAt) {
          try {
            await endOpenBreak();
          } catch (err) {
            toasts.error(err instanceof Error ? err.message : "Pause konnte nicht beendet werden");
            return; // abort clock-out — user can retry
          }
        }
        // Phase 76.2 D-03 — explicit generic; CONFLICT branches (and, since Phase 307 Plan 02,
        // DEBOUNCE_NOOP too) surface as thrown ApiError (HTTP 409), caught below.
        // Phase 129: no breakMinutes in the body — the server derives it from Break rows only.
        // Phase 307 Plan 02 (D-04, AK-1/AK-4): the response IS now read, through the pure
        // interpretClockOut() translator — a DEBOUNCE_NOOP must never again reach the surface
        // as a silent success (it no longer can via HTTP either, since the route now answers
        // 409, but interpretClockOut() stays the defensive second line: see its own docblock).
        const clockOutResponse = await api.post<ClockOutResponse>(
          `/time-entries/${activeEntryId}/clock-out`,
          {},
        );
        const clockOutResult = interpretClockOut(clockOutResponse);
        if (clockOutResult.kind === "not-closed") {
          toasts.error(clockOutResult.message);
        } else {
          // #843 (D-843-19): acknowledged only after the server closed the entry.
          toasts.success(clockedOutMessage(clockTime(clockOutResult.entry.endTime)));
          // Issue #80 (D-09a): a clock-out that completes a cross-salon day without enough break
          // is saved either way; the API's warning is shown as a notice.
          const breakFindingNotice = breakFindingSaveNotice(clockOutResponse.warnings);
          if (breakFindingNotice) toasts.warning(breakFindingNotice);
          // Phase 115 (issue #118): clockedIn / activeEntryId / clockStart are $derived now.
          // They resolve to the closed state on their own once loadData() returns the closed
          // row, and the open-break $effect then clears breakStartedAt.
          breakMinutes = 0;
        }
        // Independent of the outcome above: this mirrors the break `endOpenBreak()` already
        // closed server-side a few lines up, not whether the clock-out itself succeeded.
        clearStoredOpenBreak();
      }
      await loadData();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Fehler beim Stempeln");
      // D-02a: if the request succeeded but the response was lost, re-sync so clockedIn reflects
      // the server and the user cannot fire a spurious second clock-in.
      try {
        await loadData();
      } catch {
        /* ignore reload error */
      }
    } finally {
      clockLoading = false;
    }
  }

  // ── Shift reminder arrival (Issue #609, D-09/D-14, AC-4) ───────────────────
  // A tap on a start/end reminder (push or bell) navigates to /dashboard?clock=1. That parameter
  // only OPENS a confirmation: nothing is sent before the person confirms, and the stamp is the
  // unchanged handleClock() above. `afterNavigate` counts every arrival, including a goto() on an
  // already mounted dashboard (the service worker's navigate message, the bell), and it only
  // fires once the router is ready - which is what makes the replaceState below safe.
  let clockArrival = $state(0);
  let clockHandledArrival = $state(-1);
  let clockReminderOpen = $state(false);
  let clockReminderPending = $state<"confirm-in" | "confirm-out" | null>(null);
  afterNavigate(() => {
    clockArrival += 1;
  });

  // `loading` here means "the page cannot decide yet": data, salon choice or router not ready.
  let clockReminderWaiting = $derived(loading || !clockSalonLoaded || clockArrival === 0);
  let clockReminderTexts = $derived(
    clockReminderPending ? clockReminderDialog(clockReminderPending, currentTime) : null,
  );

  function bringClockCardIntoView() {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .querySelector(".timer-card")
      ?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    document
      .querySelector<HTMLSelectElement>(".clock-salon-select")
      ?.focus({ preventScroll: true });
  }

  async function settleClockReminder(action: ClockReminderAction, url: URL) {
    if (action === "confirm-in" || action === "confirm-out") {
      clockReminderPending = action;
      clockReminderOpen = true;
    } else if (action === "focus-card") {
      await tick();
      bringClockCardIntoView();
    }
    // Deferred past the current update: never a synchronous router call from the effect itself.
    await tick();
    replaceState(stripClockParam(url), $page.state);
  }

  $effect(() => {
    const param = $page.url.searchParams.get("clock");
    const arrival = clockArrival;
    const action = clockReminderAction({
      param,
      loading: clockReminderWaiting,
      isExempt,
      dayKind: day.kind,
      clockInBlocked: clockInBlocked(clockSalonViewState, clockSalonId),
    });
    // Without the parameter this is not a reminder arrival; "wait" re-runs when the page is ready.
    if (param !== "1" || action === "wait") return;
    untrack(() => {
      if (arrival === clockHandledArrival) return;
      clockHandledArrival = arrival;
      void settleClockReminder(action, $page.url);
    });
  });

  // The confirmation re-derives the action from the LIVE state: a state change between opening
  // and confirming (clocked out elsewhere, day finished) never stamps the opposite (P-609-21).
  async function confirmClockReminder() {
    const live = clockReminderAction({
      param: "1",
      loading: false,
      isExempt,
      dayKind: day.kind,
      clockInBlocked: clockInBlocked(clockSalonViewState, clockSalonId),
    });
    if (live !== clockReminderPending) {
      toasts.info("Dein Stempelstatus hat sich inzwischen geändert.");
      return;
    }
    await handleClock();
  }

  // ── Deliberate re-clock-in on a finished day (Phase 115, issue #118) ──────
  // The server maps this to REOPEN (state-machine.ts:18-22) — the gap since the recorded
  // clock-out becomes a Break row. That consequence is named in the dialog before anything
  // is sent; it is never reachable from the card's primary action.
  let reopenDialogOpen = $state(false);

  function openReopenDialog() {
    if (!canReopenFinishedDay(day) || clockLoading) return;
    reopenDialogOpen = true;
  }

  async function confirmReopen(): Promise<void> {
    if (clockLoading) return;
    // The 30 s poll can change the day underneath an open dialog. Re-check before sending.
    if (!canReopenFinishedDay(day)) {
      reopenDialogOpen = false;
      return;
    }
    clockLoading = true;
    try {
      await performClockIn();
      await loadData();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Fehler beim Stempeln");
      try {
        await loadData();
      } catch {
        /* ignore reload error */
      }
    } finally {
      clockLoading = false;
    }
  }

  // ── Second salon on a finished day (Issue #70, D-02/D-11) ─────────────────
  // „In anderem Salon einstempeln“ starts a NEW entry in the chosen salon and leaves the finished
  // one untouched; no Rückfrage, because nothing is reopened. The server refuses an instant inside
  // an existing entry (409 ENTRY_OVERLAP) and a locked month (409); its German text is toasted.
  async function handleOtherSalonClockIn(): Promise<void> {
    if (clockLoading || !canReopenFinishedDay(day)) return;
    if (otherSalonBlocked(clockSalonViewState, clockSalonId)) return;
    clockLoading = true;
    try {
      await performClockIn("otherSalon");
      await loadData();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Fehler beim Stempeln");
      try {
        await loadData();
      } catch {
        /* ignore reload error */
      }
    } finally {
      clockLoading = false;
    }
  }

  // ── Break toggle (Pause starten / Pause beenden) ─────────────────────────
  // Toggle semantics: starting just records a local timestamp; ending POSTs
  // the closed segment to the server. Disabled while not clocked in.
  async function handleBreakToggle() {
    if (!clockedIn || !activeEntryId || clockLoading) return;
    breakLoading = true;
    try {
      if (breakStartedAt) {
        // #843 (D-843-19): said after the break POST succeeded (endOpenBreak throws otherwise).
        const endedAt = await endOpenBreak();
        if (endedAt) toasts.success(breakEnded(clockTime(endedAt)));
      } else {
        const startedAt = startOpenBreak();
        // #843 (D-843-19): local acknowledgement, the server-side pause is #596.
        toasts.success(breakStarted(clockTime(startedAt)));
      }
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Pause fehlgeschlagen");
    } finally {
      breakLoading = false;
    }
  }

  function startOpenBreak(): Date {
    const startedAt = new Date();
    breakStartedAt = startedAt;
    persistOpenBreak();
    return startedAt;
  }

  /** Returns the instant the break ended at, `null` when there was nothing to end. */
  async function endOpenBreak(): Promise<Date | null> {
    if (!breakStartedAt || !activeEntryId) return null;
    const startedAt = breakStartedAt;
    const endedAt = new Date();
    // Guard against zero-length breaks (double-click): ensure the Break record
    // is at least 60s long by anchoring on endedAt and shifting the START into
    // the PAST when needed. We must never shift the END into the future — the
    // server rejects future-end timestamps ("Pausenende darf nicht in der
    // Zukunft liegen") and the local "now" is already at or after the server's
    // "now" once the request round-trips.
    //
    // The shifted start is also clamped to clockStart so the break never lies
    // before the entry's startTime (server validates that too).
    let effectiveStart = startedAt;
    if (endedAt.getTime() - startedAt.getTime() < 60_000) {
      effectiveStart = new Date(endedAt.getTime() - 60_000);
      if (clockStart && effectiveStart < clockStart) {
        effectiveStart = clockStart;
      }
    }
    const res = await api.post<{ breakMinutes: number }>(`/time-entries/${activeEntryId}/breaks`, {
      startTime: effectiveStart.toISOString(),
      endTime: endedAt.toISOString(),
    });
    breakMinutes = res.breakMinutes;
    breakStartedAt = null;
    clearStoredOpenBreak();
    return endedAt;
  }

  function persistOpenBreak() {
    if (typeof window === "undefined") return;
    if (!activeEntryId || !breakStartedAt) return;
    try {
      localStorage.setItem(
        OPEN_BREAK_STORAGE_KEY,
        JSON.stringify({ entryId: activeEntryId, startedAt: breakStartedAt.toISOString() }),
      );
    } catch {
      /* localStorage may be unavailable; ignore */
    }
  }

  function clearStoredOpenBreak() {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(OPEN_BREAK_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function restoreOpenBreak() {
    if (typeof window === "undefined") return;
    if (!activeEntryId) return;
    try {
      const raw = localStorage.getItem(OPEN_BREAK_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { entryId: string; startedAt: string };
      if (parsed.entryId !== activeEntryId) {
        // Stale entry from a previous clock-in cycle.
        clearStoredOpenBreak();
        return;
      }
      const startedAt = new Date(parsed.startedAt);
      if (Number.isNaN(startedAt.getTime())) {
        clearStoredOpenBreak();
        return;
      }
      breakStartedAt = startedAt;
    } catch {
      clearStoredOpenBreak();
    }
  }

  // Phase 115 (issue #118): activeEntryId is derived now, so the open-break restore that
  // used to sit inside loadData()/pollDashboard() reacts to the id instead. `lastSeenEntryId`
  // is a PLAIN let on purpose — making it $state would make this effect re-trigger itself.
  let lastSeenEntryId: string | null = null;
  $effect(() => {
    const id = activeEntryId;
    if (id === lastSeenEntryId) return;
    lastSeenEntryId = id;
    if (id) {
      restoreOpenBreak();
    } else {
      breakStartedAt = null;
      clearStoredOpenBreak();
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtHours(hours: number): string {
    const totalMin = Math.round(Math.abs(hours) * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, "0")}h`;
  }

  function greeting(): string {
    const h = new Date().getHours();
    if (h < 12) return "Guten Morgen";
    if (h < 18) return "Guten Tag";
    return "Guten Abend";
  }

  function dayLabel(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return format(d, "EEE", { locale: de });
  }

  // Issue #587 (D-587-4, P-07): a cell links to the person-day on Team-Zeiten only for a caller who
  // may open that page; every other caller sees the cell exactly as before, never a dead link.
  let canOpenTeamDay = $derived(mayOpenTeamPage("/team/time-entries", $authStore.user));

  /** The status wording of a cell for its accessible name; same vocabulary as the attendance list. */
  function teamCellStatusText(day: TeamDay): string {
    return day.status === "none" ? "Frei" : attendanceStatusText(day);
  }

  function dayNum(dateStr: string): string {
    return dateStr.slice(8, 10);
  }

  function isToday(dateStr: string): boolean {
    return dateStr === format(new Date(), "yyyy-MM-dd");
  }

  let userName = $derived($authStore.user?.firstName ?? $authStore.user?.email.split("@")[0] ?? "");
  let capitalizedName = $derived(userName.charAt(0).toUpperCase() + userName.slice(1));

  // ── Heutiger Eintrag derived ──────────────────────────────────────────────
  // Compute Start/End/Pause/Net from todayEntry.
  // - If clocked in (no endTime): "Ende" shows "—", break minutes are 0 (breaks only counted after clock-out)
  // - If clocked out: use entry.endTime; breakMinutes from entry
  // Issue #70 (D-07): with two or more entries the card describes the DAY — earliest start, latest end
  // ("—" while one runs), Σ breaks, Σ working minutes (server value of closed rows + the running row's
  // live value). A one-entry day keeps the exact per-entry values it always had.
  let multiRowDay = $derived(todayEntries.length >= 2);
  let totals = $derived(dayTotals(todayEntries, currentTime));
  function hhmmOf(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  let entryStartHHMM = $derived.by(() => {
    if (multiRowDay) return totals.startTime ? hhmmOf(totals.startTime) : "—";
    if (!todayEntry) return "—";
    return hhmmOf(todayEntry.startTime);
  });
  let entryEndHHMM = $derived.by(() => {
    if (multiRowDay) return totals.endTime ? hhmmOf(totals.endTime) : "—";
    if (!todayEntry || !todayEntry.endTime) return "—";
    return hhmmOf(todayEntry.endTime);
  });
  // Live-updating worked minutes: open entry => up to currentTime, closed => endTime - startTime
  let entryWorkedMin = $derived.by(() => {
    if (multiRowDay) return totals.workingMinutes;
    if (!todayEntry) return 0;
    return entryWorkedMinutes(todayEntry, currentTime);
  });
  let entryBreakMin = $derived(multiRowDay ? totals.breakMinutes : (todayEntry?.breakMinutes ?? 0));

  // Phase 115 (issue #118) — the hero card's three-state view model.
  let primaryLabel = $derived(primaryClockLabel(day)); // null on a finished day
  let reopenGapLabel = $derived(reopenGapStartLabel(day)); // "17:46" on a finished day
  // Phase 115 (issue #118), acceptance criterion #4: the Rückfrage must NAME the consequence.
  // These are the three things services/clock/resolver.ts:124-137 actually does on REOPEN —
  // a Break from the old endTime to now, endTime = null, and breakMinutes recomputed from ALL
  // Break rows. Stated as fact, not as a warning.
  let reopenDialogText = $derived(
    `Der Zeitraum ${reopenGapLabel ?? ""}–jetzt wird als Pause erfasst. ` +
      `Der heutige Eintrag wird dadurch wieder geöffnet, seine Netto-Arbeitszeit sinkt und der Pausenwert wird neu berechnet.`,
  );

  // ── Issue #845: the stage view model (D-02, D-03, D-845-01/02/08) ─────────────────────────────
  let todayIso = $derived(format(currentTime, "yyyy-MM-dd"));
  let todayMyWeek = $derived(myWeekDays.find((d) => d.date === todayIso) ?? null);
  let goalMin = $derived(
    dayGoalMinutes(
      myWeekScheduleType ?? (stats as DashboardStats | null)?.scheduleType,
      todayMyWeek,
    ),
  );
  let pauseRunningMin = $derived(
    clockedIn && breakStartedAt
      ? Math.max(0, (currentTime.getTime() - (breakStartedAt as Date).getTime()) / 60_000)
      : 0,
  );
  // While a break runs the working time stands still: the running break is taken off the live value.
  let stageWorkedMin = $derived(Math.max(0, entryWorkedMin - pauseRunningMin));
  let stageState = $derived<"ruhig" | "arbeitet" | "pause" | "fertig">(
    day.kind === "running"
      ? breakStartedAt
        ? "pause"
        : "arbeitet"
      : day.kind === "finished"
        ? "fertig"
        : "ruhig",
  );

  function fmtClock(min: number): string {
    const total = Math.max(0, Math.floor(min));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  let stageTitle = $derived(
    stageState === "arbeitet"
      ? "Du arbeitest"
      : stageState === "pause"
        ? "Pause"
        : stageState === "fertig"
          ? `Ausgestempelt um ${entryEndHHMM}`
          : "Noch nicht eingestempelt",
  );
  // The place of the running / finished day belongs to the status line (owner acceptance, item 2).
  let stageSalonName = $derived(
    clockSalonViewState.kind === "fixed" && day.kind !== "idle"
      ? clockSalonViewState.salon.name
      : null,
  );
  // Today's own shift: SHIFT_BASED reads it from the roster read above, others from the week read.
  let todayShiftText = $derived(
    todayShift !== null
      ? `${todayShift.startTime}–${todayShift.endTime}`
      : (ownShiftByDate.get(todayIso) ?? null),
  );

  let stageMeta = $derived.by((): { label: string; value: string }[] => {
    if (stageState === "arbeitet") {
      const out = [{ label: "seit", value: clockStart ? format(clockStart, "HH:mm") : "—" }];
      // D-845-02: the break taken so far, never a § 4 budget computed here
      out.push({ label: "Pause", value: fmtClock(entryBreakMin) });
      if (goalMin !== null)
        out.push({
          label: "bis Soll noch",
          value: fmtClock(Math.max(0, goalMin - stageWorkedMin)),
        });
      return out;
    }
    if (stageState === "pause") {
      return [
        { label: "seit", value: breakStartedAt ? format(breakStartedAt, "HH:mm") : "—" },
        { label: "läuft", value: `${Math.floor(pauseRunningMin)} min` },
        { label: "Arbeitszeit", value: "steht" },
      ];
    }
    if (stageState === "fertig") {
      return [
        { label: "Zeiten", value: `${entryStartHHMM}–${entryEndHHMM}` },
        { label: "Pause", value: fmtClock(entryBreakMin) },
        { label: "Netto", value: `${fmtClock(entryWorkedMin)} h` },
      ];
    }
    const out: { label: string; value: string }[] = [];
    if (todayShiftText) out.push({ label: "Schicht", value: todayShiftText });
    if (goalMin !== null) out.push({ label: "Soll", value: fmtClock(goalMin) });
    if (out.length === 0) out.push({ label: "Heute", value: "kein Arbeitstag" });
    return out;
  });

  // The day bar 08:00–20:00 (prototype): the planned shift as a faint band, every entry of today
  // as a segment, the running break on top.
  const TL_START_MIN = 8 * 60;
  const TL_SPAN_MIN = 12 * 60;
  function tlPos(minutesOfDay: number): number {
    return Math.min(100, Math.max(0, ((minutesOfDay - TL_START_MIN) / TL_SPAN_MIN) * 100));
  }
  let plannedBand = $derived.by(() => {
    const m = /^(\d{2}):(\d{2})–(\d{2}):(\d{2})$/.exec(todayShiftText ?? "");
    if (!m) return null;
    const l = tlPos(Number(m[1]) * 60 + Number(m[2]));
    const r = tlPos(Number(m[3]) * 60 + Number(m[4]));
    return r > l ? { left: l, width: r - l } : null;
  });
  let timelineSegments = $derived.by(() => {
    const pos = (d: Date) => tlPos(d.getHours() * 60 + d.getMinutes());
    const segs: { kind: "work" | "break"; left: number; width: number }[] = [];
    for (const e of todayEntries) {
      const l = pos(new Date(e.startTime));
      const r = pos(e.endTime ? new Date(e.endTime) : currentTime);
      segs.push({ kind: "work", left: l, width: Math.max(0.6, r - l) });
    }
    if (clockedIn && breakStartedAt) {
      const l = pos(breakStartedAt as Date);
      segs.push({ kind: "break", left: l, width: Math.max(0.6, pos(currentTime) - l) });
    }
    return segs;
  });

  // „Montag, 9. November · Clokr Demo Nord · Soll heute 8:00 h“ (owner acceptance, item 1)
  let homeSalonName = $derived(
    $salonContext.salons.find((x) => x.id === $salonContext.homeSalonId)?.name ?? null,
  );
  let meinTagSub = $derived(
    [
      format(currentTime, "EEEE, d. MMMM", { locale: de }),
      homeSalonName,
      goalMin !== null ? `Soll heute ${fmtClock(goalMin)} h` : null,
    ]
      .filter((x): x is string => !!x)
      .join(" · "),
  );

  // ── Issue #845: the Kennzahlenleiste (D-01, D-04, D-845-03/07) ───────────────────────────────
  /** „3 beantragt · 21.12.–23.12.“ — undecided days (server figure) and the next approved leave. */
  function vacationLine(v: { total: number; pending?: number }): string {
    const pending = v.pending ?? 0;
    const next = myNextLeave
      ? `${format(new Date(myNextLeave.startDate), "d.M.")}–${format(new Date(myNextLeave.endDate), "d.M.")}`
      : null;
    return (
      [pending > 0 ? `${pending} beantragt` : null, next].filter(Boolean).join(" · ") ||
      `von ${v.total}`
    );
  }

  let kpiItems = $derived.by((): KpiItem[] => {
    const items: KpiItem[] = [];
    // Phase 76b (Issue #76), CR-01: `stats.overtime === null` = no overtime:read:EIGENE — no cell at all.
    if (stats && stats.overtime === null) {
      // intentionally empty: no saldo cell for this caller
    } else if (isExempt) {
      items.push({
        label: "Stundenkonto",
        value: "—",
        explanation: "§ 18 ArbZG",
        testId: "kpi-saldo",
      });
    } else if (ownOvertime) {
      const f = saldoFigure(ownOvertime);
      items.push({
        label: "Stundenkonto",
        badge: f.forecast ? "Prognose" : undefined,
        value: f.value,
        unit: "h",
        explanation: saldoMonthsLine(ownOvertime, todayIso) ?? undefined,
        derivationHref: "/ich/zeiten",
        testId: "kpi-saldo",
      });
    } else {
      items.push({
        label: "Stundenkonto",
        value: "—",
        explanation: "nicht verfügbar",
        testId: "kpi-saldo",
      });
    }
    if (stats?.vacation) {
      items.push({
        label: "Resturlaub",
        value: String(stats.vacation.remaining),
        unit: stats.vacation.remaining === 1 ? "Tag" : "Tage",
        explanation: vacationLine(stats.vacation),
        testId: "kpi-vacation",
      });
    }
    const planned = nextPlannedDay(
      [...myWeekDays, ...nextWeekDays],
      nextShift,
      myWeekScheduleType ?? (stats as DashboardStats | null)?.scheduleType,
      todayIso,
    );
    items.push({
      label: nextShift ? "Nächste Schicht" : "Nächster Arbeitstag",
      value: planned
        ? format(new Date(planned.date + "T12:00:00"), "EEEEEE d.M.", { locale: de })
        : "—",
      explanation: planned ? planned.text : "Kein Arbeitstag geplant",
      testId: "kpi-next-shift",
    });
    if (stats?.week && stats.week.targetHours > 0) {
      const n = plannedDaysCount(
        myWeekDays,
        myWeekScheduleType ?? (stats as DashboardStats | null)?.scheduleType,
        new Set(ownShiftByDate.keys()),
      );
      items.push({
        label: "Diese Woche",
        value: fmtClock(stats.week.workedHours * 60),
        unit: `/ ${fmtClock(stats.week.targetHours * 60)}`,
        explanation: n === 1 ? "1 Tag geplant" : `${n} Tage geplant`,
        testId: "kpi-week",
      });
    }
    return items;
  });

  // ── Issue #845: „Für dich“ (D-06, D-845-06) ───────────────────────────────────────────────────
  interface ForYouItem {
    key: string;
    title: string;
    subtitle?: string;
    chip: string;
    tone: "ok" | "warn" | "bad" | "info" | "brand" | "neutral";
    href: string;
    action: string;
    testId?: string;
    hint?: string;
  }
  function dayShort(iso: string): string {
    return format(new Date(iso + "T12:00:00"), "EEEEEE d.M.", { locale: de });
  }
  let forYou = $derived.by((): ForYouItem[] => {
    const out: ForYouItem[] = [];
    // one row per break finding of the server's day check, each with its own day link
    for (const d of [...breakDaySet].sort()) {
      out.push({
        key: `break-${d}`,
        title: `${dayShort(d)} ohne Pause`,
        subtitle: "Pause nachtragen oder Tag bestätigen.",
        chip: "Prüfen",
        tone: "warn",
        href: breakNudgeHref(summarizeUnconfirmedBreakDays([d])),
        action: "Öffnen",
        testId: out.length === 0 ? "dashboard-break-nudge" : undefined,
      });
    }
    for (const missDate of openItems?.missingDays ?? []) {
      out.push({
        key: `miss-${missDate}`,
        title: `${dayShort(missDate)} ohne Zeiteintrag`,
        subtitle: "An diesem Arbeitstag fehlt deine Zeit.",
        chip: "Fehlt",
        tone: "bad",
        href: `/ich/zeiten?view=list&date=${missDate}`,
        action: "Nachtragen",
      });
    }
    if ((openItems?.invalidEntries ?? 0) > 0) {
      const n = openItems!.invalidEntries;
      out.push({
        key: "invalid",
        title: n === 1 ? "1 Eintrag zu korrigieren" : `${n} Einträge zu korrigieren`,
        subtitle: "Bitte prüfen und korrigieren.",
        chip: "Prüfen",
        tone: "warn",
        href: "/ich/zeiten",
        action: "Öffnen",
      });
    }
    if (karenzNudge.count > 0) {
      out.push({
        key: "karenz",
        title: karenzNudge.label,
        subtitle: KARENZ_NUDGE_TOOLTIP,
        chip: "Info",
        tone: "info",
        href: karenzNudgeHref(karenzNudge),
        action: "Öffnen",
        testId: "dashboard-karenz-nudge",
      });
    }
    if ((openItems?.pendingRequests ?? 0) > 0) {
      const n = openItems!.pendingRequests;
      out.push({
        key: "pending",
        title: n === 1 ? "Dein Antrag wartet" : `${n} Anträge warten`,
        subtitle: "Du bekommst Bescheid, sobald entschieden ist.",
        chip: "Offen",
        tone: "neutral",
        href: "/ich/abwesenheiten?view=requests",
        action: "Ansehen",
      });
    }
    return out;
  });

  // Owner acceptance (item 5): only the person's own events in everyday language — no system lines
  // (the month close, audit entries); the sentences come from the one API text source.
  let history = $derived(
    historySentences(activityItems.filter((i) => i.category === "time" || i.category === "leave")),
  );
  function historyWhen(iso: string): string {
    const d = new Date(iso);
    return format(d, "yyyy-MM-dd") === todayIso
      ? format(d, "HH:mm")
      : format(d, "EEEEEE", { locale: de });
  }
  let breakDaySet = $derived(new Set(openItems?.unconfirmedBreakDays ?? []));
  let recentDayRows = $derived(
    recentDays(recentEntries, cumulativeByDate, breakDaySet, (rows) =>
      dayTotals(rows as ClockDayEntry[], currentTime),
    ),
  );
</script>

<svelte:head>
  <title>{pageLabel(pageKey)} – Clokr</title>
</svelte:head>

{#snippet teamCellContent(day: TeamDay)}
  {#if day.status === "present"}
    {#if day.workedElsewhere && day.workedHours === 0}
      <span class="cell-badge cell-badge--elsewhere" title="In einem anderen Salon gearbeitet"
        >anderer Salon</span
      >
    {:else}
      <span
        class="cell-badge cell-badge--present"
        title="{fmtHours(day.workedHours)} gearbeitet{day.workedElsewhere
          ? ', außerdem in einem anderen Salon gearbeitet'
          : ''}"
      >
        {fmtHours(day.workedHours)}
      </span>
    {/if}
    {#if day.shift}
      <span class="shift-label" style={day.shift.color ? `color: ${day.shift.color}` : ""}>
        {day.shift.startTime}–{day.shift.endTime}
      </span>
    {/if}
  {:else if day.status === "clocked_in"}
    <span
      class="cell-badge cell-badge--active"
      title={day.workedElsewhere ? "Eingestempelt (anderer Salon)" : "Eingestempelt"}
    >
      <Icon name="circle-fill" size={14} />
    </span>
  {:else if day.status === "absent"}
    <span
      class="cell-badge cell-badge--absent"
      class:cell-badge--bs={day.absenceType === "VOCATIONAL_SCHOOL"}
      title={day.reason ?? "Abwesend"}
    >
      {#if day.leaveTypeCode === "SICK" || day.absenceType === "SICK" || day.leaveTypeCode === "SICK_CHILD" || day.absenceType === "SICK_CHILD"}
        <Icon name="medical" size={14} title={day.reason ?? "Krank"} />
      {:else if day.leaveTypeCode === "MATERNITY" || day.absenceType === "MATERNITY"}
        <Icon name="heart" size={14} title="Mutterschutz" />
      {:else if day.leaveTypeCode === "PARENTAL" || day.absenceType === "PARENTAL"}
        <Icon name="users" size={14} title="Elternzeit" />
      {:else if day.absenceType === "VOCATIONAL_SCHOOL"}
        <Icon name="graduation-cap" size={14} title="Berufsschule" />
      {:else}
        <Icon name="umbrella" size={14} title={day.reason ?? "Urlaub"} />
      {/if}
    </span>
  {:else if day.status === "holiday"}
    <span class="cell-badge cell-badge--holiday" title={day.reason ?? "Feiertag"}>
      <Icon name="sun" size={14} title={day.reason ?? "Feiertag"} />
    </span>
  {:else if day.status === "missing"}
    <span class="cell-badge cell-badge--missing" title={teamMissingTitle(day)}>
      <Icon name="alert" size={14} title="Fehlt" />
    </span>
  {:else if day.status === "scheduled"}
    <span
      class="cell-badge cell-badge--scheduled"
      title={day.shift
        ? (day.shift.label ?? day.shift.startTime + "–" + day.shift.endTime)
        : "Arbeitstag"}
      style={day.shift?.color ? `border-color: ${day.shift.color}` : ""}
    >
      {#if day.shift}
        <span class="shift-time">{day.shift.startTime}–{day.shift.endTime}</span>
      {:else}
        <span class="shift-time">{fmtHours(day.expectedHours ?? 0)}</span>
      {/if}
    </span>
  {:else if day.status === "requested"}
    <span class="cell-badge cell-badge--requested" title={day.reason ?? "Antrag offen"}>
      <Icon name="clock" size={14} title="beantragt" />
    </span>
  {:else}
    <span class="cell-badge cell-badge--none" title="Frei">–</span>
  {/if}
{/snippet}

<!-- Phase 75-02 (D-01): data-testid surface for the Dashboard visual baseline.
     Matches the Phase 73-04/-05 convention (`<surface>-page`). -->
<div class="dashboard" data-testid="dashboard-page">
  <!-- Page Header -->
  <PageHead
    eyebrow={view === "team" ? AREA_LABELS.team : AREA_LABELS.ich}
    title={view === "me" ? `${greeting()}, ${capitalizedName}` : pageLabel(pageKey)}
    compact={view === "me"}
    sub={view === "me" ? meinTagSub : `${greeting()}, ${capitalizedName}`}
  >
    {#snippet actions()}
      {#if view === "me"}
        <a class="btn btn-ghost btn-sm" href="/ich/abwesenheiten?antrag=krank">Krank melden</a>
        <a class="btn btn-outline btn-sm" href="/ich/abwesenheiten?antrag=urlaub"
          >Urlaub beantragen</a
        >
      {/if}
    {/snippet}
  </PageHead>

  {#if view === "me"}
    <!-- Issue #845 (prototype v5, owner acceptance 09.11.2026): Bühne → Kennzahlen →
       [Deine Woche · Letzte Tage | Für dich · Verlauf]. The page lays out the #843 blocks. -->
    <div class="mein-tag">
      <!-- Phase 76.7 (D-15, UI-V19-04): § 18 ArbZG-exempt users (Inhaber/Geschäftsführer/leitende
         Angestellte) see no clock at all — not a disabled button. -->
      {#if !isExempt}
        <section class="mt-stage card-animate" style="--card-idx: 0;" data-testid="mein-tag-stage">
          <Stage state={stageState} ariaLabel="Zeiterfassung">
            <div class="clock-stage" data-day-state={day.kind}>
              <div class="clock-big" data-testid="clock-big">
                {fmtClock(stageWorkedMin)}<small>h</small>
              </div>
              <div class="clock-main">
                <div class="clock-state">
                  <span class="clock-pulse" aria-hidden="true"></span>
                  <span data-testid="clock-state">{stageTitle}</span>
                  {#if stageSalonName}<span class="clock-salon-name">· {stageSalonName}</span>{/if}
                </div>
                <div class="clock-meta">
                  {#each stageMeta as m (m.label)}
                    <span>{m.label} <b>{m.value}</b></span>
                  {/each}
                </div>
                <div class="clock-tl" aria-hidden="true">
                  {#if plannedBand}
                    <i
                      class="clock-tl-plan"
                      style="left: {plannedBand.left}%; width: {plannedBand.width}%;"
                    ></i>
                  {/if}
                  {#each timelineSegments as seg, i (i)}
                    <i
                      class:clock-tl-break={seg.kind === "break"}
                      style="left: {seg.left}%; width: {seg.width}%;"
                    ></i>
                  {/each}
                </div>
                <div class="clock-tl-labels" aria-hidden="true">
                  <span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span>
                </div>
                {#if clockSalonViewState.kind === "select"}
                  <ClockSalonSelect
                    view={clockSalonViewState}
                    value={clockSalonId}
                    disabled={clockLoading}
                    onselect={(id) => (clockSalonId = id)}
                    noteLabel={fixedSalonNoteLabel(day.kind, todayEntries.length)}
                  />
                {/if}
              </div>
            </div>
            {#snippet actions()}
              {#if clockedIn}
                <!-- During a break „Weiterarbeiten“ is the one primary action (Ausstempeln waits). -->
                <button
                  type="button"
                  class="btn"
                  class:btn-primary={breakStartedAt}
                  class:btn-outline={!breakStartedAt}
                  disabled={clockLoading || breakLoading}
                  onclick={handleBreakToggle}
                  title={breakStartedAt
                    ? "Aktive Pause beenden — die Zeit wird als Pause vom Eintrag abgezogen"
                    : "Pause starten — die Zeit wird als Pause vom Eintrag abgezogen"}
                >
                  {#if breakLoading}<span class="btn-spinner"></span>{/if}
                  {breakStartedAt ? "Weiterarbeiten" : "Pause"}
                </button>
              {/if}
              {#if primaryLabel && !(clockedIn && breakStartedAt)}
                <button
                  onclick={handleClock}
                  disabled={clockLoading || clockInBlocked(clockSalonViewState, clockSalonId)}
                  class="btn btn-primary"
                  type="button"
                >
                  {#if clockLoading}<span class="btn-spinner"></span>{/if}
                  {primaryLabel}
                </button>
              {/if}
              {#if day.kind === "finished"}
                {#if canReopenFinishedDay(day) && reopenGapLabel}
                  <button
                    type="button"
                    class="btn btn-outline"
                    disabled={clockLoading}
                    onclick={openReopenDialog}
                    title="Wieder einstempeln — der Zeitraum seit dem Ausstempeln wird als Pause erfasst"
                  >
                    {#if clockLoading}<span class="btn-spinner"></span>{/if}
                    Wieder einstempeln
                  </button>
                  <!-- Issue #70 (D-02/D-11): „In anderem Salon einstempeln“ starts a NEW entry in another
                     salon; the component renders it only when the server offers one. -->
                  <ClockOtherSalon
                    salons={otherSalonOptions(clockSalonViewState)}
                    value={clockSalonId}
                    disabled={clockLoading}
                    loading={clockLoading}
                    blocked={otherSalonBlocked(clockSalonViewState, clockSalonId)}
                    onselect={(id) => (clockSalonId = id)}
                    onstart={handleOtherSalonClockIn}
                  />
                {:else}
                  <span class="clock-note">
                    Monat abgeschlossen — der Eintrag kann nicht mehr geändert werden.
                  </span>
                {/if}
              {/if}
            {/snippet}
          </Stage>
          {#if showEntryList}
            {#if entryCount}
              <p class="mt-quiet mt-entry-count">{entryCount.replaceAll(" ", "\u00A0")}</p>
            {/if}
            <TodayEntriesList entries={todayEntries} />
          {/if}
        </section>
        <!-- Phase 115 (issue #118): the ONLY route from the stage back into a REOPEN. Inside
           {#if !isExempt} on purpose — an exempt user must not gain a clock through this dialog. -->
        <ConfirmDialog
          bind:open={reopenDialogOpen}
          title="Wieder einstempeln?"
          description={reopenDialogText}
          confirmLabel="Wieder einstempeln"
          cancelLabel="Abbrechen"
          onConfirm={confirmReopen}
        />
        <!-- Issue #609 (AC-4): the confirmation behind a shift reminder tap; it stamps only through the
           unchanged handleClock(). -->
        <ConfirmDialog
          bind:open={clockReminderOpen}
          title={clockReminderTexts?.title ?? ""}
          description={clockReminderTexts?.description}
          confirmLabel={clockReminderTexts?.confirmLabel ?? "Bestätigen"}
          cancelLabel="Abbrechen"
          onConfirm={confirmClockReminder}
        />
      {/if}

      <!-- Kennzahlen (D-01, D-04): Stundenkonto, Resturlaub, Nächste Schicht, Diese Woche -->
      <div class="mt-kpis card-animate" style="--card-idx: 1;" data-testid="mein-tag-kpis">
        {#if stats === null && loading}
          <Skeleton shape="card" />
        {:else}
          <KpiStrip items={kpiItems} ariaLabel="Deine Kennzahlen" />
        {/if}
      </div>

      <div class="mt-grid">
        <div class="mt-col">
          <section class="mt-sec card-animate" style="--card-idx: 2;" aria-labelledby="mt-week">
            <h2 id="mt-week" class="mt-h2">
              Deine Woche <span class="mt-h2-meta">KW {getWeekNumber(todayIso)}</span>
            </h2>
            <ol class="mt-week" data-testid="mein-tag-week">
              {#each myWeekDays as d (d.date)}
                {@const text = weekStripText(
                  d,
                  myWeekScheduleType,
                  ownShiftByDate.get(d.date) ?? null,
                )}
                <li
                  class="mt-day"
                  class:mt-day--today={d.date === todayIso}
                  class:mt-day--off={text === "Frei"}
                  aria-current={d.date === todayIso ? "date" : undefined}
                >
                  <span class="mt-day-h"
                    ><span>{format(new Date(d.date + "T12:00:00"), "EEEEEE", { locale: de })}</span
                    ><b>{format(new Date(d.date + "T12:00:00"), "d")}</b></span
                  >
                  <span class="mt-day-s">{text}</span>
                </li>
              {/each}
            </ol>
          </section>

          <section class="mt-sec card-animate" style="--card-idx: 4;" aria-labelledby="mt-recent">
            <h2 id="mt-recent" class="mt-h2">
              Letzte Tage <a class="mt-h2-link" href="/ich/zeiten">Alle Zeiten</a>
            </h2>
            {#if !meinTagLoaded}
              <Skeleton shape="row" count={3} />
            {:else if recentDayRows.length === 0}
              <p class="mt-quiet">In den letzten zwei Wochen ist nichts erfasst.</p>
            {:else}
              <div class="mt-table-wrap">
                <table class="mt-table" data-testid="mein-tag-recent">
                  <thead>
                    <tr>
                      <th scope="col">Tag</th>
                      <th scope="col">Zeiten</th>
                      <th scope="col" class="r">Pause</th>
                      <th scope="col" class="r">Netto</th>
                      <th scope="col" class="r"><span class="sr-only">Saldo</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each recentDayRows as r (r.date)}
                      <tr>
                        <td
                          >{format(new Date(r.date + "T12:00:00"), "EEEEEE d.M.", {
                            locale: de,
                          })}</td
                        >
                        <td>{r.start}–{r.end}</td>
                        <td class="r">{r.breakMinutes > 0 ? fmtClock(r.breakMinutes) : "—"}</td>
                        <td class="r">{fmtClock(r.workingMinutes)}</td>
                        <td class="r">
                          {#if r.breakMissing}
                            <Chip tone="warn">Pause fehlt</Chip>
                          {:else if r.saldoMinutes !== null}
                            <Chip
                              tone={r.saldoMinutes > 0
                                ? "ok"
                                : r.saldoMinutes < 0
                                  ? "bad"
                                  : "neutral"}
                              >{r.saldoMinutes === 0 ? "±0" : fmtBalance(r.saldoMinutes)}</Chip
                            >
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </section>
        </div>

        <div class="mt-col">
          <section class="mt-sec card-animate" style="--card-idx: 3;" aria-labelledby="mt-for-you">
            <h2 id="mt-for-you" class="mt-h2">Für dich</h2>
            {#if openItems === null && !meinTagLoaded}
              <Skeleton shape="row" count={2} />
            {:else if forYou.length === 0}
              <p class="mt-quiet">Nichts offen. Alles erledigt.</p>
            {:else}
              <List ariaLabel="Für dich">
                {#each forYou as item (item.key)}
                  <ListRow title={item.title} subtitle={item.subtitle} avatar={false}>
                    {#snippet leading()}
                      <Chip tone={item.tone}>{item.chip}</Chip>
                    {/snippet}
                    {#snippet trailing()}
                      {#if item.href}
                        <a
                          class="btn btn-outline btn-sm"
                          href={item.href}
                          data-testid={item.testId}
                          title={item.hint}>{item.action}</a
                        >
                      {/if}
                    {/snippet}
                  </ListRow>
                {/each}
              </List>
            {/if}
          </section>

          <section class="mt-sec card-animate" style="--card-idx: 5;" aria-labelledby="mt-history">
            <h2 id="mt-history" class="mt-h2">Verlauf</h2>
            {#if history.length === 0}
              <p class="mt-quiet">Noch keine Ereignisse.</p>
            {:else}
              <ul class="mt-history" data-testid="mein-tag-history">
                {#each history as h (h.id)}
                  <li><span class="mt-when">{historyWhen(h.when)}</span><span>{h.text}</span></li>
                {/each}
              </ul>
            {/if}
          </section>
        </div>
      </div>
    </div>
  {/if}

  <!-- ═══ Team-Bereich (permission-gated, Phase 378 / #378; since #844 only on Heute im Salon) ═══ -->
  <!-- Single gate on team-overview:read:ZUGEWIESEN: employees, and any holder without it, never
       see team charts, upcoming leaves, or team-week table. -->
  {#if canSeeTeamBereich}
    <div class="team-divider">
      <span class="team-divider-label">{teamLabel === null ? "Team" : `Team · ${teamLabel}`}</span>
    </div>

    {#if teamUnavailable}
      <Card animate class="card-body" style="--card-idx: 7;">
        <p class="callout brand">{TEAM_SALON_UNAVAILABLE_TEXT}</p>
      </Card>
    {:else}
      <!-- Salden (Issue #588): the first block of the team area -->
      {#if canSeeTeamSaldo && !teamSaldoHidden}
        <div class="team-saldo-slot">
          <TeamSaldoCard
            rows={teamSaldoRows}
            loading={teamSaldoLoading}
            salonFiltered={teamSaldoFiltered}
            personHref={(id) => (canOpenTeamDay ? teamPersonHref(id) : null)}
            onOpenPerson={(href) => goto(href)}
            cardIdx={7}
          />
        </div>
      {/if}

      <!-- Charts (Team-Aggregation) -->
      <div class="charts-grid">
        {#snippet hoursLink()}
          <a
            class="widget-action"
            href={hoursReportHref}
            aria-label="Arbeitsstunden im Bericht öffnen">Bericht →</a
          >
        {/snippet}
        {#snippet trendLink()}
          <a
            class="widget-action"
            href={trendReportHref}
            aria-label="Überstunden-Trend im Bericht öffnen">Bericht →</a
          >
        {/snippet}
        {#snippet sickLink()}
          <a
            class="widget-action"
            href={sickReportHref}
            aria-label="Krankheitstage im Bericht öffnen">Bericht →</a
          >
        {/snippet}
        <Card animate class="chart-card" style="--card-idx: 8;">
          <CardHeader
            title="Arbeitsstunden"
            sub={trendView?.chartSub ?? "Letzte 6 Monate"}
            actions={hoursReportHref !== null ? hoursLink : undefined}
          />
          <div class="chart-wrap">
            {#if chartsLoading}
              <div class="chart-skeleton" aria-hidden="true"></div>
            {:else}
              <canvas
                bind:this={weeklyChartEl}
                role="img"
                aria-label={chartAriaLabel(teamHoursChartDescriptor(trendView))}
              ></canvas>
            {/if}
          </div>
          {#if trendView?.sollNote}
            <p class="chart-note">{trendView.sollNote}</p>
          {/if}
        </Card>

        {#if chartsLoading || overtimeTrendAvailable || trendView?.trendNote}
          <Card animate class="chart-card" style="--card-idx: 9;">
            <CardHeader
              title="Überstunden-Trend"
              sub="Saldo-Verlauf"
              actions={trendReportHref !== null ? trendLink : undefined}
            />
            <div class="chart-wrap">
              {#if chartsLoading}
                <div class="chart-skeleton" aria-hidden="true"></div>
              {:else if trendView?.trendNote}
                <p class="callout brand">{trendView.trendNote}</p>
              {:else}
                <canvas
                  bind:this={overtimeChartEl}
                  role="img"
                  aria-label={chartAriaLabel(TEAM_SALDO_TREND_CHART)}
                ></canvas>
              {/if}
            </div>
          </Card>
        {/if}

        <Card animate class="chart-card" style="--card-idx: 10;">
          <CardHeader
            title="Krankheitstage"
            sub="Letzte 6 Monate"
            actions={sickReportHref !== null ? sickLink : undefined}
          />
          <div class="chart-wrap">
            {#if chartsLoading}
              <div class="chart-skeleton" aria-hidden="true"></div>
            {:else}
              <canvas
                bind:this={sickChartEl}
                role="img"
                aria-label={chartAriaLabel(TEAM_SICK_DAYS_CHART)}
              ></canvas>
            {/if}
          </div>
        </Card>
      </div>

      <!-- Anstehende Urlaube -->
      {#if upcomingLeaves.length > 0}
        <Card animate class="upcoming-section card-body" style="--card-idx: 11;">
          <div class="widget-header">
            <h3 class="widget-title">Anstehende Urlaube</h3>
            <a href="/leave" class="widget-action">Urlaube →</a>
          </div>
          <div class="upcoming-list">
            {#each upcomingLeaves as leave (leave.id)}
              <div class="upcoming-item">
                <span class="upcoming-name">{leave.employeeName}</span>
                <span class="upcoming-dates">
                  {new Date(leave.startDate).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                  })}
                  – {new Date(leave.endDate).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                  })}
                </span>
                <span class="upcoming-days">{leave.days} {leave.days === 1 ? "Tag" : "Tage"}</span>
                <span class="upcoming-type badge badge-blue">{leave.type}</span>
              </div>
            {/each}
          </div>
        </Card>
      {/if}

      <!-- Team Wochenübersicht -->
      {#if teamWeek}
        <Card animate class="team-section" style="--card-idx: 12;">
          <CardHeader
            title="Team-Wochenübersicht"
            sub={`KW ${getWeekNumber(teamWeek.weekStart)}: ${formatShortDate(teamWeek.weekStart)} – ${formatShortDate(teamWeek.weekEnd)}`}
          >
            {#snippet actions()}
              <button class="btn btn-sm btn-ghost" onclick={prevWeek} title="Vorherige Woche"
                >‹</button
              >
              <button class="btn btn-sm btn-ghost" onclick={currentWeek} disabled={weekOffset === 0}
                >Heute</button
              >
              <button class="btn btn-sm btn-ghost" onclick={nextWeek} title="Nächste Woche"
                >›</button
              >
            {/snippet}
          </CardHeader>

          <div class="team-grid-wrap">
            <table class="team-grid">
              <thead>
                <tr>
                  <th class="team-grid__name">Mitarbeiter</th>
                  {#each teamWeek.weekDays as day (day)}
                    <th class="team-grid__day" class:team-grid__day--today={isToday(day)}>
                      <span class="day-label">{dayLabel(day)}</span>
                      <span class="day-num">{dayNum(day)}</span>
                    </th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each pagedTeam as member (member.id)}
                  <tr>
                    <td class="team-grid__name">
                      <span class="member-name">{member.name}</span>
                    </td>
                    {#each member.days as day (day.date)}
                      {@const href = teamDayHref(member.id, day.date)}
                      <td class="team-grid__cell" class:team-grid__day--today={isToday(day.date)}>
                        {#if canOpenTeamDay && href !== null}
                          <a
                            class="team-grid__link"
                            {href}
                            aria-label={teamCellAriaLabel(
                              member.name,
                              day.date,
                              teamCellStatusText(day),
                            )}
                          >
                            {@render teamCellContent(day)}
                          </a>
                        {:else}
                          {@render teamCellContent(day)}
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
            <Pagination
              total={teamWeek.team.length}
              bind:page={teamPage}
              bind:pageSize={teamPageSize}
            />
          </div>

          <div class="legend">
            <span class="legend-item">
              <span class="cell-badge cell-badge--present">5.0</span>
              {DAY_STATUS_LABEL.present}
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--active"
                ><Icon name="circle-fill" size={12} /></span
              >
              Eingestempelt
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--absent"><Icon name="umbrella" size={12} /></span>
              Urlaub
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--absent"><Icon name="medical" size={12} /></span>
              Krank
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--absent cell-badge--bs"
                ><Icon name="graduation-cap" size={12} /></span
              >
              Berufsschule
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--missing"><Icon name="alert" size={12} /></span>
              {DAY_STATUS_LABEL.missing}
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--holiday"><Icon name="sun" size={12} /></span>
              Feiertag
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--scheduled">9–17</span>
              {DAY_STATUS_LABEL.scheduled}
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--requested"><Icon name="clock" size={12} /></span>
              {DAY_STATUS_LABEL.requested}
            </span>
            <span class="legend-item">
              <span class="cell-badge cell-badge--none">–</span> Keine Daten
            </span>
            {#if teamFilter !== null || teamWeekHasElsewhere(teamWeek?.team ?? [])}
              <span class="legend-item">
                <span class="cell-badge cell-badge--elsewhere">anderer Salon</span> In einem anderen Salon
                gearbeitet
              </span>
            {/if}
          </div>
        </Card>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .dashboard {
    /* max-width inherited from .app-main (1600px) */
    /* Prevent chart.js canvas from causing horizontal overflow on narrow viewports */
    overflow-x: hidden;
  }

  /* Continuous cascade across all dashboard widgets — overrides the
     :nth-child stagger from app.css (which resets per parent row).
     Each .card-animate carries a style="--card-idx: N" inline. */
  .dashboard :global(.card-animate) {
    animation-delay: calc(var(--card-idx, 0) * 60ms);
  }
  .weekly-total-wrap {
    text-align: right;
  }
  .weekly-total {
    font-size: 26px;
    line-height: 1;
    font-family: var(--font-ui);
    font-weight: 400;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .weekly-total-target {
    font-size: 11px;
    color: var(--text-3);
  }
  .weekly-chart {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    align-items: end;
    height: 80px;
    padding: 4px 2px 0;
  }
  .weekly-bar-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    height: 100%;
    justify-content: flex-end;
  }
  .weekly-bar-track {
    position: relative;
    width: 70%;
    background: var(--sunk);
    border-radius: 4px 4px 0 0;
    height: 100%;
    display: flex;
    align-items: flex-end;
    overflow: hidden;
  }
  .weekly-bar-fill {
    width: 100%;
    background: var(--brand);
    border-radius: 4px 4px 0 0;
    transition: height 500ms var(--ease-out);
  }
  .weekly-bar-fill.weekly-bar-today {
    background: var(--brand);
  }
  .weekly-bar-target {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed var(--line-2);
  }
  .weekly-bar-label {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-3);
    letter-spacing: 0.08em;
  }
  .weekly-bar-label.weekly-bar-label-today {
    color: var(--brand);
  }

  /* ── Skeleton loader ────────────────────────────── */
  .skeleton-block,
  .skeleton-text {
    background: linear-gradient(90deg, var(--sunk) 25%, var(--line) 50%, var(--sunk) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
  }
  .skeleton-text {
    display: inline-block;
    width: 4rem;
    height: 0.875em;
    vertical-align: middle;
  }
  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  /* ── Widgets Row (side by side) ──────────────────── */
  .widgets-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
    align-items: start;
  }
  @media (max-width: 768px) {
    .widgets-row {
      grid-template-columns: 1fr;
    }
  }

  .widget-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .widget-title {
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 0;
  }
  .widget-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    background: var(--bad);
    color: var(--card);
    font-size: 0.6875rem;
    font-weight: 700;
    margin-left: 0.375rem;
    vertical-align: middle;
  }
  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .cell-badge--holiday {
    background: var(--brand-soft);
    color: var(--brand);
  }
  .team-divider {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 1rem 0 1.5rem;
  }
  .team-divider::before,
  .team-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .team-divider-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-2);
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    /* #845: the arc follows the label of whatever button holds it (primary or secondary stage
       button), so it has the label's proven contrast (clock-card-cta-546). */
    border: 2px solid color-mix(in srgb, currentColor 35%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Pending Approvals Banner */
  .pending-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    background: var(--warn-soft);
    border: 1px solid var(--warn-soft);
    border-radius: var(--r-control);
    margin-bottom: 1rem;
    text-decoration: none;
    color: var(--text);
    transition:
      background-color 0.15s,
      box-shadow 0.15s;
  }
  .pending-banner:hover {
    background: var(--warn-soft);
    box-shadow: var(--shadow);
  }
  .pending-banner-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.375rem;
    height: 1.375rem;
    padding: 0 0.375rem;
    border-radius: 9999px;
    background: var(--warn);
    color: var(--card);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
  }
  .pending-banner-text {
    flex: 1;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .pending-banner svg {
    color: var(--text-2);
    flex-shrink: 0;
  }

  /* Charts */
  .team-saldo-slot {
    margin-bottom: 1.5rem;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }

  :global(.chart-card:last-child) {
    grid-column: 1 / -1;
  }

  .chart-wrap {
    position: relative;
    height: 240px;
    margin-top: 4px;
  }

  .chart-note {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: var(--text-2);
  }

  .chart-skeleton {
    width: 100%;
    height: 100%;
    border-radius: var(--r-control);
    background: linear-gradient(90deg, var(--sunk) 25%, var(--rail) 50%, var(--sunk) 75%);
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  :global(.upcoming-section) {
    margin-top: 1.75rem;
    margin-bottom: 1.75rem;
    border-left: 3px solid var(--brand);
  }

  .upcoming-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .upcoming-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--line);
    font-size: 0.875rem;
    min-width: 0;
  }

  .upcoming-item:last-child {
    border-bottom: none;
  }

  .upcoming-name {
    font-weight: 500;
    min-width: 80px;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .upcoming-dates {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .upcoming-days {
    color: var(--text-2);
    font-size: 0.8125rem;
  }

  .upcoming-type {
    margin-left: auto;
  }

  @media (max-width: 900px) {
    .charts-grid {
      grid-template-columns: 1fr;
    }
    .chart-wrap {
      height: 180px;
    }
  }

  /* ── Team Section (v1.5 .card recipe; no border-left accent, no backdrop-filter) ── */
  :global(.team-section) {
    margin-bottom: 1.5rem;
    box-shadow: var(--shadow);
  }

  .team-grid-wrap {
    overflow-x: auto;
    margin: 0 -0.25rem;
    /* Negative margin must not create horizontal page overflow on narrow viewports */
    max-width: calc(100% + 0.5rem);
  }

  @media (max-width: 768px) {
    .team-grid-wrap {
      margin: 0;
      max-width: 100%;
    }
  }

  .team-grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .team-grid th,
  .team-grid td {
    padding: 0.5rem 0.375rem;
    text-align: center;
    border-bottom: 1px solid var(--line);
  }

  .team-grid__name {
    text-align: left;
    white-space: nowrap;
    padding-left: 0.5rem;
    padding-right: 0.75rem;
    width: 1%;
  }

  .team-grid__day {
    width: 4.5rem;
  }

  .team-grid__day--today {
    background: var(--brand-soft);
  }

  .day-label {
    display: block;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--text-2);
  }

  .day-num {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .member-name {
    font-weight: 500;
    color: var(--text);
  }

  .team-grid__cell {
    min-width: 3rem;
    text-align: center;
    vertical-align: middle;
  }

  /* Issue #587: the cell link is a transparent block wrapper — same look as the unlinked cell. */
  .team-grid__link {
    display: block;
    color: inherit;
    text-decoration: none;
    border-radius: 999px;
  }

  .team-grid__link:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  /* Cell badges */
  .cell-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    padding: 0.1875rem 0.4375rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition: transform 0.15s ease;
  }

  .cell-badge--present {
    background: var(--ok-soft);
    color: var(--ok);
    border: 1px solid var(--ok-soft);
  }

  .cell-badge--active {
    background: var(--info-soft);
    color: var(--info);
    border: 1px solid color-mix(in srgb, var(--info) 30%, transparent);
    animation: pulse-badge 2s ease-in-out infinite;
  }

  @keyframes pulse-badge {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .cell-badge--absent {
    background: var(--brand-soft);
    color: var(--brand);
    border: 1px solid var(--brand-soft);
    font-size: 0.875rem;
  }

  /* Berufsschule day — distinct from generic absence so the 🎓 emoji reads as
     "operationally planned school day" rather than "leave/sick". Slightly
     lighter surface + neutral border to differentiate from vacation. */
  .cell-badge--bs {
    background: var(--sunk);
    color: var(--text);
    border: 1px solid var(--line);
  }

  .bs-emoji {
    font-size: 0.875rem;
    line-height: 1;
  }

  .cell-badge--missing {
    background: var(--bad-soft);
    color: var(--bad);
    border: 1px solid var(--bad-soft);
    font-size: 0.875rem;
  }

  /* Issue #84: worked in another salon only (salon filter) — not an absence, not a missing day. */
  .cell-badge--elsewhere {
    background: var(--sunk);
    color: var(--text-2);
    border: 1px dashed var(--line);
    font-size: 0.6875rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .cell-badge--scheduled {
    background: var(--sunk);
    color: var(--text-2);
    border: 1px dashed var(--line);
    font-size: 0.6875rem;
  }

  /* Open (pending) leave request — amber/warn tone signals "attention/awaiting decision",
     distinct from the neutral "none"/Frei state and from approved (brand) leave. */
  .cell-badge--requested {
    background: var(--warn-soft);
    color: var(--warn);
    border: 1px solid var(--warn-soft);
    font-size: 0.875rem;
  }

  .cell-badge--none {
    color: var(--text-2);
    opacity: 0.4;
  }

  .shift-label {
    display: block;
    font-size: 0.625rem;
    line-height: 1;
    margin-top: 2px;
    opacity: 0.7;
  }

  .shift-time {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  /* Legend */
  .legend {
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--line);
    font-size: 0.8125rem;
    color: var(--text-2);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* ── Issue #845: Ich › Mein Tag — layout only, the blocks carry their own look ── */
  .mein-tag {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-width: 0;
  }
  .clock-stage {
    display: flex;
    align-items: center;
    gap: var(--s-5);
    min-width: 0;
  }
  .clock-big {
    font-size: var(--fs-hero);
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    min-width: 5ch;
  }
  .clock-big small {
    font-size: var(--fs-base);
    font-weight: 500;
    margin-left: var(--s-1);
    color: var(--text-2);
  }
  :global(.stage[data-state="pause"]) .clock-big small {
    color: inherit;
  }
  .clock-main {
    flex: 1 1 auto;
    min-width: 0;
  }
  .clock-state {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-weight: 600;
  }
  .clock-pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-3);
    flex: none;
  }
  :global(.stage[data-state="arbeitet"]) .clock-pulse {
    background: var(--ok);
  }
  :global(.stage[data-state="pause"]) .clock-pulse {
    background: var(--warn);
  }
  .clock-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-3);
    margin-top: 2px;
    font-size: var(--fs-sm);
  }
  .clock-meta b {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .clock-tl {
    position: relative;
    height: 6px;
    margin-top: var(--s-2);
    border-radius: var(--r-pill);
    background: var(--line);
    overflow: hidden;
  }
  .clock-tl i {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: var(--r-pill);
    background: var(--brand);
  }
  .clock-tl i.clock-tl-break {
    background: var(--accent);
  }
  .clock-tl-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
    font-size: var(--fs-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .clock-note {
    font-size: var(--fs-sm);
  }
  .mt-entry-count {
    margin: var(--s-2) 0 var(--s-1);
  }
  .mt-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--s-6) var(--s-5);
    margin-top: var(--s-2);
  }
  .mt-sec {
    min-width: 0;
  }
  .mt-h2 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-2);
    margin: 0 0 var(--s-2);
    font-size: var(--fs-h2);
    font-weight: 600;
  }
  .mt-h2-link {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--brand);
  }
  .mt-quiet {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-sm);
  }
  .mt-row-end {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
  }
  .mt-table-wrap {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--card);
  }
  .mt-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .mt-table th {
    height: 34px;
    padding: 0 var(--s-3);
    text-align: left;
    font-size: var(--fs-th);
    font-weight: 600;
    color: var(--text-2);
    border-bottom: 1px solid var(--line);
  }
  .mt-table td {
    height: 44px;
    padding: 0 var(--s-3);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  .mt-table tr:last-child td {
    border-bottom: 0;
  }
  .mt-table .r {
    text-align: right;
  }
  .mt-history {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .mt-history li {
    display: flex;
    gap: var(--s-3);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-sm);
  }
  .mt-history li:last-child {
    border-bottom: 0;
  }
  .mt-when {
    flex: none;
    min-width: 6ch;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .mt-col {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  .mt-grid {
    grid-template-columns: minmax(0, 11fr) minmax(0, 9fr);
  }
  .mt-h2-meta {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .clock-salon-name {
    font-weight: 500;
    color: var(--text-2);
  }
  :global(.stage[data-state="pause"]) .clock-salon-name {
    color: inherit;
  }
  .clock-tl i.clock-tl-plan {
    background: color-mix(in srgb, var(--brand) 22%, transparent);
  }
  /* „Deine Woche“: one row of seven days (prototype v5), today marked */
  .mt-week {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1px;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
  }
  .mt-day {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
    padding: var(--s-2) var(--s-3);
    background: var(--card);
    font-size: var(--fs-sm);
  }
  .mt-day--off {
    background: var(--sunk);
  }
  .mt-day--today {
    box-shadow: inset 0 2px 0 var(--brand);
  }
  .mt-day-h {
    display: flex;
    justify-content: space-between;
    color: var(--text-3);
    font-size: var(--fs-th);
    font-weight: 600;
  }
  .mt-day-h b {
    color: var(--text);
    font-size: var(--fs-base);
    font-variant-numeric: tabular-nums;
  }
  .mt-day-s {
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  /* Phone: the stage stays compact so the Kennzahlen reach the first screen (D-01, AC 390×844). */
  @media (max-width: 759.98px) {
    .mt-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    /* prototype phone: number, status, meta and time bar stacked; the action spans the stage */
    .clock-stage {
      flex-direction: column;
      align-items: stretch;
      gap: var(--s-3);
      width: 100%;
    }
    .mt-stage :global(.stage-actions) {
      width: 100%;
    }
    .mt-stage :global(.stage-actions > *) {
      flex: 1 1 0;
    }
    .mt-day-s {
      display: none;
    }
    .mt-day-h {
      justify-content: center;
      gap: var(--s-1);
    }
  }
  /* after the base rules of the two-column grid: one column on narrow screens */
  @media (max-width: 1099.98px) {
    .mt-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
