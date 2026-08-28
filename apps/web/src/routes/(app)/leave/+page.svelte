<script lang="ts">
  import { preventDefault } from "svelte/legacy";

  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte"; // Phase 97-06
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte"; // Quick 260824-cjd
  import CollisionWarnBody from "$lib/phorest/CollisionWarnBody.svelte";
  import {
    checkAppointmentCollisions,
    COLLISION_UNAVAILABLE_TOAST,
    type CollisionSummary,
  } from "$lib/phorest/appointmentCollisions";
  import { toasts } from "$stores/toast";
  import {
    mapVacationBalance,
    resolveAdjustmentBadge,
    type VacationBalance,
    type VacationEntitlementRow,
    type LastDaysAdjustment,
  } from "$lib/leave/vacation-balance";

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

  interface OverlapEntry {
    id: string;
    employeeName: string;
    typeName: string;
    startDate: string;
    endDate: string;
    status: Status;
  }

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

  // Formular
  let showForm = $state(false);
  let editingRequest: LeaveRequest | null = $state(null); // gesetztes Objekt = Bearbeitungsmodus
  let formType: TypeCode = $state("VACATION");
  let formStart = $state("");
  let formEnd = $state("");
  let formHalfDay = $state(false);
  let formNote = $state("");
  let formSaving = $state(false);
  let formError = $state("");

  // Special leave rules
  interface SpecialLeaveRule {
    id: string;
    name: string;
    defaultDays: number;
    isActive: boolean;
  }
  let specialLeaveRules: SpecialLeaveRule[] = $state([]);
  let formSpecialRuleId = $state("");

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
  // Phase 100 (OTC-03) — resolved negative-balance tolerance, same
  // `undefined`-default convention as the Phase-97 fields above.
  let maxNegativeBalanceMinutes: number | null | undefined = $state(undefined);
  let isNegativeLimitExceeded: boolean | undefined = $state(undefined);
  // Phase 104-10 (D-31): one movement per CONFIRMED § 9 credit in this entitlement year —
  // rendered verbatim (server-authored label), never re-derived on the client.
  // Types + the mapper live in $lib/leave/vacation-balance.ts (dev-pass fix, see that
  // file's doc comment) so every call site maps `section9Movements` the same way and
  // the mapping is unit-testable without mounting this page.
  let vacationBalance = $state<VacationBalance | null>(null);

  // Stunden- und Tage-Vorschau (vom Server berechnet, Feiertage berücksichtigt)
  let hoursPreview: number | null = $state(null);
  // Phase 100 (WR-03 code review fix) — exact integer minutes alongside the
  // .toFixed(2)-rounded `hoursPreview`, so wouldBeRejected below can compare in the
  // same unit the server gate uses instead of reconstructing it through two
  // different rounding paths.
  let minutesNeeded: number | null = $state(null);
  let serverDays: number | null = $state(null); // Feiertags-bereinigte Tage vom Server
  let hoursPreviewLoading = $state(false);
  let hoursPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  // Parallele Abwesenheiten im Formular
  let overlapEntries: OverlapEntry[] = $state([]);
  let overlapLoading = $state(false);
  let overlapTimer: ReturnType<typeof setTimeout> | null = null;

  // Attest-Modal (für bereits genehmigte Krankmeldungen) — Modal primitive owns Escape/backdrop/focus-trap.
  let attestModal: LeaveRequest | null = $state(null);
  let attestOpen = $state(false);
  let attestPresent = $state(false);
  let attestFrom = $state("");
  let attestTo = $state("");
  let attestSaving = $state(false);
  let attestError = $state("");

  // Highlighted request (from notification deep-link)
  let highlightRequestId: string | null = $state(null);

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
    formStart = start;
    formEnd = end;
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
    if (calYear !== prevYear) loadData();
  }
  function nextMonth() {
    const prevYear = calYear;
    if (calMonth === 12) {
      calMonth = 1;
      calYear++;
    } else calMonth++;
    loadCalendar();
    if (calYear !== prevYear) loadData();
  }
  function gotoMonthYear(m: number, y: number) {
    const prevYear = calYear;
    calMonth = m;
    calYear = y;
    showMonthPicker = false;
    loadCalendar();
    if (calYear !== prevYear) loadData();
  }
  function gotoToday() {
    const now = new Date();
    const prevYear = calYear;
    calMonth = now.getMonth() + 1;
    calYear = now.getFullYear();
    showMonthPicker = false;
    loadCalendar();
    if (calYear !== prevYear) loadData();
  }
  function prevYear() {
    calYear--;
    loadCalendar();
    loadData();
  }
  function nextYear() {
    calYear++;
    loadCalendar();
    loadData();
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

  // Typ → Hintergrundfarbe (approved=satt, pending=heller)
  function typeColor(code: TypeCode | null, status: Status, isOwn: boolean): string {
    if (!isOwn || !code)
      return status === "APPROVED" ? "var(--leave-type-absent)" : "var(--leave-type-absent-muted)";
    const colors: Record<TypeCode, string> = {
      VACATION: "var(--leave-type-vacation)",
      OVERTIME_COMP: "var(--leave-type-overtime)",
      SPECIAL: "var(--leave-type-special)",
      EDUCATION: "var(--leave-type-education)",
      SICK: "var(--leave-type-sick)",
      SICK_CHILD: "var(--leave-type-sick-child)",
      UNPAID: "var(--leave-type-unpaid)",
      HOLIDAY: "var(--leave-type-holiday)",
      MATERNITY: "var(--leave-type-maternity)",
      PARENTAL: "var(--leave-type-parental)",
    };
    return colors[code] ?? "var(--leave-type-default)";
  }

  // ── Laden ─────────────────────────────────────────────────────────────────
  onMount(async () => {
    await loadData();
    loadCalendar();
    loadVacationSummary();
    loadOvertimeBalance();

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

  onDestroy(() => {
    if (hoursPreviewTimer) clearTimeout(hoursPreviewTimer);
    if (overlapTimer) clearTimeout(overlapTimer);
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

  async function loadVacationSummary() {
    const userId = $authStore.user?.employeeId;
    if (!userId) return;
    try {
      const year = new Date().getFullYear();
      const [entitlements, empData] = await Promise.all([
        api.get<VacationEntitlementRow[]>(`/leave/entitlements/${userId}?year=${year}`),
        api.get<{ exitDate: string | null }>(`/employees/${userId}`).catch(() => null),
      ]);
      const vac = entitlements.find((e) => e.typeCode === "VACATION");
      vacationBalance = mapVacationBalance(vac);
      viewedExitDate = empData?.exitDate ?? null;
    } catch {
      /* silent */
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
      maxNegativeBalanceMinutes = r.maxNegativeBalanceMinutes;
      isNegativeLimitExceeded = r.isNegativeLimitExceeded;
    } catch {
      overtimeBalance = null;
      confirmedMinutes = undefined;
      openMonthMinutes = undefined;
      hasClosedMonth = false;
      rosterIncomplete = undefined;
      maxNegativeBalanceMinutes = undefined;
      isNegativeLimitExceeded = undefined;
    }
  }

  // ── Overlap laden ─────────────────────────────────────────────────────────
  function scheduleOverlapLoad() {
    if (overlapTimer) clearTimeout(overlapTimer);
    if (!formStart || !formEnd || formStart > formEnd) {
      overlapEntries = [];
      return;
    }
    overlapTimer = setTimeout(doLoadOverlap, 300);
  }

  async function doLoadOverlap(start = formStart, end = formEnd) {
    if (!start || !end || start > end) return;
    overlapLoading = true;
    try {
      overlapEntries = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${start}&endDate=${end}`,
      );
    } catch {
      overlapEntries = [];
    } finally {
      overlapLoading = false;
    }
  }

  function scheduleHoursPreview() {
    if (hoursPreviewTimer) clearTimeout(hoursPreviewTimer);
    if (!formStart || !formEnd || formStart > formEnd) {
      hoursPreview = null;
      minutesNeeded = null;
      serverDays = null;
      return;
    }
    hoursPreviewTimer = setTimeout(loadHoursPreview, 300);
  }

  async function loadHoursPreview() {
    if (!formStart || !formEnd) return;
    hoursPreviewLoading = true;
    try {
      const r = await api.get<{ hours: number; days: number; minutesNeeded: number }>(
        `/leave/hours-preview?startDate=${formStart}&endDate=${formEnd}&halfDay=${formHalfDay}`,
      );
      hoursPreview = r.hours;
      minutesNeeded = r.minutesNeeded;
      serverDays = r.days;
    } catch {
      hoursPreview = null;
      minutesNeeded = null;
      serverDays = null;
    } finally {
      hoursPreviewLoading = false;
    }
  }

  async function loadBalanceForType(type: TypeCode) {
    if (type === "OVERTIME_COMP") {
      try {
        const r = await api.get<OvertimeBalanceResponse>("/leave/overtime-balance");
        overtimeBalance = r.balanceHours;
        confirmedMinutes = r.confirmedMinutes;
        openMonthMinutes = r.openMonthMinutes;
        hasClosedMonth = r.hasClosedMonth ?? false;
        rosterIncomplete = r.rosterIncomplete;
        maxNegativeBalanceMinutes = r.maxNegativeBalanceMinutes;
        isNegativeLimitExceeded = r.isNegativeLimitExceeded;
      } catch {
        overtimeBalance = null;
        confirmedMinutes = undefined;
        openMonthMinutes = undefined;
        hasClosedMonth = false;
        rosterIncomplete = undefined;
        maxNegativeBalanceMinutes = undefined;
        isNegativeLimitExceeded = undefined;
      }
    } else if (type === "VACATION") {
      try {
        const year = new Date().getFullYear();
        const userId = $authStore.user?.employeeId;
        if (!userId) return;
        const entitlements = await api.get<VacationEntitlementRow[]>(
          `/leave/entitlements/${userId}?year=${year}`,
        );
        const vac = entitlements.find((e) => e.typeCode === "VACATION");
        vacationBalance = mapVacationBalance(vac);
      } catch {
        vacationBalance = null;
      }
    }
  }

  // ── Formular zurücksetzen ─────────────────────────────────────────────────
  async function loadSpecialLeaveRules() {
    if (specialLeaveRules.length > 0) return;
    try {
      const all = await api.get<SpecialLeaveRule[]>("/special-leave/rules");
      specialLeaveRules = all.filter((r) => r.isActive);
    } catch {
      /* ignore */
    }
  }

  function resetForm() {
    showForm = false;
    resetFormFields();
  }

  function resetFormFields() {
    editingRequest = null;
    formType = "VACATION";
    formStart = formEnd = formNote = "";
    formHalfDay = false;
    formSpecialRuleId = "";
    overlapEntries = [];
    hoursPreview = null;
    minutesNeeded = null;
    serverDays = null;
  }

  // ── Antrag einreichen / bearbeiten ────────────────────────────────────────
  // Phase 87: appointment-collision warn-and-confirm gate on CREATE only. The
  // dialog is parent-owned; on ≥1 collision it must be confirmed before POST.
  let collisionConfirmOpen = $state(false);
  let collisionSummary = $state<CollisionSummary | null>(null);

  // Snapshot of the create payload captured BEFORE the form Modal is closed on
  // the collision path. Closing the Modal triggers the reset effect
  // (`if (!showForm) resetFormFields()`) which would otherwise wipe
  // formStart/formEnd/… before the confirm-path POST runs — so the confirm
  // mutation reads this snapshot instead of the (now reset) live fields.
  type PendingCreate = {
    type: TypeCode;
    startDate: string;
    endDate: string;
    halfDay: boolean;
    note: string;
    specialLeaveRuleId?: string;
  };
  let pendingCreate = $state<PendingCreate | null>(null);

  async function submitRequest() {
    // Edit path is unchanged — no collision pre-check on PATCH.
    if (editingRequest) {
      await performLeaveMutation();
      return;
    }
    // Create path: fail-open pre-check before the POST.
    const summary = await checkAppointmentCollisions({
      employeeId: $authStore.user?.employeeId ?? "",
      from: formStart,
      to: formEnd,
    });
    if (summary && summary.total > 0) {
      // Booked appointments in range → require explicit confirm before POST.
      // Snapshot the payload FIRST, then close the form Modal so exactly ONE
      // scrim is live (mirrors the team/leave pendingApprove pattern), then
      // open the collision dialog.
      pendingCreate = {
        type: formType,
        startDate: formStart,
        endDate: formEnd,
        halfDay: formHalfDay,
        note: formNote,
        ...(formType === "SPECIAL" && formSpecialRuleId
          ? { specialLeaveRuleId: formSpecialRuleId }
          : {}),
      };
      collisionSummary = summary;
      showForm = false;
      collisionConfirmOpen = true;
      return;
    }
    if (summary === null) {
      // Fail-open: endpoint unreachable — proceed without blocking, notify.
      toasts.error(COLLISION_UNAVAILABLE_TOAST);
    }
    await performLeaveMutation();
  }

  // Confirm handler for the collision dialog (create path only). Throws on
  // failure so the ConfirmDialog stays open (its documented contract), mirroring
  // the team/leave confirmCreateWithCollisions pattern.
  async function confirmCreateWithCollisions() {
    const ok = await performLeaveMutation();
    if (!ok) throw new Error("Antrag konnte nicht eingereicht werden");
  }

  // Cancel handler for the collision dialog — abort cleanly, no orphaned state.
  function cancelCreateCollision() {
    pendingCreate = null;
    collisionSummary = null;
  }

  // The actual create/edit mutation, shared by the direct path and the
  // collision-confirm path. Returns true on success, false on failure.
  async function performLeaveMutation(): Promise<boolean> {
    formSaving = true;
    formError = "";
    try {
      if (editingRequest) {
        await api.patch(`/leave/requests/${editingRequest.id}`, {
          startDate: formStart,
          endDate: formEnd,
          halfDay: formHalfDay,
          note: formNote || null,
        });
      } else {
        // Prefer the snapshot captured before the collision dialog closed the
        // form (its reset effect wiped the live fields); fall back to the live
        // form fields for the direct no-collision path.
        const src: PendingCreate = pendingCreate ?? {
          type: formType,
          startDate: formStart,
          endDate: formEnd,
          halfDay: formHalfDay,
          note: formNote,
          ...(formType === "SPECIAL" && formSpecialRuleId
            ? { specialLeaveRuleId: formSpecialRuleId }
            : {}),
        };
        await api.post("/leave/requests", {
          type: src.type,
          startDate: src.startDate,
          endDate: src.endDate,
          halfDay: src.halfDay,
          note: src.note || null,
          ...(src.type === "SPECIAL" && src.specialLeaveRuleId
            ? { specialLeaveRuleId: src.specialLeaveRuleId }
            : {}),
        });
      }
      resetForm();
      pendingCreate = null;
      collisionSummary = null;
      await Promise.all([loadData(), loadCalendar(), loadVacationSummary()]);
      return true;
    } catch (e: unknown) {
      formError = e instanceof Error ? e.message : "Fehler";
      // On the collision-confirm path the form Modal is already closed, so the
      // inline formError is not visible — surface it via a toast instead.
      if (!showForm) toasts.error(formError);
      return false;
    } finally {
      formSaving = false;
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
    await Promise.all([loadData(), loadCalendar(), loadVacationSummary()]);
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
    formType = req.typeCode as TypeCode;
    formStart = req.startDate;
    formEnd = req.endDate;
    formHalfDay = req.halfDay;
    formNote = req.note ?? "";
    showForm = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Attest-Modal (für bereits genehmigte Krankmeldungen) ─────────────────
  function openAttestModal(req: LeaveRequest) {
    attestModal = req;
    attestPresent = req.attestPresent ?? false;
    attestFrom = req.attestValidFrom ?? "";
    attestTo = req.attestValidTo ?? "";
    attestError = "";
    attestOpen = true;
  }

  function closeAttestModal() {
    if (attestSaving) return;
    attestOpen = false;
    attestModal = null;
  }

  async function saveAttest() {
    if (!attestModal) return;
    attestSaving = true;
    attestError = "";
    try {
      await api.patch(`/leave/requests/${attestModal.id}/attest`, {
        attestPresent,
        attestValidFrom: attestPresent && attestFrom ? attestFrom : null,
        attestValidTo: attestPresent && attestTo ? attestTo : null,
      });
      attestOpen = false;
      attestModal = null;
      await loadData();
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

  function calcDays(start: string, end: string, halfDay: boolean): number {
    if (!start || !end || start > end) return 0;
    if (halfDay) return 0.5;
    let days = 0;
    const cur = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (cur <= endD) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) days++;
      cur.setDate(cur.getDate() + 1);
    }
    return days;
  }

  function fmtH(h: number): string {
    const abs = Math.abs(h);
    const hh = Math.floor(abs);
    const mm = Math.round((abs - hh) * 60);
    return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
  }
  // Abgeleitete Werte
  let formDays = $derived(calcDays(formStart, formEnd, formHalfDay));
  let effectiveDays = $derived(serverDays ?? formDays); // Server-Wert bevorzugen (Feiertage)
  let hoursNeeded = $derived(hoursPreview ?? formDays * 8); // Fallback auf ×8 solange Preview lädt
  // Phase 97-06 (SALDO-DISP-04) — the OVERTIME_COMP balance-box's affordability
  // arithmetic (Guthaben/Verbleibend) uses the CONFIRMED figure, never the
  // lifetime total (which still includes the unclaimable open-month forecast).
  // Falls back to the lifetime total when confirmedMinutes hasn't loaded yet,
  // matching the KPI tile's own degrade-not-blank convention below.
  let confirmedHours = $derived(
    confirmedMinutes !== undefined ? confirmedMinutes / 60 : (overtimeBalance ?? 0),
  );
  // Phase 100 (OTC-03) — resolved negative-balance tolerance in hours, for the
  // Toleranz row display below.
  let toleranceHours = $derived((maxNegativeBalanceMinutes ?? 0) / 60);
  // Phase 100 (OTC-05, WR-03 code-review fix) — mirrors the server gate in leave.ts
  // (`neededMinutes > availableMinutes`). Compares in MINUTES — the server's own unit —
  // whenever both exact-minute values have loaded: `minutesNeeded` from GET
  // /leave/hours-preview and `confirmedMinutes` from GET /leave/overtime-balance are both
  // exact integers, so this branch can never disagree with the server.
  //
  // Previously this compared in HOURS: `hoursNeeded` (derived from the preview's
  // .toFixed(2)-rounded `hours` field) against unrounded confirmedHours/toleranceHours.
  // At a boundary whose true value isn't a whole number of minutes (e.g. needed =
  // available = 241 minutes), the asymmetric rounding could disagree with the server's
  // exact-minute gate and show a spurious warning/no-warning.
  //
  // Falls back to the (approximate, rounded-hours) comparison only in the brief
  // (300ms-debounced) window before minutesNeeded/confirmedMinutes have loaded. This is
  // display-only in both branches — the "⚠ Nicht genug Überstunden" hint never blocks
  // the Antrag-Button (only `formSaving` does), and the server remains authoritative on
  // submit regardless of which branch was active.
  let wouldBeRejected = $derived(
    minutesNeeded !== null && confirmedMinutes !== undefined
      ? confirmedMinutes + (maxNegativeBalanceMinutes ?? 0) < minutesNeeded
      : confirmedHours + toleranceHours - hoursNeeded < 0,
  );
  let vacRemaining = $derived(
    vacationBalance
      ? vacationBalance.total + vacationBalance.carryOver - vacationBalance.used
      : null,
  );
  let vacAfter = $derived(vacRemaining !== null ? vacRemaining - effectiveDays : null);
  // ── Lane assignment: stable gantt-style rows across calendar days ────────
  // Returns a Map<absenceId, laneIndex> so that a multi-day absence always
  // occupies the same vertical row in every day cell it spans.
  interface LaneResult {
    laneById: Map<string, number>;
    totalLanes: number;
  }

  function buildLaneMap(entries: CalEntry[]): LaneResult {
    // Only the absences that will actually be rendered (mirrors the per-cell filter)
    const visible = entries.filter((e) => !e.isHoliday && (e.isOwn || e.status === "APPROVED"));

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
  let vacSummaryTotal = $derived(vacationBalance?.total ?? 0);
  let vacSummaryCarryOver = $derived(vacationBalance?.carryOver ?? 0);
  let vacSummaryUsed = $derived(vacationBalance?.used ?? 0);
  let vacSummaryPlanned = $derived(pendingVacDays);
  let vacSummaryCarryOverRemaining = $derived(Math.max(0, vacSummaryCarryOver - vacSummaryUsed));
  let vacSummaryLeft = $derived(
    vacSummaryTotal + vacSummaryCarryOver - vacSummaryUsed - vacSummaryPlanned,
  );
  let showVacSummary = $state(true);

  // ── Austrittsdatum für pro-rata Warnung ──────────────────────────────────
  let viewedExitDate = $state<string | null>(null);

  // Pro-rata Warnung: erscheint wenn Mitarbeiter exitDate hat und used > pro-rata Anspruch
  // Inline-Berechnung (Keep in sync with apps/api/src/utils/vacation-calc.ts::calculateProRataVacation)
  let proRataWarning = $derived.by(() => {
    if (!viewedExitDate) return null;
    const exit = new Date(viewedExitDate);
    const exitYear = exit.getFullYear();
    const currentYear = new Date().getFullYear();
    if (exitYear !== currentYear) return null;
    const base = vacSummaryTotal;
    if (base <= 0) return null;
    // Count volle Beschäftigungsmonate: month is full only if exit >= last day of that month
    let monthsWorked = 0;
    for (let month = 0; month < 12; month++) {
      const lastDayOfMonth = new Date(exitYear, month + 1, 0);
      if (exit >= lastDayOfMonth) monthsWorked++;
    }
    monthsWorked = Math.min(monthsWorked, 12);
    const proRata = Math.ceil(((base * monthsWorked) / 12) * 2) / 2;
    if (vacSummaryUsed > proRata) {
      return { used: vacSummaryUsed, entitlement: proRata };
    }
    return null;
  });

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

  $effect(() => {
    if (showForm) {
      formStart;
      formEnd;
      scheduleOverlapLoad();
    }
  });
  $effect(() => {
    if (showForm) {
      formStart;
      formEnd;
      formHalfDay;
      scheduleHoursPreview();
    }
  });
  // Kontostände laden wenn Typ wechselt oder Formular öffnet
  $effect(() => {
    if (showForm) loadBalanceForType(formType);
  });
  // When Modal closes (Escape/backdrop), reset form fields.
  $effect(() => {
    if (!showForm) resetFormFields();
  });
  // When attest modal closes (Escape/backdrop), clear state.
  $effect(() => {
    if (!attestOpen) {
      attestModal = null;
      attestError = "";
    }
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
      <KPIStat
        label="Resturlaub"
        value={vacRemaining === null ? "–" : String(vacRemaining)}
        unit={(vacRemaining ?? 0) === 1 ? "Tag" : "Tage"}
        delta={vacationBalance
          ? `von ${vacationBalance.total + vacationBalance.carryOver} verfügbar`
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
  <!-- Phase 73-04 testid wiring:
     - Modal primitive does not pass attrs through to its inner DOM; a
       display:contents wrapper around the modal body owns
       `leave-form-modal`, and the inner <form> owns `leave-form`. -->
  <Modal
    bind:open={showForm}
    eyebrow="Urlaub"
    title={editingRequest ? "Antrag bearbeiten" : "Neuer Abwesenheitsantrag"}
  >
    <div data-testid="leave-form-modal" style="display: contents">
      {#if formError}
        <div
          class="alert alert-error"
          role="alert"
          style="margin-bottom:1rem"
          data-testid="leave-form-error"
        >
          <span>⚠</span><span>{formError}</span>
        </div>
      {/if}

      <form
        id="leave-form"
        data-testid="leave-form"
        onsubmit={preventDefault(submitRequest)}
        class="form-grid"
      >
        <div class="form-group">
          <label class="form-label" for="f-type">Art der Abwesenheit</label>
          <select
            id="f-type"
            data-testid="leave-form-type"
            bind:value={formType}
            class="form-input"
            disabled={!!editingRequest}
            onchange={() => {
              if (formType === "SPECIAL") loadSpecialLeaveRules();
            }}
          >
            {#each TYPE_OPTIONS as t (t.code)}
              <option value={t.code}>{t.label}</option>
            {/each}
          </select>
        </div>

        {#if formType === "SPECIAL"}
          <div class="form-group">
            <label class="form-label" for="f-special-rule">Anlass</label>
            <select id="f-special-rule" bind:value={formSpecialRuleId} class="form-input" required>
              <option value="">— Anlass wählen —</option>
              {#each specialLeaveRules as rule (rule.id)}
                <option value={rule.id}>{rule.name} ({Number(rule.defaultDays)} Tage)</option>
              {/each}
            </select>
          </div>
        {/if}

        <div class="form-group">
          <label class="form-label" for="f-start">Von</label>
          <input
            id="f-start"
            data-testid="leave-form-from"
            type="date"
            bind:value={formStart}
            required
            class="form-input"
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="f-end">Bis</label>
          <input
            id="f-end"
            data-testid="leave-form-to"
            type="date"
            bind:value={formEnd}
            required
            min={formStart}
            class="form-input"
          />
        </div>

        <!-- Überstundensaldo-Info -->
        {#if formType === "OVERTIME_COMP" && overtimeBalance !== null}
          <div class="form-group form-group--full">
            <div class="balance-box">
              <div class="balance-row">
                <span class="balance-label">Guthaben</span>
                {#if !hasClosedMonth}
                  <!-- Phase 97-06 (SALDO-DISP-04) — a confirmed value of 0 with no
                       closed month yet must not read as a genuine 0h entitlement.
                       Reuses SaldoAnzeige's own "noch kein Monatsabschluss" caption
                       (state A3) rather than restating that copy locally here. -->
                  <span class="balance-value">
                    <SaldoAnzeige
                      variant="compact"
                      confirmedMinutes={confirmedMinutes ?? 0}
                      hasClosedMonth={false}
                    />
                  </span>
                {:else}
                  <span class="balance-value">{fmtH(confirmedHours)}</span>
                {/if}
              </div>
              {#if toleranceHours > 0}
                <div class="balance-row">
                  <span class="balance-label">Toleranz</span>
                  <span class="balance-value">+ {fmtH(toleranceHours)}</span>
                </div>
              {/if}
              {#if isNegativeLimitExceeded === true}
                <!-- Phase 100 (D-10) — warn tone, not the red hint below: this is
                     a standing account-state signal, independent of any draft
                     request. The red hint stays reserved for "this specific
                     request would be rejected". -->
                <p class="balance-hint-notice">
                  ⚠ Guthaben übersteigt bereits die Toleranzgrenze ({fmtH(toleranceHours)})
                </p>
              {/if}
              {#if typeof openMonthMinutes === "number"}
                <!-- Muted, non-arithmetic — the forecast is shown for context but
                     never enters the Verbleibend/warning arithmetic below, and is
                     never presented as claimable (the whole point of this plan).
                     Omitted entirely when openMonthMinutes is null (fail-safe
                     shape) rather than showing a fabricated zero. -->
                <div class="balance-row">
                  <span class="balance-label">Laufender Monat (Prognose)</span>
                  <span class="balance-value balance-value--muted"
                    >{fmtH(openMonthMinutes / 60)}</span
                  >
                </div>
                <p class="balance-hint-muted">
                  Noch nicht abrufbar – wird mit dem Monatsabschluss zu „Bestätigt“.
                </p>
              {/if}
              {#if effectiveDays > 0 || formHalfDay}
                <div class="balance-row">
                  <span class="balance-label">
                    Wird genutzt ({daysLabel(effectiveDays, formHalfDay)})
                  </span>
                  <span class="balance-value balance-deduct">
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      − {fmtH(hoursNeeded)}
                    {/if}
                  </span>
                </div>
                <div class="balance-divider"></div>
                <div class="balance-row">
                  <span class="balance-label">Verbleibend</span>
                  <span class="balance-value {wouldBeRejected ? 'balance-warn' : ''}">
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      {fmtH(confirmedHours - hoursNeeded)}
                    {/if}
                  </span>
                </div>
                {#if !hoursPreviewLoading && wouldBeRejected}
                  <p class="balance-hint-warn">
                    ⚠ Nicht genug Überstunden vorhanden{toleranceHours > 0
                      ? " (auch mit Toleranz)"
                      : ""}
                  </p>
                {/if}
              {/if}
            </div>
          </div>
        {/if}

        <!-- Tage-Info (sofort sichtbar, kein Ladeindikator) -->
        {#if formStart && formEnd && formStart <= formEnd && (formDays > 0 || formHalfDay)}
          <div class="form-group form-group--full" data-testid="leave-form-days-calc">
            <div class="days-info-bar">
              <span class="days-info-icon">📅</span>
              <span class="days-info-text">
                <strong>{daysLabel(effectiveDays, formHalfDay)}</strong>
                {#if hoursPreviewLoading}
                  <span class="days-info-note">(Feiertage werden geprüft…)</span>
                {:else if serverDays !== null && serverDays !== formDays}
                  <span class="days-info-note">(Feiertage berücksichtigt)</span>
                {/if}
              </span>
            </div>
          </div>
        {/if}

        <!-- Urlaubssaldo-Info -->
        {#if formType === "VACATION" && vacationBalance !== null}
          <div class="form-group form-group--full">
            <div class="balance-box">
              <div class="balance-row">
                <span class="balance-label">Jahresanspruch</span>
                <span class="balance-value">{vacationBalance.total} Tage</span>
              </div>
              {#if vacationBalance.carryOver > 0}
                <div class="balance-row">
                  <span class="balance-label">
                    Resturlaub Vorjahr
                    {#if vacationBalance.carryOverDeadline}
                      <span class="balance-meta"
                        >(verfällt {fmtDate(vacationBalance.carryOverDeadline)})</span
                      >
                    {/if}
                  </span>
                  <span class="balance-value">+ {vacationBalance.carryOver} Tage</span>
                </div>
              {/if}
              <!-- Phase 107 gap G-03: the label is CONDITIONAL on purpose. "(bestätigt)" is a
                   qualifier that only means something next to the "Verbraucht (vorläufig)" row
                   below, which renders only for SHIFT_BASED provisional consumption. At
                   provisionalUsed === 0 that row is absent, so the qualifier would pose a
                   contrast the card never resolves — we fall back to "Genommen", the pre-107
                   wording still used by this page's own summary strip, admin/employees/[id]
                   and reports. Same predicate as the #if guard below, so the pair is always
                   rendered together or not at all. Do NOT collapse this back to a constant. -->
              <div class="balance-row">
                <span class="balance-label"
                  >{vacationBalance.provisionalUsed > 0
                    ? "Verbraucht (bestätigt)"
                    : "Genommen"}</span
                >
                <span class="balance-value"
                  >− {vacationBalance.used - vacationBalance.provisionalUsed} Tage</span
                >
              </div>
              {#if vacationBalance.provisionalUsed > 0}
                <!-- Phase 107-07 (D-12): omitted entirely at zero — that omission plus the
                     conditional label above (gap G-03) is what makes the card indistinguishable
                     from before this phase for a reader with no SHIFT_BASED provisional
                     consumption; dropping this row alone would leave a dangling "(bestätigt)"
                     qualifier up there with nothing to contrast against. Muted like Phase 97's
                     "Laufender Monat (Prognose)" row (same class, same "true today, may change"
                     meaning). -->
                <div class="balance-row">
                  <span class="balance-label">Verbraucht (vorläufig)</span>
                  <span class="balance-value balance-value--muted"
                    >− {vacationBalance.provisionalUsed} Tage</span
                  >
                </div>
              {/if}
              <div class="balance-row">
                <span class="balance-label">Verfügbar</span>
                <span class="balance-value">{vacRemaining} Tage</span>
              </div>
              {#if vacationBalance.section9Movements?.length}
                <!-- Phase 104-10 (D-31): rendered verbatim from the server — never
                     re-derived on the client, so account line, notification and audit
                     entry all say the same thing. Optional chaining here is a second
                     line of defense on top of mapVacationBalance() always populating
                     the array — see the dev-pass fix note near VacationEntitlementRow. -->
                <ul class="section9-movements">
                  {#each vacationBalance.section9Movements ?? [] as m (m.creditId)}
                    <li class="section9-movement" data-testid="section9-movement">{m.label}</li>
                  {/each}
                </ul>
              {/if}
              {#if effectiveDays > 0 || formHalfDay}
                <div class="balance-row">
                  <span class="balance-label">
                    Wird genutzt
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      ({daysLabel(
                        effectiveDays,
                        formHalfDay,
                      )}{#if serverDays !== null && serverDays !== formDays}, Feiertage abgezogen{/if})
                    {/if}
                  </span>
                  <span class="balance-value balance-deduct">
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      − {effectiveDays} {effectiveDays === 1 ? "Tag" : "Tage"}
                    {/if}
                  </span>
                </div>
                <div class="balance-divider"></div>
                <div class="balance-row">
                  <span class="balance-label">Verbleibend</span>
                  <span class="balance-value {(vacAfter ?? 0) < 0 ? 'balance-warn' : ''}">
                    {#if hoursPreviewLoading}
                      <span class="text-muted">…</span>
                    {:else}
                      {vacAfter} {(vacAfter ?? 0) === 1 ? "Tag" : "Tage"}
                    {/if}
                  </span>
                </div>
                {#if !hoursPreviewLoading && (vacAfter ?? 0) < 0}
                  <p class="balance-hint-warn">⚠ Nicht genug Resturlaub vorhanden</p>
                {/if}
              {/if}
            </div>
          </div>
        {/if}

        <div class="form-group form-group--full">
          <label class="form-label" for="f-note">Anmerkung (optional)</label>
          <input
            id="f-note"
            data-testid="leave-form-note"
            type="text"
            bind:value={formNote}
            class="form-input"
            placeholder="z.B. Hochzeit, Arzttermin …"
          />
        </div>

        <div class="form-group form-group--full">
          <label class="toggle-label">
            <input
              type="checkbox"
              data-testid="leave-form-half-day"
              bind:checked={formHalfDay}
              class="toggle-cb"
            />
            <span>Halber Tag</span>
          </label>
        </div>

        <!-- Parallele Abwesenheiten -->
        {#if formStart && formEnd && formStart <= formEnd}
          <div class="form-group form-group--full">
            <div class="overlap-box">
              <p class="overlap-title">
                Kolleg:innen im gleichen Zeitraum
                {#if overlapLoading}<span class="text-muted"> laden…</span>{/if}
              </p>
              {#if !overlapLoading && overlapEntries.filter((o) => o.status === "APPROVED").length === 0}
                <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
              {:else}
                <div class="overlap-list">
                  {#each overlapEntries.filter((o) => o.status === "APPROVED") as o (o.id)}
                    <div class="overlap-row">
                      <span class="overlap-name">{o.employeeName}</span>
                      <span class="overlap-type">abwesend</span>
                      <span class="overlap-dates"
                        >{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span
                      >
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}

        <div class="form-actions form-group--full">
          <button
            type="submit"
            data-testid="leave-form-submit"
            class="btn btn-primary"
            disabled={formSaving}
          >
            {formSaving
              ? "Speichern…"
              : editingRequest
                ? "Änderungen speichern"
                : "Antrag einreichen"}
          </button>
          <button
            type="button"
            data-testid="leave-form-cancel"
            class="btn btn-ghost"
            onclick={resetForm}
          >
            Abbrechen
          </button>
        </div>
      </form>
    </div>
    <!-- /leave-form-modal -->
  </Modal>

  <!-- ── Übergreifend: Pro-rata Warnung + Urlaubsübersicht (beide Tabs) ──────── -->
  {#if proRataWarning}
    <div class="alert alert-warning card-animate" role="status">
      Achtung: Der Mitarbeiter hat mehr Urlaub genommen oder genehmigt ({proRataWarning.used} Tage) als
      ihm anteilig zusteht ({proRataWarning.entitlement} Tage). Bitte prüfen Sie, ob eine Rückforderung
      nötig ist.
    </div>
  {/if}
  {#snippet vacStats()}
    <div class="vac-stats">
      <div class="vac-stat">
        <div class="vac-stat-label">Anspruch</div>
        <div class="vac-stat-value">{vacSummaryTotal}<span class="vac-stat-unit">T</span></div>
      </div>
      {#if vacSummaryCarryOver > 0}
        <div class="vac-stat">
          <div class="vac-stat-label">Resturlaub</div>
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
          <div class="vac-stat-label">Geplant</div>
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
        {@render vacStats()}
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
            {@const dayAbsences = entries.filter(
              (e) => !e.isHoliday && (e.isOwn || e.status === "APPROVED"),
            )}
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
                  formStart = day.dateStr;
                  formEnd = day.dateStr;
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
                      style:background={typeColor(e.typeCode, e.status, e.isOwn)}
                      title="{e.firstName} {e.lastName}{e.isOwn && e.typeName
                        ? ' · ' + e.typeName
                        : ''}{e.status === 'PENDING' ? ' (ausstehend)' : ''}"
                    >
                      {#if _showLabel}
                        <span class="cal-chip-name">{e.firstName}</span>
                        {#if e.isOwn && e.typeName}
                          <span class="cal-chip-type">{e.typeName}</span>
                        {:else}
                          <span class="cal-chip-type">abwesend</span>
                        {/if}
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
        {@render vacStats()}
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

  <!-- ── Attest-Modal ─────────────────────────────────────────────────────────── -->
  {#if attestModal}
    <Modal
      bind:open={attestOpen}
      eyebrow="Krankmeldung"
      title={`Attest: ${attestModal.employee.firstName} ${attestModal.employee.lastName}`}
    >
      <p class="text-muted" style="font-size:0.875rem;margin-bottom:1rem;">
        {fmtDate(attestModal.startDate)} – {fmtDate(attestModal.endDate)} · {typeName(
          attestModal.typeCode,
        )}
      </p>
      <div class="attest-box">
        <label class="toggle-label">
          <input type="checkbox" bind:checked={attestPresent} class="toggle-cb" />
          <span>Attest liegt vor</span>
        </label>
        {#if attestPresent}
          <div class="attest-dates">
            <div class="form-group">
              <label class="form-label" for="a-from">Gültig von</label>
              <input
                id="a-from"
                type="date"
                bind:value={attestFrom}
                class="form-input"
                style="max-width:160px"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="a-to">Gültig bis</label>
              <input
                id="a-to"
                type="date"
                bind:value={attestTo}
                class="form-input"
                style="max-width:160px"
              />
            </div>
          </div>
        {/if}
      </div>
      {#if attestError}
        <div class="alert alert-error" role="alert" style="margin-top:0.75rem">
          <span>⚠</span><span>{attestError}</span>
        </div>
      {/if}

      {#snippet footer()}
        <button class="btn btn-ghost" onclick={closeAttestModal} disabled={attestSaving}
          >Abbrechen</button
        >
        <button class="btn btn-primary" onclick={saveAttest} disabled={attestSaving}>
          {attestSaving ? "Speichern…" : "Speichern"}
        </button>
      {/snippet}
    </Modal>
  {/if}

  <!-- ── Phase 87: Terminkollision-Warnung (Urlaub anlegen) ──────────────────── -->
  {#if collisionSummary}
    <ConfirmDialog
      bind:open={collisionConfirmOpen}
      title="Kundentermine im Zeitraum gebucht"
      confirmLabel="Trotzdem fortfahren"
      cancelLabel="Abbrechen"
      onConfirm={confirmCreateWithCollisions}
      onCancel={cancelCreateCollision}
    >
      {#snippet body()}
        <CollisionWarnBody summary={collisionSummary} variant="range" />
      {/snippet}
    </ConfirmDialog>
  {/if}

  <!-- ── Quick 260824-cjd: Storno-Begründung (Zurückziehen / Stornierung) ────── -->
  <ReasonDialog
    bind:open={cancelDialogOpen}
    title={cancelDialogTitle}
    confirmLabel="Bestätigen"
    danger
    onConfirm={confirmCancelDialog}
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

  /* ── Attest ───────────────────────────────────────────────────────── */
  .attest-box {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0.875rem 1rem;
  }
  .attest-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.625rem;
  }
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
  .toggle-cb {
    width: 16px;
    height: 16px;
    accent-color: var(--brand);
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
    .cal-chip-type {
      display: none;
    }
  }
  @media (max-width: 480px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
