<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte"; // Phase 97-06
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // Quick 260824-cjd
  import KarenzAttestPanel from "$lib/components/leave/KarenzAttestPanel.svelte";
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
  let editingRequest: LeaveRequest | null = $state(null); // gesetztes Objekt = Bearbeitungsmodus
  // Seeds the dialog's date fields on a fresh CREATE open (calendar drag-select / day click /
  // Enter-Space). Reset to "" by the plain "+ Neue Abwesenheit" button.
  let pendingInitialStart = $state("");
  let pendingInitialEnd = $state("");

  // Überstunden- / Urlaubskontostand
  let overtimeBalance: number | null = $state(null);
  // Phase 97-06 (SALDO-DISP-01/04) — split fields from GET /leave/overtime-balance,
  // alongside the pre-existing lifetime `overtimeBalance`. Default `undefined` (not
  // null) so "not yet loaded" and "older cached response without the split fields"
  // both read as `confirmedMinutes === undefined` — the same fallback-to-legacy
  // check the dashboard's SaldoAnzeige tile already uses (97-04).
  let confirmedMinutes: number | undefined = $state(undefined);
  let openMonthMinutes: number | null | undefined = $state(undefined);
  let hasClosedMonth = $state(false);
  let rosterIncomplete: boolean | undefined = $state(undefined);
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
  // Phase 104-10 (D-28/D-29): the § 9 marker the server computes per request — masked
  // exactly like typeCode/typeName (null for a colleague without detail visibility).
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

  type View = "calendar" | "list";
  let view: View = $state("calendar");

  // Phase 378 (#378): the one place this page decides whether a colleague's absence TYPE may be
  // named (DSGVO Art. 9, #257/#303/D-10) — permission-based, not role-based. See the identical
  // comment on team/leave/+page.svelte for why.
  const canSeeOthersLeaveType = $derived(
    hasPermission($authStore.user, "leave-request:read:ZUGEWIESEN"),
  );

  /** Format a local Date to YYYY-MM-DD without UTC shift */
  function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const now = new Date();
  let calYear = $state(now.getFullYear());
  let calMonth = $state(now.getMonth() + 1); // 1-12

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

  async function loadCalendar() {
    calLoading = true;
    try {
      calEntries = await api.get<CalEntry[]>(`/leave/calendar?year=${calYear}&month=${calMonth}`);
    } catch {
      calEntries = [];
    } finally {
      calLoading = false;
    }
  }

  let showMonthPicker = $state(false);
  let pickerYear = $state(new Date().getFullYear());

  function prevMonth() {
    const prevYear = calYear;
    if (calMonth === 1) {
      calMonth = 12;
      calYear--;
    } else calMonth--;
    loadCalendar();
    if (calYear !== prevYear) {
      loadData();
      loadVacationSummary(calYear);
    }
  }
  function nextMonth() {
    const prevYear = calYear;
    if (calMonth === 12) {
      calMonth = 1;
      calYear++;
    } else calMonth++;
    loadCalendar();
    if (calYear !== prevYear) {
      loadData();
      loadVacationSummary(calYear);
    }
  }
  function gotoMonthYear(m: number, y: number) {
    const prevYear = calYear;
    calMonth = m;
    calYear = y;
    showMonthPicker = false;
    loadCalendar();
    if (calYear !== prevYear) {
      loadData();
      loadVacationSummary(calYear);
    }
  }
  function gotoToday() {
    const now = new Date();
    const prevYear = calYear;
    calMonth = now.getMonth() + 1;
    calYear = now.getFullYear();
    showMonthPicker = false;
    loadCalendar();
    if (calYear !== prevYear) {
      loadData();
      loadVacationSummary(calYear);
    }
  }
  function prevYear() {
    calYear--;
    loadCalendar();
    loadData();
    loadVacationSummary(calYear);
  }
  function nextYear() {
    calYear++;
    loadCalendar();
    loadData();
    loadVacationSummary(calYear);
  }

  // Year dropdown options for the list-view filter (current ± 2).
  const _currentYear = new Date().getFullYear();
  const yearOptions = [_currentYear - 2, _currentYear - 1, _currentYear, _currentYear + 1];

  const MONTH_NAMES = [
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

  // ── Laden ─────────────────────────────────────────────────────────────────
  onMount(async () => {
    await loadData();
    loadCalendar();
    loadVacationSummary(calYear);
    loadOvertimeBalance();
    loadKarenzOverrun();

    // Deep-link: highlight a specific request from notification
    const requestId = $page.url.searchParams.get("request");
    if (requestId) {
      highlightRequestId = requestId;
      view = "list";
      // Scroll to highlighted request after DOM update
      requestAnimationFrame(() => {
        const el = document.getElementById(`request-${requestId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      // Clear highlight after 3 seconds
      setTimeout(() => {
        highlightRequestId = null;
      }, 3000);
    }
  });

  async function loadData() {
    loading = true;
    error = "";
    try {
      const myEmployeeId = $authStore.user?.employeeId;
      const mine = await api.get<LeaveRequest[]>(
        `/leave/requests?year=${calYear}${myEmployeeId ? `&employeeId=${myEmployeeId}` : ""}`,
      );
      myRequests = mine;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
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

  // Phase 97-06 — response shape widened additively; balanceHours keeps its
  // existing meaning (lifetime total) for any consumer that still needs it.
  interface OvertimeBalanceResponse {
    balanceHours: number;
    confirmedMinutes?: number;
    openMonthMinutes?: number | null;
    hasClosedMonth?: boolean;
    rosterIncomplete?: boolean;
    // Phase 100 (OTC-03/OTC-05) — resolved negative-balance tolerance, alongside
    // the Phase-97 split fields above. Optional so an older cached response
    // degrades to "unconfigured" (no Toleranz row, no warn hint).
    maxNegativeBalanceMinutes?: number | null;
    isNegativeLimitExceeded?: boolean;
  }

  async function loadOvertimeBalance() {
    try {
      const r = await api.get<OvertimeBalanceResponse>("/leave/overtime-balance");
      overtimeBalance = r.balanceHours;
      confirmedMinutes = r.confirmedMinutes;
      openMonthMinutes = r.openMonthMinutes;
      hasClosedMonth = r.hasClosedMonth ?? false;
      rosterIncomplete = r.rosterIncomplete;
    } catch {
      overtimeBalance = null;
      confirmedMinutes = undefined;
      openMonthMinutes = undefined;
      hasClosedMonth = false;
      rosterIncomplete = undefined;
    }
  }

  // ── Antrag zurückziehen / Stornierung beantragen ──────────────────────────
  // Quick 260824-cjd: Storno now requires a Begründung — routed through a
  // ReasonDialog rather than fired directly from the row buttons.
  let cancelDialogOpen = $state(false);
  let cancelDialogRequest: LeaveRequest | null = $state(null);
  let cancelDialogTitle = $derived(
    cancelDialogRequest?.status === "APPROVED" ? "Stornierung beantragen?" : "Antrag zurückziehen?",
  );

  function openCancelDialog(req: LeaveRequest) {
    cancelDialogRequest = req;
    cancelDialogOpen = true;
  }

  async function cancelRequest(id: string, reason: string) {
    await api.delete(`/leave/requests/${id}`, { reason });
    await Promise.all([loadData(), loadCalendar(), loadVacationSummary(calYear)]);
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

  function daysLabel(days: number, halfDay: boolean): string {
    if (halfDay) return "½ Tag";
    return days === 1 ? "1 Tag" : `${days} Tage`;
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
  // Sick days (approved SICK + SICK_CHILD) for the currently viewed calendar year
  let sickDaysYear = $derived(
    myRequests
      .filter(
        (r) =>
          SICK_CODES.includes(r.typeCode) &&
          r.status === "APPROVED" &&
          new Date(r.startDate + "T00:00:00").getFullYear() === calYear,
      )
      .reduce((sum, r) => sum + Number(r.days), 0),
  );
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

  let filteredMyRequests = $derived(
    myRequests.filter((req) => {
      if (filterLeaveStatus && req.status !== filterLeaveStatus) return false;
      if (filterLeaveType && req.typeCode !== filterLeaveType) return false;
      return true;
    }),
  );

  let pagedMyRequests = $derived(
    filteredMyRequests.slice((myReqPage - 1) * myReqPageSize, myReqPage * myReqPageSize),
  );

  $effect(() => {
    filteredMyRequests.length;
    myReqPage = 1;
  });
</script>

<svelte:head>
  <title>Abwesenheiten – Clokr</title>
</svelte:head>

<svelte:window onmouseup={handleDayMouseUp} />

<!-- Phase 73-04 (D-05): `data-testid="leave-page"` is the stable surface anchor.
     Wrapped via `display:contents` so the marker contributes nothing to layout
     but Playwright (and future visual-regression specs) can address the page
     root without keying off CSS class hashes. -->
<div data-testid="leave-page" style="display: contents">
  <!-- ── Header ─────────────────────────────────────────────────────────────── -->
  <PageHead eyebrow="Mein Bereich" title="Urlaub & Abwesenheit" accent="Abwesenheit">
    {#snippet actions()}
      {#if !showForm}
        <button
          data-testid="leave-new-request"
          class="btn btn-primary btn-sm"
          onclick={() => {
            editingRequest = null;
            pendingInitialStart = "";
            pendingInitialEnd = "";
            showForm = true;
          }}>+ Neue Abwesenheit</button
        >
      {/if}
    {/snippet}
  </PageHead>

  {#if error}
    <div class="alert alert-error" role="alert" data-testid="leave-page-error">
      <span>⚠</span><span>{error}</span>
    </div>
  {/if}

  <!-- ── KPI-Zeile (Resturlaub, Überstundenkonto, Krankheitstage) ───────────── -->
  <div class="kpi-row" data-testid="leave-balance">
    <Card animate class="kpi-card">
      <!-- Phase 114 (RU-01/02/04): `Resturlaub` = der verfügbare Saldo, genau diese eine
           Bedeutung auf /leave. Der Vorjahresübertrag heißt „Übertrag Vorjahr" (Strip +
           Delta-Zeile), nie mehr „Resturlaub". Das „(ohne beantragte)" im Label ist
           ABSICHTLICH bedingt — bei 0 beantragten Tagen zeigen Karte und Leiste dieselbe
           Zahl und der Zusatz würde einen Unterschied behaupten, den es nicht gibt (gleiche
           Begründung wie Phase 107 G-03 im Panel unten). Die Entscheidung liegt in
           vacationCardLabel(), damit sie getestet ist. -->
      <KPIStat
        label={vacationCardLabel(vacSummaryPlanned)}
        value={vacRemaining === null ? "–" : String(vacRemaining)}
        unit={(vacRemaining ?? 0) === 1 ? "Tag" : "Tage"}
        delta={vacationBalance
          ? vacationCardDelta(vacationBalance.total, vacationBalance.carryOver)
          : undefined}
      />
    </Card>

    <Card animate class="kpi-card">
      <!-- Phase 97-06 (SALDO-DISP-02/05) — the split primitive replaces the inline
           KPIStat markup outright (not wrapped), same as the dashboard tile:
           KPIStat's pure-props string contract cannot express a two-figure tile.
           Leads with "Bestätigt", subordinates "Laufender Monat (Prognose)". -->
      <!-- IN-01 (code review) — `loading` (declared above) now reaches the primitive. Note:
           this KPI's own data arrives via loadOvertimeBalance(), fired (not awaited) AFTER
           `loading` already flips false in onMount — so this only narrows the "Kein
           Stundenplan" flash window (covers loadData()'s own fetch), it does not close it
           completely. A fully precise fix would need a dedicated loading flag for
           loadOvertimeBalance() itself; not added here to keep this change minimal. `error` is
           deliberately NOT wired — this page's `error` string is reused for unrelated
           mutations (delete/iCal-download/etc.), so surfacing it here would mislabel an
           unrelated failure as "saldo failed to load". -->
      {#if confirmedMinutes !== undefined}
        <SaldoAnzeige
          variant="expanded"
          label="Überstundenkonto"
          confirmedMinutes={confirmedMinutes ?? 0}
          openMonthMinutes={openMonthMinutes ?? null}
          hasClosedMonth={hasClosedMonth ?? false}
          {rosterIncomplete}
          {loading}
        />
      {:else}
        <!-- Fallback: an older cached response without the split fields — degrade
             to the primitive's single-value rendering instead of blanking. -->
        <SaldoAnzeige
          variant="expanded"
          label="Überstundenkonto"
          saldoMinutes={overtimeBalance !== null ? Math.round(overtimeBalance * 60) : null}
          {loading}
        />
      {/if}
    </Card>

    <Card animate class="kpi-card">
      <KPIStat
        label="Krankheitstage"
        value={String(sickDaysYear)}
        unit={sickDaysYear === 1 ? "Tag" : "Tage"}
        delta={`in ${calYear}`}
      />
    </Card>
  </div>

  <!-- ── View-Toggle ────────────────────────────────────────────────────────── -->
  <div class="view-tabs" data-testid="leave-view-tabs">
    <button
      data-testid="leave-view-calendar"
      class="view-tab"
      class:view-tab--active={view === "calendar"}
      onclick={() => (view = "calendar")}
    >
      Kalender
    </button>
    <button
      data-testid="leave-view-list"
      class="view-tab"
      class:view-tab--active={view === "list"}
      onclick={() => (view = "list")}
    >
      Meine Anträge
    </button>
  </div>

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
    entitlementYear={calYear}
    onSaved={async () => {
      await Promise.all([loadData(), loadCalendar(), loadVacationSummary(calYear)]);
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
  <!-- Phase 117 (issue #122, D-03) — while the entitlement figures for the selected year are in
       flight, the strip shows a skeleton, never the numbers of the year we just left. Same rule
       and same recipe as Phase 116's /time-entries list skeleton: the global `.skeleton` shimmer
       from app.css, aria-hidden, only the geometry is page-scoped. Four tiles is the strip's
       usual width; the two Übertrag tiles are conditional, so the placeholder count is
       deliberately approximate — it is a shimmer, not a claim. -->
  {#snippet vacStatsSkeleton()}
    <div class="vac-summary-skeleton" data-testid="vac-summary-skeleton" aria-hidden="true">
      {#each Array(4) as _, i (i)}<div class="skeleton vac-summary-skel-tile"></div>{/each}
    </div>
  {/snippet}
  {#snippet vacStats()}
    <div class="vac-stats">
      <div class="vac-stat">
        <div class="vac-stat-label">Anspruch</div>
        <div class="vac-stat-value">{vacSummaryTotal}<span class="vac-stat-unit">T</span></div>
      </div>
      {#if vacSummaryCarryOver > 0}
        <!-- Phase 114 (RU-01/RU-03): zwei Kacheln statt einer. Der BRUTTO-Übertrag war bisher
             nirgends als Zahl sichtbar — nur eingerechnet — weshalb „Genommen 31 bei Anspruch 24"
             unerklärt blieb. Die zweite Kachel ist die frühere Kachel „Resturlaub": sie meint
             ausschließlich den ungenutzten REST des Übertrags. Beide stehen bewusst
             nebeneinander; getrennt wäre „(Rest) 0" wieder eine verwaiste Zahl. Kein Jahr im
             Label — die Entitlement-Zahlen kommen immer aus dem laufenden Jahr, unabhängig vom
             angezeigten calYear (siehe deferred-items.md). -->
        <div class="vac-stat" data-testid="vac-stat-carryover">
          <div class="vac-stat-label">Übertrag Vorjahr</div>
          <div class="vac-stat-value vac-stat-carry">
            +{vacSummaryCarryOver}<span class="vac-stat-unit">T</span>
          </div>
        </div>
        <div class="vac-stat" data-testid="vac-stat-carryover-rest">
          <div class="vac-stat-label">Übertrag Vorjahr (Rest)</div>
          <div class="vac-stat-value {vacSummaryCarryOverRemaining === 0 ? '' : 'vac-stat-carry'}">
            {vacSummaryCarryOverRemaining === 0 ? "0" : "+" + vacSummaryCarryOverRemaining}<span
              class="vac-stat-unit">T</span
            >
          </div>
        </div>
      {/if}
      <div class="vac-stat">
        <div class="vac-stat-label">Genommen</div>
        <div class="vac-stat-value">{vacSummaryUsed}<span class="vac-stat-unit">T</span></div>
      </div>
      {#if vacSummaryPlanned > 0}
        <div class="vac-stat">
          <div class="vac-stat-label">Beantragt</div>
          <div class="vac-stat-value vac-stat-planned">
            {vacSummaryPlanned}<span class="vac-stat-unit">T</span>
          </div>
        </div>
      {/if}
      <div class="vac-stat vac-stat--highlight">
        <div class="vac-stat-label">Verbleibend</div>
        <div class="vac-stat-value {vacSummaryLeft < 0 ? 'neg' : 'pos'}">
          {vacSummaryLeft}<span class="vac-stat-unit">T</span>
        </div>
      </div>
    </div>
  {/snippet}

  <!-- ── Kalender-Ansicht ──────────────────────────────────────────────────── -->
  {#if view === "calendar"}
    <!-- Combined month bar (v1.5 — identisch zu Zeiterfassung, with picker dropdown) -->
    <div class="card cal-monthbar card-animate">
      <div class="cal-monthbar-nav">
        <button
          class="nav-btn"
          onclick={prevMonth}
          title="Vorheriger Monat"
          aria-label="Vorheriger Monat"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"><polyline points="15 18 9 12 15 6" /></svg
          >
        </button>
        <div class="cal-nav-center cal-monthbar-center">
          <div class="serif-eyebrow cal-monthbar-eyebrow">Buchungsmonat</div>
          <button
            class="cal-monthbar-title"
            onclick={() => {
              pickerYear = calYear;
              showMonthPicker = !showMonthPicker;
            }}
            title="Monat/Jahr wählen"
          >
            {MONTH_NAMES[calMonth - 1]}
            {calYear}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"><polyline points="6 9 12 15 18 9" /></svg
            >
          </button>
          {#if showMonthPicker}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="month-picker-backdrop" onclick={() => (showMonthPicker = false)}></div>
            <div class="month-picker">
              <div class="month-picker-year">
                <button onclick={() => pickerYear--}>‹</button>
                <span>{pickerYear}</span>
                <button onclick={() => pickerYear++}>›</button>
              </div>
              <div class="month-picker-grid">
                {#each MONTH_NAMES as name, i (i)}
                  <button
                    class="month-picker-btn"
                    class:active={i + 1 === calMonth && pickerYear === calYear}
                    onclick={() => gotoMonthYear(i + 1, pickerYear)}>{name.slice(0, 3)}</button
                  >
                {/each}
              </div>
              <button class="month-picker-today" onclick={gotoToday}>Heute</button>
            </div>
          {/if}
        </div>
        <button
          class="nav-btn"
          onclick={nextMonth}
          title="Nächster Monat"
          aria-label="Nächster Monat"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg
          >
        </button>
        <button class="btn btn-ghost btn-sm cal-monthbar-today" onclick={gotoToday}>Heute</button>
      </div>
      {#if showVacSummary}
        {#if vacSummaryLoading}
          {@render vacStatsSkeleton()}
        {:else}
          {@render vacStats()}
        {/if}
      {/if}
    </div>

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
                    {@const _vis = resolveChipVisual(e, canSeeOthersLeaveType)}
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

      <!-- Legende -->
      <div class="cal-legend">
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-vacation)"
          ></span>Urlaub</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-overtime)"
          ></span>ÜSt-Ausgleich</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-sick)"></span>Krank</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-sick-child)"
          ></span>Kinderkrank</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-special)"
          ></span>Sonderurlaub</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-education)"
          ></span>Bildungsurlaub</span
        >
        <span class="legend-item"
          ><span class="legend-dot" style:background="var(--leave-type-absent)"
          ></span>Abwesend</span
        >
        <span class="legend-item"><span class="legend-holiday-dot"></span>Feiertag</span>
        <span class="legend-item legend-pending">gestrichelt = ausstehend</span>
      </div>
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
        >
          {icalDownloading ? "Laden…" : "Meine Abwesenheiten"}
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onclick={() => downloadIcal("team")}
          disabled={icalDownloading}
        >
          {icalDownloading ? "Laden…" : "Team-Abwesenheiten"}
        </button>
      </div>
    </div>
  {/if}

  <!-- ── Listen-Ansicht ────────────────────────────────────────────────────── -->
  {#if view === "list"}
    <!-- Combined year-bar (v1.5 — identisch zu Zeiterfassung, static year title) -->
    <div class="card cal-monthbar card-animate">
      <div class="cal-monthbar-nav">
        <button
          class="nav-btn"
          onclick={prevYear}
          title="Vorheriges Jahr"
          aria-label="Vorheriges Jahr"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"><polyline points="15 18 9 12 15 6" /></svg
          >
        </button>
        <div class="cal-nav-center cal-monthbar-center">
          <div class="serif-eyebrow cal-monthbar-eyebrow">Urlaubsjahr</div>
          <div class="cal-monthbar-title cal-monthbar-title--static">{calYear}</div>
        </div>
        <button class="nav-btn" onclick={nextYear} title="Nächstes Jahr" aria-label="Nächstes Jahr">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg
          >
        </button>
      </div>
      {#if showVacSummary}
        {#if vacSummaryLoading}
          {@render vacStatsSkeleton()}
        {:else}
          {@render vacStats()}
        {/if}
      {/if}
    </div>

    <!-- ── Anträge-Tabelle ─────────────────────────────────────────────────────── -->
    <div class="section-header card-animate">
      <h2>Meine Anträge</h2>
    </div>

    {#if loading}
      <div class="card card-body skeleton skeleton-card" style="height:180px"></div>
    {:else}
      <div class="filter-bar card-animate">
        <select
          data-testid="leave-filter-status"
          class="form-input filter-select"
          bind:value={filterLeaveStatus}
          aria-label="Nach Status filtern"
        >
          <option value="" data-testid="leave-filter-open">Alle Status</option>
          <option value="PENDING">Ausstehend</option>
          <option value="APPROVED" data-testid="leave-filter-approved">Genehmigt</option>
          <option value="REJECTED">Abgelehnt</option>
          <option value="CANCELLED">Storniert</option>
          <option value="CANCELLATION_REQUESTED" data-testid="leave-filter-cancellation"
            >Stornierung beantragt</option
          >
        </select>
        <select
          data-testid="leave-filter-type"
          class="form-input filter-select"
          bind:value={filterLeaveType}
          aria-label="Nach Art filtern"
        >
          <option value="">Alle Arten</option>
          {#each TYPE_OPTIONS as t (t.code)}
            <option value={t.code}>{t.label}</option>
          {/each}
        </select>
        <span class="filter-count">{filteredMyRequests.length} im Jahr {calYear}</span>
      </div>

      {#if myRequests.length === 0}
        <div class="empty-state card card-body" data-testid="leave-empty-state">
          <span class="empty-icon">🏖️</span>
          <h3>Keine Anträge in {calYear}</h3>
          <p class="text-muted">Wähle ein anderes Jahr oder lege einen neuen Antrag an.</p>
        </div>
      {:else}
        <div class="table-wrapper">
          <table class="data-table" data-testid="leave-mine-table">
            <thead>
              <tr>
                <th>Art</th>
                <th>Von</th>
                <th>Bis</th>
                <th class="text-center">Umfang</th>
                <th>Status</th>
                <th>Anmerkung</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each pagedMyRequests as req (req.id)}
                {@const isOwn = req.employeeId === $authStore.user?.employeeId}
                <tr
                  id="request-{req.id}"
                  data-testid={`leave-mine-row-${req.id}`}
                  data-status={req.status}
                  class:highlight-row={highlightRequestId === req.id}
                >
                  <td>{typeName(req.typeCode)}</td>
                  <td class="font-mono">{fmtDate(req.startDate)}</td>
                  <td class="font-mono">{fmtDate(req.endDate)}</td>
                  <td class="text-center">{daysLabel(Number(req.days), req.halfDay)}</td>
                  <td>
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
                        class="badge badge-attest {req.attestPresent
                          ? 'badge-green'
                          : 'badge-gray'}"
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
                  </td>
                  <td class="note-cell text-muted">
                    {#if req.status === "REJECTED" && req.reviewNote}
                      <span class="text-red" title={req.reviewNote}>⚠ {req.reviewNote}</span>
                    {:else}
                      {req.note ?? "—"}
                    {/if}
                  </td>
                  <td class="action-cell">
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
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
          <Pagination
            total={filteredMyRequests.length}
            bind:page={myReqPage}
            bind:pageSize={myReqPageSize}
          />
        </div>
      {/if}
    {/if}
  {/if}<!-- Ende Liste -->

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
    canSeeType={canSeeOthersLeaveType}
  />
</div>

<!-- /leave-page -->

<style>
  /* ── KPI Row (v1.5 design system) ─────────────────────────────────── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 16px;
  }
  .kpi-card {
    /* .card recipe in app.css provides bg, border, radius, padding */
    min-height: 96px;
  }
  @media (max-width: 768px) {
    .kpi-row {
      grid-template-columns: 1fr;
      gap: 12px;
    }
  }

  /* ── Highlight from notification deep-link ────────────────────────── */
  @keyframes highlight-fade {
    0% {
      background-color: var(--brand-soft);
    }
    100% {
      background-color: transparent;
    }
  }
  .highlight-row {
    animation: highlight-fade 3s var(--ease-out) both;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 0.875rem;
  }
  .section-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }

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
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.875rem 1rem;
  }
  .overlap-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
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
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .overlap-dates {
    font-family: var(--font-mono);
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
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action-cell {
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

  /* ── Empty ────────────────────────────────────────────────────────── */
  .empty-state {
    text-align: center;
    padding: 3rem 2rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
  }
  .empty-icon {
    font-size: 2.5rem;
  }
  .empty-state h3 {
    font-size: 1rem;
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */
  .btn-danger {
    background: var(--bad);
    color: white;
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
    color: var(--text-muted);
  }

  /* ── Balance Box ──────────────────────────────────────────────────── */
  .balance-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
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
    color: var(--text-muted);
  }
  .balance-value {
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .balance-meta {
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-muted);
    margin-left: 0.25rem;
  }
  .balance-deduct {
    color: var(--text-muted);
  }
  .balance-warn {
    color: var(--bad);
  }
  .balance-divider {
    height: 1px;
    background: var(--border);
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
  /* Phase 97-06 (SALDO-DISP-04) — the "Laufender Monat (Prognose)" row: muted like
     the forecast everywhere else in the app (never --good/--bad/--warn — colour
     must never imply a certainty this figure doesn't have). */
  .balance-value--muted {
    color: var(--text-muted);
  }
  .balance-hint-muted {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0 0;
  }

  /* ── View Tabs ────────────────────────────────────────────────────── */
  /* view-tabs, view-tab, tab-badge → global in app.css */

  /* ── Combined Calendar Month-Bar ─────────────────────────────────────
     .cal-monthbar* recipe lives in app.css (v1.5 canonical, shared with
     /team/leave). Per-page overrides are forbidden. */

  .vac-stats {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    flex-wrap: wrap;
  }

  /* Phase 117 (issue #122, D-03) — Ladezustand der Kachelleiste. Reuses the global .skeleton
     shimmer (app.css:883); only the geometry is page-scoped, same split as Phase 116's
     .list-skeleton on /time-entries. Mirrors .vac-stats' own flex row + 28px gap so the strip
     does not jump when the numbers arrive. */
  .vac-summary-skeleton {
    display: flex;
    align-items: flex-end;
    gap: 28px;
    flex-wrap: wrap;
  }
  .vac-summary-skel-tile {
    width: 72px;
    height: 38px;
    border-radius: var(--r-sm);
  }

  .vac-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .vac-stat-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .vac-stat-value {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 22px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  .vac-stat-value.pos {
    color: var(--good);
  }
  .vac-stat-value.neg {
    color: var(--bad);
  }
  .vac-stat-carry {
    color: var(--brand);
  }
  .vac-stat-planned {
    color: var(--warn);
  }

  .vac-stat-unit {
    font-family: var(--font-sans);
    font-variant-numeric: normal;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }

  .vac-stat--highlight .vac-stat-label {
    color: var(--text);
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
    color: var(--text-muted);
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
    color: white;
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
    outline: 1.5px dashed rgba(255, 255, 255, 0.7);
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
    background: rgba(255, 255, 255, 0.35);
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
    color: var(--text-muted);
  }

  /* Legende */
  .cal-legend {
    display: flex;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
    flex-wrap: wrap;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .badge-attest {
    margin-left: 0.25rem;
    font-size: 0.75rem;
  }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
    display: inline-block;
  }
  .legend-holiday-dot {
    width: 10px;
    height: 10px;
    background: var(--brand-soft);
    border: 1.5px solid var(--brand);
    border-radius: 2px;
    flex-shrink: 0;
    display: inline-block;
  }
  .legend-pending {
    font-style: italic;
  }

  /* ── iCal ────────────────────────────────────────────────────────── */
  .ical-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
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
    color: var(--text-muted);
    margin: 0;
  }
  .ical-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
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
      border-radius: var(--r-md);
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
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-family: var(--font-serif);
      font-style: italic;
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
