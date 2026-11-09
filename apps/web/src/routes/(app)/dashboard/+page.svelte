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
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import { toasts } from "$stores/toast";
  import Pagination from "$components/ui/Pagination.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import MyShiftsWeek from "$lib/components/dashboard/MyShiftsWeek.svelte";
  import MyWeekView from "$lib/components/dashboard/MyWeekView.svelte";
  import ClockSalonSelect from "$lib/components/dashboard/ClockSalonSelect.svelte"; // Issue #87
  import ClockOtherSalon from "$lib/components/dashboard/ClockOtherSalon.svelte"; // Issue #70
  import TodayEntriesList from "$lib/components/dashboard/TodayEntriesList.svelte"; // Issue #70
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
  import { weekProgressDelta } from "$lib/dashboard/week-progress"; // Issue #451 (D-06)
  import { interpretClockOut, type ClockOutResponse } from "$lib/dashboard/clock-out-result"; // Phase 307 Plan 02 (D-04)
  import { breakFindingSaveNotice } from "$lib/breaks/day-break-violation"; // Issue #80 (D-09a), #511 (D-10)
  import {
    DAY_STATUS_LABEL,
    attendanceStatusText,
    teamMissingTitle,
  } from "$lib/dashboard/day-status-label"; // Issue #587 (P-06)
  import { teamDayHref, teamCellAriaLabel } from "$lib/dashboard/team-day-links"; // Issue #587 (D-587-4), #588
  import { mayOpenTeamPage } from "$lib/nav/team-nav";
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
  import Note from "$components/ui/Note.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import {
    dayGoalMinutes,
    saldoFigure,
    nextOwnShift,
    historySentences,
    type MyWeekDay,
    type OvertimeAnswer,
    type MyShiftWeek,
    type NextShift,
  } from "$lib/dashboard/mein-tag"; // Issue #845
  import { isTravelRow } from "$lib/time-entries/travel-entry-form";
  import {
    attendanceBand,
    attendanceFilterOf,
    filterAttendance,
    ATTENDANCE_FILTERS,
    TEAM_WEEK_PAGE_SIZE,
    openTeamLeaveTasks,
    leaveTypeLabel,
    type TeamTaskLeave,
  } from "$lib/dashboard/heute-im-salon"; // Issue #846
  import { leaveDaysLabel } from "$lib/leave/leave-days-label";
  import type { TodayEmployee } from "$lib/reports/today-attendance";
  import type { TodayAttendanceData } from "$lib/reports/today-attendance";
  import LeaveReviewDialog from "$lib/components/leave/LeaveReviewDialog.svelte"; // #846 D-03: the dialog of Aufgaben
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
    teamViewLabel,
    upcomingFromResponse,
    withSalonId,
    type TeamTrendMonth,
    type TeamTrendResponse,
    type TeamUpcomingLeaveResponse,
  } from "$lib/dashboard/team-view"; // Issue #84 (D-07, D-11, D-12), #85 (D-04, D-06)

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
    vacation: { remaining: number; total: number; used: number } | null;
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
  // Issue #846 (D-02): the week is always the current one; pages only from 25 persons on.
  let teamPageSize = $state(TEAM_WEEK_PAGE_SIZE);
  let pagedTeam = $derived(
    teamWeek ? teamWeek.team.slice((teamPage - 1) * teamPageSize, teamPage * teamPageSize) : [],
  );
  // Phase 267 (#267, D-04): shaped after `GET /shifts/my-week`'s `ownShifts[]`, which is already
  // narrowed to the caller server-side. The former `template: { name, color }` is gone — /my-week
  // returns `templateName`/`templateColor` flat, and the markup below renders only label,
  // startTime and endTime anyway.
  let todayShift: {
    startTime: string;
    endTime: string;
    label: string | null;
  } | null = $state(null);

  // Next personal absence
  let myNextLeave: { startDate: string; endDate: string; days: number; type: string } | null =
    $state(null);

  // Phase 49.4: MyWeekView (non-SHIFT_BASED) and MyShiftsWeek (SHIFT_BASED) each
  // fetch their own data. shiftFallback flips to true when MyShiftsWeek reports 410,
  // so a SHIFT_BASED-flagged employee with no actual shifts still gets the hours view.
  let shiftFallback = $state(false);

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
  let breakNudge = $derived(summarizeUnconfirmedBreakDays(openItems?.unconfirmedBreakDays));
  // Kept as a separate name because hasNoOpenItems() and the {#if} below read it.
  let unconfirmedBreakDays = $derived(breakNudge.count);

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
  const teamLabel = $derived(teamViewLabel($salonContext));
  // D-16: the server rejected the selected salon (404); calm empty state, no further polling.
  let teamUnavailable = $state(false);

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
          // Note: MyShiftsWeek.svelte fetches the same endpoint for the week strip below, so the
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

      // Phase 49.4: MyWeekView / MyShiftsWeek each fetch their own data — no prefetch here.
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
  let myWeekDays = $state<MyWeekDay[]>([]);
  let myWeekScheduleType = $state<string | null>(null);
  let nextShift = $state<NextShift | null>(null);
  let recentEntries = $state<ClockDayEntry[]>([]);
  let meinTagLoaded = $state(false);

  async function loadMeinTag(today: string) {
    const employeeId = $authStore.user?.employeeId;
    const weekAhead = format(addDays(new Date(today + "T12:00:00"), 7), "yyyy-MM-dd");
    const twoWeeksBack = format(addDays(new Date(today + "T12:00:00"), -14), "yyyy-MM-dd");
    const yesterday = format(addDays(new Date(today + "T12:00:00"), -1), "yyyy-MM-dd");
    const [overtimeR, myWeekR, shiftsNowR, shiftsNextR, recentR] = await Promise.allSettled([
      // D-845-03: the endpoint the Zeiten page shows — one figure, one source
      employeeId && stats !== null && (stats as DashboardStats).overtime !== null
        ? api.get<OvertimeAnswer>(`/overtime/${employeeId}`)
        : Promise.resolve(null),
      api.get<{ scheduleType: string | null; days: MyWeekDay[] }>(
        `/dashboard/my-week?date=${today}`,
      ),
      api.get<MyShiftWeek>(`/shifts/my-week?date=${today}`),
      api.get<MyShiftWeek>(`/shifts/my-week?date=${weekAhead}`),
      api.get<ClockDayEntry[]>(`/time-entries?from=${twoWeeksBack}&to=${yesterday}`),
    ]);
    ownOvertime = overtimeR.status === "fulfilled" ? overtimeR.value : null;
    if (myWeekR.status === "fulfilled") {
      myWeekDays = myWeekR.value.days ?? [];
      myWeekScheduleType = myWeekR.value.scheduleType;
    }
    const weeks = [shiftsNowR, shiftsNextR]
      .filter((r): r is PromiseFulfilledResult<MyShiftWeek> => r.status === "fulfilled")
      .map((r) => r.value);
    nextShift = nextOwnShift(weeks, today, format(new Date(), "HH:mm"));
    recentEntries =
      recentR.status === "fulfilled"
        ? recentR.value
            .filter((e) => e.endTime !== null && !isTravelRow(e))
            .sort((a, b) => b.startTime.localeCompare(a.startTime))
            .slice(0, 5)
        : [];
    meinTagLoaded = true;
  }

  async function pollDashboard() {
    // only Team-Bereich holders need team-week data, once the salon context is known; a salon
    // the server rejected is not polled again until the selection changes
    if (canSeeTeamBereich && teamContextReady && !teamUnavailable) {
      await Promise.allSettled([loadTeamWeek(), loadTodayAttendance()]);
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
    attendance = null;
    teamMonth = null;
    await Promise.allSettled([
      loadTeamWeek(),
      loadTodayAttendance(),
      loadTeamMonth(),
      loadUpcomingLeaves(),
      loadTeamTasks(),
    ]);
  }

  // The first team load waits until the salon context is known (no unfiltered-then-filtered double
  // load); afterwards it runs only when the guarded filter value actually changes. `untrack`
  // because the loaders read other state synchronously.
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
      // D-02: always the current week (today marked)
      const dateParam = format(new Date(), "yyyy-MM-dd");
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

  // ── Issue #846: Team › Heute im Salon ─────────────────────────────────────────────────────────
  // Every figure is a server answer under the same salon filter and reach rules (#82/#84/#85);
  // `$lib/dashboard/heute-im-salon` only counts statuses the server decided and words them.
  let attendance = $state<TodayAttendanceData | null>(null);
  let teamMonth = $state<TeamTrendMonth | null>(null);
  let teamMonthBasis = $state<TeamTrendResponse["workedBasis"] | null>(null);
  let pendingLeave = $state<TeamTaskLeave[]>([]);
  let pendingRetroCount = $state(0);
  let reviewOpen = $state(false);
  let reviewRequest = $state<TeamTaskLeave | null>(null);
  const canDecideLeave = $derived(
    hasPermission($authStore.user, "leave-request:approve:ZUGEWIESEN"),
  );
  const canDecideRetro = $derived(
    hasPermission($authStore.user, "retro-request:approve:ZUGEWIESEN"),
  );

  async function loadTodayAttendance() {
    const filter = teamFilter;
    const generation = teamGeneration;
    try {
      const answer = await api.get<TodayAttendanceData>(
        withSalonId("/dashboard/today-attendance", filter),
      );
      if (generation !== teamGeneration) return;
      attendance = answer;
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) teamUnavailable = true;
        return;
      }
      console.error("Failed to load today's attendance:", err);
    }
  }

  // „Monat bis gestern“: the running month of the team trend (closed valid entries through
  // tenant-local yesterday); the Soll is null where it cannot be attributed (salon filter, reach).
  async function loadTeamMonth() {
    const filter = teamFilter;
    const generation = teamGeneration;
    try {
      const resp = await api.get<TeamTrendResponse>(
        withSalonId("/dashboard/team-trend?months=1", filter),
      );
      if (generation !== teamGeneration) return;
      teamMonth = resp.months[resp.months.length - 1] ?? null;
      teamMonthBasis = resp.workedBasis;
    } catch (err) {
      if (isTeamSalonRejected(err)) {
        if (generation === teamGeneration) teamUnavailable = true;
        return;
      }
      console.error("Failed to load the team month:", err);
    }
  }

  // D-03: the open leave requests decided here go through the SAME dialog as Aufgaben
  // (LeaveReviewDialog) — this page never writes a decision of its own.
  async function loadTeamTasks() {
    const filter = teamFilter;
    const generation = teamGeneration;
    const [leaveR, retroR] = await Promise.allSettled([
      canDecideLeave
        ? api.get<TeamTaskLeave[]>(withSalonId("/leave/requests?status=PENDING", filter))
        : Promise.resolve([] as TeamTaskLeave[]),
      canDecideRetro
        ? api.get<{ status: string }[]>("/retro-entry-requests")
        : Promise.resolve([] as { status: string }[]),
    ]);
    if (generation !== teamGeneration) return;
    pendingLeave =
      leaveR.status === "fulfilled"
        ? openTeamLeaveTasks(leaveR.value, $authStore.user?.employeeId)
        : [];
    pendingRetroCount =
      retroR.status === "fulfilled" ? retroR.value.filter((r) => r.status === "PENDING").length : 0;
  }

  // D-01: every Kennzahl opens its list — the attendance filter lives in the URL (`?status=`).
  const attendanceFilter = $derived(attendanceFilterOf($page.url.searchParams.get("status")));
  function statusHref(key: string): string {
    const params = new URLSearchParams($page.url.searchParams);
    if (key === "alle") params.delete("status");
    else params.set("status", key);
    const q = params.toString();
    return `${$page.url.pathname}${q ? `?${q}` : ""}#jetzt`;
  }
  const attendanceFilterOptions = Object.entries(ATTENDANCE_FILTERS).map(([value, f]) => ({
    value,
    label: f.label,
  }));
  const nowRows = $derived(filterAttendance(attendance?.employees ?? [], attendanceFilter));
  const band = $derived(attendanceBand(attendance));

  function attendanceSubtitle(row: TodayEmployee): string {
    if (row.status === "missing" && row.expectedStart)
      return `Schicht seit ${row.expectedStart} · nicht eingestempelt`;
    if (row.status === "scheduled" && row.expectedStart) return `Schicht ab ${row.expectedStart}`;
    if (row.workedElsewhere) return "heute auch in einem anderen Salon";
    return attendanceStatusText(row);
  }
  function statusTone(status: TodayEmployee["status"]): "ok" | "warn" | "bad" | "info" | "neutral" {
    if (status === "clocked_in") return "ok";
    if (status === "missing") return "bad";
    if (status === "scheduled" || status === "requested" || status === "holiday") return "info";
    return "neutral";
  }

  const teamKpis = $derived.by((): KpiItem[] => {
    const items: KpiItem[] = [
      {
        label: "Anwesend",
        value: String(band.present),
        unit: `von ${band.expected}`,
        explanation: band.done > 0 ? `${band.done} heute schon gearbeitet` : "gerade eingestempelt",
        derivationHref: statusHref("anwesend"),
        derivationLabel: "Liste →",
        testId: "kpi-present",
      },
      {
        label: "Erwartet",
        value: String(band.missing + band.scheduled),
        explanation:
          band.missing > 0 ? `${band.missing} fehlt seit Schichtbeginn` : "noch nicht da",
        deltaTone: band.missing > 0 ? "bad" : "neutral",
        derivationHref: statusHref("erwartet"),
        derivationLabel: "Liste →",
        testId: "kpi-expected",
      },
      {
        label: "Abwesend",
        value: String(band.absent),
        explanation: "Urlaub, Krankheit, Berufsschule",
        derivationHref: statusHref("abwesend"),
        derivationLabel: "Liste →",
        testId: "kpi-absent",
      },
    ];
    if (canDecideLeave || canDecideRetro) {
      items.push({
        label: "Aufgaben",
        value: String(pendingLeave.length + pendingRetroCount),
        explanation: `${pendingLeave.length} ${pendingLeave.length === 1 ? "Antrag" : "Anträge"} · ${pendingRetroCount} ${pendingRetroCount === 1 ? "Nachtrag" : "Nachträge"}`,
        derivationHref: "/team/aufgaben",
        derivationLabel: "Aufgaben →",
        testId: "kpi-tasks",
      });
    }
    if (teamMonth) {
      const worked = fmtHours(teamMonth.workedMinutes / 60);
      items.push({
        label: "Monat bis gestern",
        value: worked,
        unit:
          teamMonth.shouldMinutes !== null
            ? `/ ${fmtHours(teamMonth.shouldMinutes / 60)}`
            : undefined,
        explanation:
          teamMonth.shouldMinutes !== null
            ? "erfasst / Soll"
            : teamMonthBasis === "SCOPE_ENTRIES"
              ? "erfasst in deiner Reichweite"
              : "erfasst in diesem Salon",
        testId: "kpi-month",
      });
    }
    return items;
  });

  function openReview(request: TeamTaskLeave) {
    reviewRequest = request;
    reviewOpen = true;
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

  let stageMeta = $derived.by((): { label: string; value: string }[] => {
    const shift = todayShift ? `${todayShift.startTime}–${todayShift.endTime}` : null;
    if (stageState === "arbeitet") {
      const out = [{ label: "seit", value: clockStart ? format(clockStart, "HH:mm") : "—" }];
      // D-845-02: the break taken so far, never a § 4 budget computed here
      out.push({ label: "Pause", value: fmtClock(entryBreakMin) });
      if (goalMin !== null)
        out.push({
          label: "bis Soll noch",
          value: fmtClock(Math.max(0, goalMin - stageWorkedMin)),
        });
      else if (shift) out.push({ label: "Schicht", value: shift });
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
    if (shift) out.push({ label: "Schicht", value: shift });
    if (goalMin !== null) out.push({ label: "Soll", value: fmtClock(goalMin) });
    return out;
  });

  // The day bar 06:00–22:00: one segment per entry of today, the running break on top.
  const TL_START_MIN = 6 * 60;
  const TL_SPAN_MIN = 16 * 60;
  let timelineSegments = $derived.by(() => {
    const pos = (d: Date) =>
      Math.min(
        100,
        Math.max(0, ((d.getHours() * 60 + d.getMinutes() - TL_START_MIN) / TL_SPAN_MIN) * 100),
      );
    const segs: { kind: "work" | "break"; left: number; width: number }[] = [];
    for (const e of todayEntries) {
      const l = pos(new Date(e.startTime));
      const r = pos(e.endTime ? new Date(e.endTime) : currentTime);
      segs.push({ kind: "work", left: l, width: Math.max(0.6, r - l) });
    }
    if (clockedIn && breakStartedAt) {
      const l = pos(breakStartedAt);
      segs.push({ kind: "break", left: l, width: Math.max(0.6, pos(currentTime) - l) });
    }
    return segs;
  });

  // ── Issue #845: the Kennzahlenleiste (D-01, D-04, D-845-03/07) ───────────────────────────────
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
        value: f.value,
        unit: "h",
        explanation: f.explanation,
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
        explanation: myNextLeave
          ? `nächster ${myNextLeave.type} ab ${format(new Date(myNextLeave.startDate), "d.M.")}`
          : `von ${stats.vacation.total}`,
        derivationHref: "/ich/abwesenheiten",
        derivationLabel: "Abwesenheiten →",
        testId: "kpi-vacation",
      });
    }
    items.push({
      label: "Nächste Schicht",
      value: nextShift
        ? format(new Date(nextShift.date + "T12:00:00"), "EEEEEE d.M.", { locale: de })
        : "—",
      explanation: nextShift
        ? `${nextShift.startTime}–${nextShift.endTime}${nextShift.name ? ` · ${nextShift.name}` : ""}`
        : "Keine geplant",
      testId: "kpi-next-shift",
    });
    if (stats?.week && stats.week.targetHours > 0) {
      // Issue #451 (D-06): the delta compares the through-yesterday pair, never today's half day.
      const weekDiff = weekProgressDelta(stats.week);
      items.push({
        label: "Diese Woche",
        value: fmtClock(stats.week.workedHours * 60),
        unit: `/ ${fmtClock(stats.week.targetHours * 60)}`,
        explanation: "erfasst / Soll der Woche",
        delta:
          weekDiff === 0
            ? "bis gestern ausgeglichen"
            : `bis gestern ${weekDiff > 0 ? "+" : "−"}${fmtClock(Math.abs(weekDiff) * 60)}`,
        deltaTone: weekDiff === 0 ? "neutral" : weekDiff > 0 ? "good" : "warn",
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
    if (unconfirmedBreakDays > 0) {
      out.push({
        key: "break",
        title: breakNudge.label,
        subtitle: "Pause nachtragen oder Tag bestätigen.",
        chip: "Prüfen",
        tone: "warn",
        href: breakNudgeHref(breakNudge),
        action: "Öffnen",
        testId: "dashboard-break-nudge",
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
        chip: "Info",
        tone: "info",
        href: karenzNudgeHref(karenzNudge),
        action: "Öffnen",
        testId: "dashboard-karenz-nudge",
        hint: KARENZ_NUDGE_TOOLTIP,
      });
    }
    if ((openItems?.pendingRequests ?? 0) > 0) {
      const n = openItems!.pendingRequests;
      out.push({
        key: "pending",
        title:
          n === 1 ? "1 Antrag wartet auf Entscheidung" : `${n} Anträge warten auf Entscheidung`,
        chip: "Offen",
        tone: "neutral",
        href: "/ich/abwesenheiten?view=requests",
        action: "Ansehen",
      });
    }
    return out;
  });

  let history = $derived(historySentences(activityItems));

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const now = currentTime.getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return "gerade eben";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `vor ${diffMin} Min.`;
    const sameDay = new Date(iso).toDateString() === new Date(now).toDateString();
    if (sameDay) {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    const diffDays = Math.floor(diffSec / 86400);
    if (diffDays === 1) return "gestern";
    if (diffDays < 7) {
      const d = new Date(iso);
      return format(d, "EEE", { locale: de });
    }
    return new Date(iso).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
    });
  }
</script>

<svelte:head>
  <title>{pageLabel(pageKey)} – Clokr</title>
</svelte:head>

{#snippet teamCellContent(day: TeamDay)}
  <!-- Issue #846 (D-02): hours as a pill, every other status as a chip WITH text, never a symbol alone. -->
  {#if day.status === "present"}
    {#if day.workedElsewhere && day.workedHours === 0}
      <Chip tone="neutral" title="In einem anderen Salon gearbeitet">anderer Salon</Chip>
    {:else}
      <span class="ts-pill">{fmtHours(day.workedHours)}</span>
    {/if}
  {:else if day.status === "clocked_in"}
    <Chip tone="ok">{DAY_STATUS_LABEL.clocked_in}</Chip>
  {:else if day.status === "missing"}
    <Chip tone="bad" title={teamMissingTitle(day)}>{DAY_STATUS_LABEL.missing}</Chip>
  {:else if day.status === "absent"}
    <Chip tone="neutral" title={day.reason ?? DAY_STATUS_LABEL.absent}
      >{day.reason ?? DAY_STATUS_LABEL.absent}</Chip
    >
  {:else if day.status === "holiday"}
    <Chip tone="info" title={day.reason ?? DAY_STATUS_LABEL.holiday}
      >{DAY_STATUS_LABEL.holiday}</Chip
    >
  {:else if day.status === "requested"}
    <Chip tone="info" title={day.reason ?? DAY_STATUS_LABEL.requested}
      >{DAY_STATUS_LABEL.requested}</Chip
    >
  {:else if day.status === "scheduled"}
    <span class="ts-faint"
      >{day.shift
        ? `${day.shift.startTime}–${day.shift.endTime}`
        : fmtHours(day.expectedHours ?? 0)}</span
    >
  {:else}
    <span class="ts-faint" title="Frei">—</span>
  {/if}
{/snippet}

<!-- Phase 75-02 (D-01): data-testid surface for the Dashboard visual baseline.
     Matches the Phase 73-04/-05 convention (`<surface>-page`). -->
<div class="dashboard" data-testid="dashboard-page">
  <!-- Page Header -->
  <PageHead
    eyebrow={view === "team" ? AREA_LABELS.team : AREA_LABELS.ich}
    title={pageLabel(pageKey)}
    sub={view === "me"
      ? `${greeting()}, ${capitalizedName} · ${format(currentTime, "EEEE, d. MMMM", { locale: de })}`
      : `${format(currentTime, "EEEE, d. MMMM", { locale: de })} · Stand ${format(currentTime, "HH:mm")}`}
  >
    {#snippet actions()}
      {#if view === "me"}
        <a class="btn btn-outline btn-sm" href="/ich/abwesenheiten">Urlaub beantragen</a>
      {/if}
      <!-- #846 D-05: the own clock stays one click away on Heute im Salon, while not clocked in. -->
      {#if view === "team" && !isExempt && primaryLabel === "Einstempeln"}
        {#if clockInBlocked(clockSalonViewState, clockSalonId)}
          <!-- a salon must be chosen first: that choice lives on the clock stage of Mein Tag -->
          <a class="btn btn-primary btn-sm" href="/ich/tag">Einstempeln</a>
        {:else}
          <button
            onclick={handleClock}
            disabled={clockLoading || clockInBlocked(clockSalonViewState, clockSalonId)}
            class="btn btn-primary btn-sm"
            type="button">Einstempeln</button
          >
        {/if}
      {/if}
    {/snippet}
  </PageHead>

  {#if view === "me"}
    <!-- Issue #845 (D-01): Bühne → Kennzahlen → [Deine Woche | Für dich] / [Letzte Tage | Verlauf].
       Every block is one of the #843 building blocks; the page only lays them out. -->
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
                <div class="clock-state" data-testid="clock-state">
                  <span class="clock-pulse" aria-hidden="true"></span>
                  {stageTitle}
                </div>
                <div class="clock-meta">
                  {#each stageMeta as m (m.label)}
                    <span>{m.label} <b>{m.value}</b></span>
                  {/each}
                </div>
                {#if day.kind !== "idle"}
                  <div class="clock-tl" aria-hidden="true">
                    {#each timelineSegments as seg, i (i)}
                      <i
                        class:clock-tl-break={seg.kind === "break"}
                        style="left: {seg.left}%; width: {seg.width}%;"
                      ></i>
                    {/each}
                  </div>
                  <div class="clock-tl-labels" aria-hidden="true">
                    <span>06:00</span><span>10:00</span><span>14:00</span><span>18:00</span><span
                      >22:00</span
                    >
                  </div>
                {/if}
                <ClockSalonSelect
                  view={clockSalonViewState}
                  value={clockSalonId}
                  disabled={clockLoading}
                  onselect={(id) => (clockSalonId = id)}
                  noteLabel={fixedSalonNoteLabel(day.kind, todayEntries.length)}
                />
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
        <!-- The week component carries its own heading („Meine Woche · KW …“). -->
        <section class="mt-sec card-animate" style="--card-idx: 2;" aria-label="Deine Woche">
          <!-- Phase 49.4 — MyShiftsWeek for SHIFT_BASED, MyWeekView for everyone else -->
          {#if stats?.scheduleType === "SHIFT_BASED" && !shiftFallback}
            <MyShiftsWeek
              onFallback={() => {
                shiftFallback = true;
              }}
            />
          {:else}
            <MyWeekView />
          {/if}
        </section>

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
                  {#snippet trailing()}
                    <span class="mt-row-end">
                      <Chip tone={item.tone}>{item.chip}</Chip>
                      <a
                        class="btn btn-sm"
                        href={item.href}
                        data-testid={item.testId}
                        title={item.hint}>{item.action}</a
                      >
                    </span>
                  {/snippet}
                </ListRow>
              {/each}
            </List>
          {/if}
        </section>

        <section class="mt-sec card-animate" style="--card-idx: 4;" aria-labelledby="mt-recent">
          <h2 id="mt-recent" class="mt-h2">
            Letzte Tage <a class="mt-h2-link" href="/ich/zeiten">Alle Zeiten</a>
          </h2>
          {#if !meinTagLoaded}
            <Skeleton shape="row" count={3} />
          {:else if recentEntries.length === 0}
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
                  </tr>
                </thead>
                <tbody>
                  {#each recentEntries as e (e.id)}
                    <tr>
                      <td>{format(new Date(e.startTime), "EEEEEE d.M.", { locale: de })}</td>
                      <td>{hhmmOf(e.startTime)}–{e.endTime ? hhmmOf(e.endTime) : "—"}</td>
                      <td class="r">{fmtClock(e.breakMinutes ?? 0)}</td>
                      <td class="r">
                        {typeof e.workingMinutes === "number" ? fmtClock(e.workingMinutes) : "—"}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

        <section class="mt-sec card-animate" style="--card-idx: 5;" aria-labelledby="mt-history">
          <h2 id="mt-history" class="mt-h2">Verlauf</h2>
          {#if history.length === 0}
            <p class="mt-quiet">Noch keine Ereignisse.</p>
          {:else}
            <ul class="mt-history" data-testid="mein-tag-history">
              {#each history as h (h.id)}
                <li><span class="mt-when">{relativeTime(h.when)}</span><span>{h.text}</span></li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    </div>
  {/if}

  <!-- ═══ Team › Heute im Salon (Issue #846; permission-gated, Phase 378 / #378) ═══ -->
  <!-- Single gate on team-overview:read:ZUGEWIESEN. Order (prototype v5): Kennzahlen-Band →
       [Jetzt im Salon · Team-Woche | Aufgaben · Demnächst abwesend]. No charts (D-04, Z-03). -->
  {#if canSeeTeamBereich}
    {#if teamLabel !== null}
      <p class="ts-scope">{teamLabel}</p>
    {/if}
    {#if teamUnavailable}
      <Note tone="info">{TEAM_SALON_UNAVAILABLE_TEXT}</Note>
    {:else}
      <div class="ts card-animate" style="--card-idx: 1;">
        <div data-testid="salon-kpis">
          {#if attendance === null}
            <Skeleton shape="card" />
          {:else}
            <KpiStrip band items={teamKpis} ariaLabel="Heute im Salon in Zahlen" />
          {/if}
        </div>

        <div class="ts-grid">
          <div class="ts-col">
            <section class="ts-sec" id="jetzt" aria-labelledby="ts-now">
              <h2 id="ts-now" class="mt-h2">
                Jetzt im Salon
                <SegmentedControl
                  size="sm"
                  name="ts-status"
                  ariaLabel="Liste filtern"
                  options={attendanceFilterOptions}
                  value={attendanceFilter}
                  onchange={(v) =>
                    goto(statusHref(v), { replaceState: true, noScroll: true, keepFocus: true })}
                />
              </h2>
              {#if attendance === null}
                <Skeleton shape="row" count={4} />
              {:else if nowRows.length === 0}
                <p class="mt-quiet">
                  {attendanceFilter === "alle"
                    ? "Heute ist niemand eingeplant."
                    : "Niemand in dieser Auswahl."}
                </p>
              {:else}
                <List ariaLabel="Jetzt im Salon">
                  {#each nowRows as row (row.id)}
                    <ListRow
                      title={row.name}
                      subtitle={attendanceSubtitle(row)}
                      avatarKey={row.id}
                      href={canOpenTeamDay
                        ? (teamDayHref(row.id, attendance.date) ?? undefined)
                        : undefined}
                    >
                      {#snippet trailing()}
                        <Chip tone={statusTone(row.status)}>{DAY_STATUS_LABEL[row.status]}</Chip>
                      {/snippet}
                    </ListRow>
                  {/each}
                </List>
              {/if}
            </section>
          </div>

          <div class="ts-col">
            {#if canDecideLeave || canDecideRetro}
              <section class="ts-sec" aria-labelledby="ts-tasks">
                <h2 id="ts-tasks" class="mt-h2">
                  Aufgaben <a class="mt-h2-link" href="/team/aufgaben">Alle Aufgaben</a>
                </h2>
                {#if pendingLeave.length === 0 && pendingRetroCount === 0}
                  <p class="mt-quiet">Nichts zu entscheiden.</p>
                {:else}
                  <List ariaLabel="Aufgaben">
                    {#each pendingLeave.slice(0, 5) as req (req.id)}
                      <ListRow
                        variant="task"
                        avatar={false}
                        title={`${leaveTypeLabel(req.typeCode)} · ${req.employee.firstName} ${req.employee.lastName}`}
                        subtitle={`${formatShortDate(req.startDate)} – ${formatShortDate(req.endDate)} · ${leaveDaysLabel(Number(req.days), req.halfDay, req.typeCode)}`}
                      >
                        {#snippet actions()}
                          <button
                            type="button"
                            class="btn btn-outline btn-sm"
                            onclick={() => openReview(req)}>Ablehnen</button
                          >
                          <button
                            type="button"
                            class="btn btn-primary btn-sm"
                            onclick={() => openReview(req)}>Genehmigen</button
                          >
                        {/snippet}
                      </ListRow>
                    {/each}
                    {#if pendingRetroCount > 0}
                      <ListRow
                        avatar={false}
                        title={pendingRetroCount === 1
                          ? "1 Zeitnachtrag wartet"
                          : `${pendingRetroCount} Zeitnachträge warten`}
                        href="/team/aufgaben"
                      />
                    {/if}
                  </List>
                {/if}
              </section>
            {/if}

            <section class="ts-sec" aria-labelledby="ts-upcoming">
              <h2 id="ts-upcoming" class="mt-h2">
                Demnächst abwesend <a class="mt-h2-link" href="/team/abwesenheiten">Kalender</a>
              </h2>
              {#if upcomingLeaves.length === 0}
                <p class="mt-quiet">In den nächsten Wochen ist niemand abwesend.</p>
              {:else}
                <List ariaLabel="Demnächst abwesend">
                  {#each upcomingLeaves as leave (leave.id)}
                    <ListRow
                      title={leave.employeeName}
                      subtitle={`${formatShortDate(leave.startDate)} – ${formatShortDate(leave.endDate)}`}
                      avatarKey={leave.employeeName}
                    >
                      {#snippet trailing()}
                        <span class="mt-row-end">
                          <Chip tone="neutral">{leave.type}</Chip>
                          <span class="mt-quiet"
                            >{leave.days} {leave.days === 1 ? "Tag" : "Tage"}</span
                          >
                        </span>
                      {/snippet}
                    </ListRow>
                  {/each}
                </List>
              {/if}
            </section>
          </div>
        </div>
        {#if teamWeek}
          <section class="ts-sec" aria-labelledby="ts-week">
            <h2 id="ts-week" class="mt-h2">
              Team-Woche
              <span class="ts-h2-meta"
                >KW {getWeekNumber(teamWeek.weekStart)} · {formatShortDate(teamWeek.weekStart)} –
                {formatShortDate(teamWeek.weekEnd)}</span
              >
            </h2>
            <div class="mt-table-wrap">
              <table class="mt-table ts-week" data-testid="team-week">
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    {#each teamWeek.weekDays as d (d)}
                      <th scope="col" class:ts-today={isToday(d)}>
                        {dayLabel(d)}
                        {dayNum(d)}
                      </th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each pagedTeam as member (member.id)}
                    <tr>
                      <td class="ts-name">{member.name}</td>
                      {#each member.days as day (day.date)}
                        {@const href = teamDayHref(member.id, day.date)}
                        <td class="team-grid__cell" class:ts-today={isToday(day.date)}>
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
            </div>
            {#if teamWeek.team.length > TEAM_WEEK_PAGE_SIZE}
              <Pagination
                total={teamWeek.team.length}
                bind:page={teamPage}
                bind:pageSize={teamPageSize}
              />
            {/if}
          </section>
        {/if}
      </div>
      <LeaveReviewDialog
        bind:open={reviewOpen}
        request={reviewRequest}
        currentEmployeeId={$authStore.user?.employeeId ?? null}
        onReviewed={loadTeamTasks}
      />
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
  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
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

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
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
  /* Ab 1800 px (Designkonzept: more columns instead of wider) the four sections sit in one row. */
  @media (min-width: 1800px) {
    .mt-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }
  /* Phone: the stage stays compact so the Kennzahlen reach the first screen (D-01, AC 390×844). */
  @media (max-width: 759.98px) {
    .mt-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .clock-stage {
      gap: var(--s-3);
    }
    .clock-tl-labels {
      display: none;
    }
  }

  /* ── Issue #846: Team › Heute im Salon — layout only ── */
  .ts-scope {
    margin: 0 0 var(--s-2);
    color: var(--text-2);
    font-size: var(--fs-sm);
  }
  .ts {
    display: flex;
    flex-direction: column;
    gap: var(--s-5);
  }
  .ts-grid {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    gap: var(--s-6) var(--s-5);
  }
  .ts-col {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  .ts-sec {
    min-width: 0;
    scroll-margin-top: 64px;
  }
  .ts-h2-meta {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .ts-week th,
  .ts-week td {
    text-align: left;
  }
  .ts-week .ts-name {
    font-weight: 500;
  }
  .ts-week .ts-today {
    background: var(--brand-tint);
  }
  .ts-pill {
    display: inline-block;
    padding: 1px var(--s-2);
    border-radius: var(--r-pill);
    background: var(--sunk);
    font-variant-numeric: tabular-nums;
  }
  .ts-faint {
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .team-grid__link {
    display: block;
    color: inherit;
    text-decoration: none;
    border-radius: var(--r-control);
  }
  .team-grid__link:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  @media (min-width: 1800px) {
    .ts-grid {
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    }
  }
  @media (max-width: 1099.98px) {
    .ts-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
