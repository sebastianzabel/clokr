<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { onMount, tick, untrack } from "svelte";
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import Pagination from "$components/ui/Pagination.svelte";
  import PageTabs from "$components/ui/PageTabs.svelte"; // Issue #853 (D-853-18)
  import PeriodSwitcher from "$components/ui/PeriodSwitcher.svelte"; // Issue #853 (D-853-11)
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableRowTone,
  } from "$components/ui/DataTable.svelte"; // Issue #853 (D-853-18)
  import Chip, { type ChipTone } from "$components/ui/Chip.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import { matchesSearch } from "$lib/table/search";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // Quick 260824-ef6
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import { isSalonFilterRejected, salonPageFilter, withSalonId } from "$lib/salons/page-scope"; // Issue #558 (D-03/D-04/D-09)
  import AttestFields from "$lib/components/leave/AttestFields.svelte"; // Phase 201
  import {
    resolveStornoAction,
    stornoDialogCopy,
    stornoSuccessToast,
    type StornoKind,
  } from "$lib/leave/storno"; // Quick 260824-ef6
  import {
    LEAVE_TYPE_OPTIONS,
    SICK_CODES,
    type CalendarTypeCode,
  } from "$lib/leave/team-calendar-visibility"; // Phase 257, Phase 262, #269, Issue #446 (D-04)
  import { leaveDaysLabel } from "$lib/leave/leave-days-label"; // Issue #595 (D-04)
  import { parseLeaveCreateDeepLink, type LeaveCreateDeepLink } from "$lib/leave/create-deep-link"; // Issue #587
  import LeaveLegend from "$lib/components/leave/LeaveLegend.svelte"; // Issue #840 (D-840-10)
  import LeaveTypeChip from "$lib/components/leave/LeaveTypeChip.svelte"; // Issue #840 (G-3)
  import LeavePlanningPanel from "$lib/components/leave/LeavePlanningPanel.svelte"; // Issue #840 (D-840-17)
  import LeavePlanControls from "$lib/components/leave/LeavePlanControls.svelte"; // Issue #840 (G-6)
  import { legendFrom } from "$lib/leave/leave-colors";
  import AbsenceTimeline from "$lib/components/leave/timeline/AbsenceTimeline.svelte"; // Issue #840
  import AbsenceList from "$lib/components/leave/timeline/AbsenceList.svelte"; // Issue #840 (D-840-11)
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
    type TimelineBar,
    type TimelinePerson,
    type Zoom,
  } from "$lib/leave/timeline-model"; // Issue #840 (D-840-07)
  import {
    parseTeamLeaveState,
    teamLeaveSearch,
    type LeaveStatusFilter,
    type TeamLeaveState,
    type TeamLeaveTab,
  } from "$lib/leave/area-tabs"; // Issue #840 (D-840-01/02)
  import {
    emptyRequestsText,
    inLeaderReach,
    locateDeepLinkedRequest,
    matchesStatusFilter,
    openRequestsSummary,
    overviewPersons,
    pageOfRequest,
    requestsForStatus,
  } from "$lib/leave/team-leave-model"; // Issue #840 (E-06)
  import { closedDaysFor } from "$lib/shifts/closed-days"; // Issue #563 (D-03), #840 (D-840-14)
  import { teamSalonViewSalon } from "$lib/dashboard/team-view"; // Issue #82/#558, #840 (D-840-17)
  import { deepLinkSalon } from "$lib/leave-plan/deep-link"; // Issue #835 (WR-07)
  import { resolveAdjustmentBadge, type LastDaysAdjustment } from "$lib/leave/vacation-balance"; // Phase 107-07
  // Phase 415 (#415): the shared create/edit dialog — replaces this page's own copy of the
  // create modal, its collision-confirm flow, and the mutation itself.
  import LeaveRequestForm from "$lib/components/leave/LeaveRequestForm.svelte";
  // Issue #468 (D-12, A-2): "Elternzeit-Kürzung erklären" row action on an approved PARENTAL
  // request.
  import LeaveLimitNotice from "$lib/components/leave/LeaveLimitNotice.svelte";
  import { exceedanceDescription, warningSentences } from "$lib/leave-limits/sentences";
  import {
    exceedancesOf,
    isLeaveLimitExceptionRequired,
    validateExceptionReason,
  } from "$lib/leave-limits/exception"; // Issue #836 (AC-7)
  import {
    exceededDaysFromLoad,
    limitBadgeTitle,
    type ExceededDay,
  } from "$lib/leave-limits/calendar-load"; // Issue #836 (AC-10)
  import type { LeaveLimitLoadResponse } from "$lib/leave-limits/types";
  import ParentalReductionDialog from "$lib/components/leave/ParentalReductionDialog.svelte";
  import { showsParentalReductionAction } from "$lib/leave/parental-reduction";
  import { halfDayRangeError, endDateForHalfDay } from "$lib/leave/half-day"; // Issue #449 (D-4)

  // ── Typen ─────────────────────────────────────────────────────────────────
  type Status = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CANCELLATION_REQUESTED";
  // Phase 257: the union now lives with the colour/label table it belongs to.
  type TypeCode = CalendarTypeCode;

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
    // Phase 107-07 (D-12/D-19): set at approval time, server-derived only — see
    // GET /leave/requests' own doc comment for both fields.
    daysProvisional?: boolean | null;
    lastDaysAdjustment?: LastDaysAdjustment | null;
  }

  // ── Konstanten ────────────────────────────────────────────────────────────
  function typeName(code: TypeCode): string {
    return LEAVE_TYPE_OPTIONS.find((t) => t.code === code)?.label ?? code;
  }

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let employees: Employee[] = $state([]);
  let allTeamRequests: LeaveRequest[] = $state([]);
  let pendingRequests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // Issue #558: the header salon narrows every list of this page. The page decides only through
  // `salonPageFilter` (never the store's raw selection); the loaders read `pageSalonId` when they
  // are called and one effect below reruns them on a change. The approval queue is filtered with
  // the visible reference (D-09, the label names it); the inbox stays unfiltered because a work
  // queue must never hide a due approval, and the overlap check of the review dialog stays
  // tenant-wide decision support.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  // #840 (D-840-14): the page shows no salon label of its own; the header selection is the one
  // salon display, and a rejected salon only gets a calm sentence (no alert).
  let salonRejected = $state(false);
  // Plain lets: an older response never overwrites a newer one (not reactive on purpose).
  let dataGeneration = 0;
  // #840 G-1: the open count has its own loader so it shows on every tab as soon as it is known.
  let openGeneration = 0;

  // Korrektur-Modal (EDIT-05): Manager korrigiert einen bereits GENEHMIGTEN Antrag
  let correctModal: LeaveRequest | null = $state(null);
  let correctOpen = $state(false);
  let correctStart = $state("");
  let correctEnd = $state("");
  let correctType: TypeCode = $state("VACATION");
  let correctHalfDay = $state(false);
  let correctNote = $state("");
  // Quick 260824-cjd: mandatory Begründung — separate from the optional Antragsnotiz
  // above, which stays as-is (correctNote is never sent as `reason`).
  let correctReason = $state("");
  let correctSaving = $state(false);
  let correctError = $state("");
  // Issue #449 (D-4): the effective half-day flag the modal and submitCorrection both reason
  // about — SICK types never carry a half day (partial incapacity to work does not exist as a
  // legal concept), independent of whatever correctHalfDay itself currently holds.
  let correctHalfDayEffective = $derived(correctHalfDay && !SICK_CODES.includes(correctType));

  // ── Attest-Nachtrag (Phase 201 / Issue #201) ──────────────────────────────
  // A separate action, NOT a field in the Korrigieren-Modal: PATCH /correct carries the
  // delta-lock guard and a mandatory Begründung, and an Attest needs neither — it moves no
  // day and is explicitly allowed after the Monatsabschluss (owner decision 2026-09-14).
  let attestModal = $state<LeaveRequest | null>(null);
  let attestOpen = $state(false);
  let attestPresent = $state(false);
  let attestFrom = $state("");
  let attestTo = $state("");
  let attestSaving = $state(false);
  let attestError = $state("");

  // ── Elternzeit-Kürzung (Issue #468, D-12/A-2) ────────────────────────────────
  // A separate action, like Attest-Nachtrag above: it mounts its own dialog (not a field in the
  // Korrigieren-Modal), gets its own preview from the server and never computes a number itself.
  let parentalModal: LeaveRequest | null = $state(null);
  let parentalOpen = $state(false);

  function openParentalReduction(req: LeaveRequest) {
    parentalModal = req;
    parentalOpen = true;
  }

  // Quick 260824-ef6: Storno-Button (Zurückziehen / Stornierung beantragen) in der
  // Anträge-Tabelle. `resolveStornoAction` gates which button (if any) a row gets;
  // see apps/web/src/lib/leave/storno.ts for the full decision matrix and reasoning.
  let stornoRequest = $state<LeaveRequest | null>(null);
  let stornoOpen = $state(false);
  let stornoKind: StornoKind | null = $derived(
    stornoRequest
      ? resolveStornoAction(
          stornoRequest.status,
          stornoRequest.employeeId === $authStore.user?.employeeId,
        )
      : null,
  );
  let stornoCopy = $derived(stornoKind ? stornoDialogCopy(stornoKind) : null);

  function openStorno(req: LeaveRequest) {
    stornoRequest = req;
    stornoOpen = true;
  }

  async function confirmStorno(reason: string) {
    if (!stornoRequest || !stornoKind) return;
    const kind = stornoKind;
    // Both API shapes are safe here: 204 (PENDING -> CANCELLED) yields undefined from
    // the client, 200 (APPROVED -> CANCELLATION_REQUESTED) yields a body. We read
    // neither. Do NOT wrap this in a try/catch that swallows: ReasonDialog needs the
    // throw to keep itself open and surface the server message inline.
    await api.delete(`/leave/requests/${stornoRequest.id}`, { reason });
    await reloadAll();
    toasts.success(stornoSuccessToast(kind));
  }

  // Highlighted request (from notification deep-link)
  let highlightRequestId: string | null = $state(null);

  // ── Manager-on-behalf-of: Neue Abwesenheit anlegen ───────────────────────
  // Phase 415 (#415): the create dialog itself — fields, balances, preview, overlap, the
  // collision-confirm flow, and the mutation — moved into the shared `LeaveRequestForm.svelte`.
  // The page keeps only the person picker (its one addition, Phase 415 D-03) and what opens it.
  let createModalOpen = $state(false);
  // Issue #836: sentences of the limit warnings returned by the last create (empty = no notice).
  let limitSentences: string[] = $state([]);
  let createEmployeeId = $state("");
  // Preserves this page's pre-existing default (today/today) as the shared component's initial
  // date props — the component itself defaults to blank when these are omitted (matching
  // `/leave`'s own default). Set once per openCreate() call, not reactive.
  let createInitialDate = $state("");

  // ── URL state: tab, zoom and anchor day (Issue #840, E-01, D-840-01/02/13/17) ────────────────
  // Tab, zoom and anchor come only from `parseTeamLeaveState`; a change writes the URL through
  // `navigate` (the back button walks the tabs, a zoom or period change replaces the entry).
  function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const today = toLocalDateStr(new Date());
  const urlState: TeamLeaveState = $derived(parseTeamLeaveState($page.url.searchParams, today));
  const activeTab: TeamLeaveTab = $derived(urlState.tab);
  const TAB_IDS: readonly TeamLeaveTab[] = ["uebersicht", "antraege", "planung"];
  const TIMELINE_ZOOMS: Zoom[] = ["jahr", "quartal", "monat"];

  /** The period of the two timeline tabs (Übersicht, Planung). */
  const overviewPeriod = $derived(periodOf(urlState.zoom, urlState.datum));
  /** The period the toolbar shows: the Anträge list is bound to a year, so its switcher steps by year. */
  const toolbarPeriod = $derived(
    activeTab === "antraege" ? periodOf("jahr", urlState.datum) : overviewPeriod,
  );
  const listYear = $derived(Number(urlState.datum.slice(0, 4)));

  function navigate(
    patch: Partial<Pick<TeamLeaveState, "tab" | "zoom" | "datum" | "status" | "allSalons">> & {
      requestId?: string | null;
    },
    replaceState = false,
  ): Promise<void> {
    // A highlighted request and a status filter belong to one navigation; neither rides along.
    const next: TeamLeaveState = { ...urlState, ...patch, requestId: patch.requestId ?? null };
    if (next.tab !== "antraege") next.status = null;
    return goto(`?${teamLeaveSearch(next)}`, { replaceState, keepFocus: true, noScroll: true });
  }

  function selectTab(id: string) {
    const tab = TAB_IDS.find((t) => t === id);
    if (tab !== undefined && tab !== activeTab) void navigate({ tab });
  }

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

  // ── Issue #836 (AC-10): days over a leave limit, read from the daily-load endpoint ─────
  // Shown only to callers who may read the load; the request is a UX gate, the API decides
  // (403/404). No count is computed here: every number comes from the response. The endpoint
  // answers at most 92 days, so the Jahr zoom draws no limit markers.
  const canReadLimitLoad = $derived(
    hasPermission($authStore.user, "leave-limit:manage:ZUGEWIESEN") ||
      hasPermission($authStore.user, "leave-request:approve:ZUGEWIESEN"),
  );
  let limitDays: Map<string, ExceededDay> = $state(new Map());
  let limitGeneration = 0;

  async function loadLimitDays() {
    const generation = ++limitGeneration;
    if (!canReadLimitLoad) {
      limitDays = new Map();
      return;
    }
    if (overviewPeriod.zoom === "jahr") {
      limitDays = new Map();
      return;
    }
    const { startDay: from, endDay: to } = overviewPeriod;
    try {
      const view = await api.get<LeaveLimitLoadResponse>(
        withSalonId(`/leave/limits/load?from=${from}&to=${to}`, pageSalonId),
      );
      if (generation !== limitGeneration) return;
      limitDays = exceededDaysFromLoad(view);
    } catch {
      // A failed load leaves no marker and no error: the marker is a hint, not a gate.
      if (generation !== limitGeneration) return;
      limitDays = new Map();
    }
  }

  // ── Übersicht (Issue #840, D-840-07/10/17) ────────────────────────────────────────────────
  // The read is the range form of the one calendar route: the server decides per person what the
  // reader sees in detail and what is only the neutral word, the page draws it.
  let overviewRows: TimelinePerson[] = $state([]);
  let overviewHolidays: Array<{ day: string; name: string }> = $state([]);
  let overviewSalons: CalendarSalon[] = $state([]);
  let overviewLoading = $state(false);
  let overviewGeneration = 0;

  async function loadOverview() {
    void loadLimitDays();
    const generation = ++overviewGeneration;
    overviewLoading = true;
    try {
      const answer = await api.get<CalendarRangeAnswer>(
        withSalonId(`/leave/calendar?${calendarRangeQuery(overviewPeriod)}`, pageSalonId),
      );
      if (generation !== overviewGeneration) return;
      const timeline = calendarToTimeline(answer.entries);
      overviewRows = timeline.rows;
      overviewHolidays = timeline.holidays;
      overviewSalons = answer.salons ?? [];
    } catch {
      // The calm 404 of an inadmissible salon and every other failure: an empty view, no alert.
      if (generation !== overviewGeneration) return;
      overviewRows = [];
      overviewHolidays = [];
      overviewSalons = [];
    } finally {
      if (generation === overviewGeneration) overviewLoading = false;
    }
  }

  /** Below 768 px the list replaces the timeline (D-840-11). */
  let isMobile = $state(false);

  /** A bar with a request opens the Anträge tab at that request; a masked bar has none. */
  async function selectBar(bar: TimelineBar) {
    const id = bar.requestId;
    if (!id) return;
    filterLeaveType = "";
    requestQuery = "";
    await navigate({ tab: "antraege", status: null, requestId: id });
    await tick();
    focusRequest(id);
  }

  // ── Laden ─────────────────────────────────────────────────────────────────
  async function loadData() {
    const generation = ++dataGeneration;
    loading = true;
    error = "";
    try {
      const [all, emps] = await Promise.all([
        api.get<LeaveRequest[]>(withSalonId(`/leave/requests?year=${listYear}`, pageSalonId)),
        api.get<Employee[]>(withSalonId("/employees", pageSalonId)),
      ]);
      if (generation !== dataGeneration) return;
      allTeamRequests = all;
      employees = emps;
      salonRejected = false;
    } catch (e: unknown) {
      if (generation !== dataGeneration) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: a calm text, no error alert.
        allTeamRequests = [];
        employees = [];
        salonRejected = true;
      } else {
        error = e instanceof Error ? e.message : "Fehler beim Laden";
      }
    } finally {
      if (generation === dataGeneration) loading = false;
    }
  }

  /**
   * The open requests (`PENDING` and a requested cancellation, every year) of the header salon.
   * Read on its own so the count of the Anträge tab shows on every tab as soon as it is known and
   * keeps its last value while a reload runs (Issue #840 G-1): a failure other than the calm
   * rejected salon leaves the shown count in place.
   */
  async function loadOpenRequests() {
    const generation = ++openGeneration;
    try {
      const pending = await api.get<LeaveRequest[]>(
        withSalonId("/leave/requests?status=PENDING", pageSalonId),
      );
      if (generation !== openGeneration) return;
      pendingRequests = pending;
    } catch (e: unknown) {
      if (generation !== openGeneration) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: nothing is open there; the calm text is loadData's.
        pendingRequests = [];
      } else {
        error = e instanceof Error ? e.message : "Fehler beim Laden";
      }
    }
  }

  // Deep-link targets read from the URL by onMount; the scroll and highlight run only after the
  // first completed (salon-filtered) load, because the rows do not exist before it.
  let deepLinkRequestId: string | null = null;
  // Issue #587 (D-587-4): ?create=1&employeeId&date from the „Abwesenheit erfassen“ action.
  let deepLinkCreate: LeaveCreateDeepLink | null = null;
  let firstLoadDone = false;

  /** Pages to, marks and scrolls to one request of the Anträge list; never navigates. */
  function focusRequest(requestId: string) {
    const at = pageOfRequest(
      filteredTeamRequests.map((req) => req.id),
      requestId,
      teamReqPageSize,
    );
    if (at !== null) teamReqPage = at;
    highlightRequestId = requestId;
    void tick().then(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`request-${requestId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    setTimeout(() => {
      highlightRequestId = null;
    }, 3000);
  }

  // A deep-linked request waiting for its list: the effect below highlights it as soon as the row
  // exists (the year or the filter may have to change first, WR-05).
  let pendingFocusId: string | null = $state(null);

  /**
   * Finds the request of a `?request=` link and shows it. The link carries no year, so a request
   * outside the loaded year list is looked up in the open list of every year: found, the Anträge
   * tab switches to the open filter and to the request's own year; not found (decided, in another
   * salon, out of reach) the page says so calmly instead of highlighting nothing.
   */
  async function showLinkedRequest(requestId: string) {
    const located = locateDeepLinkedRequest(requestId, allTeamRequests, pendingRequests);
    if (located.kind === "year") {
      focusRequest(requestId);
      return;
    }
    if (located.kind === "open") {
      pendingFocusId = requestId;
      setTimeout(() => {
        if (pendingFocusId === requestId) pendingFocusId = null;
      }, 5000);
      await navigate({ status: "PENDING", datum: located.startDate, requestId }, true);
      return;
    }
    toasts.info("Dieser Antrag ist nicht in deiner aktuellen Auswahl.");
  }

  $effect(() => {
    const id = pendingFocusId;
    if (id === null || loading) return;
    if (!filteredTeamRequests.some((req) => req.id === id)) return;
    untrack(() => {
      pendingFocusId = null;
      focusRequest(id);
    });
  });

  function runDeepLink() {
    // Deep-link: highlight a specific request from a notification or a bar (Anträge tab only).
    const requestId = deepLinkRequestId;
    if (requestId && activeTab === "antraege") void showLinkedRequest(requestId);

    // Deep-link: create=1 (Issue #587) opens the EXISTING „Neue Abwesenheit“ dialog, prefilled, on
    // whatever tab is active (#840 D-840-03). Only with the create permission; the person is taken
    // over only when it is in this page's own (salon-filtered) list, else the picker stays empty;
    // nothing is submitted from here.
    const createLink = deepLinkCreate;
    deepLinkCreate = null;
    if (createLink && hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN")) {
      const person = employees.find((emp) => emp.id.toLowerCase() === createLink.employeeId);
      createEmployeeId = person ? person.id : "";
      createInitialDate = createLink.date ?? new Date().toISOString().slice(0, 10);
      createModalOpen = true;
    }
  }

  onMount(() => {
    // Issue #840 (D-840-03): the legacy links (`?view=`, `?section9=`, a bare `?request=`) are
    // mapped to their new home by `+page.ts` before this page renders; what is left to read here
    // is the highlight target and the create link, both applied after the first load.
    deepLinkRequestId = urlState.requestId;

    // Deep-link: ?create=1 (Issue #587) — validated now, applied after the first load.
    deepLinkCreate = parseLeaveCreateDeepLink($page.url.searchParams);
  });

  onMount(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    isMobile = query.matches;
    const onChange = (event: MediaQueryListEvent) => (isMobile = event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  });

  // Issue #558: this effect owns the load of the request lists. It is declared after onMount so
  // the deep-link targets are registered first, waits for the salon context so the first request
  // is already filtered, and reruns when the header salon or the list year changes.
  $effect(() => {
    if (!contextLoaded) return;
    void pageSalonId;
    void listYear;
    untrack(() => {
      void (async () => {
        // Both reads start at once; the deep link below waits for both (it reads the open list too).
        const open = loadOpenRequests();
        await loadData();
        await open;
        if (!firstLoadDone) {
          firstLoadDone = true;
          runDeepLink();
        }
      })();
    });
  });

  // The Übersicht reads its own range; it reruns for a salon, a period or the tab (#558, #840).
  const overviewKey = $derived(`${overviewPeriod.startDay}|${overviewPeriod.endDay}`);
  $effect(() => {
    if (!contextLoaded || activeTab !== "uebersicht") return;
    void pageSalonId;
    void overviewKey;
    untrack(() => {
      void loadOverview();
    });
  });

  /** After a write: the request lists, and the timeline while it is the tab in view. */
  async function reloadAll() {
    await Promise.all([
      loadData(),
      loadOpenRequests(),
      activeTab === "uebersicht" ? loadOverview() : Promise.resolve(),
    ]);
  }

  // ── Korrektur-Modal (EDIT-05) ─────────────────────────────────────────────
  // Manager corrects an already-APPROVED request (period/type/half-day). Wire
  // contract from 94-01: PATCH /leave/requests/:id/correct. Server guards
  // (requireRole + APPROVED + delta-lock) are authoritative — the UI never bypasses them.
  function openCorrect(req: LeaveRequest) {
    correctModal = req;
    correctStart = req.startDate;
    // Issue #449 (D-4): copies the stored end date AS-IS, with no half-day sync of any kind — a
    // loaded legacy multi-day half-day request must not be silently collapsed on open. Correcting
    // it runs through the same submit guard below, which refuses with the same message the
    // employee-facing form shows.
    correctEnd = req.endDate;
    correctType = req.typeCode;
    // Half-day sick leave does not exist — forced off for sick types.
    correctHalfDay = SICK_CODES.includes(req.typeCode) ? false : req.halfDay;
    correctNote = req.note ?? "";
    correctReason = "";
    correctError = "";
    correctOpen = true;
  }

  function closeCorrect() {
    correctOpen = false;
    correctModal = null;
  }

  // Issue #449 (D-4): sync runs ONLY on these two user actions, never reactively on load/type
  // change — see openCorrect's own comment for why a reactive effect would be wrong here.
  function setCorrectStart(value: string) {
    correctStart = value;
    correctEnd = endDateForHalfDay(correctHalfDayEffective, correctStart, correctEnd);
  }

  function setCorrectHalfDay(value: boolean) {
    correctHalfDay = value;
    correctEnd = endDateForHalfDay(correctHalfDayEffective, correctStart, correctEnd);
  }

  // Half-day is always reset for sick types (partial incapacity to work does not exist).
  $effect(() => {
    if (SICK_CODES.includes(correctType)) correctHalfDay = false;
  });

  // Issue #836 (AC-7): the correction waiting for a limit exception reason.
  let limitExceptionOpen = $state(false);
  let limitExceptionText = $state("");
  let pendingLimitCorrection: { id: string; body: Record<string, unknown> } | null = null;

  async function submitCorrection() {
    if (!correctModal) return;
    // Client-side pre-check (the server is authoritative): end date >= start date.
    if (correctStart > correctEnd) {
      correctError = "Enddatum muss nach Startdatum liegen";
      return;
    }
    // Issue #449 (D-1/D-4): same single-date rule and message the API enforces on all three
    // write paths — checked client-side before the mandatory-reason check below so a legacy
    // multi-day half-day request can never be re-submitted unchanged.
    const halfDayError = halfDayRangeError(correctHalfDayEffective, correctStart, correctEnd);
    if (halfDayError) {
      correctError = halfDayError;
      return;
    }
    // Quick 260824-cjd: Begründung ist Pflicht (server-seitig Zod-level erzwungen) —
    // client-seitig vorab geblockt, mit derselben Fehlermeldung wie die API.
    if (!correctReason.trim()) {
      correctError = "Begründung ist erforderlich (revisionssicherheitspflichtig).";
      return;
    }
    correctSaving = true;
    correctError = "";
    const body = {
      startDate: correctStart,
      endDate: correctEnd,
      halfDay: correctHalfDayEffective,
      type: correctType,
      note: correctNote || null,
      reason: correctReason.trim(),
    };
    const requestId = correctModal.id;
    try {
      await api.patch(`/leave/requests/${requestId}/correct`, body);
      closeCorrect();
      await reloadAll();
      toasts.success("Antrag korrigiert");
    } catch (e: unknown) {
      // Issue #836 (AC-7): the correction would exceed a leave limit. Keep the body, close the
      // correction Modal (one scrim at a time) and ask for the exception reason; the correction's
      // own `reason` stays mandatory and separate.
      if (isLeaveLimitExceptionRequired(e)) {
        limitExceptionText =
          exceedanceDescription(exceedancesOf(e)) || "Eine Urlaubsgrenze ist überschritten.";
        pendingLimitCorrection = { id: requestId, body };
        closeCorrect();
        limitExceptionOpen = true;
        return;
      }
      // A delta-lock 409 ("Gesperrter Monat — Korrektur nicht möglich") or a validation 400
      // lands here and stays visible in the open modal.
      correctError = e instanceof Error ? e.message : "Fehler";
    } finally {
      correctSaving = false;
    }
  }

  // Confirm handler of the exception step: resends the same correction plus `limitException`.
  // Throws to keep the reason dialog open (its contract) on an invalid reason or a refusal.
  async function confirmLimitException(reason: string) {
    const invalid = validateExceptionReason(reason);
    if (invalid) throw new Error(invalid);
    const pending = pendingLimitCorrection;
    if (!pending) return;
    await api.patch(`/leave/requests/${pending.id}/correct`, {
      ...pending.body,
      limitException: { reason: reason.trim() },
    });
    pendingLimitCorrection = null;
    await reloadAll();
    toasts.success("Antrag korrigiert");
  }

  // ── Attest-Nachtrag (Phase 201) ─────────────────────────────────────────────
  function openAttest(req: LeaveRequest) {
    attestModal = req;
    attestPresent = req.attestPresent ?? false;
    attestFrom = req.attestValidFrom ?? "";
    attestTo = req.attestValidTo ?? "";
    attestError = "";
    attestOpen = true;
  }

  function closeAttest() {
    attestOpen = false;
    attestModal = null;
  }

  async function submitAttest() {
    if (!attestModal) return;
    attestSaving = true;
    attestError = "";
    try {
      await api.patch(`/leave/requests/${attestModal.id}/attest`, {
        attestPresent,
        attestValidFrom: attestPresent && attestFrom ? attestFrom : null,
        attestValidTo: attestPresent && attestTo ? attestTo : null,
      });
      closeAttest();
      await loadData();
      toasts.success(attestPresent ? "Attest gespeichert" : "Attest entfernt");
    } catch (e: unknown) {
      attestError = e instanceof Error ? e.message : "Fehler";
    } finally {
      attestSaving = false;
    }
  }

  // ── Helfer ────────────────────────────────────────────────────────────────
  function fmtDate(iso: string): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function statusLabel(s: Status) {
    return s === "APPROVED"
      ? "Genehmigt"
      : s === "PENDING"
        ? "Offen"
        : s === "REJECTED"
          ? "Abgelehnt"
          : s === "CANCELLATION_REQUESTED"
            ? "Stornierung beantragt"
            : "Zurückgezogen";
  }

  // ── Personen-Suche der Übersicht (Issue #853, D-853-18) ───────────────────────────────────
  // The search narrows the Übersicht rows by name; it is page-local (not in the URL) and never
  // touches the request lists.
  let personQuery = $state("");

  // Issue #840 G-1: the open count follows the header salon only, never the person filter (that
  // filter is not even shown on Planung).
  const openSummary = $derived(openRequestsSummary(pendingRequests));

  /** A click on the count: the Anträge list at „Offen“, with no type filter hiding a counted row. */
  function openOpenRequests() {
    filterLeaveType = "";
    requestQuery = "";
    void navigate({ tab: "antraege", status: "PENDING" });
  }

  // ── Übersicht: rows, load and legend (Issue #840, E-06, D-840-10/27; #853 D-853-12) ─────────
  // Rows: the persons of the calendar answer plus every person of the page's own (salon-filtered)
  // list, each a row even without a bar. The default circle is the leader's reach: the caller, the
  // roster and every person the server did not mask; „Alle Salons“ (`kreis=alle`) adds the masked
  // rest. The search then narrows the circle by name.
  const rosterIds = $derived(new Set(employees.map((emp) => emp.id)));
  const circlePeople = $derived(
    inLeaderReach(
      overviewPersons(overviewRows, employees, {
        ownEmployeeId: $authStore.user?.employeeId ?? null,
      }),
      rosterIds,
      urlState.allSalons,
    ),
  );
  const overviewPeople = $derived(
    circlePeople.filter((row) => matchesSearch(row.name, personQuery)),
  );
  const circleFilters: ToolbarFilter[] = $derived([
    {
      key: "kreis",
      label: "Personenkreis",
      options: [{ value: "alle", label: "Alle Salons" }],
      value: urlState.allSalons ? "alle" : "",
    },
  ]);
  // Closed days only for ONE salon in view (D-840-14); with several the legend says why none are drawn.
  const closedDays = $derived(closedDaysFor(overviewSalons, $salonContext));
  // The Werktage basis is decided once (D-840-08): null = Mon-Sat when no single salon with hours is in view.
  const werktage = $derived(werktageBasis(closedDays, overviewSalons));
  const LOAD_HINT =
    "Personen mit genehmigter oder beantragter Abwesenheit – Wünsche der Planung zählen nicht";
  const CLOSED_DAYS_HINT = "Schließtage nur bei einem Salon";

  const overviewLoad = $derived.by(() => {
    if (overviewPeriod.zoom === "jahr") {
      return {
        kind: "week" as const,
        counts: weekLoad(
          overviewPeople,
          overviewPeriod.year,
          workdaySet(werktage),
          overviewHolidays,
        ),
        hint: LOAD_HINT,
      };
    }
    const counts = calendarDayLoad(
      overviewPeople,
      dayColumns(overviewPeriod).map((column) => column.day),
    );
    const exceeded = new Map<string, string>();
    for (const [day, over] of limitDays) exceeded.set(day, limitBadgeTitle(over));
    return { kind: "day" as const, counts, exceeded, hint: LOAD_HINT };
  });

  const overviewLegend = $derived.by(() => {
    const base = legendFrom(overviewPeople);
    const daily = overviewPeriod.zoom !== "jahr";
    return {
      typeCodes: base.typeCodes,
      styles: base.styles,
      markings: {
        weekend: daily,
        holiday: daily && overviewHolidays.length > 0,
        closed: daily && closedDays.days.size > 0,
        today: daily,
        // Issue 840 G-4: „Mehrere Arten“ only in Jahr and only when such a week is in view.
        mixed:
          !daily &&
          hasMixedWeek(overviewPeople, overviewPeriod.year, workdaySet(werktage), overviewHolidays),
      },
      closedHint: closedDays.hint ? CLOSED_DAYS_HINT : null,
    };
  });

  // The tabs of the page head; the open requests of the salon selection badge the Anträge tab
  // with a neutral, explained count (Issue #840 G-1).
  const leaveTabs = $derived([
    { value: "uebersicht", label: "Übersicht" },
    {
      value: "antraege",
      label: "Anträge",
      badge: openSummary?.count,
      badgeLabel: openSummary?.label,
      onBadgeSelect: openOpenRequests,
      testId: "list",
    },
    { value: "planung", label: "Planung" },
  ]);

  const ZOOM_OPTIONS = [
    { value: "jahr", label: "Jahr" },
    { value: "quartal", label: "Quartal" },
    { value: "monat", label: "Monat" },
  ];

  function onZoomSelected(value: string) {
    const zoom = TIMELINE_ZOOMS.find((z) => z === value);
    if (zoom !== undefined) void navigate({ zoom }, true);
  }

  // ── Planung tab (D-840-15/17) ─────────────────────────────────────────────────────────────
  // The salon is the header selection exactly as on the old planner page; `canManage` is what the
  // panel reports (the server's value once a plan is loaded).
  const planSalonId = $derived(teamSalonViewSalon($salonContext));
  let canManagePlan = $state(false);
  let manageOpen = $state(false);
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

  // Presentation only: the open request's action is offered to approvers (the API decides).
  const canApproveHint = $derived(
    hasPermission($authStore.user, "leave-request:approve:ZUGEWIESEN"),
  );

  // ── Anträge-Filter + Pagination ───────────────────────────────────────────
  // #840 (E-02): the status filter lives in the URL (`status`), so a deep link and the back button
  // carry it; the type filter stays page-local.
  const filterLeaveStatus = $derived<LeaveStatusFilter | "">(urlState.status ?? "");
  let filterLeaveType = $state<TypeCode | "">("");
  // Issue #853: the Anträge search by person name (page-local, like the type filter).
  let requestQuery = $state("");
  let teamReqPage = $state(1);
  let teamReqPageSize = $state(10);

  // The list that feeds the Anträge tab: the year list, plus every open request of any year when
  // the status filter asks for open ones (an open request is never hidden by the year).
  const requestSource = $derived(
    requestsForStatus(urlState.status, allTeamRequests, pendingRequests),
  );

  let filteredTeamRequests = $derived(
    requestSource.filter((req) => {
      if (!matchesStatusFilter(req.status, urlState.status)) return false;
      if (filterLeaveType && req.typeCode !== filterLeaveType) return false;
      if (!matchesSearch(`${req.employee.firstName} ${req.employee.lastName}`, requestQuery)) {
        return false;
      }
      return true;
    }),
  );

  let pagedTeamRequests = $derived(
    filteredTeamRequests.slice((teamReqPage - 1) * teamReqPageSize, teamReqPage * teamReqPageSize),
  );

  $effect(() => {
    filteredTeamRequests.length;
    teamReqPage = 1;
  });

  // The Anträge table (Issue #853, D-853-18): one row per request of the page, the toolbar's
  // Status filter is the `status` URL key, the Art filter and the search are page-local.
  type RequestRow = { id: string; req: LeaveRequest };
  const REQUEST_COLUMNS: DataTableColumn[] = [
    { key: "person", label: "Person", primary: true },
    { key: "type", label: "Art" },
    { key: "period", label: "Zeitraum" },
    { key: "days", label: "Umfang" },
    { key: "status", label: "Status" },
    { key: "note", label: "Anmerkung" },
    { key: "actions", label: "Aktionen" },
  ];
  const requestRows: RequestRow[] = $derived(pagedTeamRequests.map((req) => ({ id: req.id, req })));
  const requestRowKey = (row: RequestRow) => row.id;
  const requestRowTestId = (row: RequestRow) => `leave-team-row-${row.id}`;
  const requestRowTone = (row: RequestRow): DataTableRowTone | undefined =>
    highlightRequestId === row.id ? "highlight" : undefined;

  const STATUS_FILTER_OPTIONS: Array<{ value: LeaveStatusFilter; label: string }> = [
    { value: "PENDING", label: "Offen" },
    { value: "APPROVED", label: "Genehmigt" },
    { value: "CANCELLATION_REQUESTED", label: "Stornierung beantragt" },
    { value: "REJECTED", label: "Abgelehnt" },
    { value: "CANCELLED", label: "Storniert" },
  ];
  const requestFilters: ToolbarFilter[] = $derived([
    { key: "status", label: "Status", options: STATUS_FILTER_OPTIONS, value: filterLeaveStatus },
    {
      key: "type",
      label: "Art",
      options: LEAVE_TYPE_OPTIONS.map((t) => ({ value: t.code, label: t.label })),
      value: filterLeaveType,
    },
  ]);
  const requestFiltersActive = $derived(
    requestQuery !== "" || filterLeaveStatus !== "" || filterLeaveType !== "",
  );

  function onRequestFilterChange(key: string, picked: string) {
    if (key === "status") {
      void navigate({ status: (picked || null) as LeaveStatusFilter | null }, true);
    } else if (key === "type") {
      filterLeaveType = (LEAVE_TYPE_OPTIONS.find((t) => t.code === picked)?.code ?? "") as
        TypeCode | "";
    }
  }

  /** Search, Status and Art back to „Alle“ in one URL write. */
  function resetRequestFilters() {
    requestQuery = "";
    filterLeaveType = "";
    void navigate({ status: null }, true);
  }

  function statusTone(s: Status): ChipTone {
    return s === "APPROVED"
      ? "ok"
      : s === "PENDING" || s === "CANCELLATION_REQUESTED"
        ? "warn"
        : s === "REJECTED"
          ? "bad"
          : "neutral";
  }

  // ── iCal-Download ────────────────────────────────────────────────────────
  // „Kalender abonnieren“ opens a Dialog (Issue #853, D-853-18) in place of the old page section.
  let icalOpen = $state(false);
  let icalDownloading = $state(false);

  async function downloadIcal() {
    icalDownloading = true;
    try {
      const auth = $authStore;
      const res = await fetch(withSalonId("/api/v1/leave/ical/team", pageSalonId), {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!res.ok) throw new Error("Download fehlgeschlagen");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "clokr-team-abwesenheiten.ics";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      icalOpen = false;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Download";
    } finally {
      icalDownloading = false;
    }
  }

  function openCreate() {
    createEmployeeId = "";
    createInitialDate = new Date().toISOString().slice(0, 10);
    createModalOpen = true;
  }
</script>

<svelte:head>
  <title>{pageLabel("/team/leave")} – Clokr</title>
</svelte:head>

<!-- Modal primitive owns Escape handling. -->

<!-- ── Header (Issue #853, D-853-18/19: no eyebrow, no accent) ─────────────────── -->
<PageHead
  title={pageLabel("/team/leave")}
  sub="Sieh, wer wann fehlt, prüfe Anträge und plane den Urlaub deines Teams."
>
  {#snippet actions()}
    {#if activeTab === "planung"}
      {#if canManagePlan}
        <button
          type="button"
          class="btn btn-primary btn-sm"
          data-testid="leave-plan-manage"
          onclick={() => (manageOpen = true)}
        >
          Planung verwalten
        </button>
      {/if}
    {:else if hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN")}
      <button class="btn btn-primary btn-sm" onclick={openCreate}>Abwesenheit eintragen</button>
    {/if}
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      data-testid="leave-team-ical"
      onclick={() => (icalOpen = true)}
    >
      Kalender abonnieren
    </button>
  {/snippet}
</PageHead>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<!-- Issue #836 (AC-5): non-blocking hint after a request exceeded a leave limit. -->
<LeaveLimitNotice sentences={limitSentences} onDismiss={() => (limitSentences = [])} />

<!-- Issue 840 G-6: on Planung the toolbar row holds the planner's status, deadline and add action. -->
{#snippet plannerControls()}
  {#if planControls}<LeavePlanControls controls={planControls} />{/if}
{/snippet}

<!-- The period control of the toolbar row: ‹ label › Heute, plus the zoom on the timeline tabs. -->
{#snippet periodControls(withZoom: boolean)}
  <div class="lv-period">
    <PeriodSwitcher
      period={toolbarPeriod}
      onShift={(step) =>
        void navigate({ datum: shiftPeriod(toolbarPeriod.zoom, urlState.datum, step) }, true)}
      onToday={() => void navigate({ datum: today }, true)}
    />
  </div>
  {#if withZoom}
    <SegmentedControl
      options={ZOOM_OPTIONS}
      value={overviewPeriod.zoom}
      name="leave-zoom"
      ariaLabel="Zeitraum"
      size="sm"
      onchange={onZoomSelected}
    />
  {/if}
{/snippet}

<!-- ── The three panels (Issue #853, D-853-11): only the active one holds content ──────── -->
{#snippet leavePanel(value: string)}
  {#if value === activeTab}
    {#if salonRejected && value !== "planung"}
      <div data-testid="leave-team-salon-unavailable">
        <Note tone="brand"
          >Für diesen Salon liegen hier keine Daten vor. Wähle oben einen anderen Salon.</Note
        >
      </div>
    {/if}

    {#if value === "uebersicht"}
      <!-- ── Übersicht (Issue #840): one row per person, one bar per absence ────────── -->
      <div class="lv-controls">
        {@render periodControls(true)}
        <div class="lv-people">
          <TableToolbar
            bind:query={personQuery}
            count={overviewPeople.length}
            total={circlePeople.length}
            filters={circleFilters}
            onFilterChange={(_key, picked) => void navigate({ allSalons: picked === "alle" }, true)}
            onReset={() => {
              personQuery = "";
              if (urlState.allSalons) void navigate({ allSalons: false }, true);
            }}
            searchLabel="Person suchen"
          />
        </div>
      </div>

      <div data-testid="leave-overview">
        {#if overviewPeople.length === 0 && overviewLoading}
          <Skeleton shape="block" height="240px" />
        {:else if overviewPeople.length === 0}
          <div data-testid="leave-overview-empty">
            <EmptyState
              variant={personQuery ? "noMatches" : "noData"}
              title={personQuery
                ? "Keine Person gefunden."
                : "Keine Abwesenheiten in diesem Zeitraum."}
              description={personQuery ? "Passe die Suche an." : undefined}
            />
          </div>
        {:else if isMobile}
          <AbsenceList
            rows={overviewPeople}
            period={overviewPeriod}
            holidays={overviewHolidays}
            onBarSelect={selectBar}
          />
        {:else}
          <AbsenceTimeline
            rows={overviewPeople}
            period={overviewPeriod}
            holidays={overviewHolidays}
            closedWeekdays={werktage}
            {today}
            load={overviewLoad}
            onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}
            onBarSelect={selectBar}
          />
        {/if}
        <!-- One legend under the timeline: only what this view can contain (Phase 257, D-05). -->
        <LeaveLegend
          typeCodes={overviewLegend.typeCodes}
          styles={overviewLegend.styles}
          markings={overviewLegend.markings}
          closedHint={overviewLegend.closedHint}
        />
      </div>
    {:else if value === "antraege"}
      <!-- ── Anträge (E-02): a table with toolbar; open requests are decided in the inbox ─── -->
      <div class="lv-controls">
        {@render periodControls(false)}
      </div>

      {#snippet requestsToolbar()}
        <TableToolbar
          bind:query={requestQuery}
          count={filteredTeamRequests.length}
          total={requestSource.length}
          filters={requestFilters}
          onFilterChange={onRequestFilterChange}
          onReset={resetRequestFilters}
          searchLabel="Person suchen"
        />
      {/snippet}

      {#if loading}
        <DataTable
          caption="Anträge"
          columns={REQUEST_COLUMNS}
          rows={[]}
          rowKey={requestRowKey}
          toolbar={requestsToolbar}
          loading
        />
      {:else}
        <div data-testid="leave-team-requests">
          {#if filteredTeamRequests.length === 0}
            {@const empty = emptyRequestsText(urlState.status, listYear, requestSource.length)}
            <div class="dt-toolbar-row">{@render requestsToolbar()}</div>
            <div data-testid="leave-team-empty">
              <EmptyState
                variant={requestFiltersActive ? "noMatches" : "noData"}
                icon="calendar"
                title={empty.title}
                description={empty.hint}
                onaction={requestFiltersActive ? resetRequestFilters : undefined}
              />
            </div>
          {:else}
            <DataTable
              caption="Anträge"
              columns={REQUEST_COLUMNS}
              rows={requestRows}
              rowKey={requestRowKey}
              toolbar={requestsToolbar}
              rowTestId={requestRowTestId}
              rowTone={requestRowTone}
            >
              {#snippet cell(row, column)}
                {@const req = row.req}
                {#if column.key === "person"}
                  <!-- The anchor of the notification/bar deep link (focusRequest scrolls to it). -->
                  <span id="request-{req.id}">{req.employee.firstName} {req.employee.lastName}</span
                  >
                {:else if column.key === "type"}
                  <LeaveTypeChip
                    code={req.typeCode}
                    label={typeName(req.typeCode)}
                    requested={req.status === "PENDING"}
                    data-row-status={req.status}
                    data-testid={`leave-team-row-${req.id}-type-chip`}
                  />
                {:else if column.key === "period"}
                  {fmtDate(req.startDate)} – {fmtDate(req.endDate)}
                {:else if column.key === "days"}
                  {leaveDaysLabel(Number(req.days), req.halfDay, req.typeCode)}
                {:else if column.key === "status"}
                  <span class="req-status">
                    <span data-testid={`leave-team-row-${req.id}-status-badge`}>
                      <Chip tone={statusTone(req.status)}>{statusLabel(req.status)}</Chip>
                    </span>
                    {#if req.lastDaysAdjustment}
                      {@const adjBadge = resolveAdjustmentBadge(req.lastDaysAdjustment)!}
                      <!-- Phase 107-07 (D-19/D-21): mirrors leave/+page.svelte's own request
                   row exactly, so the approving manager sees the same signal on the
                   request they approved. Persistent — not tied to notification
                   read/dismissed state. -->
                      <span
                        class={adjBadge.badgeClass}
                        data-testid={`leave-team-row-${req.id}-adjustment-badge`}
                        title={adjBadge.tooltip}
                      >
                        {adjBadge.icon} Angepasst: {adjBadge.direction === "up"
                          ? "+"
                          : "−"}{#if adjBadge.bold}<strong>{adjBadge.delta}</strong
                          >{:else}{adjBadge.delta}{/if} Tag(e)
                      </span>
                    {/if}
                    {#if req.daysProvisional}
                      <!-- Phase 107-07 (D-12): warn tone, NOT bad/row-invalid — a provisional
                   request is fully valid and payable today. -->
                      <span data-testid={`leave-team-row-${req.id}-provisional-badge`}>
                        <Chip
                          tone="warn"
                          title="Verbrauch vorläufig geschätzt — wird angepasst, sobald der Schichtplan für diesen Zeitraum steht."
                          >Vorläufig</Chip
                        >
                      </span>
                    {/if}
                    {#if SICK_CODES.includes(req.typeCode) && req.status === "APPROVED"}
                      <Chip tone={req.attestPresent ? "ok" : "neutral"}
                        >{req.attestPresent ? "Attest" : "Kein Attest"}</Chip
                      >
                    {/if}
                  </span>
                {:else if column.key === "note"}
                  {#if req.status === "REJECTED" && req.reviewNote}
                    <span class="req-note req-note--bad" title={req.reviewNote}
                      >⚠ {req.reviewNote}</span
                    >
                  {:else}
                    <span class="req-note" title={req.note ?? undefined}>{req.note ?? "—"}</span>
                  {/if}
                {:else if column.key === "actions"}
                  <div class="action-cell__group">
                    {#if req.status === "PENDING" || req.status === "CANCELLATION_REQUESTED"}
                      <!-- #840 (E-02): decisions are made in the inbox only; the action is offered
                   to approvers (Pitfall 7: a reader sees the badge without it). -->
                      {#if canApproveHint}
                        <a
                          data-testid={req.status === "CANCELLATION_REQUESTED"
                            ? `leave-team-row-${req.id}-review-cancel`
                            : `leave-team-row-${req.id}-review`}
                          class="btn btn-sm btn-ghost"
                          href={`/inbox?request=${req.id}&year=${req.startDate.slice(0, 4)}`}
                        >
                          Im Posteingang prüfen
                        </a>
                      {/if}
                    {:else if req.status === "APPROVED"}
                      <button
                        data-testid={`leave-team-row-${req.id}-correct`}
                        class="btn btn-sm btn-ghost"
                        onclick={() => openCorrect(req)}
                      >
                        Korrigieren
                      </button>
                      {#if SICK_CODES.includes(req.typeCode)}
                        <button
                          data-testid={`leave-team-row-${req.id}-attest`}
                          class="btn btn-sm btn-ghost"
                          onclick={() => openAttest(req)}
                        >
                          {req.attestPresent ? "Attest ändern" : "Attest erfassen"}
                        </button>
                      {/if}
                      {#if showsParentalReductionAction(req, $authStore.user)}
                        <button
                          data-testid={`leave-team-row-${req.id}-parental-reduction`}
                          class="btn btn-sm btn-ghost"
                          onclick={() => openParentalReduction(req)}
                        >
                          Elternzeit-Kürzung erklären
                        </button>
                      {/if}
                    {/if}
                    {#if resolveStornoAction(req.status, req.employeeId === $authStore.user?.employeeId)}
                      {@const kind = resolveStornoAction(
                        req.status,
                        req.employeeId === $authStore.user?.employeeId,
                      )!}
                      <button
                        data-testid={`leave-team-row-${req.id}-storno`}
                        data-storno-kind={kind}
                        class="btn btn-sm btn-ghost text-red"
                        onclick={() => openStorno(req)}
                      >
                        {stornoDialogCopy(kind).buttonLabel}
                      </button>
                    {/if}
                  </div>
                {/if}
              {/snippet}
            </DataTable>
            <Pagination
              total={filteredTeamRequests.length}
              bind:page={teamReqPage}
              bind:pageSize={teamReqPageSize}
            />
          {/if}
        </div>
      {/if}
    {:else if value === "planung"}
      <!-- ── Planung (D-840-15/17): the #835 planner on the one timeline, team mode ─────────
           The panel sits in no card, so a fixed dialog is not trapped (#570); its admin controls
           live in the „Planung verwalten“ dialog, opened from this page's primary action. -->
      <div class="lv-controls">
        {@render periodControls(true)}
        <div class="lv-planner">{@render plannerControls()}</div>
      </div>
      {#if !contextLoaded}
        <Skeleton shape="card" lines={3} />
      {:else}
        <LeavePlanningPanel
          mode="team"
          salonId={planSalonId}
          period={overviewPeriod}
          {today}
          bind:manageOpen
          onViewer={(viewer) => (canManagePlan = viewer.canManage)}
          onControls={(controls) => (planControls = controls)}
          onWeekSelect={(monday) => void navigate({ zoom: "quartal", datum: monday }, true)}
        />
      {/if}
    {/if}
  {/if}
{/snippet}

<PageTabs
  tabs={leaveTabs}
  tab={activeTab}
  onTabChange={selectTab}
  panel={leavePanel}
  tabsLabel="Abwesenheiten"
  testIdPrefix="leave-team-view"
/>

<!-- ── Kalender abonnieren: the team absences as a .ics file ─────────────────────── -->
<Dialog bind:open={icalOpen} title="Kalender abonnieren">
  <p>
    Die Team-Abwesenheiten als .ics-Datei herunterladen und in Outlook, Google Kalender oder Apple
    Kalender öffnen.
  </p>
  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (icalOpen = false)}>
      Schließen
    </button>
    <button
      type="button"
      class="btn btn-primary"
      data-testid="leave-team-ical-download"
      onclick={downloadIcal}
      disabled={icalDownloading}
      aria-busy={icalDownloading}
    >
      {#if icalDownloading}<Spinner />{/if}
      Team-Abwesenheiten herunterladen
    </button>
  {/snippet}
</Dialog>

<!-- ── Elternzeit-Kürzung-Modal (Issue #468, D-12/A-2) ───────────────────── -->
<ParentalReductionDialog
  bind:open={parentalOpen}
  request={parentalModal
    ? {
        id: parentalModal.id,
        employeeName: `${parentalModal.employee.firstName} ${parentalModal.employee.lastName}`,
        startDate: parentalModal.startDate,
        endDate: parentalModal.endDate,
      }
    : null}
  onChanged={async () => {
    await reloadAll();
  }}
/>

<!-- ── Korrektur-Modal: Genehmigten Antrag korrigieren (EDIT-05) ─────────── -->
{#if correctModal}
  <Modal bind:open={correctOpen} eyebrow="Antrag" title="Antrag korrigieren">
    <div data-testid="leave-correct-modal" style="display: contents">
      <div class="form-group">
        <span class="review-label">Mitarbeiter</span>
        <span class="review-value"
          >{correctModal.employee.firstName} {correctModal.employee.lastName}</span
        >
      </div>
      <div class="form-group">
        <label class="form-label" for="correct-type">Art</label>
        <select id="correct-type" class="form-input" bind:value={correctType}>
          {#each LEAVE_TYPE_OPTIONS as opt (opt.code)}
            <option value={opt.code}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <div class="form-grid-2col">
        <div class="form-group">
          <label class="form-label" for="correct-start">Von</label>
          <input
            id="correct-start"
            data-testid="leave-correct-modal-start"
            type="date"
            class="form-input"
            bind:value={() => correctStart, setCorrectStart}
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="correct-end">Bis</label>
          <input
            id="correct-end"
            data-testid="leave-correct-modal-end"
            type="date"
            class="form-input"
            bind:value={correctEnd}
            disabled={correctHalfDayEffective}
          />
        </div>
      </div>
      <div class="form-group">
        <label class="checkbox-row">
          <input
            type="checkbox"
            data-testid="leave-correct-modal-halfday"
            bind:checked={() => correctHalfDay, setCorrectHalfDay}
            disabled={SICK_CODES.includes(correctType)}
          />
          Halber Tag
        </label>
        {#if SICK_CODES.includes(correctType)}
          <p class="form-hint">Halbe Kranktage sind nicht zulässig</p>
        {:else if halfDayRangeError(correctHalfDayEffective, correctStart, correctEnd)}
          <p class="form-hint" data-testid="leave-correct-modal-half-day-range-hint">
            {halfDayRangeError(correctHalfDayEffective, correctStart, correctEnd)}
          </p>
        {/if}
      </div>
      <div class="form-group">
        <label class="form-label" for="correct-note">Notiz (optional)</label>
        <textarea id="correct-note" class="form-input" rows="3" bind:value={correctNote}></textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="correct-reason">Begründung (Pflichtfeld) *</label>
        <textarea
          id="correct-reason"
          class="form-input"
          rows="3"
          data-testid="leave-correct-modal-reason"
          bind:value={correctReason}
          placeholder="Bitte begründe die Korrektur."
        ></textarea>
      </div>
      {#if correctError}
        <div
          class="alert alert-error review-error"
          role="alert"
          data-testid="leave-correct-modal-error"
        >
          <span>⚠</span><span>{correctError}</span>
        </div>
      {/if}
    </div>

    {#snippet footer()}
      <button
        type="button"
        data-testid="leave-correct-modal-cancel"
        class="btn btn-ghost"
        onclick={closeCorrect}
        disabled={correctSaving}
      >
        Abbrechen
      </button>
      <button
        type="button"
        data-testid="leave-correct-modal-submit"
        class="btn btn-primary"
        onclick={submitCorrection}
        disabled={correctSaving}
      >
        {correctSaving ? "Speichert…" : "Bestätigen"}
      </button>
    {/snippet}
  </Modal>
{/if}

<!-- ── Attest-Modal (Phase 201): Attest nachtragen/ändern an einer genehmigten
     Krankmeldung. Ruft AUSSCHLIESSLICH PATCH /leave/requests/:id/attest — keine
     Korrektur, keine Begründung, kein § 9-Vorgang. ──────────────────────────── -->
{#if attestOpen && attestModal}
  <Modal bind:open={attestOpen} eyebrow={typeName(attestModal.typeCode)} title="Attest erfassen">
    <div data-testid="leave-team-attest-modal">
      <p class="form-hint attest-period">
        {attestModal.employee.firstName}
        {attestModal.employee.lastName} · {fmtDate(attestModal.startDate)} – {fmtDate(
          attestModal.endDate,
        )}
      </p>
      <AttestFields
        bind:present={attestPresent}
        bind:validFrom={attestFrom}
        bind:validTo={attestTo}
        idPrefix="a"
      />
      <p class="form-hint attest-late-hint">
        Ein Attest kann auch nach dem Monatsabschluss erfasst werden — es ändert keine Zeiten und
        keinen Saldo, sondern hält nur fest, ob eine Bescheinigung vorliegt.
      </p>
      {#if attestError}
        <div class="alert alert-error review-error" role="alert">
          <span>⚠</span><span>{attestError}</span>
        </div>
      {/if}
    </div>
    {#snippet footer()}
      <button class="btn btn-ghost" onclick={closeAttest} disabled={attestSaving}>
        Abbrechen
      </button>
      <button
        class="btn btn-primary"
        data-testid="leave-team-attest-modal-save"
        onclick={submitAttest}
        disabled={attestSaving}
      >
        {attestSaving ? "Speichert…" : "Speichern"}
      </button>
    {/snippet}
  </Modal>
{/if}

<!-- ── Create-Modal: Neue Abwesenheit anlegen (Manager-on-behalf-of) ─────── -->
<!-- Phase 415 (#415): the shared create/edit dialog. Only the person picker is added here
     (Phase 415 D-03) — every other field, balance box, warning and preview is identical to
     `/leave`'s own dialog and refers to the SELECTED person via `employeeId`. -->
<LeaveRequestForm
  bind:open={createModalOpen}
  employeeId={createEmployeeId}
  editingRequest={null}
  initialStartDate={createInitialDate}
  initialEndDate={createInitialDate}
  entitlementYear={listYear}
  onSaved={async (result) => {
    // Issue #836: limit warnings of the create — shown, never blocking.
    limitSentences = warningSentences(result?.leaveLimitWarnings ?? []);
    await reloadAll();
  }}
>
  {#snippet personPicker()}
    <div class="form-group">
      <label class="form-label" for="create-emp">Mitarbeiter</label>
      <select id="create-emp" class="form-input" bind:value={createEmployeeId} required>
        <option value="" disabled>— Mitarbeiter wählen —</option>
        {#each employees as emp (emp.id)}
          <option value={emp.id}>{emp.firstName} {emp.lastName}</option>
        {/each}
      </select>
    </div>
  {/snippet}
</LeaveRequestForm>

<!-- ── Quick 260824-ef6: Storno-Begründung (Zurückziehen / Stornierung) ────── -->
{#if stornoCopy}
  <ReasonDialog
    bind:open={stornoOpen}
    title={stornoCopy.title}
    description={stornoCopy.description}
    confirmLabel={stornoCopy.confirmLabel}
    danger
    onConfirm={confirmStorno}
    onCancel={() => (stornoRequest = null)}
  />
{/if}

<!-- ── Issue #836 (AC-7): Ausnahme von der Urlaubsgrenze bei einer Korrektur ───── -->
{#if limitExceptionText}
  <ReasonDialog
    bind:open={limitExceptionOpen}
    title="Ausnahme von der Urlaubsgrenze"
    description={`Mit dieser Korrektur wird eine Urlaubsgrenze überschritten:\n${limitExceptionText}`}
    label="Begründung der Ausnahme"
    confirmLabel="Trotzdem korrigieren"
    onConfirm={confirmLimitException}
    onCancel={() => (pendingLimitCorrection = null)}
  />
{/if}

<style>
  /* ── Toolbar row under the tabs (Issue #853, D-853-18): period, zoom, search/planner ──── */
  .lv-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
    margin-bottom: var(--s-3);
  }

  /* The period keeps its label and arrows (block); only its page-sized padding goes, so the row
     starts at the page edge like the prototype's .period. */
  .lv-controls :global(.month-bar) {
    padding: 0;
  }

  .lv-period {
    flex: 0 1 auto;
    min-width: 0;
  }

  .lv-people,
  .lv-planner {
    flex: 1 1 18rem;
    min-width: 0;
  }

  @media (max-width: 640px) {
    .lv-period {
      flex: 1 1 100%;
    }
  }

  /* ── Attest ───────────────────────────────────────────────────────── */
  .attest-dates {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-weight: 500;
  }

  /* ── Pending Cards ────────────────────────────────────────────────── */

  /* ── Table ────────────────────────────────────────────────────────── */
  .btn-sm {
    padding: 0.25rem 0.625rem;
    font-size: 0.8125rem;
  }
  .text-red {
    color: var(--bad);
  }
  /* Issue #442 — flex layout lives on the inner wrapper, never on the td itself, so the cell
     keeps display: table-cell and lines up with the rest of the row even when empty. */
  .action-cell__group {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    flex-wrap: wrap;
  }

  /* Status cell: the chip, then the persistent request flags beside it. */
  .req-status {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1) var(--s-2);
  }

  /* The note stays one line; the full text is in the title. */
  .req-note {
    display: inline-block;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
    color: var(--text-2);
  }
  .req-note--bad {
    color: var(--bad);
  }

  /* The toolbar above the empty state of the table (the table itself carries it otherwise). */
  .dt-toolbar-row {
    margin-bottom: var(--s-3);
  }

  /* ── Modal body helpers (Modal primitive owns chrome) ────────────── */
  #create-leave-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  #create-leave-form :global(textarea.form-input) {
    resize: vertical;
    min-height: 64px;
  }
  .form-grid-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  .checkbox-row {
    display: flex !important;
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .form-error {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--bad-soft);
    border: 1px solid var(--bad);
    border-radius: var(--r-control);
    color: var(--bad);
    font-size: 0.8125rem;
  }
  .form-hint {
    font-size: 0.75rem;
    color: var(--text-2);
    margin: 0;
  }
  .attest-date-input {
    max-width: 160px;
  }
  /* Shared with the correction modal and the standalone Attest modal (the § 9 modal moved to the inbox, #840) —
     NOT exclusive to the review dialog, which moved to LeaveReviewDialog.svelte (Phase 255). */
  .review-error {
    margin-top: 0.75rem;
  }
  .attest-period {
    margin: 0 0 0.75rem;
  }
  .attest-late-hint {
    margin: 0.75rem 0 0;
  }

  /* ── Review Grid ──────────────────────────────────────────────────── */
  /* Shared with the correction modal and the standalone Attest modal (the § 9 modal moved to the inbox, #840) —
     NOT exclusive to the review dialog, which moved to LeaveReviewDialog.svelte (Phase 255). */
  .review-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem 1.5rem;
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: 1rem 1.25rem;
  }
  .review-field {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .review-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
  }
  .review-value {
    font-size: 0.9375rem;
    font-weight: 500;
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */
  /* .btn / .btn-danger / .btn-ghost / .btn-icon are defined globally in app.css. */

  /* ── View Tabs ────────────────────────────────────────────────────── */
  /* view-tabs, view-tab, tab-badge → global in app.css */

  /* ── Anträge list (Issue #840, E-02) ─────────────────────────────────── */
  /* The type chip is LeaveTypeChip (Issue 840 G-3): colour from the one mapping, a pending request
     dashed; the „Offen“ badge in the status cell says it in words. */

  /* #840 D-840-10: the legend is LeaveLegend.svelte. */
  /* Shared with the correction modal and the standalone Attest modal (the § 9 modal moved to the inbox, #840) —
     NOT exclusive to the review dialog, which moved to LeaveReviewDialog.svelte (Phase 255). */
  .review-section {
    margin-top: 1.25rem;
  }
  /* ── Responsive ───────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .review-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
