<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, tick, untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import PageHeader from "$components/ui/PageHeader.svelte";
  import { isEffectiveLeaveStatus } from "$lib/leave/effective-leave-statuses";
  import Card from "$components/ui/Card.svelte";
  import KpiStrip, { type KpiItem } from "$components/ui/KpiStrip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import { matchesSearch } from "$lib/table/search";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // Quick 260824-cjd
  import KarenzAttestPanel from "$lib/components/leave/KarenzAttestPanel.svelte";
  import LeaveLimitNotice from "$lib/components/leave/LeaveLimitNotice.svelte";
  import LeaveLegend from "$lib/components/leave/LeaveLegend.svelte"; // Issue #840 (D-840-10)
  import LeaveToolbar from "$lib/components/leave/LeaveToolbar.svelte"; // Issue #840 (D-840-13, E-01)
  import LeavePlanningPanel from "$lib/components/leave/LeavePlanningPanel.svelte"; // Issue #840 (D-840-16)
  import LeavePlanControls from "$lib/components/leave/LeavePlanControls.svelte"; // Issue #840 (G-6)
  import AbsenceTimeline from "$lib/components/leave/timeline/AbsenceTimeline.svelte"; // Issue #840 (E-05)
  import AbsenceList from "$lib/components/leave/timeline/AbsenceList.svelte"; // Issue #840 (D-840-11)
  import { CALENDAR_LEGEND_STYLES, legendFrom } from "$lib/leave/leave-colors";
  import { warningSentences } from "$lib/leave-limits/sentences";
  import CalendarDayDetail from "$lib/components/leave/CalendarDayDetail.svelte"; // Phase 303-03 (#265's pattern)
  // Phase 415 (#415): the shared create/edit dialog — replaces this page's own copy of the
  // modal, its balance/preview/overlap fetches, and its collision-confirm flow.
  import LeaveRequestForm from "$lib/components/leave/LeaveRequestForm.svelte";
  import {
    summarizeKarenzOverrun,
    karenzOverrunDays,
    KARENZ_NUDGE_EMPTY,
    KARENZ_BADGE_TOOLTIP,
    type KarenzOverrunResponse,
    type KarenzNudgeSummary,
  } from "$lib/leave/karenz-nudge";
  import {
    mapVacationBalance,
    resolveAdjustmentBadge,
    type VacationBalance,
    type VacationEntitlementRow,
    type LastDaysAdjustment,
  } from "$lib/leave/vacation-balance";
  import {
    deriveVacationSummary,
    vacationCardDelta,
    vacationCardLabel,
  } from "$lib/leave/vacation-summary";
  import { resolveChipVisual, isDrawnInCalendar } from "$lib/leave/team-calendar-visibility"; // Phase 262 / 303, Issue #446 (D-04)
  import { leaveDaysLabel, calendarDaysUnit } from "$lib/leave/leave-days-label"; // Issue #595 (D-04)
  import {
    calendarDayLoad,
    calendarRangeQuery,
    calendarToTimeline,
    dayColumns,
    hasMixedWeek,
    periodOf,
    shiftPeriod,
    weekLoad,
    workdaySet,
    werktageBasis,
    type CalendarRangeAnswer,
    type CalendarSalon,
    type TimelinePerson,
    type Zoom,
  } from "$lib/leave/timeline-model"; // Issue #840 (D-840-07)
  import {
    myLeaveSearch,
    parseMyLeaveState,
    type MyLeaveState,
    type MyLeaveTab,
  } from "$lib/leave/area-tabs"; // Issue #840 (D-840-01/02)
  import { pageOfRequest } from "$lib/leave/team-leave-model"; // Issue #840 (E-06)
  import { closedDaysFor } from "$lib/shifts/closed-days"; // Issue #563 (D-03), #840 (D-840-14)
  import { teamSalonViewSalon } from "$lib/dashboard/team-view"; // Issue #82/#558, #840 (D-840-16)
  import { deepLinkSalon } from "$lib/leave-plan/deep-link"; // Issue #835 (WR-07)

  // The types the own calendar can paint, in legend order (#840, D-840-10). The legend names only
  // the ones present in the month in view (`calLegend` below).
  const CALENDAR_LEGEND_TYPE_CODES = [
    "VACATION",
    "OVERTIME_COMP",
    "SICK",
    "SICK_CHILD",
    "SPECIAL",
    "EDUCATION",
  ];

  // ── Typen ─────────────────────────────────────────────────────────────────
  type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";
  type TypeCode =
    | "VACATION"
    | "OVERTIME_COMP"
    | "SPECIAL"
    | "UNPAID"
    | "SICK"
    | "SICK_CHILD"
    | "EDUCATION"
    | "HOLIDAY"
    | "MATERNITY"
    | "PARENTAL";

  interface LeaveRequest {
    id: string;
    employeeId: string;
    typeCode: TypeCode;
    leaveType: { name: string };
    employee: { firstName: string; lastName: string; employeeNumber?: string };
    startDate: string;
    endDate: string;
    days: number;
    halfDay: boolean;
    status: Status;
    note: string | null;
    reviewNote: string | null;
    createdAt: string;
    attestPresent: boolean;
    attestValidFrom: string | null;
    attestValidTo: string | null;
    // Phase 104-10 (D-29): the § 9 case touching this request, if any.
    section9Status?: "AU_PENDING" | "CONFIRMED" | "REJECTED" | null;
    section9CreditId?: string | null;
    // Phase 107-07 (D-12/D-19): set at approval time, server-derived only — see
    // GET /leave/requests' own doc comment for both fields.
    daysProvisional?: boolean | null;
    lastDaysAdjustment?: LastDaysAdjustment | null;
  }

  // typeCode/typeName are null when the server masks this caller from the absence type
  // (Phase 262, D-01) — not a data error. Render a fallback for null, never "fix" it away.
  // ── Konstanten ────────────────────────────────────────────────────────────
  const TYPE_OPTIONS: { code: TypeCode; label: string }[] = [
    { code: "VACATION", label: "Urlaub" },
    { code: "OVERTIME_COMP", label: "Überstundenausgleich" },
    { code: "SPECIAL", label: "Sonderurlaub" },
    { code: "EDUCATION", label: "Bildungsurlaub" },
    { code: "SICK", label: "Krankmeldung" },
    { code: "SICK_CHILD", label: "Kinderkrank" },
    { code: "UNPAID", label: "Unbezahlter Urlaub" },
    { code: "MATERNITY", label: "Mutterschutz" },
    { code: "PARENTAL", label: "Elternzeit" },
  ];

  function typeName(code: TypeCode): string {
    return TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let myRequests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Formular — Phase 415 (#415): the modal's own fields/balances/preview/overlap state moved
  // into the shared `LeaveRequestForm.svelte`. The page keeps only what opens it and what
  // reloads after it saves.
  let showForm = $state(false);
  // Issue #836: sentences of the limit warnings returned by the last create (empty = no notice).
  let limitSentences: string[] = $state([]);
  let editingRequest: LeaveRequest | null = $state(null); // gesetztes Objekt = Bearbeitungsmodus
  // Seeds the dialog's date fields on a fresh CREATE open (calendar drag-select / day click /
  // Enter-Space). Reset to "" by the plain "+ Neue Abwesenheit" button.
  let pendingInitialStart = $state("");
  // Phase 851: „Krank melden“ opens the dialog on SICK, „Urlaub beantragen“ on VACATION.
  let pendingInitialType = $state<"VACATION" | "SICK">("VACATION");

  function openNewRequest(type: "VACATION" | "SICK") {
    editingRequest = null;
    pendingInitialStart = "";
    pendingInitialEnd = "";
    pendingInitialType = type;
    showForm = true;
  }
  let pendingInitialEnd = $state("");

  // Phase 104-10 (D-31): one movement per CONFIRMED § 9 credit in this entitlement year —
  // rendered verbatim (server-authored label), never re-derived on the client.
  // Types + the mapper live in $lib/leave/vacation-balance.ts (dev-pass fix, see that
  // file's doc comment) so every call site maps `section9Movements` the same way and
  // the mapping is unit-testable without mounting this page.
  let vacationBalance = $state<VacationBalance | null>(null);
  // Phase 117 (issue #122, D-03) — initialised `true` so the FIRST painted frame is a skeleton
  // and never an unearned claim about the year on screen. Same rule as Phase 116's `loading`
  // flip on /time-entries. Every exit path of loadVacationSummary clears it.
  let vacSummaryLoading = $state(true);

  // Highlighted request (from notification deep-link)
  let highlightRequestId: string | null = $state(null);

  // Karenztage-Hinweis (Phase 113, issue #116) — see loadKarenzOverrun().
  let karenzSummary = $state<KarenzNudgeSummary>(KARENZ_NUDGE_EMPTY);
  let karenzDays = $state<string[]>([]);

  // Drag-to-select date range in calendar
  let dragStart: string | null = $state(null);
  let dragEnd: string | null = $state(null);
  let isDragging = $state(false);

  function handleDayMouseDown(dateStr: string, isCurrentMonth: boolean) {
    if (!isCurrentMonth) return;
    isDragging = true;
    dragStart = dateStr;
    dragEnd = dateStr;
  }

  function handleDayMouseEnter(dateStr: string) {
    if (!isDragging || !dragStart) return;
    dragEnd = dateStr;
  }

  function handleDayMouseUp() {
    if (!isDragging || !dragStart || !dragEnd) {
      isDragging = false;
      return;
    }
    isDragging = false;
    // Ensure start <= end
    const start = dragStart < dragEnd ? dragStart : dragEnd;
    const end = dragStart < dragEnd ? dragEnd : dragStart;
    pendingInitialStart = start;
    pendingInitialEnd = end;
    editingRequest = null;
    showForm = true;
    dragStart = null;
    dragEnd = null;
  }

  function isDayInDragRange(dateStr: string): boolean {
    if (!isDragging || !dragStart || !dragEnd) return false;
    const start = dragStart < dragEnd ? dragStart : dragEnd;
    const end = dragStart < dragEnd ? dragEnd : dragStart;
    return dateStr >= start && dateStr <= end;
  }

  const SICK_CODES: TypeCode[] = ["SICK", "SICK_CHILD"];

  // ── Kalender ──────────────────────────────────────────────────────────────
  // Phase 104-10 (D-28/D-29): the § 9 marker the server computes per request. The calendar read
  // is own-only since #840, so the marker always belongs to the caller's own request.
  type Section9Marker = "AU_PENDING" | "CONFIRMED" | "SUPERSEDED" | null;

  interface CalEntry {
    id: string;
    isOwn: boolean;
    employeeId: string;
    firstName: string;
    lastName: string;
    typeCode: TypeCode | null;
    typeName: string | null;
    startDate: string;
    endDate: string;
    halfDay: boolean;
    status: Status;
    isHoliday: boolean;
    section9?: Section9Marker;
    section9Days?: string[];
  }

  /** Format a local Date to YYYY-MM-DD without UTC shift */
  function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ── URL state: tab, zoom and anchor day (Issue #840, E-01, D-840-01/02/13) ────────────────────
  // Tab, zoom and anchor come only from `parseMyLeaveState`; a change writes the URL through
  // `navigate` (the back button walks the tabs, a zoom or period change replaces the entry). The
  // viewed year and month are the anchor day's, so every year-bound read follows the URL.
  const today = toLocalDateStr(new Date());
  const urlState: MyLeaveState = $derived(parseMyLeaveState($page.url.searchParams, today));
  // A notification link names a request and no tab: it opens Meine Anträge at that row.
  const activeTab: MyLeaveTab = $derived(
    !urlState.explicitTab && urlState.requestId !== null ? "antraege" : urlState.tab,
  );
  const TAB_IDS: readonly MyLeaveTab[] = ["kalender", "antraege", "team", "planung"];
  // The tabs of the one toolbar; `testId` keeps the names the e2e specs know.
  let openRequestCount = $derived(
    myRequests.filter((r) => r.status === "PENDING" || r.status === "CANCELLATION_REQUESTED")
      .length,
  );

  const toolbarTabs = $derived([
    { id: "kalender", label: "Kalender", testId: "calendar" },
    {
      id: "antraege",
      label: "Anträge",
      testId: "list",
      // Phase 851 (prototype): the own requests still waiting for a decision.
      ...(openRequestCount > 0
        ? {
            badge: openRequestCount,
            badgeLabel: `${openRequestCount} ${openRequestCount === 1 ? "Antrag wartet" : "Anträge warten"} auf eine Entscheidung`,
          }
        : {}),
    },
    { id: "team", label: "Team" },
    { id: "planung", label: "Planung" },
  ]);
  const TIMELINE_ZOOMS: Zoom[] = ["jahr", "quartal", "monat"];

  /** The zoom a tab opens with; read from the one parser, so the defaults live only in `area-tabs`. */
  function defaultZoomOf(tab: MyLeaveTab): Zoom {
    return parseMyLeaveState(new URLSearchParams({ tab }), today).zoom;
  }

  // The month grid is a month, the request list a year; Team and Planung follow the zoom control.
  const activeZoom: Zoom = $derived(
    activeTab === "kalender" ? "monat" : activeTab === "antraege" ? "jahr" : urlState.zoom,
  );
  const activePeriod = $derived(periodOf(activeZoom, urlState.datum));
  const calYear = $derived(Number(urlState.datum.slice(0, 4)));
  const calMonth = $derived(Number(urlState.datum.slice(5, 7))); // 1-12

  function navigate(
    patch: Partial<Pick<MyLeaveState, "tab" | "zoom" | "datum">> & { requestId?: string | null },
    replaceState = false,
  ): Promise<void> {
    // A highlighted request belongs to one navigation; it never rides along.
    const next: MyLeaveState = { ...urlState, tab: activeTab, ...patch, requestId: null };
    return goto(`?${myLeaveSearch(next)}`, { replaceState, keepFocus: true, noScroll: true });
  }

  function selectTab(id: string) {
    const tab = TAB_IDS.find((t) => t === id);
    // A tab opens with its own default zoom; the anchor day carries over.
    if (tab !== undefined && tab !== activeTab) void navigate({ tab, zoom: defaultZoomOf(tab) });
  }

  let calEntries: CalEntry[] = $state([]);
  let calLoading = $state(false);

  function buildCalMap(entries: CalEntry[]): Map<string, CalEntry[]> {
    const map = new Map<string, CalEntry[]>();
    for (const e of entries) {
      const cur = new Date(e.startDate + "T00:00:00");
      const end = new Date(e.endDate + "T00:00:00");
      while (cur <= end) {
        const k = toLocalDateStr(cur);
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(e);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return map;
  }

  interface CalDay {
    date: Date;
    dateStr: string;
    dayNum: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isWeekend: boolean;
  }

  function buildCalDays(y: number, m: number): CalDay[] {
    const days: CalDay[] = [];
    const first = new Date(y, m - 1, 1);
    // Woche beginnt Montag: 0=Mo..6=So
    let startDow = first.getDay(); // 0=So
    startDow = startDow === 0 ? 6 : startDow - 1;

    const todayStr = toLocalDateStr(new Date());

    // Vortage aus Vormonat
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(y, m - 1, -i);
      days.push(mkCalDay(d, false, todayStr));
    }
    // Aktueller Monat
    const lastDay = new Date(y, m, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      days.push(mkCalDay(new Date(y, m - 1, d), true, todayStr));
    }
    // Folgetage um letzte Woche zu vervollständigen
    const lastDowMo = (new Date(y, m - 1, lastDay).getDay() + 6) % 7;
    const remaining = (7 - ((lastDowMo + 1) % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      days.push(mkCalDay(new Date(y, m - 1, lastDay + i), false, todayStr));
    }
    return days;
  }

  function mkCalDay(d: Date, isCurrentMonth: boolean, todayStr: string): CalDay {
    const dateStr = toLocalDateStr(d);
    const dow = d.getDay();
    return {
      date: d,
      dateStr,
      dayNum: d.getDate(),
      isCurrentMonth,
      isToday: dateStr === todayStr,
      isWeekend: dow === 0 || dow === 6,
    };
  }

  // ── Kalender (Issue #840, E-03, D-840-24): the caller's OWN absences and the holidays ────────
  // The read carries `scope=own`, so the server returns no colleague row at all; nothing is
  // filtered on the client (T-840-35).
  let calGeneration = 0;

  async function loadCalendar() {
    const generation = ++calGeneration;
    calLoading = true;
    try {
      const rows = await api.get<CalEntry[]>(
        `/leave/calendar?year=${calYear}&month=${calMonth}&scope=own`,
      );
      if (generation !== calGeneration) return;
      calEntries = rows;
    } catch {
      if (generation !== calGeneration) return;
      calEntries = [];
    } finally {
      if (generation === calGeneration) calLoading = false;
    }
  }

  // The legend names only what the month in view contains: the types of the own bars and, when a
  // request is still open, the dashed style (E-03: no colleague is drawn here).
  const calLegend = $derived.by(() => {
    const drawn = calEntries.filter((e) => isDrawnInCalendar(e));
    const present = new Set(drawn.flatMap((e) => (e.typeCode ? [e.typeCode as string] : [])));
    const known = CALENDAR_LEGEND_TYPE_CODES.filter((code) => present.has(code));
    const other = [...present].filter((code) => !CALENDAR_LEGEND_TYPE_CODES.includes(code)).sort();
    const open = drawn.some((e) => e.status === "PENDING" || e.status === "CANCELLATION_REQUESTED");
    return {
      typeCodes: [...known, ...other],
      styles: open ? CALENDAR_LEGEND_STYLES.filter((style) => style === "beantragt") : [],
    };
  });

  // ── Team (Issue #840, E-03, E-05, D-840-16): neutral and read-only ────────────────────────────
  // `scope=team` makes the server mask every foreign absence to name and period (the neutral
  // word); the page never sends a salon, the server uses the caller's own Stammsalon. A bar here
  // opens nothing: the timeline gets no select or drag callback.
  let teamRows: TimelinePerson[] = $state([]);
  let teamHolidays: Array<{ day: string; name: string }> = $state([]);
  let teamSalons: CalendarSalon[] = $state([]);
  let teamLoading = $state(false);
  let teamGeneration = 0;

  async function loadTeam() {
    const generation = ++teamGeneration;
    teamLoading = true;
    try {
      const answer = await api.get<CalendarRangeAnswer>(
        `/leave/calendar?${calendarRangeQuery(activePeriod)}&scope=team`,
      );
      if (generation !== teamGeneration) return;
      const timeline = calendarToTimeline(answer.entries);
      teamRows = timeline.rows;
      teamHolidays = timeline.holidays;
      teamSalons = answer.salons ?? [];
    } catch {
      // A failed read is an empty view, no alert: the tab is context, not a task.
      if (generation !== teamGeneration) return;
      teamRows = [];
      teamHolidays = [];
      teamSalons = [];
    } finally {
      if (generation === teamGeneration) teamLoading = false;
    }
  }

  /** Below 768 px the list replaces the timeline (D-840-11). */
  let isMobile = $state(false);

  // Closed days only for ONE salon in view (D-840-14); with several the legend says why none are drawn.
  const teamClosedDays = $derived(closedDaysFor(teamSalons, $salonContext));
  // The Werktage basis is decided once (D-840-08): null = Mon-Sat when no single salon with hours is in view.
  const teamWerktage = $derived(werktageBasis(teamClosedDays, teamSalons));
  const LOAD_HINT =
    "Personen mit genehmigter oder beantragter Abwesenheit – Wünsche der Planung zählen nicht";
  const CLOSED_DAYS_HINT = "Schließtage nur bei einem Salon";

  const teamLoad = $derived.by(() => {
    if (activePeriod.zoom === "jahr") {
      return {
        kind: "week" as const,
        counts: weekLoad(teamRows, activePeriod.year, workdaySet(teamWerktage), teamHolidays),
        hint: LOAD_HINT,
      };
    }
    return {
      kind: "day" as const,
      counts: calendarDayLoad(
        teamRows,
        dayColumns(activePeriod).map((column) => column.day),
      ),
      hint: LOAD_HINT,
    };
  });

  const teamLegend = $derived.by(() => {
    const base = legendFrom(teamRows);
    const daily = activePeriod.zoom !== "jahr";
    return {
      typeCodes: base.typeCodes,
      styles: base.styles,
      markings: {
        weekend: daily,
        holiday: daily && teamHolidays.length > 0,
        closed: daily && teamClosedDays.days.size > 0,
        today: daily,
        // Issue 840 G-4: „Mehrere Arten“ only in Jahr and only when such a week is in view.
        mixed:
          !daily &&
          hasMixedWeek(teamRows, activePeriod.year, workdaySet(teamWerktage), teamHolidays),
      },
      closedHint: teamClosedDays.hint ? CLOSED_DAYS_HINT : null,
    };
  });

  // ── Planung (Issue #840, E-03, D-840-16/23) ───────────────────────────────────────────────────
  // The own plan wishes next to the team, on the same timeline: the panel runs in `own` mode (the
  // neutral reading, no person choice, no manage controls). The salon is the header selection
  // exactly as on the team page; without exactly one salon the panel shows its empty state.
  const contextLoaded = $derived($salonContext.loaded);
  const planSalonId = $derived(teamSalonViewSalon($salonContext));
  // Issue 840 G-6: the panel reports status, deadline and the add action; the toolbar shows them.
  // The shape is spelled the same in the panel, in LeavePlanControls and here (no type module).
  let planControls = $state<null | {
    statusLabel: string;
    statusOpen: boolean;
    deadlineText: string | null;
    canAdd: boolean;
    add: () => void;
  }>(null);
  $effect(() => {
    if (activeTab !== "planung") planControls = null;
  });

  // Deep link (WR-07): the LEAVE_PLAN_OPENED notice links with `?salonId=…`. Once the salon context
  // is loaded, a salon the caller reaches is preselected in the header selection, then the
  // parameter is dropped from the URL; an unreachable id is ignored (the API validates anyway).
  let salonDeepLinkHandled = false;
  $effect(() => {
    if (!contextLoaded || salonDeepLinkHandled) return;
    const param = $page.url.searchParams.get("salonId");
    untrack(() => {
      salonDeepLinkHandled = true;
      if (param === null) return;
      const linked = deepLinkSalon(param, $salonContext);
      if (linked !== null) salonContext.setSelection(linked);
      const url = new URL($page.url);
      url.searchParams.delete("salonId");
      void goto(url, { replaceState: true, noScroll: true, keepFocus: true });
    });
  });

  // ── Laden ─────────────────────────────────────────────────────────────────
  // The deep-link target is read once on mount; the scroll and highlight run after the first
  // completed load, because the rows do not exist before it.
  let deepLinkRequestId: string | null = null;
  let firstLoadDone = false;

  onMount(() => {
    deepLinkRequestId = urlState.requestId;
    loadKarenzOverrun();
  });

  onMount(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    isMobile = query.matches;
    const onChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  // The year-bound reads (the request list, the sick days, the entitlement figures) follow the
  // anchor day's year, whatever moved it: the toolbar, the back button or a deep link. This effect
  // is the one place that reacts to a year change (D-02, issue #122; the superseded-response
  // guards live in the loaders).
  $effect(() => {
    void calYear;
    untrack(() => {
      void (async () => {
        await loadData();
        if (!firstLoadDone) {
          firstLoadDone = true;
          runDeepLink();
        }
      })();
      void loadVacationSummary(calYear);
    });
  });

  const calKey = $derived(`${calYear}-${calMonth}`);
  $effect(() => {
    if (activeTab !== "kalender") return;
    void calKey;
    untrack(() => {
      void loadCalendar();
    });
  });

  const teamKey = $derived(`${activePeriod.startDay}|${activePeriod.endDay}`);
  $effect(() => {
    if (activeTab !== "team") return;
    void teamKey;
    untrack(() => {
      void loadTeam();
    });
  });

  /** After a write: the year-bound reads, the calendar, and the team view while it is in view. */
  async function reloadAll() {
    await Promise.all([
      loadData(),
      loadCalendar(),
      loadVacationSummary(calYear),
      activeTab === "team" ? loadTeam() : Promise.resolve(),
    ]);
  }

  /** Pages to, marks and scrolls to one request of the Meine-Anträge list; never navigates. */
  function focusRequest(requestId: string) {
    const at = pageOfRequest(
      filteredMyRequests.map((req) => req.id),
      requestId,
      myReqPageSize,
    );
    if (at !== null) myReqPage = at;
    highlightRequestId = requestId;
    void tick().then(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`request-${requestId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    // Clear highlight after 3 seconds
    setTimeout(() => {
      highlightRequestId = null;
    }, 3000);
  }

  function runDeepLink() {
    // Deep-link: highlight a specific request from a notification (Meine Anträge only).
    const requestId = deepLinkRequestId;
    if (requestId && activeTab === "antraege") focusRequest(requestId);
  }

  let dataGeneration = 0;

  async function loadData() {
    const generation = ++dataGeneration;
    loading = true;
    error = "";
    try {
      const myEmployeeId = $authStore.user?.employeeId;
      const mine = await api.get<LeaveRequest[]>(
        `/leave/requests?year=${calYear}${myEmployeeId ? `&employeeId=${myEmployeeId}` : ""}`,
      );
      if (generation !== dataGeneration) return;
      myRequests = mine;
      void loadSickDaysYear(calYear);
    } catch (e: unknown) {
      if (generation !== dataGeneration) return;
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      if (generation === dataGeneration) loading = false;
    }
  }

  // ── Karenztage-Hinweis (Phase 113, issue #116) ────────────────────────────
  // Fed from GET /leave/karenz-overrun (self-scoped, server-derived 12-month window) and
  // NOT from `myRequests`: that list is filtered to ONE calYear server-side
  // (leave.ts:734-737) and paginated at 10 rows, so a January visitor's overrun from the
  // previous year would silently vanish from the explanation. Fail-safe: any error renders
  // nothing, exactly like the dashboard nudge (dashboard/+page.svelte:452-460).
  async function loadKarenzOverrun() {
    try {
      const res = await api.get<KarenzOverrunResponse>("/leave/karenz-overrun");
      karenzSummary = summarizeKarenzOverrun(res);
      karenzDays = karenzOverrunDays(res);
    } catch {
      karenzSummary = KARENZ_NUDGE_EMPTY;
      karenzDays = [];
    }
  }

  /**
   * Phase 117 (issue #122) — loads the entitlement figures for ONE year: the year the page is
   * currently showing. `year` is REQUIRED and has no default on purpose. The previous signature
   * took no parameter and read `new Date().getFullYear()` internally, so the tiles under the
   * heading „Urlaubsjahr 2025" were the 2026 figures. A forgotten argument must be a compile
   * error, never a silent fallback to „heute" — that fallback IS the bug.
   *
   */
  async function loadVacationSummary(year: number) {
    vacSummaryLoading = true;
    // D-03 — while we are finding out, show nothing rather than the other year's numbers.
    // Clearing the state (instead of only hiding the strip) covers EVERY reader of
    // `vacationBalance` in one move: the Kachelleiste, the Urlaubskonto-Karte (which renders
    // its „–" placeholder at `remaining === null`) and the form's Urlaubskonto-Panel.
    vacationBalance = null;
    const userId = $authStore.user?.employeeId;
    if (!userId) {
      vacSummaryLoading = false;
      return;
    }
    try {
      const entitlements = await api.get<VacationEntitlementRow[]>(
        `/leave/entitlements/${userId}?year=${year}`,
      );
      // Paging the selector twice quickly leaves two responses in flight. Dropping the
      // superseded one is what stops the numbers and the heading from disagreeing again —
      // last-response-wins would reintroduce this very bug on a fast double-click.
      if (year !== calYear) return;
      const vac = entitlements.find((e) => e.typeCode === "VACATION");
      vacationBalance = mapVacationBalance(vac);
    } catch {
      /* silent */
    } finally {
      // Only the response for the year currently on screen may clear the skeleton; a superseded
      // response must leave it up for the request that is still in flight.
      if (year === calYear) vacSummaryLoading = false;
    }
  }

  // ── Antrag zurückziehen / Stornierung beantragen ──────────────────────────
  // Quick 260824-cjd: Storno now requires a Begründung — routed through a
  // ReasonDialog rather than fired directly from the row buttons.
  let cancelDialogOpen = $state(false);
  let cancelDialogRequest = $state<LeaveRequest | null>(null);
  let cancelDialogTitle = $derived(
    cancelDialogRequest?.status === "APPROVED" ? "Stornierung beantragen?" : "Antrag zurückziehen?",
  );

  function openCancelDialog(req: LeaveRequest) {
    cancelDialogRequest = req;
    cancelDialogOpen = true;
  }

  async function cancelRequest(id: string, reason: string) {
    await api.delete(`/leave/requests/${id}`, { reason });
    await reloadAll();
  }

  async function confirmCancelDialog(reason: string) {
    if (!cancelDialogRequest) return;
    try {
      await cancelRequest(cancelDialogRequest.id, reason);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler";
      throw e;
    }
  }

  // ── Antrag bearbeiten (Formular öffnen) ───────────────────────────────────
  function openEditForm(req: LeaveRequest) {
    editingRequest = req;
    showForm = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Helfer ────────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function statusClass(s: Status) {
    return s === "APPROVED"
      ? "badge-green"
      : s === "PENDING"
        ? "badge-yellow"
        : s === "REJECTED"
          ? "badge-red"
          : s === "CANCELLATION_REQUESTED"
            ? "badge-orange"
            : "badge-gray";
  }

  function statusLabel(s: Status) {
    return s === "APPROVED"
      ? "Genehmigt"
      : s === "PENDING"
        ? "Ausstehend"
        : s === "REJECTED"
          ? "Abgelehnt"
          : s === "CANCELLATION_REQUESTED"
            ? "Stornierung beantragt"
            : "Zurückgezogen";
  }

  // ── Lane assignment: stable gantt-style rows across calendar days ────────
  // Returns a Map<absenceId, laneIndex> so that a multi-day absence always
  // occupies the same vertical row in every day cell it spans.
  interface LaneResult {
    laneById: Map<string, number>;
    totalLanes: number;
  }

  function buildLaneMap(entries: CalEntry[]): LaneResult {
    // Only the absences that will actually be rendered (mirrors the per-cell filter)
    const visible = entries.filter((e) => isDrawnInCalendar(e));

    // Deterministic sort: startDate → lastName → firstName → id
    const sorted = [...visible].sort((a, b) => {
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      const aName = `${a.lastName ?? ""}\0${a.firstName ?? ""}`;
      const bName = `${b.lastName ?? ""}\0${b.firstName ?? ""}`;
      if (aName !== bName) return aName < bName ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    // laneEnd[L] = the endDate of the last absence placed in lane L
    const laneEnd: string[] = [];
    const laneById = new Map<string, number>();

    for (const e of sorted) {
      let placed = false;
      for (let l = 0; l < laneEnd.length; l++) {
        // Absence fits in lane l when the lane's last endDate is strictly before this startDate
        if (laneEnd[l] < e.startDate) {
          laneById.set(e.id, l);
          laneEnd[l] = e.endDate;
          placed = true;
          break;
        }
      }
      if (!placed) {
        const l = laneEnd.length;
        laneById.set(e.id, l);
        laneEnd.push(e.endDate);
      }
    }

    return { laneById, totalLanes: laneEnd.length };
  }

  // Abgeleiteter Kalender: Map<dateStr, CalEntry[]>
  let calMap = $derived(buildCalMap(calEntries));
  let calDays = $derived(buildCalDays(calYear, calMonth));
  let calLanes = $derived(buildLaneMap(calEntries));

  // ── Day detail (GitHub issue #303, D-02/D-09) ─────────────────────────────
  // Below 700px the bar's type label is hidden, so the type would be carried by colour alone.
  // Tapping the corner target spells the types out. The trigger is a real <button> inside the
  // cell, so touch and keyboard (Enter/Space) both reach it, and `Modal` owns Escape. Unlike
  // #265's whole-cell trigger on /team/leave, this page's cell is already the create-a-request
  // control (drag-select, Enter/Space opens the form) — D-09 fixes a corner target instead of
  // the whole cell, so that interaction survives (see the trigger markup below).
  let dayDetailDate = $state<string | null>(null);
  let dayDetailOpen = $state(false);

  /** The tapped day's bars — the same filter the cell's `dayAbsences` and the lane map apply. */
  let dayDetailEntries = $derived(
    (dayDetailDate ? (calMap.get(dayDetailDate) ?? []) : []).filter((e) => isDrawnInCalendar(e)),
  );

  function openDayDetail(dateStr: string) {
    dayDetailDate = dateStr;
    dayDetailOpen = true;
  }

  // ── Urlaubszusammenfassung (über dem Kalender) ────────────────────────────
  let pendingVacDays = $derived(
    myRequests
      .filter((r) => r.typeCode === "VACATION" && r.status === "PENDING")
      .reduce((sum, r) => sum + Number(r.days), 0),
  );
  // Issue #595 (D-04): the sick days of the viewed year in CALENDAR days, counted by the server's
  // sick-day kernel (the same one the monthly report and both PDFs use) - the page counts nothing
  // itself. `null` while unknown or when the read failed (the KPI then shows a dash).
  let sickDaysYear: number | null = $state(null);

  async function loadSickDaysYear(year: number) {
    try {
      const res = await api.get<{ year: number; sickDays: number }>(
        `/leave/sick-days?year=${year}`,
      );
      if (year === calYear) sickDaysYear = res.sickDays;
    } catch {
      if (year === calYear) sickDaysYear = null;
    }
  }
  // Phase 114 — every Urlaubs-Größe on this page comes from ONE pinned pure function
  // (apps/web/src/lib/leave/vacation-summary.ts). The formulas are a verbatim copy of the
  // inline $derived expressions that used to live here; a legacy-oracle test asserts they
  // still produce identical numbers. Do not re-inline them.
  let vacSummary = $derived(deriveVacationSummary(vacationBalance, pendingVacDays));
  let vacSummaryTotal = $derived(vacSummary.total);
  let vacSummaryCarryOver = $derived(vacSummary.carryOver);
  let vacSummaryUsed = $derived(vacSummary.used);
  let vacSummaryPlanned = $derived(vacSummary.planned);
  let vacSummaryCarryOverRemaining = $derived(vacSummary.carryOverRemaining);
  let vacSummaryLeft = $derived(vacSummary.left);

  let showVacSummary = $state(true);
  // Phase 114: `vacSummary.remaining` is `number | null` — the null branch is what makes the
  // Urlaubskonto-Karte render "–" instead of a fake "0". Do NOT add `?? 0`. Declared here
  // (after `vacSummary`, not where the template renders it) — this is a pre-existing
  // declaration-order finding (unrelated to Issue #447) surfaced by this plan's svelte-check
  // gate: `$derived` is lazily evaluated at runtime regardless of script position, but the
  // static checker still flags a forward reference as "used before declaration".
  let vacRemaining = $derived(vacSummary.remaining);

  // Issue #851 (D-851-04): the figures of the Kennzahlenleiste - the same values and wording the former
  // three cards showed (vacationCardLabel / vacationCardDelta, calendarDaysUnit for sick days, #595).
  // Phase 851 (prototype): the next own approved vacation, for the „Genommen“ cell.
  let nextVacation = $derived(
    myRequests
      .filter(
        (r) =>
          r.typeCode === "VACATION" &&
          isEffectiveLeaveStatus(r.status) &&
          r.startDate.slice(0, 10) >= today,
      )
      .sort((x, y) => x.startDate.localeCompare(y.startDate))[0] ?? null,
  );
  // A carry-over deadline is only news while it lies ahead.
  let carryDeadlineAhead = $derived(
    vacationBalance?.carryOverDeadline && vacationBalance.carryOverDeadline.slice(0, 10) >= today
      ? vacationBalance.carryOverDeadline.slice(0, 10)
      : null,
  );
  function shortDate(iso: string): string {
    const [, m, d] = iso.slice(0, 10).split("-");
    return `${Number(d)}.${Number(m)}.`;
  }

  // Issue #851 (D-851-04, prototype): the four figures of the Kennzahlenleiste. Resturlaub keeps the
  // tested wording (vacationCardLabel / vacationCardDelta), the others read the same summary
  // (deriveVacationSummary) and the sick-day kernel (#595) - nothing is recomputed here.
  let balanceItems = $derived<KpiItem[]>([
    {
      label: vacationCardLabel(vacSummaryPlanned),
      value: vacRemaining === null ? "–" : vacRemaining,
      unit: (vacRemaining ?? 0) === 1 ? "Tag" : "Tage",
      delta: vacationBalance
        ? vacationCardDelta(vacationBalance.total, vacationBalance.carryOver)
        : undefined,
    },
    {
      // `used` counts approved days still ahead as well, so the label says so.
      label: "Genommen & genehmigt",
      value: vacationBalance ? vacSummaryUsed : "–",
      unit: vacSummaryUsed === 1 ? "Tag" : "Tage",
      explanation: nextVacation
        ? `nächster: ${shortDate(nextVacation.startDate)}–${shortDate(nextVacation.endDate)}`
        : "kein Urlaub geplant",
    },
    {
      label: "Verfällt",
      value: !vacationBalance ? "–" : carryDeadlineAhead ? vacSummaryCarryOverRemaining : 0,
      unit: (carryDeadlineAhead ? vacSummaryCarryOverRemaining : 0) === 1 ? "Tag" : "Tage",
      explanation: carryDeadlineAhead
        ? `Übertrag verfällt am ${shortDate(carryDeadlineAhead)}${carryDeadlineAhead.slice(0, 4)}`
        : "kein Übertrag offen",
    },
    {
      label: "Krankheitstage",
      value: sickDaysYear === null ? "–" : sickDaysYear,
      unit: calendarDaysUnit(sickDaysYear ?? 0),
      explanation: `in ${calYear}`,
    },
  ]);

  // ── iCal-Download ────────────────────────────────────────────────────────
  let icalDownloading = $state(false);

  async function downloadIcal(endpoint: "personal" | "team") {
    icalDownloading = true;
    try {
      const auth = $authStore;
      const res = await fetch(`/api/v1/leave/ical/${endpoint}`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!res.ok) throw new Error("Download fehlgeschlagen");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = endpoint === "team" ? "clokr-team-abwesenheiten.ics" : "clokr-abwesenheiten.ics";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Download";
    } finally {
      icalDownloading = false;
    }
  }

  // Filters for list view
  let filterLeaveStatus = $state<Status | "">("");
  let filterLeaveType = $state<TypeCode | "">("");

  // Pagination for Meine Anträge list
  let myReqPage = $state(1);
  let myReqPageSize = $state(10);

  // Issue #851 (D-851-04): the search of the table toolbar (type, period, note).
  let myReqQuery = $state("");

  let filteredMyRequests = $derived(
    myRequests.filter((req) => {
      if (filterLeaveStatus && req.status !== filterLeaveStatus) return false;
      if (filterLeaveType && req.typeCode !== filterLeaveType) return false;
      const haystack = [
        typeName(req.typeCode),
        fmtDate(req.startDate),
        fmtDate(req.endDate),
        statusLabel(req.status),
        req.note ?? "",
      ].join(" ");
      return matchesSearch(haystack, myReqQuery);
    }),
  );

  const MY_REQ_STATUS_OPTIONS: { value: Status; label: string }[] = [
    { value: "PENDING", label: "Ausstehend" },
    { value: "APPROVED", label: "Genehmigt" },
    { value: "REJECTED", label: "Abgelehnt" },
    { value: "CANCELLED", label: "Storniert" },
    { value: "CANCELLATION_REQUESTED", label: "Stornierung beantragt" },
  ];

  let myReqFilters = $derived<ToolbarFilter[]>([
    { key: "status", label: "Status", options: MY_REQ_STATUS_OPTIONS, value: filterLeaveStatus },
    {
      key: "type",
      label: "Art",
      options: TYPE_OPTIONS.map((t) => ({ value: t.code, label: t.label })),
      value: filterLeaveType,
    },
  ]);

  function onMyReqFilter(key: string, value: string) {
    if (key === "status") filterLeaveStatus = value as Status | "";
    if (key === "type") filterLeaveType = value as TypeCode | "";
  }

  function resetMyReqFilters() {
    myReqQuery = "";
    filterLeaveStatus = "";
    filterLeaveType = "";
  }

  const MY_REQ_COLUMNS: DataTableColumn[] = [
    { key: "type", label: "Art", primary: true },
    { key: "period", label: "Zeitraum" },
    { key: "days", label: "Tage", align: "end" },
    { key: "status", label: "Status" },
    { key: "note", label: "Anmerkung" },
    { key: "actions", label: "Aktionen", align: "end" },
  ];

  let pagedMyRequests = $derived(
    filteredMyRequests.slice((myReqPage - 1) * myReqPageSize, myReqPage * myReqPageSize),
  );

  $effect(() => {
    filteredMyRequests.length;
    myReqPage = 1;
  });
</script>

<svelte:head>
  <title>{pageLabel("/leave")} – Clokr</title>
</svelte:head>

<svelte:window onmouseup={handleDayMouseUp} />

<!-- Phase 73-04 (D-05): `data-testid="leave-page"` is the stable surface anchor.
     Wrapped via `display:contents` so the marker contributes nothing to layout
     but Playwright (and future visual-regression specs) can address the page
     root without keying off CSS class hashes. -->
<div data-testid="leave-page" style="display: contents">
  <!-- ── Header — Phase 851 (prototype „Ich › Abwesenheiten“): the two things a person files ─── -->
  <PageHeader
    title={pageLabel("/leave")}
    subtitle="Urlaub, Krankmeldungen und deine Wünsche für die Urlaubsplanung"
  >
    {#snippet actions()}
      {#if !showForm}
        <button
          data-testid="leave-report-sick"
          class="btn btn-secondary btn-sm"
          onclick={() => openNewRequest("SICK")}>Krank melden</button
        >
        <button
          data-testid="leave-new-request"
          class="btn btn-primary btn-sm"
          onclick={() => openNewRequest("VACATION")}>Urlaub beantragen</button
        >
      {/if}
    {/snippet}
  </PageHeader>

  {#if error}
    <div class="alert alert-error" role="alert" data-testid="leave-page-error">
      <span>⚠</span><span>{error}</span>
    </div>
  {/if}

  <!-- ── Kennzahlen — Phase 851 (prototype): Resturlaub, Genommen, Verfällt, Krankheitstage. The
       hours account lives in Ich › Konto now (#594), so this page shows no saldo. `Resturlaub` keeps its
       one meaning (Phase 114, RU-01/02/04): label from vacationCardLabel(). -->
  <div data-testid="leave-balance">
    <KpiStrip ariaLabel="Urlaub und Krankheitstage" items={balanceItems} />
  </div>

  <!-- ── The one toolbar: tabs, period, zoom (Issue #840, E-01, D-840-13) ─────────────────── -->
  <!-- The KPI cards above stay on every tab. The tab ids are the URL's (`tab=`); the test ids keep
       the names the e2e specs know (`leave-view-calendar`, `leave-view-list`). -->
  {#snippet plannerControls()}
    {#if planControls}<LeavePlanControls controls={planControls} />{/if}
  {/snippet}
  <LeaveToolbar
    ariaLabel="Abwesenheiten"
    tabs={toolbarTabs}
    {activeTab}
    onTabChange={selectTab}
    period={activePeriod}
    zooms={activeTab === "team" || activeTab === "planung" ? TIMELINE_ZOOMS : []}
    zoom={activeZoom}
    onZoomChange={(zoom) => void navigate({ zoom }, true)}
    onShift={(step) =>
      void navigate({ datum: shiftPeriod(activeZoom, urlState.datum, step) }, true)}
    onToday={() => void navigate({ datum: today }, true)}
    filters={activeTab === "planung" ? plannerControls : undefined}
    testIdPrefix="leave-view"
  />

  <!-- ── Neuer Antrag (Modal) ─────────────────────────────────────────────────── -->
  <!-- Phase 415 (#415): the shared create/edit dialog. `employeeId` is always the caller's own
       here (`/leave` has no person-picker concept); `entitlementYear` mirrors `calYear` so the
       dialog's Resturlaub box and this page's own KPI strip agree on the same accounting year,
       even though the two are now independent reads of the same endpoint (see the component's
       own doc comment for why that is safe). -->
  <LeaveRequestForm
    bind:open={showForm}
    employeeId={$authStore.user?.employeeId ?? ""}
    {editingRequest}
    initialStartDate={pendingInitialStart}
    initialEndDate={pendingInitialEnd}
    initialType={pendingInitialType}
    entitlementYear={calYear}
    onSaved={async (result) => {
      // Issue #836: limit warnings of the create — shown, never blocking.
      limitSentences = warningSentences(result?.leaveLimitWarnings ?? []);
      await reloadAll();
    }}
  />

  <!-- ── Übergreifend: Austritts-Hinweis (Server, § 5 Abs. 3 BUrlG) + Urlaubsübersicht (beide
       Tabs) ──────── Issue #447 (D-06/D-08): the hint text is built once on the server
       (exitVacationOverUseWarning) and rendered verbatim here — no client-side pro-rata
       re-calculation, no reclaim wording. -->
  {#if vacationBalance?.exitOverUseWarningMessage}
    <div class="alert alert-warning card-animate" role="status">
      {vacationBalance.exitOverUseWarningMessage}
    </div>
  {/if}
  <!-- Phase 113 (issue #116) — the destination explanation the „Attest"-Hinweis deep-links
       to. Above BOTH views: the page is reachable from the nav and from the calendar, and
       the explanation is equally relevant there. Renders nothing when there is no overrun. -->
  <KarenzAttestPanel label={karenzSummary.label} days={karenzDays} />
  <!-- Issue #836 (AC-5): non-blocking hint after a request exceeded a leave limit. -->
  <LeaveLimitNotice sentences={limitSentences} onDismiss={() => (limitSentences = [])} />
  <!-- Phase 117 (issue #122, D-03) — while the entitlement figures for the selected year are in
       flight, the strip shows a skeleton, never the numbers of the year we just left. Same rule
       and same recipe as Phase 116's /time-entries list skeleton: the global `.skeleton` shimmer
       from app.css, aria-hidden, only the geometry is page-scoped. Four tiles is the strip's
       usual width; the two Übertrag tiles are conditional, so the placeholder count is
       deliberately approximate — it is a shimmer, not a claim. -->

  <!-- ── Kalender (Issue #840, E-03): the caller's own absences and the holidays ────────────── -->
  {#if activeTab === "kalender"}
    <div role="tabpanel" id="leave-panel-kalender" aria-labelledby="leave-tab-kalender">
      <!-- The entitlement figures of the viewed year; a year switch shows the skeleton, never the
           numbers of the year just left (issue #122). -->

      <div class="cal-section card card-animate">
        <!-- Wochentag-Header -->
        <div class="cal-grid cal-header-row">
          {#each ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as wd (wd)}
            <div class="cal-dow">{wd}</div>
          {/each}
        </div>

        <!-- Tage -->
        {#if calLoading}
          <div class="cal-grid">
            {#each Array(35) as _, i (i)}<div class="cal-cell skeleton"></div>{/each}
          </div>
        {:else}
          <div class="cal-grid">
            {#each calDays as day (day.dateStr)}
              {@const entries = calMap.get(day.dateStr) ?? []}
              {@const holidays = entries.filter((e) => e.isHoliday)}
              {@const dayAbsences = entries.filter((e) => isDrawnInCalendar(e))}
              {@const isHoliday = holidays.length > 0}
              {@const _dow = new Date(day.dateStr + "T00:00:00").getDay()}
              <div
                class="cal-cell"
                class:cal-current={day.isCurrentMonth}
                class:cal-other={!day.isCurrentMonth}
                class:cal-today={day.isToday}
                class:cal-weekend={day.isWeekend && day.isCurrentMonth}
                class:cal-holiday={isHoliday && day.isCurrentMonth}
                class:cal-cell--drag-selected={isDayInDragRange(day.dateStr)}
                role={day.isCurrentMonth ? "button" : undefined}
                tabindex={day.isCurrentMonth ? 0 : undefined}
                onmousedown={() => handleDayMouseDown(day.dateStr, day.isCurrentMonth)}
                onmouseenter={() => handleDayMouseEnter(day.dateStr)}
                onkeydown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && day.isCurrentMonth) {
                    e.preventDefault();
                    pendingInitialStart = day.dateStr;
                    pendingInitialEnd = day.dateStr;
                    editingRequest = null;
                    showForm = true;
                  }
                }}
              >
                <span class="cal-day-num">{day.dayNum}</span>
                {#if isHoliday && day.isCurrentMonth}
                  <div class="cal-holiday-label" title={holidays[0].typeName ?? ""}>
                    {holidays[0].firstName}
                  </div>
                {/if}
                <div class="cal-chips">
                  {#each Array(calLanes.totalLanes) as _, laneIdx (laneIdx)}
                    {@const e = dayAbsences.find((a) => calLanes.laneById.get(a.id) === laneIdx)}
                    {#if e}
                      {@const _isBarStart = day.dateStr === e.startDate || _dow === 1}
                      {@const _isBarEnd = day.dateStr === e.endDate || _dow === 0}
                      {@const _showLabel = day.dateStr === e.startDate || _dow === 1}
                      <!-- #840 (E-03): every bar here is the caller's own (`scope=own`), so the type is always theirs
                         to see; the flag is false on purpose, which makes a row that is not theirs
                         (it cannot arrive) render neutral instead of naming a type. -->
                      {@const _vis = resolveChipVisual(e, false)}
                      <!-- Phase 104-10 (D-28/D-29): the § 9 marker only applies to the SPECIFIC
                         days the server named in section9Days — a multi-day bar can be
                         partially marked. -->
                      {@const _section9OnDay = !!(
                        e.section9 && e.section9Days?.includes(day.dateStr)
                      )}
                      <div
                        class="cal-chip"
                        class:cal-chip--bar-start={_isBarStart && !_isBarEnd}
                        class:cal-chip--bar-end={!_isBarStart && _isBarEnd}
                        class:cal-chip--bar-middle={!_isBarStart && !_isBarEnd}
                        class:cal-chip--pending={e.status === "PENDING" ||
                          e.status === "CANCELLATION_REQUESTED"}
                        class:cal-chip--own={e.isOwn}
                        class:cal-chip--section9-superseded={_section9OnDay &&
                          e.section9 === "SUPERSEDED"}
                        style:background={_vis.background}
                        style:color={_vis.textColor}
                        title="{e.firstName} {e.lastName}{_vis.typeLabel
                          ? ' · ' + _vis.typeLabel
                          : ''}{e.status === 'PENDING' ? ' (ausstehend)' : ''}"
                      >
                        {#if _showLabel}
                          <span class="cal-chip-name">{e.firstName}</span>
                          <span class="cal-chip-type">{_vis.chipLabel}</span>
                        {/if}
                        {#if _section9OnDay && (e.section9 === "CONFIRMED" || e.section9 === "AU_PENDING")}
                          {@const _isConfirmedSection9 = e.section9 === "CONFIRMED"}
                          <span
                            class="section9-chip-badge"
                            class:section9-chip-badge--pending={!_isConfirmedSection9}
                            data-testid="section9-cell-badge"
                            title={_isConfirmedSection9
                              ? "§ 9 BUrlG — nicht auf den Jahresurlaub angerechnet"
                              : "AU ausstehend — ohne ärztliche Bescheinigung bleiben diese Urlaubstage angerechnet"}
                          >
                            <span class="sr-only"
                              >{_isConfirmedSection9
                                ? "§ 9 BUrlG — nicht auf den Jahresurlaub angerechnet: "
                                : "AU ausstehend — ohne ärztliche Bescheinigung bleiben diese Urlaubstage angerechnet: "}</span
                            >{_isConfirmedSection9 ? "§ 9" : "AU"}
                          </span>
                        {/if}
                      </div>
                    {:else}
                      <div class="cal-chip-placeholder"></div>
                    {/if}
                  {/each}
                </div>
                <!-- Tap target for the day-detail sheet (#303, D-09). Shown only below 700px —
                   see `.cal-day-tap` in the style block — because that is where the bar's type
                   label leaves the screen and where no finger can open a `title` tooltip.
                   UNLIKE #265's whole-cell trigger on /team/leave, this is a CORNER target
                   only: the cell here is already the create-a-request control (drag-select via
                   onmousedown/onmouseenter, Enter/Space via onkeydown, completed by the
                   page-level window onmouseup above), so a whole-cell overlay would sit on top
                   of that primary action and — because mousedown still bubbles — fire both the
                   sheet and the new-request modal. Propagation is stopped below on both
                   mousedown and keydown so this trigger cannot co-fire either handler. -->
                {#if dayAbsences.length > 0}
                  <button
                    type="button"
                    class="cal-day-tap"
                    data-testid="leave-cal-day-tap"
                    aria-label="Abwesenheiten am {fmtDate(day.dateStr)} anzeigen"
                    onclick={() => openDayDetail(day.dateStr)}
                    onmousedown={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                  >
                    <span class="cal-day-tap-hint" aria-hidden="true">i</span>
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Legend: the one component; the types are the ones this calendar paints (#840, D-840-10). -->
        <LeaveLegend
          typeCodes={calLegend.typeCodes}
          styles={calLegend.styles}
          markings={{ holiday: true }}
          holidayLook="calendar"
        />
      </div>

      <!-- iCal-Download -->
      <div class="ical-section">
        <div class="ical-header">
          <span class="ical-icon">📥</span>
          <div>
            <p class="ical-title">Kalender exportieren</p>
            <p class="ical-desc">
              Abwesenheiten als .ics-Datei herunterladen (Outlook, Google Calendar, Apple Kalender)
            </p>
          </div>
        </div>
        <div class="ical-actions">
          <button
            class="btn btn-ghost btn-sm"
            onclick={() => downloadIcal("personal")}
            disabled={icalDownloading}
            aria-busy={icalDownloading}
          >
            {#if icalDownloading}<Spinner />{/if}
            Meine Abwesenheiten
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onclick={() => downloadIcal("team")}
            disabled={icalDownloading}
            aria-busy={icalDownloading}
          >
            {#if icalDownloading}<Spinner />{/if}
            Team-Abwesenheiten
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ── Meine Anträge: the year's own requests (Issue #840) ─────────────────────────────────── -->
  {#if activeTab === "antraege"}
    <div role="tabpanel" id="leave-panel-antraege" aria-labelledby="leave-tab-antraege">
      <!-- ── Anträge-Tabelle — Issue #851 (D-851-04): toolbar and table from the blocks ──────── -->
      <h2 class="leave-section-title card-animate">Meine Anträge</h2>

      {#if loading}
        <Skeleton shape="card" lines={3} />
      {:else}
        <div class="card-animate" data-testid="leave-filters">
          <TableToolbar
            bind:query={myReqQuery}
            count={filteredMyRequests.length}
            total={myRequests.length}
            filters={myReqFilters}
            onFilterChange={onMyReqFilter}
            onReset={resetMyReqFilters}
            searchLabel="Anträge durchsuchen"
          />
        </div>

        {#if myRequests.length === 0}
          <div data-testid="leave-empty-state">
            <EmptyState
              icon="calendar"
              title="Keine Anträge in {calYear}"
              description="Wähle ein anderes Jahr oder lege einen neuen Antrag an."
            />
          </div>
        {:else}
          <div data-testid="leave-mine-table">
            <DataTable
              caption="Meine Anträge {calYear}"
              columns={MY_REQ_COLUMNS}
              rows={pagedMyRequests}
              rowKey={(req) => req.id}
              rowTestId={(req) => `leave-mine-row-${req.id}`}
              rowId={(req) => `request-${req.id}`}
              rowHighlight={(req) => highlightRequestId === req.id}
              filtered={filteredMyRequests.length === 0}
              onResetFilters={resetMyReqFilters}
            >
              {#snippet cell(req, column)}
                {@const isOwn = req.employeeId === $authStore.user?.employeeId}
                {#if column.key === "type"}
                  {typeName(req.typeCode)}
                {:else if column.key === "period"}
                  {req.startDate === req.endDate
                    ? fmtDate(req.startDate)
                    : `${fmtDate(req.startDate)} – ${fmtDate(req.endDate)}`}
                {:else if column.key === "days"}
                  {leaveDaysLabel(Number(req.days), req.halfDay, req.typeCode)}
                {:else if column.key === "status"}
                  <span
                    class="badge {statusClass(req.status)}"
                    data-testid={`leave-mine-row-${req.id}-status-badge`}
                    >{statusLabel(req.status)}</span
                  >
                  {#if req.lastDaysAdjustment}
                    {@const adjBadge = resolveAdjustmentBadge(req.lastDaysAdjustment)!}
                    <!-- Phase 107-07 (D-19/D-21): persistent — NOT tied to the triggering
                           bell-notification's read/dismissed state, always the latest
                           adjustment only. Reading order: status, then this, then Vorläufig
                           (UI-SPEC §Visual Hierarchy — this reports something that
                           happened, Vorläufig only a standing condition). -->
                    <span
                      class={adjBadge.badgeClass}
                      data-testid={`leave-mine-row-${req.id}-adjustment-badge`}
                      title={adjBadge.tooltip}
                    >
                      {adjBadge.icon} Angepasst: {adjBadge.direction === "up"
                        ? "+"
                        : "−"}{#if adjBadge.bold}<strong>{adjBadge.delta}</strong
                        >{:else}{adjBadge.delta}{/if} Tag(e)
                    </span>
                  {/if}
                  {#if req.daysProvisional}
                    <!-- Phase 107-07 (D-12): --warn tone, NOT --bad/row-invalid — a
                           provisional request is fully valid and payable today. -->
                    <span
                      class="badge badge-yellow"
                      data-testid={`leave-mine-row-${req.id}-provisional-badge`}
                      title="Verbrauch vorläufig geschätzt — wird angepasst, sobald der Schichtplan für diesen Zeitraum steht."
                    >
                      Vorläufig
                    </span>
                  {/if}
                  {#if SICK_CODES.includes(req.typeCode) && req.status === "APPROVED"}
                    <span
                      class="badge badge-attest {req.attestPresent ? 'badge-green' : 'badge-gray'}"
                      title={req.attestPresent ? "Attest liegt vor." : KARENZ_BADGE_TOOLTIP}
                    >
                      {req.attestPresent ? "Attest" : "Kein Attest"}
                    </span>
                  {/if}
                  <!-- Phase 104-10 (D-29): § 9 status alongside the existing SICK badge —
                         also shown on the overlapping VACATION row so a manager can see the
                         case from either side. Text label carries the meaning, not colour
                         alone (Phase-97 UAT lesson). -->
                  {#if req.section9Status === "AU_PENDING"}
                    <span class="badge badge-yellow" data-testid="section9-list-badge">
                      AU ausstehend
                    </span>
                  {:else if req.section9Status === "CONFIRMED"}
                    <span class="badge badge-gray" data-testid="section9-list-badge">
                      § 9 gutgeschrieben
                    </span>
                  {:else if req.section9Status === "REJECTED"}
                    <span class="badge badge-gray" data-testid="section9-list-badge">
                      AU abgelehnt
                    </span>
                  {/if}
                {:else if column.key === "note"}
                  <span class="note-cell text-muted">
                    {#if req.status === "REJECTED" && req.reviewNote}
                      <span class="text-red" title={req.reviewNote}>⚠ {req.reviewNote}</span>
                    {:else}
                      {req.note ?? "—"}
                    {/if}
                  </span>
                {:else}
                  <div class="action-cell__group">
                    {#if isOwn && req.status === "PENDING"}
                      <button
                        data-testid={`leave-mine-row-${req.id}-edit`}
                        class="btn btn-sm btn-ghost"
                        onclick={() => openEditForm(req)}>Bearbeiten</button
                      >
                      <button
                        data-testid={`leave-mine-row-${req.id}-withdraw`}
                        class="btn btn-sm btn-ghost text-red"
                        onclick={() => openCancelDialog(req)}>Zurückziehen</button
                      >
                    {/if}
                    {#if isOwn && req.status === "APPROVED"}
                      <button
                        data-testid={`leave-mine-row-${req.id}-cancel`}
                        class="btn btn-sm btn-ghost text-red"
                        onclick={() => openCancelDialog(req)}>Stornieren</button
                      >
                    {/if}
                  </div>
                {/if}
              {/snippet}
            </DataTable>
            <Pagination
              total={filteredMyRequests.length}
              bind:page={myReqPage}
              bind:pageSize={myReqPageSize}
            />
          </div>
        {/if}
      {/if}
    </div>
  {/if}<!-- Ende Liste -->

  <!-- ── Team (Issue #840, E-03/E-05): who of my salon is away, never why ────────────────────── -->
  {#if activeTab === "team"}
    <div role="tabpanel" id="leave-panel-team" aria-labelledby="leave-tab-team">
      <div class="card card-animate overview-card" data-testid="leave-team-overview">
        <LeaveLegend
          typeCodes={teamLegend.typeCodes}
          styles={teamLegend.styles}
          markings={teamLegend.markings}
          closedHint={teamLegend.closedHint}
        />
        {#if teamRows.length === 0 && teamLoading}
          <Skeleton shape="block" height="240px" />
        {:else if teamRows.length === 0}
          <p class="overview-empty" data-testid="leave-team-empty">
            Keine Abwesenheiten in diesem Zeitraum.
          </p>
        {:else if isMobile}
          <AbsenceList rows={teamRows} period={activePeriod} holidays={teamHolidays} />
        {:else}
          <AbsenceTimeline
            rows={teamRows}
            period={activePeriod}
            holidays={teamHolidays}
            closedWeekdays={teamWerktage}
            {today}
            load={teamLoad}
            onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}
          />
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Planung (Issue #840, E-03, D-840-16/23): the own wishes next to the team ──────────────
       The panel is mounted OUTSIDE every animated block (#570); `mode="own"` is the neutral
       reading: own wishes editable, colleagues neutral, no person choice, no manage controls. -->
  {#if activeTab === "planung"}
    <div role="tabpanel" id="leave-panel-planung" aria-labelledby="leave-tab-planung">
      {#if !contextLoaded}
        <Skeleton shape="card" lines={3} />
      {:else}
        <LeavePlanningPanel
          mode="own"
          salonId={planSalonId}
          period={activePeriod}
          {today}
          onControls={(controls) => (planControls = controls)}
          onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}
        />
      {/if}
    </div>
  {/if}

  <!-- ── Quick 260824-cjd: Storno-Begründung (Zurückziehen / Stornierung) ────── -->
  <ReasonDialog
    bind:open={cancelDialogOpen}
    title={cancelDialogTitle}
    confirmLabel="Bestätigen"
    danger
    onConfirm={confirmCancelDialog}
  />

  <!-- ── Day detail (#303): the absence types of one day, in plain text ───────
       Opened by the `.cal-day-tap` button in the calendar cell. The role rule from #257 is
       enforced inside the component's shared module, not here (D-10). -->
  <CalendarDayDetail
    bind:open={dayDetailOpen}
    dateLabel={dayDetailDate ? fmtDate(dayDetailDate) : ""}
    entries={dayDetailEntries}
    canSeeType={false}
  />
</div>

<!-- /leave-page -->

<style>
  /* ── Form (inside Modal primitive) ──────────────────────────────── */
  .form-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .form-group--full {
    grid-column: 1 / -1;
  }

  .form-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding-top: 0.25rem;
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
  }
  .toggle-cb {
    width: 1rem;
    height: 1rem;
    accent-color: var(--brand);
  }

  /* ── Overlap ──────────────────────────────────────────────────────── */
  .overlap-box {
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.875rem 1rem;
  }
  .overlap-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
    margin: 0 0 0.5rem;
  }
  .overlap-empty {
    font-size: 0.9375rem;
    margin: 0;
  }
  .overlap-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .overlap-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.9375rem;
  }
  .overlap-name {
    font-weight: 600;
  }
  .overlap-type {
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .overlap-dates {
    font-family: var(--font-ui);
    font-size: 0.875rem;
    margin-left: auto;
  }

  /* ── Table ────────────────────────────────────────────────────────── */
  .text-center {
    text-align: center;
  }
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8125rem;
  }
  .text-red {
    color: var(--bad);
  }
  .note-cell {
    display: inline-block;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Issue #442 — flex layout lives on the inner wrapper, never on the td itself, so the cell
     keeps display: table-cell and lines up with the rest of the row even when empty. */
  .action-cell__group {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    flex-wrap: wrap;
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */
  .btn-danger {
    background: var(--bad);
    color: var(--card);
    border: none;
    border-radius: 8px;
    padding: 0.5rem 1.25rem;
    font-size: 0.9375rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-danger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    font-size: 1rem;
    color: var(--text-2);
  }

  /* ── Balance Box ──────────────────────────────────────────────────── */
  .balance-box {
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.875rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .balance-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    font-size: 0.9375rem;
  }
  .balance-label {
    color: var(--text-2);
  }
  .balance-value {
    font-weight: 600;
    font-family: var(--font-ui);
  }
  .balance-meta {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-2);
    margin-left: 0.25rem;
  }
  .balance-deduct {
    color: var(--text-2);
  }
  .balance-warn {
    color: var(--bad);
  }
  .balance-divider {
    height: 1px;
    background: var(--line);
    margin: 0.125rem 0;
  }
  .balance-hint-warn {
    font-size: 0.8125rem;
    color: var(--bad);
    margin: 0.25rem 0 0;
  }
  /* Phase 100 (D-10) — warn tone: a standing account-state signal ("your
     confirmed balance already exceeds the configured tolerance"), distinct
     from the --bad hint above ("this specific request would be rejected").
     Do not merge these two or retone one into the other. */
  .balance-hint-notice {
    font-size: 0.8125rem;
    color: var(--warn);
    margin: 0.25rem 0 0;
  }
  /* Phase 97-06 (SALDO-DISP-04) — the forecast row: muted like
     the forecast everywhere else in the app (never --ok/--bad/--warn — colour
     must never imply a certainty this figure doesn't have). */
  .balance-value--muted {
    color: var(--text-2);
  }
  .balance-hint-muted {
    font-size: 0.8125rem;
    color: var(--text-2);
    margin: 0.25rem 0 0;
  }

  /* ── View Tabs ────────────────────────────────────────────────────── */
  /* view-tabs, view-tab, tab-badge → global in app.css */

  /* ── Period control ───────────────────────────────────────────────────
     The period switcher is the one LeaveToolbar (#840); the page has no month bar of its own. */

  /* The entitlement strip of the viewed year (Kalender and Meine Anträge). */
  .leave-section-title {
    font-size: var(--fs-h2);
    font-weight: 600;
    color: var(--text);
    margin: 0;
  }

  /* The Team tab's card around the legend and the read-only timeline (same recipe as the team area). */
  .overview-card {
    padding: 0.75rem;
    margin-bottom: 1rem;
  }
  .overview-empty {
    margin: 0;
    padding: 1.5rem 1rem;
    text-align: center;
    color: var(--text-2);
    font-size: 0.875rem;
  }

  /* ── Days-Info Bar ────────────────────────────────────────────────── */
  .days-info-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: var(--brand-soft);
    border: 1px solid var(--brand-soft);
    border-radius: 8px;
    padding: 0.5rem 0.875rem;
    font-size: 0.9375rem;
    color: var(--brand);
  }
  .days-info-icon {
    font-size: 1rem;
  }
  .days-info-note {
    font-size: 0.8125rem;
    opacity: 0.75;
    margin-left: 0.25rem;
  }
  .days-info-loading {
    color: var(--text-2);
    font-size: 0.875rem;
  }

  /* ── Kalender ─────────────────────────────────────────────────────── */
  /* .cal-grid + .cal-cell base recipe inherited from app.css (v1.5 canonical).
     See CLAUDE.md UI Consistency Rules: per-page overrides forbidden. */

  .cal-grid {
    user-select: none;
  }

  .cal-loading {
    opacity: 0.5;
    pointer-events: none;
  }

  .cal-cell--drag-selected {
    background: var(--brand-soft) !important;
    box-shadow: inset 0 0 0 2px var(--brand);
  }
  .cal-cell--drag-selected {
    background: var(--brand-soft) !important;
    box-shadow: inset 0 0 0 2px var(--brand);
  }

  .cal-day-num {
    z-index: 1;
  }

  .cal-chips {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 2px;
    flex: 1;
    min-height: 0;
    overflow: visible;
    margin: 0 -0.4rem;
  }
  /* Empty lane placeholder — reserves the row height so occupied lanes above/below
     keep their stable vertical position across adjacent day cells. */
  .cal-chip-placeholder {
    height: 22px;
    flex-shrink: 0;
  }
  .cal-chip {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 2px 0.4rem;
    border-radius: 4px;
    /* Fallback only: the chip sets the fill's own text partner inline (#842, D-842-08). */
    color: var(--card);
    font-size: 0.75rem;
    line-height: 1.4;
    overflow: hidden;
    cursor: default;
    min-height: 18px;
  }
  .cal-chip--bar-start {
    border-radius: 4px 0 0 4px;
    margin-right: -1.5px;
    height: 22px;
  }
  .cal-chip--bar-end {
    border-radius: 0 4px 4px 0;
    margin-left: -1.5px;
    height: 22px;
  }
  .cal-chip--bar-middle {
    border-radius: 0;
    margin-left: -1.5px;
    margin-right: -1.5px;
    height: 22px;
  }
  .cal-chip--pending {
    outline: 1.5px dashed color-mix(in srgb, var(--card) 70%, transparent);
    outline-offset: -2px;
    opacity: 0.9;
  }
  .cal-chip-name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 60px;
  }
  .cal-chip-type {
    font-size: 0.6875rem;
    opacity: 0.85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Day-detail trigger (#303, D-09) ─────────────────────────────────
     Above the breakpoint the bar prints the type itself and a pointer can open the `title`
     tooltip, so the button does not exist there — `display: none` also keeps it out of the tab
     order, which is why its visibility and its reachability cannot drift apart. The media block
     at the bottom of this file turns it on, as a CORNER target only (not #265's whole-cell
     trigger — this page's cell is already the create-a-request control, see D-09 below). */
  .cal-day-tap {
    display: none;
  }

  /* Phase 104-10 (D-28): a confirmed § 9 credit overlays this vacation day — the entry
     stays discoverable but visibly loses to the SICK entry (reduced emphasis, same
     opacity idiom as .cal-chip--pending above, no new colour token). */
  .cal-chip--section9-superseded {
    opacity: 0.5;
  }

  /* Phase 104-10 (D-28/D-29): compact § 9 marker inside a calendar chip. Text label
     ("§ 9" / "AU") carries the meaning — never colour/symbol alone (Phase-97 UAT lesson) —
     the sr-only span above it spells out the full sentence for assistive tech. */
  .section9-chip-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-left: auto;
    padding: 0 3px;
    border-radius: 3px;
    font-size: 0.5625rem;
    font-weight: 700;
    line-height: 1.3;
    background: color-mix(in srgb, var(--card) 35%, transparent);
  }
  .section9-chip-badge--pending {
    background: var(--warn-soft);
    color: var(--warn);
    outline: 1px dashed var(--warn);
    outline-offset: -1px;
  }

  /* Phase 104-10 (D-31): the Urlaubskonto movement list — one line per CONFIRMED § 9
     credit, rendered verbatim from the server. */
  .section9-movements {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .section9-movement {
    font-size: 0.8125rem;
    color: var(--text-2);
  }

  /* Legende */
  /* #840 D-840-10: the legend is LeaveLegend.svelte. */
  .badge-attest {
    margin-left: 0.25rem;
    font-size: 0.75rem;
  }
  /* ── iCal ────────────────────────────────────────────────────────── */
  .ical-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0.875rem 1.25rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
  }
  .ical-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }
  .ical-icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }
  .ical-title {
    font-size: 0.875rem;
    font-weight: 600;
    margin: 0;
    color: var(--text);
  }
  .ical-desc {
    font-size: 0.8125rem;
    color: var(--text-2);
    margin: 0;
  }
  /* Wraps and may shrink to its widest button: at 320 px the two buttons side by side were
     wider than the page (Issue #564). */
  .ical-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-width: 0;
  }

  /* ── Responsive ───────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .form-grid {
      grid-template-columns: 1fr 1fr;
    }
    .overlap-dates {
      margin-left: 0;
    }
    /* The bar is too narrow here for the type name, so the label leaves the EYES — but not the
       accessibility tree. This is app.css's `.sr-only` recipe, inlined because a class cannot be
       added by viewport width; `display: none` (what stood here before #303) took the type away
       from screen readers too. What replaces it visually is `.cal-day-tap` below. */
    .cal-chip-type {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }
    .cal-day-tap {
      display: flex;
      position: absolute;
      /* D-09: the containing block is app.css's `.cal-cell { position: relative }`. Unlike
         #265's whole-cell trigger (`inset: 0`) this box is deliberately a CORNER, not the cell —
         this page's cell already runs the create-a-request interaction (drag-select on
         mousedown/mouseenter, Enter/Space on keydown, completed by the page-level window
         mouseup), and an overlay covering the whole cell would sit on top of that primary
         action, firing both the day-detail sheet and the new-request modal because mousedown
         still bubbles. Only `top`/`right` are set — `bottom`/`left` stay unset on purpose, so
         the box cannot stretch across the cell the way `inset: 0` would. */
      top: 0;
      right: 0;
      z-index: 2;
      align-items: center;
      justify-content: center;
      /* Both minimums are asserted here, unlike the whole-cell variant on /team/leave: that one
         borrows its 44px height for free from the `.cal-cell` recipe (min-height: 86px); a
         corner box has no such floor, so width AND height each need their own 44px minimum. */
      min-width: 44px;
      min-height: 44px;
      padding: 4px;
      background: transparent;
      border: 0;
      border-radius: var(--r-control);
      cursor: pointer;
      appearance: none;
    }
    .cal-day-tap:focus-visible {
      outline: 2px solid var(--brand);
      outline-offset: -2px;
    }
    /* The affordance. A bar nobody knows is tappable is no remedy at all, and a touch device
       offers no hover or cursor to hint with — so the hint is drawn. It says "there is more
       here", not WHICH type: one glyph for every day, never a per-type symbol set (the symbol
       option was weighed and rejected in #265, reused here per D-02). */
    .cal-day-tap-hint {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      background: var(--card);
      border: 1px solid var(--line);
      color: var(--text-2);
      font-family: var(--font-ui);
      font-size: 0.625rem;
      font-weight: 700;
      line-height: 1;
    }
  }
  @media (max-width: 480px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
