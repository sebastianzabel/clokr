<script lang="ts">
  import { homeHref, rosterTabs } from "$lib/nav/routes";
  import { pageLabel } from "$lib/nav/page-labels";
  import {
    ROSTER_LEGEND_PROBLEMS,
    STAFFING_EXPLANATION,
    staffingFigure,
    staffingStatusText,
    staffingTooltip,
  } from "$lib/shifts/staffing"; // Issue #850
  import { shortGermanDay } from "$lib/shifts/planning-week"; // Issue #850
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { salonContext } from "$stores/salon-context";
  import { tenantFeatures } from "$stores/tenant-features";
  import { closedDaysFor, type SalonOpeningHoursEntry } from "$lib/shifts/closed-days";
  import { leaveTypeColor, ABSENT, type LeaveColor } from "$lib/leave/leave-colors"; // Issue #923
  import { hasPermission } from "$lib/permissions"; // Phase 378 (#378)
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import SalonScopeLabel from "$lib/components/team/SalonScopeLabel.svelte";
  import TeamSection from "$lib/components/team/TeamSection.svelte";
  import {
    isSalonFilterRejected,
    salonPageFilter,
    salonScopeLabel,
    SALON_SOLL_NOT_ATTRIBUTABLE_NOTE,
    withSalonId,
  } from "$lib/salons/page-scope"; // Issue #558 (D-02/D-03/D-04/D-13)
  import PageTabs from "$components/ui/PageTabs.svelte";
  import PeriodPicker from "$components/ui/PeriodPicker.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import CollisionWarnBody from "$lib/phorest/CollisionWarnBody.svelte";
  import {
    checkAppointmentCollisions,
    type CollisionSummary,
  } from "$lib/phorest/appointmentCollisions";
  import { dndzone, type DndEvent } from "svelte-dnd-action";

  // ── Types ──────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
    classification?: string;
    coverageWeight?: number | string;
    requiresSupervision?: boolean;
    workSchedules?: Array<{
      type: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
      weeklyHours: number | string | null;
    }>;
  }
  interface Shift {
    // Issue #744 — non-blocking hint of a shift write on a half-day leave (code HALF_DAY_LEAVE)
    hint?: { code: string; message: string };
    id: string;
    employeeId: string;
    templateId: string | null;
    date: string;
    startTime: string;
    endTime: string;
    label: string | null;
    note: string | null;
    conflictsWithLeave?: boolean;
    template?: { name: string; color: string } | null;
  }
  interface AvailabilityEntry {
    employeeId: string;
    date: string;
    availability:
      | "available"
      | "vacation"
      | "sick"
      | "special"
      // Phase 63 D-20: VOCATIONAL_SCHOOL Absence → "vocational_school" bucket.
      // Renders as a locked, non-droppable cell; drag-drop is rejected client-side.
      | "vocational_school"
      | "other"
      | "unavailable"
      | "preferred";
  }
  interface CoverageEntry {
    date: string;
    effectiveStaff: number;
    minStaff: number;
    hasSupervisor: boolean;
    unsupervisedAzubis: number;
    coverageStatus: "ok" | "under" | "supervision-missing";
  }
  // v1.7.4 hotfix — SchoolHolidayPeriod marker per (employee × day). Emitted by
  // GET /api/v1/shifts/week when the employee's effective Bundesland is in a
  // cached holiday range. BS-Absence (vocational_school) wins display priority
  // over Ferien marker — both can be present, but the Schichtplan cell renders
  // BS first.
  interface SchoolHolidayEntry {
    employeeId: string;
    date: string;
    name: string;
    federalState: string;
  }
  interface WeekData {
    weekDays: string[];
    employees: Employee[];
    shifts: Shift[];
    availability: AvailabilityEntry[];
    coverage: CoverageEntry[];
    // Phase 63 follow-up — per-employee BS minutes for the visible week. Used by
    // the Soll-Korrelation row so a BS day counts as worked toward the weekly
    // target (D-01..D-04). Map omits employees with 0 BS minutes (server-side).
    vocationalSchoolMinutesByEmp?: Record<string, number>;
    // v1.7.3 — per-employee effective break minutes for the visible week.
    // Computed server-side via getEffectiveBreakDuration, honors Employee
    // Pausen-Override + tenant defaults. Used by the Soll-Korrelation row.
    shiftBreakMinutesByEmp?: Record<string, number>;
    // Phase 76.11 — per-employee Urlaub/Abwesenheit minutes in the visible
    // week. Subtracted from `wh` in sollRowByEmp so vacation/sick weeks don't
    // show a phantom Soll-Diff. Filter: APPROVED + CANCELLATION_REQUESTED for
    // leave, deletedAt:null for absences (mirrors CLAUDE.md soft-delete rule
    // and the Leave Cancellation Flow).
    leaveMinutesByEmp?: Record<string, number>;
    absenceMinutesByEmp?: Record<string, number>;
    // Phase 76.23 — server-authoritative contract Soll per SHIFT_BASED employee
    // (minutes). Computed server-side via calcExpectedMinutesTz (Ø-Methode)
    // minus leave/absence credits (Ausfallprinzip) plus Berufsschule.
    // The frontend MUST render this value as the Soll (D-02 — no re-derivation
    // from weeklyHours). Never written to OvertimeAccount (D-04, § 615).
    // Issue #558 D-13 — under a salon filter the server sends `null` plus `sollUnavailableReason`:
    // the contract Soll is a property of the person and cannot be attributed to one salon.
    contractSollMinutesByEmp?: Record<string, number> | null;
    sollUnavailableReason?: "SALON_FILTER";
    // v1.7.4 hotfix — SchoolHolidayPeriod cells for the visible week.
    schoolHoliday?: SchoolHolidayEntry[];
    // Issue #563 (D-15) — opening hours of the active salons inside the caller's shift:read reach.
    // Optional so an older API during a rolling deploy dims nothing instead of failing.
    salonOpeningHours?: SalonOpeningHoursEntry[];
  }
  interface Template {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    color: string;
  }

  const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  // ── Helpers ────────────────────────────────────────────────────────────────
  function mondayOfWeek(d: Date): Date {
    const dow = d.getDay();
    const offset = dow === 0 ? -6 : 1 - dow;
    const m = new Date(d);
    m.setDate(m.getDate() + offset);
    m.setHours(0, 0, 0, 0);
    return m;
  }

  function ymd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let cursorMonday = $state(mondayOfWeek(new Date()));
  let week = $state<WeekData | null>(null);
  let templates: Template[] = $state([]);
  let loading = $state(true);
  let error = $state("");
  let gated = $state(false);

  // Issue #558: the header salon narrows the week (people by the master-data rule, shifts by their
  // own salon). The page decides only through `salonPageFilter` (never the store's raw selection):
  // a single-salon tenant or a one-salon caller never sends a `salonId`.
  const contextLoaded = $derived($salonContext.loaded);
  const pageSalonId = $derived(salonPageFilter($salonContext));
  const scopeLabel = $derived(salonScopeLabel($salonContext));
  // Issue #853 (D-853-05): the four roster tabs are the link tabs of the route table; a tab the caller may
  // not open (Verfügbarkeit without the feature or its permissions) is not part of the list.
  const rosterTabsList = $derived(
    rosterTabs($authStore.user, { availabilityEnabled: $tenantFeatures.availabilityEnabled }),
  );
  let weekRejected = $state(false);
  // Plain `let`s (never `$state`): an effect that read them could re-trigger itself, which is the
  // v1.8.17 `effect_update_depth_exceeded` failure described at `prevCursorMondayTime` below.
  let weekGeneration = 0;
  let lastLoadedSalonKey: string | null | undefined = undefined;

  // Modal state
  let modalOpen = $state(false);
  let modalEmployeeId = $state("");
  let modalDate = $state("");
  let modalTemplateId = $state("");
  let modalStartTime = $state("08:00");
  let modalEndTime = $state("16:00");
  let modalLabel = $state("");
  let modalNote = $state("");
  let modalError = $state("");
  let saving = $state(false);
  let editingShiftId: string | null = $state(null);

  // ── Phase 47 — Drag & Drop sources/targets ────────────────────────────────
  // Each draggable Template-Chip lives in the strip dndzone keyed by its id.
  // svelte-dnd-action requires items to have a stable `id` field.
  // Phase 47-02 — discriminated union: template-chip (creates shift) or
  // shift-pill (moves shift between cells). `kind` is the discriminator;
  // `onCellFinalize` dispatches on it to route to POST /shifts (create) or
  // PUT /shifts/:id (move).
  type TemplateDragItem = { id: string; kind: "template"; templateId: string };
  type ShiftDragItem = {
    id: string;
    kind: "shift";
    shiftId: string;
    originEmployeeId: string;
    originIso: string;
  };
  // v1.7.4 — Berufsschule chip removed from the strip. The canonical BS source
  // is now `EmployeeVocationalSchoolPattern` + auto-generator. Manual one-off
  // BS-days are still supported via the POST /vocational-school/manual-insert
  // endpoint (used by future UX), just no longer via drag-and-drop.
  type DragItem = TemplateDragItem | ShiftDragItem;

  type DropTargetKey = string; // `${employeeId}::${iso}`

  // The strip's dndzone item array — TemplateDragItems plus svelte-dnd-action's
  // transient shadow-placeholder objects mid-drag. Typed as DragItem[] so the
  // shadow (which the library adds during drag-out to preserve children.length)
  // can live in the array without being filtered out.
  let dndTemplates: DragItem[] = $state([]);

  // Per-cell dndzone item array — empty by default. When the chip is dragged
  // onto a target cell, svelte-dnd-action moves the item into that zone's
  // array; we detect the new arrival in onCellFinalize, fire the API call,
  // and reset.
  let dndCells = $state<Record<DropTargetKey, DragItem[]>>({});

  // Track the in-flight drop so the UI shows a saving state on the affected cell.
  let dropPending: DropTargetKey | null = $state(null);

  const FLIP_MS = 120; // dndzone animation duration

  // Delete confirmation
  let shiftDeleteConfirm = $state<{ open: boolean; id: string | null; closeAfter: boolean }>({
    open: false,
    id: null,
    closeAfter: false,
  });
  // Phase 87: appointment-collision summary for the shift being deleted. When
  // non-null (>=1 booked appointment on the shift's day) the existing delete
  // ConfirmDialog renders the warn body via its additive `body` snippet — one
  // dialog, one scrim. Null on zero-collision / fail-open (delete confirm as before).
  let shiftDeleteCollisions = $state<CollisionSummary | null>(null);
  let shiftDeletePrecheckPending = $state(false);

  // 260601-g8l — BS-Tag removal confirmation. absenceId is resolved at click time
  // via GET /vocational-school/upcoming (no client-side cache of absence ids), then
  // a ConfirmDialog gates the DELETE call.
  let vsRemoveConfirm = $state<{
    open: boolean;
    absenceId: string | null;
    employeeId: string;
    date: string;
    employeeName: string;
  }>({
    open: false,
    absenceId: null,
    employeeId: "",
    date: "",
    employeeName: "",
  });
  let vsRemovePending = $state(false);

  // Phase 43-03 — Force-override confirmation when the API responds 409 with
  // SHIFT_CONFLICT_LEAVE / SHIFT_CONFLICT_ABSENCE.
  let conflictConfirm = $state<{
    open: boolean;
    message: string;
    code: string;
  }>({ open: false, message: "", code: "" });

  // Phase 43-02 — Woche generieren preview + commit
  interface GenerateDiff {
    weekStart: string;
    create: Array<{
      id?: string;
      employeeId: string;
      date: string;
      templateId?: string;
      startTime: string;
      endTime: string;
      label?: string;
    }>;
    skip: Array<{
      employeeId: string;
      date: string;
      reason:
        "leave" | "absence" | "existing" | "no-pattern" | "open-day" | "availability-unavailable";
    }>;
    committed: boolean;
  }
  let generateOpen = $state(false);
  let generateDiff: GenerateDiff | null = $state(null);
  let generating = $state(false);
  let generateError = $state("");

  // Phase 43-05 — Letzte Woche kopieren (primary action)
  interface CopyDiff {
    sourceWeekStart: string;
    targetWeekStart: string;
    create: Array<{
      id?: string;
      employeeId: string;
      date: string;
      templateId?: string | null;
      startTime: string;
      endTime: string;
      label?: string | null;
    }>;
    skip: Array<{
      employeeId: string;
      date: string;
      reason: "leave" | "absence" | "existing" | "availability-unavailable";
    }>;
    committed: boolean;
  }
  let copyOpen = $state(false);
  let copyDiff: CopyDiff | null = $state(null);
  let copying = $state(false);
  let copyError = $state("");
  // Default source week = target week minus 7 days. Bound to the date input
  // and re-derived whenever the user navigates to a different target week.
  let copySourceWeekStart = $state("");

  // Phase 65 follow-up — Berufsschultag insertion is now a drag-and-drop chip
  // in the template strip (matches the shift-template UX). The old row-action
  // "⋯" menu + modal flow was removed because dropping the chip on a cell is
  // cell-centric and matches the rest of the planner. See onCellFinalize for
  // the drop handler.

  function isAzubi(emp: Employee): boolean {
    return (emp.classification ?? "").toUpperCase() === "AZUBI";
  }

  function empName(id: string): string {
    if (!week) return id;
    const e = week.employees.find((x) => x.id === id);
    return e ? `${e.firstName} ${e.lastName}` : id;
  }

  // 260601-g8l — German DD.MM.YYYY formatter for the BS-removal ConfirmDialog
  // description. Avoids `Intl.DateTimeFormat` to stay deterministic regardless
  // of the user's locale.
  function formatDeDate(iso: string): string {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }

  function skipReasonLabel(r: GenerateDiff["skip"][number]["reason"]): string {
    switch (r) {
      case "leave":
        return "Urlaub";
      case "absence":
        return "Abwesenheit";
      case "existing":
        return "Schicht existiert";
      case "open-day":
        return "Frei nach Muster";
      case "availability-unavailable":
        return "Nicht verfügbar";
      case "no-pattern":
      default:
        return "Kein Muster";
    }
  }

  async function openGenerate() {
    generateError = "";
    generateDiff = null;
    generating = true;
    generateOpen = true;
    try {
      const weekStart = ymd(cursorMonday);
      const diff = await api.post<GenerateDiff>("/shifts/generate-week", {
        weekStart,
        commit: false,
      });
      generateDiff = diff;
    } catch (e) {
      generateError = e instanceof Error ? e.message : "Vorschau fehlgeschlagen.";
    } finally {
      generating = false;
    }
  }

  async function commitGenerate() {
    if (!generateDiff) return;
    generating = true;
    generateError = "";
    try {
      const weekStart = ymd(cursorMonday);
      const result = await api.post<GenerateDiff>("/shifts/generate-week", {
        weekStart,
        commit: true,
      });
      toasts.success(`${result.create.length} Schicht(en) erstellt.`);
      generateOpen = false;
      generateDiff = null;
      await load();
    } catch (e) {
      generateError =
        e instanceof Error ? e.message : "Die Muster konnten nicht angewendet werden.";
    } finally {
      generating = false;
    }
  }

  // ── Phase 43-05 — Letzte Woche kopieren ───────────────────────────────────
  function copySkipReasonLabel(r: CopyDiff["skip"][number]["reason"]): string {
    switch (r) {
      case "leave":
        return "Übersprungen — Urlaub";
      case "absence":
        return "Übersprungen — Krankheit";
      case "existing":
        return "Übersprungen — Schicht existiert bereits";
      case "availability-unavailable":
        return "Übersprungen — nicht verfügbar";
      default:
        return "Übersprungen";
    }
  }

  // Default source = current target week minus 7 days
  function defaultSourceWeekStart(): string {
    const d = new Date(cursorMonday);
    d.setDate(d.getDate() - 7);
    return ymd(d);
  }

  async function openCopy() {
    copyError = "";
    copyDiff = null;
    copySourceWeekStart = defaultSourceWeekStart();
    copyOpen = true;
    await refreshCopyPreview();
  }

  // Align any selected date back to the Monday of that week so the input is
  // forgiving (user can pick any day-of-week, we round down to Monday).
  function mondayOf(iso: string): string {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return ymd(mondayOfWeek(dt));
  }

  async function refreshCopyPreview() {
    if (!copySourceWeekStart) {
      copyError = "Bitte eine Quellwoche wählen.";
      return;
    }
    const sourceWeekStart = mondayOf(copySourceWeekStart);
    const targetWeekStart = ymd(cursorMonday);
    if (sourceWeekStart === targetWeekStart) {
      copyError = "Quell- und Zielwoche sind identisch.";
      copyDiff = null;
      return;
    }
    copying = true;
    copyError = "";
    try {
      const diff = await api.post<CopyDiff>("/shifts/copy-week", {
        sourceWeekStart,
        targetWeekStart,
        commit: false,
      });
      copyDiff = diff;
    } catch (e) {
      copyError = e instanceof Error ? e.message : "Vorschau fehlgeschlagen.";
    } finally {
      copying = false;
    }
  }

  async function commitCopy() {
    if (!copyDiff) return;
    copying = true;
    copyError = "";
    try {
      const sourceWeekStart = mondayOf(copySourceWeekStart);
      const targetWeekStart = ymd(cursorMonday);
      const result = await api.post<CopyDiff>("/shifts/copy-week", {
        sourceWeekStart,
        targetWeekStart,
        commit: true,
      });
      toasts.success(`${result.create.length} Schicht(en) kopiert.`);
      copyOpen = false;
      copyDiff = null;
      await load();
    } catch (e) {
      copyError = e instanceof Error ? e.message : "Kopieren fehlgeschlagen.";
    } finally {
      copying = false;
    }
  }

  // ── Role gate + initial load ───────────────────────────────────────────────
  // WR-03 fix (Phase 76.23): merged the two separate onMount callbacks into one.
  // The old pattern had a second onMount that set `mounted = true`, which caused
  // the $effect below to fire immediately on mount (because `mounted` changed),
  // resulting in two concurrent GET /shifts/week requests on every page load.
  // Now: one onMount does the permission check and triggers the initial load(); the
  // $effect only re-fires on genuine week-navigation (cursorMonday changes).
  //
  // Phase 378 (#378): gated on `shift:plan:ZUGEWIESEN`, not `shift:read:ZUGEWIESEN` — this page
  // is entirely write-oriented (create/generate/copy/delete shifts) with no read-only rendering
  // mode, so a holder of only `shift:read` (Ausbilder template, #76) is not handed a
  // half-working edit UI (D-05).
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
    if (!hasPermission($authStore.user, "shift:plan:ZUGEWIESEN")) {
      gated = true;
      goto(homeHref($authStore.user));
      return;
    }
    // Issue #558: with the salon context not loaded yet the salon effect below issues the one
    // initial request (it fires when `contextLoaded` turns true); with it ready this is the one.
    if (contextLoaded) void load();
  });

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    if (gated) return;
    // Issue #558: read untracked, so the week-navigation effect that calls this function never
    // depends on the salon (the salon effect owns that dependency).
    const salonId = untrack(() => pageSalonId);
    const generation = ++weekGeneration;
    lastLoadedSalonKey = salonId;
    loading = true;
    // Phase 47 — clear leftover per-cell drop state when navigating weeks.
    dndCells = {};
    error = "";
    try {
      const date = ymd(cursorMonday);
      const [w, t] = await Promise.all([
        api.get<WeekData>(withSalonId(`/shifts/week?date=${date}`, salonId)),
        api.get<Template[]>("/shifts/templates"),
      ]);
      if (generation !== weekGeneration) return;
      weekRejected = false;
      week = w;
      templates = t;
      // Phase 47 — seed one TemplateDragItem per template. svelte-dnd-action
      // maps items[i] to children[i] positionally, so the initial list and
      // restoreTemplatesStrip() must both render the full canonical templates
      // array — slicing here cancels drags for templates beyond the cut.
      dndTemplates = t.map((tpl) => ({
        id: `tpl-${tpl.id}`,
        kind: "template" as const,
        templateId: tpl.id,
      }));
    } catch (e: unknown) {
      if (generation !== weekGeneration) return;
      if (isSalonFilterRejected(e)) {
        // The one 404 of an inadmissible salon: a calm text, no error alert, no toast.
        week = null;
        weekRejected = true;
        return;
      }
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      if (generation === weekGeneration) loading = false;
    }
  }

  // WR-03 fix: $effect fires only on genuine week-navigation (cursorMonday
  // value change), not on the initial mount. prevCursorMondayTime tracks the last
  // loaded week; load() is called only when cursorMonday differs from it.
  // This replaces the old boolean `mounted` guard which caused a double-load
  // because setting mounted=true itself triggered the $effect.
  //
  // v1.8.17 hotfix: `prevCursorMondayTime` is a PLAIN `let`, not `$state`, and holds
  // a primitive timestamp (number), not a Date. The previous code stored a `Date` in
  // `$state` and reassigned it inside this effect; because the effect also read that
  // state and `new Date()` yields a fresh reference every run, Svelte's referential
  // equality saw a change on every pass → the effect re-fired endlessly
  // (effect_update_depth_exceeded, crashing the page). A non-reactive `let` is not
  // tracked, so reading/writing it here cannot re-trigger the effect — the only
  // reactive dependency is `cursorMonday` (plus mounted/gated), which is exactly the
  // WR-03 intent: no double-load on mount, one load() per genuine week navigation.
  let prevCursorMondayTime: number | null = null;
  $effect(() => {
    // Declare reactive dependency on cursorMonday so Svelte tracks it.
    const current = cursorMonday.getTime();
    if (!mounted || gated) return;
    if (prevCursorMondayTime !== null && current !== prevCursorMondayTime) {
      // Issue #558: untracked, so `load()` (which reads the salon and writes state) adds no dependency.
      untrack(() => void load());
    }
    prevCursorMondayTime = current;
  });

  // Issue #558: reload when the header salon genuinely changes. Same rules as the two notes above
  // (WR-03 single load, v1.8.17 no loop): this effect reads only the primitive deriveds
  // `contextLoaded` / `pageSalonId` and the `mounted` / `gated` flags, compares against the plain
  // `let lastLoadedSalonKey` (written by `load()` itself, synchronously) and starts `load()` via
  // `untrack`; it writes no `$state` that it reads. Exactly one initial request: either onMount
  // loaded (the key is then already equal) or this effect does once the context is ready.
  $effect(() => {
    if (!mounted || gated || !contextLoaded) return;
    if (pageSalonId !== lastLoadedSalonKey) {
      untrack(() => void load());
    }
  });

  // ── Navigation ─────────────────────────────────────────────────────────────
  function prevWeek() {
    const d = new Date(cursorMonday);
    d.setDate(d.getDate() - 7);
    cursorMonday = d;
  }
  function nextWeek() {
    const d = new Date(cursorMonday);
    d.setDate(d.getDate() + 7);
    cursorMonday = d;
  }
  function goToToday() {
    cursorMonday = mondayOfWeek(new Date());
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const shiftsByEmpDate = $derived.by(() => {
    const map = new Map<string, Shift>();
    if (!week) return map;
    for (const s of week.shifts) {
      const key = `${s.employeeId}::${s.date.slice(0, 10)}`;
      map.set(key, s);
    }
    return map;
  });

  const availabilityByEmpDate = $derived.by(() => {
    const map = new Map<string, AvailabilityEntry["availability"]>();
    if (!week) return map;
    for (const a of week.availability) {
      map.set(`${a.employeeId}::${a.date.slice(0, 10)}`, a.availability);
    }
    return map;
  });

  // v1.7.4 hotfix — Schulferien marker per (employee × day). Used only when the
  // cell is NOT already marked as vocational_school (BS-Absence wins priority).
  const schoolHolidayByEmpDate = $derived.by(() => {
    const map = new Map<string, { name: string; federalState: string }>();
    if (!week?.schoolHoliday) return map;
    for (const h of week.schoolHoliday) {
      map.set(`${h.employeeId}::${h.date.slice(0, 10)}`, {
        name: h.name,
        federalState: h.federalState,
      });
    }
    return map;
  });

  const coverageByDate = $derived.by(() => {
    const map = new Map<string, CoverageEntry>();
    if (!week) return map;
    for (const c of week.coverage) {
      map.set(c.date.slice(0, 10), c);
    }
    return map;
  });

  // Phase 47.1 — Only SHIFT_BASED employees appear in the grid.
  // Server (POST/PUT /shifts) rejects assignments to FIXED_SCHEDULE / FLEXTIME / MONTHLY_HOURS
  // employees with 422 SHIFT_INVALID_EMPLOYEE_TYPE; this filter hides them so
  // users don't try to drag onto rows that would just bounce.
  const shiftEmployees = $derived.by(() => {
    if (!week) return [];
    return week.employees.filter((e) => e.workSchedules?.[0]?.type === "SHIFT_BASED");
  });

  // ── Phase 45: SHIFT_BASED Soll-Row helpers ─────────────────────────────────
  function parseHHMM(s: string): { h: number; m: number } {
    const [h, m] = s.split(":").map(Number);
    return { h: h || 0, m: m || 0 };
  }

  function shiftHours(start: string, end: string): number {
    const a = parseHHMM(start);
    const b = parseHHMM(end);
    let dur = (b.h * 60 + b.m - (a.h * 60 + a.m)) / 60;
    if (dur < 0) dur += 24; // cross-midnight shift (e.g. 22:00–06:00)
    return Math.max(0, dur);
  }

  // v1.7.3 — `shiftNetHours()` removed in favor of the server-computed
  // `week.shiftBreakMinutesByEmp` map which honors per-employee Pausen-Override
  // (Employee.breakOver6hOverride/9hOverride) and tenant defaults. The legacy
  // hardcoded 30/45-min deduction ignored those overrides (Phase 64 follow-up).

  function diffClass(diff: number): "ok" | "warn" | "bad" {
    const abs = Math.abs(diff);
    if (abs <= 0.5) return "ok";
    if (abs <= 1) return "warn";
    return "bad";
  }

  function formatHours(n: number): string {
    return n.toFixed(1).replace(/\.0$/, "");
  }

  // Map<employeeId, { shiftH, bsH, assignedH, weeklyH, diff, klass, ... }> for the
  // visible week. `assignedH` = shiftH + bsH (Phase 63 D-01: BS counts as worked
  // toward the weekly target — server returns BS minutes via the
  // `vocationalSchoolMinutesByEmp` map so block-week cap stays in lockstep with
  // the saldo math).
  //
  // Phase 76.23 — `contractSollH` is now the SERVER-AUTHORITATIVE Soll, read from
  // `week.contractSollMinutesByEmp` (Ø-Methode, Ausfallprinzip, Berufsschule folded
  // in — the same C_net as the 76.22 saldo). The frontend MUST NOT re-derive the
  // Soll from `weeklyHours` for the comparison (D-02 — no drifting second Soll).
  // `weeklyH`, `leaveH`, `absenceH` are ONLY for the informational sub-label breakdown.
  const sollRowByEmp = $derived.by(() => {
    const out = new Map<
      string,
      {
        shiftH: number;
        bsH: number;
        assignedH: number;
        weeklyH: number;
        // Phase 76.11 — Urlaub/Abwesenheit hours in the visible week. Surfaced
        // in the Soll label so managers see the reduction transparently.
        leaveH: number;
        absenceH: number;
        // `effectiveWeeklyH = max(0, weeklyH - leaveH - absenceH)`. Kept for the
        // informational sub-label ONLY — the compared Soll is now contractSollH (D-02).
        effectiveWeeklyH: number;
        // Phase 76.23 — server-authoritative contract Soll (hours). This is the
        // value `diff` and the Unterdeckung warning are computed against (D-02).
        contractSollH: number;
        // geplantH = assignedH (alias for clarity in the warning computation).
        geplantH: number;
        diff: number;
        klass: "ok" | "warn" | "bad";
        // Phase 76.23 — Unterdeckung warning: true when geplant < contractSoll (D-01, D-03).
        // Fires immediately with no tolerance band (D-03). Only set when contractSollH > 0.
        underCoverage: boolean;
        // Gap in hours (contractSollH - geplantH) when underCoverage, else 0.
        gapH: number;
      }
    >();
    if (!week) return out;
    // Issue #558 D-13 — the server withholds the contract Soll under a salon filter; the row is
    // hidden by the response CODE, never by the filter state, so no false „Unterdeckung“ appears.
    if (week.sollUnavailableReason === "SALON_FILTER") return out;
    const bsMap = week.vocationalSchoolMinutesByEmp ?? {};
    // v1.7.3 — server-computed effective break minutes per employee for the
    // visible week. Honors Employee.breakOver6hOverride/9hOverride and
    // TenantConfig.defaultBreakOver6h/9h. Replaces the legacy
    // shiftNetHours() hardcoded 30/45-min deduction.
    const breakMap = week.shiftBreakMinutesByEmp ?? {};
    // Phase 76.11 — Urlaub/Abwesenheit-Minuten je Mitarbeiter im sichtbaren
    // Mon-So-Fenster. Server filtert APPROVED + CANCELLATION_REQUESTED
    // (CANCELLATION_REQUESTED bleibt aktiv bis Stornierung genehmigt; vgl.
    // CLAUDE.md "Leave Cancellation Flow") und Absence.deletedAt:null.
    const leaveMap = week.leaveMinutesByEmp ?? {};
    const absenceMap = week.absenceMinutesByEmp ?? {};
    // Phase 76.23 — server-authoritative contract Soll map.
    const sollMap = week.contractSollMinutesByEmp ?? {};
    for (const emp of week.employees) {
      const sched = emp.workSchedules?.[0];
      if (!sched || sched.type !== "SHIFT_BASED") continue;
      const wh = Number(sched.weeklyHours ?? 0);
      if (wh <= 0) continue;
      const empShifts = week.shifts.filter((s) => s.employeeId === emp.id);
      const grossH = empShifts.reduce((sum, s) => sum + shiftHours(s.startTime, s.endTime), 0);
      const breakH = (breakMap[emp.id] ?? 0) / 60;
      const shiftH = Math.max(0, grossH - breakH);
      const bsH = (bsMap[emp.id] ?? 0) / 60;
      const assignedH = shiftH + bsH;
      const leaveH = (leaveMap[emp.id] ?? 0) / 60;
      const absenceH = (absenceMap[emp.id] ?? 0) / 60;
      // Informational sub-label only — NOT the compared Soll (D-02).
      const effectiveWeeklyH = Math.max(0, wh - leaveH - absenceH);
      // Phase 76.23 — server-authoritative Soll from the endpoint (D-02).
      const contractSollH = (sollMap[emp.id] ?? 0) / 60;
      const geplantH = assignedH;
      const diff = geplantH - contractSollH;
      // Unterdeckung: fires as soon as geplant < Soll (D-03, no tolerance band).
      // Guard: only fire when contractSollH > 0 (no server value = no Soll target).
      const underCoverage = contractSollH > 0 && geplantH < contractSollH;
      const gapH = underCoverage ? contractSollH - geplantH : 0;
      out.set(emp.id, {
        shiftH,
        bsH,
        assignedH,
        weeklyH: wh,
        leaveH,
        absenceH,
        effectiveWeeklyH,
        contractSollH,
        geplantH,
        diff,
        klass: diffClass(diff),
        underCoverage,
        gapH,
      });
    }
    return out;
  });

  // ── Phase 47 — DnD handlers ───────────────────────────────────────────────
  // Restore the strip from the canonical `templates` array. Used after a drop
  // (whether the chip landed on a cell or was dropped outside) so the chip
  // always reappears in the strip.
  function restoreTemplatesStrip() {
    dndTemplates = templates.map((tpl) => ({
      id: `tpl-${tpl.id}`,
      kind: "template" as const,
      templateId: tpl.id,
    }));
  }

  // Strip dndzone handlers — we don't reorder templates within the strip; we
  // only act as a drag source. `consider` MUST mirror e.detail.items verbatim
  // (including svelte-dnd-action's shadow placeholder during drag-out) so the
  // rendered children.length stays in sync with items.length — mismatch
  // cancels the drag immediately. `finalize` restores the canonical list.
  function onTemplateConsider(e: CustomEvent<DndEvent<DragItem>>) {
    dndTemplates = e.detail.items;
  }
  function onTemplateFinalize(_e: CustomEvent<DndEvent<DragItem>>) {
    restoreTemplatesStrip();
  }

  // Per-cell drop target handlers. `key` is `${employeeId}::${iso}`.
  function onCellConsider(key: DropTargetKey, e: CustomEvent<DndEvent<DragItem>>) {
    dndCells = { ...dndCells, [key]: e.detail.items };
  }
  async function onCellFinalize(
    employeeId: string,
    iso: string,
    e: CustomEvent<DndEvent<DragItem>>,
  ) {
    const key: DropTargetKey = `${employeeId}::${iso}`;
    const items = e.detail.items;
    // Reset this cell's empty-target zone state regardless of outcome.
    dndCells = { ...dndCells, [key]: [] };
    // Only the case where exactly one item arrived = a chip/pill was dropped here.
    if (items.length !== 1) return;
    const item = items[0];

    // Phase 63 D-20: client-side guard — drops onto a vocational_school cell
    // are rejected before any API call. Defense in depth: the server-side
    // shift-conflict check (Plan 04 / D-20) would also reject the create with
    // 409, but failing fast here gives an immediate, BS-specific German toast
    // instead of the generic "Schicht-Konflikt" message. The unavailable-cell
    // branch in the render usually means the cell isn't even a drop target,
    // but template-chip drops can still target it via the shift-pill swap
    // path — guard the handler itself.
    const cellAvailability = availabilityByEmpDate.get(key);
    if (cellAvailability === "vocational_school") {
      restoreTemplatesStrip();
      // A drag item is only ever a template chip or a shift pill (the BS chip left the strip in
      // v1.7.4), so a drop onto a BS cell always gets this message.
      toasts.error("Berufsschultag — Schichten können nicht eingeplant werden");
      return;
    }

    if (item.kind === "template") {
      // Restore the template chip in the strip immediately so the UI stays
      // consistent while the POST is in flight.
      restoreTemplatesStrip();

      const tpl = templates.find((t) => t.id === item.templateId);
      if (!tpl) {
        toasts.error("Vorlage nicht gefunden.");
        return;
      }

      dropPending = key;
      try {
        const created = await api.post<Shift>("/shifts", {
          employeeId,
          templateId: tpl.id,
          date: iso,
          startTime: tpl.startTime,
          endTime: tpl.endTime,
          label: tpl.name,
          // Issue #558 D-13 — a shift created while salon X is shown lands in X; without a salon
          // the server's `salonForDay` default applies as before.
          ...(pageSalonId !== null ? { salonId: pageSalonId } : {}),
        });
        toasts.success(`Schicht zugewiesen: ${tpl.name}`);
        announceShiftHint(created);
        await load();
      } catch (err) {
        // Phase 47.4-02 — § 3 ArbZG hard-block (422). Drag never auto-forces; toast only.
        if (err instanceof ApiError && err.status === 422) {
          const data = err.data as { message?: string; code?: string } | undefined;
          if (data?.code === "ARBZG_VIOLATION_DAILY_MAX") {
            toasts.error(
              data?.message ??
                "Schicht überschreitet die zulässige Tageshöchstarbeitszeit (§ 3 ArbZG: 10 Stunden).",
            );
          } else {
            toasts.error(err instanceof Error ? err.message : "Schicht-Zuweisung fehlgeschlagen.");
          }
        } else if (err instanceof ApiError && err.status === 409) {
          // Existing 409 conflict path (SHIFT_CONFLICT_LEAVE / SHIFT_CONFLICT_ABSENCE /
          // SHIFT_CONFLICT_UNAVAILABILITY) and § 5 ArbZG (ARBZG_VIOLATION_REST_PERIOD):
          // surface as toast. Drag is the fast-path; users must use the Modal
          // click-flow to force-override (mirrors UNAVAILABILITY drag UX).
          const data = err.data as { message?: string; code?: string } | undefined;
          if (data?.code === "ARBZG_VIOLATION_REST_PERIOD") {
            toasts.error(
              data?.message ??
                'Verstoß gegen § 5 ArbZG (Ruhezeit). Über Klick + „Trotzdem zuweisen" zuweisen.',
            );
          } else if (data?.code === "SHIFT_CONFLICT_UNAVAILABILITY") {
            toasts.error(
              data?.message ??
                'Mitarbeiter ist am gewählten Tag nicht verfügbar. Über Klick + „Trotzdem zuweisen" zuweisen.',
            );
          } else if (data?.code === "SHIFT_OUTSIDE_STORE_HOURS") {
            toasts.error(
              data?.message ??
                'Schicht liegt außerhalb der Öffnungszeiten. Über Klick + „Trotzdem zuweisen" zuweisen.',
            );
          } else {
            toasts.error(
              data?.message ??
                "Schicht-Konflikt — Mitarbeiter hat Urlaub oder Abwesenheit am gewählten Tag.",
            );
          }
        } else {
          toasts.error(err instanceof Error ? err.message : "Schicht-Zuweisung fehlgeschlagen.");
        }
      } finally {
        dropPending = null;
      }
    } else if (item.kind === "shift") {
      // Phase 47-02 — dispatch the move via PUT /shifts/:id
      await handleShiftMove(item, employeeId, iso);
    }
  }

  // ── Phase 47-02 — Shift-move (drag existing pill to another cell) ─────────
  // The empty target cell's onCellFinalize routes ShiftDragItems here. We
  // verify the target is still unoccupied (defense in depth: client check
  // matches server's 409), call PUT /shifts/:id with the new employeeId +
  // date, and reload the week. On 409 (leave/absence conflict) we surface a
  // German toast and load() to revert the visual position.
  async function handleShiftMove(item: ShiftDragItem, newEmployeeId: string, newIso: string) {
    // Same cell — cancelled drag, just resync.
    if (item.originEmployeeId === newEmployeeId && item.originIso === newIso) {
      await load();
      return;
    }
    // Target cell already occupied? Reject client-side (server would also
    // accept since the unique constraint is (employeeId, date) — server-side
    // would 409 on the DB write, but failing fast here avoids the round-trip
    // and gives a clearer message.
    const targetKey: DropTargetKey = `${newEmployeeId}::${newIso}`;
    if (shiftsByEmpDate.get(targetKey)) {
      toasts.error("Zielzelle ist bereits belegt — Schicht nicht verschoben.");
      await load(); // restore visual position
      return;
    }
    dropPending = targetKey;
    try {
      const moved = await api.put<Shift>(`/shifts/${item.shiftId}`, {
        employeeId: newEmployeeId,
        date: newIso,
      });
      toasts.success("Schicht verschoben.");
      announceShiftHint(moved);
      await load();
    } catch (err) {
      // Phase 47.4-02 — § 3 ArbZG hard-block (422). Drag never auto-forces; toast only.
      if (err instanceof ApiError && err.status === 422) {
        const data = err.data as { message?: string; code?: string } | undefined;
        if (data?.code === "ARBZG_VIOLATION_DAILY_MAX") {
          toasts.error(
            data?.message ??
              "Schicht überschreitet die zulässige Tageshöchstarbeitszeit (§ 3 ArbZG: 10 Stunden).",
          );
        } else {
          toasts.error(err instanceof Error ? err.message : "Verschieben fehlgeschlagen.");
        }
      } else if (err instanceof ApiError && err.status === 409) {
        const data = err.data as { message?: string; code?: string } | undefined;
        if (data?.code === "ARBZG_VIOLATION_REST_PERIOD") {
          toasts.error(
            data?.message ??
              'Verstoß gegen § 5 ArbZG (Ruhezeit) am Zieltag. Über Klick + „Trotzdem zuweisen" zuweisen.',
          );
        } else if (data?.code === "SHIFT_CONFLICT_UNAVAILABILITY") {
          toasts.error(
            data?.message ??
              'Mitarbeiter ist am Zieltag nicht verfügbar. Über Klick + „Trotzdem zuweisen" zuweisen.',
          );
        } else if (data?.code === "SHIFT_OUTSIDE_STORE_HOURS") {
          toasts.error(
            data?.message ??
              'Zielzeit liegt außerhalb der Öffnungszeiten. Über Klick + „Trotzdem zuweisen" zuweisen.',
          );
        } else {
          toasts.error(data?.message ?? "Schicht-Konflikt — Mitarbeiter hat Urlaub am Zieltag.");
        }
      } else {
        toasts.error(err instanceof Error ? err.message : "Verschieben fehlgeschlagen.");
      }
      await load(); // revert visual position
    } finally {
      dropPending = null;
    }
  }

  // Phase 47-02 — per-occupied-cell drag-source state. The grid's occupied
  // cells each get their own dndzone whose `items` array is exactly one
  // ShiftDragItem. We derive the "ground truth" from `week.shifts` and keep a
  // mutable copy that svelte-dnd-action mutates on consider/finalize.
  const shiftDragItems = $derived.by(() => {
    const map = new Map<string, ShiftDragItem[]>();
    if (!week) return map;
    for (const s of week.shifts) {
      const iso = s.date.slice(0, 10);
      const key = `${s.employeeId}::${iso}`;
      map.set(key, [
        {
          id: `shift-${s.id}`,
          kind: "shift" as const,
          shiftId: s.id,
          originEmployeeId: s.employeeId,
          originIso: iso,
        },
      ]);
    }
    return map;
  });

  // Mutable per-cell state — svelte-dnd-action mutates the array on
  // consider/finalize so we keep a Record<key, items[]> alongside the derived
  // "ground truth".
  let dndShiftCells = $state<Record<DropTargetKey, ShiftDragItem[]>>({});

  // Sync mutable state from derived whenever the week's shifts change. This
  // runs after every successful load() and restores cells after cancelled drags.
  $effect(() => {
    const next: Record<DropTargetKey, ShiftDragItem[]> = {};
    for (const [k, v] of shiftDragItems) next[k] = v;
    dndShiftCells = next;
  });

  function shiftCellItems(key: DropTargetKey): ShiftDragItem[] {
    return dndShiftCells[key] ?? [];
  }

  function onShiftCellConsider(key: DropTargetKey, e: CustomEvent<DndEvent<DragItem>>) {
    // Filter so only ShiftDragItems live in the source cell's zone.
    const next = e.detail.items.filter((i): i is ShiftDragItem => i.kind === "shift");
    dndShiftCells = { ...dndShiftCells, [key]: next };
  }
  function onShiftCellFinalize(key: DropTargetKey, e: CustomEvent<DndEvent<DragItem>>) {
    // After a successful move, load() re-syncs via $effect on shiftDragItems.
    // After a cancel, also re-sync to restore the source pill.
    const next = e.detail.items.filter((i): i is ShiftDragItem => i.kind === "shift");
    dndShiftCells = { ...dndShiftCells, [key]: next };
  }

  // Per-cell items accessor — ensures the dndzone `items` reference is stable
  // when the key hasn't been touched yet (`dndCells[key]` would be undefined).
  function cellItems(key: DropTargetKey): DragItem[] {
    return dndCells[key] ?? [];
  }

  // ── Formatters ─────────────────────────────────────────────────────────────
  function fmtRange(): string {
    if (!week) return "";
    const first = new Date(week.weekDays[0]);
    const last = new Date(week.weekDays[6]);
    const fOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
    const lOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
    return `${first.toLocaleDateString("de-DE", fOpts)} – ${last.toLocaleDateString("de-DE", lOpts)}`;
  }
  function fmtDayHeader(iso: string): string {
    const d = new Date(iso);
    return `${d.getDate()}.${d.getMonth() + 1}`;
  }
  function isToday(iso: string): boolean {
    const today = ymd(new Date());
    return iso.slice(0, 10) === today;
  }
  // Phase 47.2 — Schichten in der Vergangenheit sind nicht änderbar
  function isPastDay(iso: string): boolean {
    return iso.slice(0, 10) < ymd(new Date());
  }
  // Phase 47.5 / Issue #563 — which closed days the grid dims and for which salon: the week field
  // `salonOpeningHours` plus the header's salon choice, decided in `closedDaysFor()` (presentation
  // only, never a filter of shifts or employees).
  const closedView = $derived(closedDaysFor(week?.salonOpeningHours, $salonContext));
  // Closed-day check: weekday from iso (converted to 0 = Montag), then lookup in the view's set.
  function isClosedDay(iso: string): boolean {
    const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
    const jsDow = d.getUTCDay();
    const dow = jsDow === 0 ? 6 : jsDow - 1;
    return closedView.days.has(dow);
  }
  // Issue #923 — the tooltip of a shift pill (grid and day view); plain words, no emoji.
  function shiftTitle(s: Shift, iso: string): string {
    if (isPastDay(iso)) return "Schicht in der Vergangenheit (nur lesen)";
    if (s.conflictsWithLeave) return "Konflikt mit Urlaub – bitte überprüfen oder entfernen";
    return "Klicken zum Bearbeiten, ziehen zum Verschieben";
  }
  // Issue #923 — the staffing bar: share of the Mindestbesetzung that is covered (0–100).
  function staffFillPct(c: CoverageEntry): number {
    if (c.minStaff <= 0) return 100;
    return Math.max(0, Math.min(100, (c.effectiveStaff / c.minStaff) * 100));
  }
  // Issue #923 — Geplant vs. Vertrag in the person cell: balanced, under or over the contract.
  function deltaKind(diff: number): "ok" | "under" | "over" {
    if (Math.abs(diff) <= 0.5) return "ok";
    return diff < 0 ? "under" : "over";
  }
  function classificationLabel(c: string): string {
    const lower = c.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  // Issue #923 — the day the phone day view shows: the picked one if it lies in the week, else
  // today if it lies in the week, else the Monday.
  let pickedDay: string | null = $state(null);
  const dayIso = $derived.by(() => {
    if (!week) return "";
    const days = week.weekDays.map((d) => d.slice(0, 10));
    if (pickedDay && days.includes(pickedDay)) return pickedDay;
    return days.find((d) => isToday(d)) ?? days[0];
  });
  function shiftLabel(s: Shift): string {
    const start = s.startTime.slice(0, 5);
    const end = s.endTime.slice(0, 5);
    return `${start}–${end}`;
  }

  // Availability label (DE). Issue #923: no emoji; the colour comes from availColor().
  function availLabel(a: AvailabilityEntry["availability"]): string {
    switch (a) {
      case "vacation":
        return "Urlaub";
      case "sick":
        return "Krank";
      case "special":
        return "Sonderurlaub";
      case "vocational_school":
        return "Berufsschule";
      case "other":
        return "Abwesend";
      case "unavailable":
        return "Nicht verfügbar";
      case "preferred":
        return "Bevorzugt";
      default:
        return "";
    }
  }

  // Issue #923: an absence on the roster wears the same colour pair as on the absence timeline
  // (`leave-colors.ts`, the one mapping). Berufsschule is no leave type and keeps the info role;
  // the two availability wishes („Nicht verfügbar“, „Bevorzugt“) are no absence and stay neutral.
  function availColor(a: AvailabilityEntry["availability"]): LeaveColor | null {
    switch (a) {
      case "vacation":
        return leaveTypeColor("VACATION");
      case "sick":
        return leaveTypeColor("SICK");
      case "special":
        return leaveTypeColor("SPECIAL");
      case "other":
        return ABSENT;
      default:
        return null;
    }
  }

  // Phase 46 — explicit class mapping for derived availability badges.
  // Inline interpolation (`sp-avail-badge--{av}`) would also work, but spelling
  // out the class names here makes the lint:tokens/lint:ui-classes audit
  // trail obvious and matches the global recipes in app.css.
  function availClass(a: AvailabilityEntry["availability"]): string {
    switch (a) {
      case "vacation":
        return "sp-avail-badge sp-avail-badge--vacation";
      case "sick":
        return "sp-avail-badge sp-avail-badge--sick";
      case "special":
        return "sp-avail-badge sp-avail-badge--special";
      // Phase 63 D-20: brand-tinted, lock-iconed badge (CSS below).
      case "vocational_school":
        return "sp-avail-badge sp-avail-badge--vocational-school";
      case "other":
        return "sp-avail-badge sp-avail-badge--other";
      case "unavailable":
        return "sp-avail-badge sp-avail-badge--unavailable";
      case "preferred":
        return "sp-avail-badge sp-avail-badge--preferred";
      default:
        return "";
    }
  }

  // ── Modal handlers ─────────────────────────────────────────────────────────
  function onCellClick(employeeId: string, date: string) {
    editingShiftId = null;
    modalEmployeeId = employeeId;
    modalDate = date;
    modalTemplateId = "";
    modalStartTime = "08:00";
    modalEndTime = "16:00";
    modalLabel = "";
    modalNote = "";
    modalError = "";
    modalOpen = true;
  }

  // 260601-g8l — Permission gate for the BS-removal click handler (Phase 378, #378: was a role
  // check). Mirrored in the template so a viewer without `shift:plan:ZUGEWIESEN` doesn't receive
  // a misleading "Knopf" affordance (role="button" / tabindex / title are omitted) — though this
  // page is unreachable without that permission anyway (see the onMount guard above), this stays
  // as defense-in-depth against a future entry point that mounts the component differently.
  const canRemoveVs = $derived(hasPermission($authStore.user, "shift:plan:ZUGEWIESEN"));

  // 260601-g8l — Click on a vocational_school cell → resolve absenceId via
  // /vocational-school/upcoming (the canonical read endpoint), then open the
  // ConfirmDialog. The shifts /api/v1/shifts response does NOT carry absence ids,
  // so this extra round-trip is unavoidable but cheap (the result set is a single
  // day window).
  async function onVocationalSchoolCellClick(employeeId: string, iso: string): Promise<void> {
    if (!canRemoveVs) return; // defense-in-depth; the cell stays readable for EMPLOYEE
    if (vsRemovePending) return; // avoid double-firing while a previous DELETE is in flight
    try {
      type UpcomingRow = {
        id: string;
        employeeId: string;
        date: string;
        source: "MANUAL" | "PATTERN";
      };
      const rows = await api.get<UpcomingRow[]>(
        `/vocational-school/upcoming?from=${iso}&to=${iso}`,
      );
      const match = rows.find((r) => r.employeeId === employeeId && r.date === iso);
      if (!match) {
        toasts.error("Berufsschultag konnte nicht entfernt werden.");
        return;
      }
      const emp = week?.employees.find((e) => e.id === employeeId);
      vsRemoveConfirm = {
        open: true,
        absenceId: match.id,
        employeeId,
        date: iso,
        employeeName: emp ? `${emp.firstName} ${emp.lastName}` : "",
      };
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Berufsschultag konnte nicht entfernt werden.");
    }
  }

  // 260601-g8l — Enter/Space keyboard parity for the BS cell. Pulled out as a
  // named function so the template stays readable and we avoid inline arrow
  // closures that re-allocate on every render.
  function onVocationalSchoolCellKeydown(e: KeyboardEvent, employeeId: string, iso: string): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void onVocationalSchoolCellClick(employeeId, iso);
    }
  }

  function openEditShift(shift: Shift) {
    editingShiftId = shift.id;
    modalEmployeeId = shift.employeeId;
    modalDate = shift.date.split("T")[0];
    modalTemplateId = shift.templateId ?? "";
    modalStartTime = shift.startTime;
    modalEndTime = shift.endTime;
    modalLabel = shift.label ?? "";
    modalNote = shift.note ?? "";
    modalError = "";
    modalOpen = true;
  }

  function onTemplateSelect() {
    const tpl = templates.find((t) => t.id === modalTemplateId);
    if (tpl) {
      modalStartTime = tpl.startTime;
      modalEndTime = tpl.endTime;
      modalLabel = tpl.name;
    }
  }

  // Issue #744 — a shift on a half-day leave is saved; the server answers with a hint, never a 409.
  function announceShiftHint(saved: Shift | undefined) {
    if (saved?.hint?.code === "HALF_DAY_LEAVE") toasts.warning(saved.hint.message, 8000);
  }

  // Persist the modal as a shift. `force` adds ?force=true so the API will write
  // an SHIFT_FORCED_OVER_LEAVE audit entry alongside the regular CREATE/UPDATE.
  async function saveShift(force = false) {
    if (!modalStartTime || !modalEndTime) {
      modalError = "Start- und Endzeit sind Pflichtfelder.";
      return;
    }
    saving = true;
    modalError = "";
    try {
      const qs = force ? "?force=true" : "";
      if (editingShiftId) {
        const saved = await api.put<Shift>(`/shifts/${editingShiftId}${qs}`, {
          templateId: modalTemplateId || undefined,
          startTime: modalStartTime,
          endTime: modalEndTime,
          label: modalLabel || undefined,
          note: modalNote || undefined,
        });
        toasts.success(force ? "Schicht trotz Konflikt aktualisiert." : "Schicht aktualisiert.");
        announceShiftHint(saved);
      } else {
        const saved = await api.post<Shift>(`/shifts${qs}`, {
          employeeId: modalEmployeeId,
          templateId: modalTemplateId || undefined,
          date: modalDate,
          startTime: modalStartTime,
          endTime: modalEndTime,
          label: modalLabel || undefined,
          note: modalNote || undefined,
          // Issue #558 D-13 — same rule as the drag-and-drop create; editing never sends a salon.
          ...(pageSalonId !== null ? { salonId: pageSalonId } : {}),
        });
        toasts.success(force ? "Schicht trotz Konflikt zugewiesen." : "Schicht zugewiesen.");
        announceShiftHint(saved);
      }
      modalOpen = false;
      editingShiftId = null;
      conflictConfirm = { open: false, message: "", code: "" };
      await load();
    } catch (e) {
      // Phase 47.4-02 — § 3 ArbZG (Tageshöchstarbeitszeit) is HARD-BLOCKED.
      // 422 ARBZG_VIOLATION_DAILY_MAX → toast only, never opens conflictConfirm,
      // no force-override path exists for this code.
      if (e instanceof ApiError && e.status === 422) {
        const data = e.data as { code?: string; message?: string } | undefined;
        if (data?.code === "ARBZG_VIOLATION_DAILY_MAX") {
          toasts.error(
            data?.message ??
              "Schicht überschreitet die zulässige Tageshöchstarbeitszeit (§ 3 ArbZG: 10 Stunden).",
          );
          saving = false;
          return;
        }
      }
      // 409 with code SHIFT_CONFLICT_LEAVE/ABSENCE/UNAVAILABILITY or
      // ARBZG_VIOLATION_REST_PERIOD (§ 5) → ask for force-override confirmation.
      if (e instanceof ApiError && e.status === 409) {
        const data = e.data as { code?: string; message?: string } | undefined;
        if (
          data?.code === "SHIFT_CONFLICT_LEAVE" ||
          data?.code === "SHIFT_CONFLICT_ABSENCE" ||
          data?.code === "SHIFT_CONFLICT_UNAVAILABILITY" ||
          data?.code === "ARBZG_VIOLATION_REST_PERIOD" ||
          data?.code === "SHIFT_OUTSIDE_STORE_HOURS"
        ) {
          conflictConfirm = {
            open: true,
            message: data.message ?? "Konflikt am gewählten Tag.",
            code: data.code,
          };
          saving = false;
          return;
        }
      }
      modalError = e instanceof Error ? e.message : "Speichern fehlgeschlagen.";
    } finally {
      saving = false;
    }
  }

  async function confirmForceSave() {
    conflictConfirm = { open: false, message: conflictConfirm.message, code: conflictConfirm.code };
    await saveShift(true);
  }

  async function askDeleteShift(id: string, closeAfter = false) {
    // Phase 87: fail-open appointment-collision pre-check by shiftId. On >=1
    // booked appointment the existing delete ConfirmDialog surfaces the warn
    // body; on zero-collision / error (null) it behaves exactly as before.
    shiftDeletePrecheckPending = true;
    try {
      const summary = await checkAppointmentCollisions({ shiftId: id });
      shiftDeleteCollisions = summary && summary.total > 0 ? summary : null;
    } finally {
      shiftDeletePrecheckPending = false;
    }
    shiftDeleteConfirm = { open: true, id, closeAfter };
  }

  async function confirmDeleteShift() {
    const id = shiftDeleteConfirm.id;
    if (!id) return;
    try {
      await api.delete(`/shifts/${id}`);
      toasts.success("Schicht gelöscht.");
      if (shiftDeleteConfirm.closeAfter) {
        modalOpen = false;
        editingShiftId = null;
      }
      shiftDeleteCollisions = null;
      await load();
    } catch (e) {
      toasts.error(e instanceof Error ? e.message : "Löschen fehlgeschlagen.");
    }
  }

  // 260601-g8l — Confirm handler for the BS-removal ConfirmDialog. Posts the
  // DELETE, surfaces the standard 403 (locked-month) / 404 (cross-tenant or
  // already-deleted) toasts, and refreshes the week on success.
  async function confirmRemoveVocationalSchool(): Promise<void> {
    const id = vsRemoveConfirm.absenceId;
    if (!id) return;
    vsRemovePending = true;
    try {
      await api.delete(`/vocational-school/${id}`);
      toasts.success("Berufsschultag entfernt");
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) {
          toasts.error("Monat ist abgeschlossen — Berufsschultag kann nicht entfernt werden.");
        } else if (e.status === 404) {
          toasts.error("Berufsschultag konnte nicht entfernt werden.");
        } else {
          toasts.error(e.message || "Berufsschultag konnte nicht entfernt werden.");
        }
      } else {
        toasts.error(
          e instanceof Error ? e.message : "Berufsschultag konnte nicht entfernt werden.",
        );
      }
    } finally {
      vsRemovePending = false;
      vsRemoveConfirm = {
        open: false,
        absenceId: null,
        employeeId: "",
        date: "",
        employeeName: "",
      };
    }
  }

  // Modal employee name
  const modalEmployeeName = $derived.by(() => {
    if (!week) return "";
    const emp = week.employees.find((e) => e.id === modalEmployeeId);
    return emp ? `${emp.firstName} ${emp.lastName}` : "";
  });
</script>

<svelte:head>
  <title>{pageLabel("/shifts")} – Clokr</title>
</svelte:head>

{#snippet staffing(iso: string)}
  {@const c = coverageByDate.get(iso)}
  {@const closed = isClosedDay(iso)}
  {#if c}
    <!-- Issue #923: the staffing of a day sits under its header (bar + "x / y"). Red only for a
         real shortfall on an open day; a closed day is never understaffed (#853 owner review). -->
    <div
      class="sp-staff"
      class:sp-staff--ok={!closed && c.coverageStatus === "ok"}
      class:sp-staff--under={!closed && c.coverageStatus === "under"}
      class:sp-staff--warn={!closed && c.coverageStatus === "supervision-missing"}
      class:sp-staff--closed={closed}
      title={staffingTooltip(c)}
    >
      <span class="sp-staff-bar" aria-hidden="true">
        <span class="sp-staff-fill" style:width="{staffFillPct(c)}%"></span>
      </span>
      <span class="sp-staff-num" data-testid="staffing-figure">{staffingFigure(c)}</span>
      {#if !closed && c.coverageStatus === "supervision-missing"}
        <span class="sp-coverage-note">{staffingStatusText(c.coverageStatus)}</span>
      {:else if !closed}
        <span class="sr-only">{staffingStatusText(c.coverageStatus)}</span>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet whoInfo(u: Employee)}
  {@const sr = sollRowByEmp.get(u.id)}
  <div class="who-cell-main">
    <div class="name">{u.firstName} {u.lastName}</div>
    <div class="sp-who-meta">
      {#if u.classification}
        <span class="role">{classificationLabel(u.classification)}</span>
      {/if}
      {#if sr}
        {@const reductionH = sr.leaveH + sr.absenceH}
        {@const kind = deltaKind(sr.diff)}
        <span
          class="sp-hours"
          aria-label="Geplant / Vertrag für {u.firstName} {u.lastName}: {formatHours(
            sr.assignedH,
          )} von {formatHours(sr.contractSollH)} Stunden"
          title="{u.firstName} {u.lastName}: geplant {formatHours(sr.assignedH)}h ({formatHours(
            sr.shiftH,
          )}h Schicht{sr.bsH > 0
            ? ` + ${formatHours(sr.bsH)}h Berufsschule`
            : ''}), Vertrag {formatHours(sr.contractSollH)}h{reductionH > 0
            ? ` (${formatHours(sr.weeklyH)}h − ${formatHours(reductionH)}h Urlaub/Abwesenheit)`
            : ''}, Abweichung {sr.diff >= 0 ? '+' : ''}{formatHours(sr.diff)}h"
        >
          {formatHours(sr.assignedH)} / {formatHours(sr.contractSollH)} h
        </span>
        <span class="sp-delta sp-delta--{kind}">
          {kind === "ok" ? "±0" : sr.diff > 0 ? "+" : "−"}{kind === "ok"
            ? ""
            : formatHours(Math.abs(sr.diff))} h
        </span>
        {#if sr.underCoverage}
          <span class="sr-only">{formatHours(sr.gapH)} Stunden weniger geplant als im Vertrag</span>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

{#snippet availBadge(av: AvailabilityEntry["availability"])}
  {@const col = availColor(av)}
  <span
    class={availClass(av)}
    class:sp-avail-badge--leave={col !== null}
    style:--sp-fill={col ? `var(${col.fill})` : undefined}>{availLabel(av)}</span
  >
{/snippet}

<!-- Phase 75-02 (D-01): data-testid surface for the Schichtplanung visual baseline.
     Matches the Phase 73-04/-05 convention (`<surface>-page`). -->
<div class="page" data-testid="shifts-page">
  <div class="roster-head">
    <PageHead
      title={pageLabel("/shifts")}
      sub="Schichten der Woche planen und Muster anwenden. Vorlagen und Mindestbesetzung pflegt die Verwaltung."
    >
      {#snippet actions()}
        <!-- Issue #853 (D-853-13): the two plan actions live in the head; the sibling links to the
             conflict overview and to Planungsbedarf (Phase 430) are the tabs below now. -->
        <button type="button" class="btn btn-secondary sm" onclick={openCopy}>
          Letzte Woche kopieren
        </button>
        <button type="button" class="btn btn-primary sm" onclick={openGenerate}>
          Muster anwenden
        </button>
      {/snippet}
    </PageHead>
    <PageTabs tabs={rosterTabsList} tab="/team/dienstplan" tabsLabel="Dienstplan" />
  </div>

  <!-- Prototype .toolbar2; the scope label is placed on the right by CSS. -->
  <div class="roster-period-row">
    <div class="roster-scope">
      <SalonScopeLabel label={scopeLabel} rejected={weekRejected} />
    </div>
    <!-- #843 D-843-11 (#648): the week header is the PeriodPicker block; the page owns no period arrows. -->
    <PeriodPicker
      label={fmtRange()}
      onPrev={prevWeek}
      onNext={nextWeek}
      onToday={goToToday}
      zooms={["woche"]}
      zoom="woche"
      prevLabel="Vorherige Woche"
      nextLabel="Nächste Woche"
      testIdPrefix="shifts-week"
    />
  </div>

  {#if error}
    <div class="callout error card-animate" role="alert">{error}</div>
  {/if}

  <!-- Template strip — Phase 47: draggable chips via use:dndzone, one chip per template.
       v1.7.4: Berufsschule chip removed — BS is now managed via the canonical
       EmployeeVocationalSchoolPattern + auto-generator path. -->
  {#if dndTemplates.length > 0}
    <TeamSection title="Vorlagen">
      <div
        class="sp-template-strip"
        use:dndzone={{
          items: dndTemplates,
          flipDurationMs: FLIP_MS,
          dropFromOthersDisabled: true,
          type: "shift-template",
        }}
        onconsider={onTemplateConsider}
        onfinalize={onTemplateFinalize}
      >
        {#each dndTemplates as item (item.id)}
          {@const tpl =
            item.kind === "template" ? templates.find((t) => t.id === item.templateId) : undefined}
          <!--
            ALWAYS render a chip div for every item so children.length stays
            equal to items.length — svelte-dnd-action requires a 1:1 mapping
            between items[] and direct children. Shadow placeholders (mid-drag)
            may not resolve to a Template; render an invisible spacer for them.
          -->
          <div
            class="sp-tpl-chip"
            class:sp-tpl-chip--shadow={!tpl}
            data-template-id={tpl?.id ?? ""}
          >
            {#if tpl}
              <span class="sp-tpl-name">{tpl.name}</span>
              <span class="sp-tpl-time">
                {tpl.startTime.slice(0, 5)}–{tpl.endTime.slice(0, 5)}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </TeamSection>
  {/if}

  <!-- The week grid is the page's one surface (D-853-18): no card around it. -->
  <div class="week-surface">
    <div class="week-body">
      {#if loading}
        <Skeleton shape="block" height="360px" />
      {:else if !week}
        {#if !weekRejected}
          <div class="state-msg">Keine Daten</div>
        {/if}
      {:else if shiftEmployees.length === 0}
        <div class="callout info card-animate sp-empty-shift-roster" role="status">
          <strong>Keine Mitarbeiter im Schichtsystem.</strong>
          <p class="sp-empty-sub">
            Um hier Schichten zu planen, stell bei mindestens einer Person das Arbeitszeitmodell
            „Nach Schichtplan“ ein — in
            <a href="/admin/vacation">Administration → Personal &amp; Urlaub</a>.
          </p>
        </div>
      {:else}
        {#if week.sollUnavailableReason === "SALON_FILTER"}
          <div class="callout info" role="status" data-testid="shifts-soll-unavailable">
            <p>{SALON_SOLL_NOT_ATTRIBUTABLE_NOTE}</p>
          </div>
        {/if}
        <!-- Issue #923: one row per person (Geplant / Vertrag sits in the person cell), the staffing
             of a day sits under its header, quiet empty and closed cells. -->
        <div class="shift-grid">
          <div class="head sp-head-person">
            <span>Person · Geplant / Vertrag</span>
            <span class="sp-head-staff">
              Besetzung
              <span
                class="sp-info"
                role="img"
                aria-label="Erklärung: {STAFFING_EXPLANATION}"
                title={STAFFING_EXPLANATION}
                data-testid="staffing-info">i</span
              >
            </span>
          </div>
          {#each week.weekDays as d, i (d)}
            <div class="head sp-head-day" class:today-col={isToday(d)}>
              <div class="sp-day">
                <span class="sp-dow">{DOW[i]}</span>
                <span class="head-date">{fmtDayHeader(d)}.</span>
                {#if isToday(d)}<span class="sp-today">Heute</span>{/if}
              </div>
              {@render staffing(d.slice(0, 10))}
            </div>
          {/each}

          {#each shiftEmployees as u (u.id)}
            <div class="who-cell">
              {@render whoInfo(u)}
            </div>
            {#each week.weekDays as d (d)}
              {@const iso = d.slice(0, 10)}
              {@const s = shiftsByEmpDate.get(`${u.id}::${iso}`)}
              {@const av = availabilityByEmpDate.get(`${u.id}::${iso}`) ?? "available"}
              {@const cellKey = `${u.id}::${iso}`}
              <!-- v1.7.4 hotfix — schoolHoliday marker, AZUBI rows only (BBiG §15, defense-in-depth;
                   the API already filters). A BS absence wins display priority. -->
              {@const holiday = isAzubi(u)
                ? schoolHolidayByEmpDate.get(`${u.id}::${iso}`)
                : undefined}
              {#if s}
                <!-- Occupied cell: drag-source for the shift pill, NOT a drop-target (drops onto an
                     occupied cell are rejected in handleShiftMove). Past dates are read-only. -->
                <div
                  class="shift-cell sp-cell sp-cell--drop-blocked"
                  class:sp-cell--today={isToday(d)}
                  class:sp-cell--past={isPastDay(iso)}
                  use:dndzone={{
                    items: shiftCellItems(cellKey),
                    flipDurationMs: FLIP_MS,
                    type: "shift-template",
                    dropFromOthersDisabled: true,
                    dragDisabled: isPastDay(iso),
                  }}
                  onconsider={(e) => onShiftCellConsider(cellKey, e)}
                  onfinalize={(e) => onShiftCellFinalize(cellKey, e)}
                >
                  {#each shiftCellItems(cellKey) as item (item.id)}
                    <button
                      type="button"
                      class="shift-pill sp-shift-pill"
                      class:sp-shift-pill--conflict={s.conflictsWithLeave}
                      data-shift-drag-id={item.id}
                      onclick={() => openEditShift(s)}
                      title={shiftTitle(s, iso)}
                    >
                      {shiftLabel(s)}
                      {#if s.conflictsWithLeave}
                        <span class="sp-mark" aria-hidden="true">!</span>
                        <span class="sr-only">Konflikt mit Urlaub</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {:else if isClosedDay(iso)}
                <!-- Phase 47.5 — closed day: hatched, no drop-target. -->
                <div
                  class="shift-cell sp-cell sp-cell--closed"
                  title={`${closedView.salonName ?? "Der Salon"} ist an diesem Tag geschlossen`}
                >
                  <span class="sp-closed-label">geschlossen</span>
                </div>
              {:else if av !== "available"}
                <!-- 260601-g8l: a vocational_school cell is click-to-remove for holders of the right;
                     every other availability is a passive label (drop-targeting is rejected in
                     onCellFinalize, Phase 63 D-20). -->
                {#if av === "vocational_school" && canRemoveVs}
                  <div
                    class="shift-cell sp-cell sp-cell--absent sp-cell--vs-removable"
                    class:sp-cell--today={isToday(d)}
                    role="button"
                    tabindex={0}
                    title="Berufsschultag entfernen"
                    onclick={() => onVocationalSchoolCellClick(u.id, iso)}
                    onkeydown={(e) => onVocationalSchoolCellKeydown(e, u.id, iso)}
                  >
                    {@render availBadge(av)}
                  </div>
                {:else}
                  <div class="shift-cell sp-cell sp-cell--absent" class:sp-cell--today={isToday(d)}>
                    {@render availBadge(av)}
                  </div>
                {/if}
              {:else if isPastDay(iso)}
                <!-- Phase 47.2 — past day, empty: nothing to plan, nothing drawn. -->
                <div
                  class="shift-cell sp-cell off sp-cell--past"
                  title="Vergangenheit – nicht änderbar"
                ></div>
              {:else}
                <!-- Empty open cell: drop-target only. Its button stays in the tab order and shows
                     „+ Schicht“ on hover and focus (Issue #923). A school-holiday day is tinted and
                     badged; it stays a drop-target (informational, not blocking). -->
                <div
                  class="shift-cell sp-cell off sp-cell--drop-target"
                  class:sp-cell--today={isToday(d)}
                  class:sp-cell--drop-hover={cellItems(cellKey).length === 1}
                  class:sp-cell--holiday={holiday}
                  use:dndzone={{
                    items: cellItems(cellKey),
                    flipDurationMs: FLIP_MS,
                    type: "shift-template",
                    dragDisabled: true,
                    dropTargetStyle: {},
                  }}
                  onconsider={(e) => onCellConsider(cellKey, e)}
                  onfinalize={(e) => onCellFinalize(u.id, iso, e)}
                  title={holiday ? `${holiday.name} (${holiday.federalState})` : undefined}
                >
                  {#if holiday}
                    <span class="sp-holiday-badge" aria-label="Schulferien: {holiday.name}">
                      Ferien
                    </span>
                  {/if}
                  <button
                    type="button"
                    class="sp-cell-empty"
                    class:sp-cell-empty--pending={dropPending === cellKey}
                    onclick={() => onCellClick(u.id, iso)}
                    aria-label="Schicht zuweisen"
                    disabled={dropPending === cellKey}
                  >
                    <span class="sp-add"
                      >{dropPending === cellKey ? "speichere …" : "+ Schicht"}</span
                    >
                  </button>
                  {#each cellItems(cellKey) as item (item.id)}
                    <!-- Hidden placeholder while a drag hovers; svelte-dnd-action draws the ghost in
                         the body via .dnd-action-dragged-el. -->
                    <span style="display: none" data-dropped-id={item.id}></span>
                  {/each}
                </div>
              {/if}
            {/each}
          {/each}
        </div>

        <!-- Issue #923: below 760 px the week is a day view (pick a day, see its people). No drag
             and drop there; a tap opens the same dialogs. -->
        <section class="sp-dayview" aria-label="Tagesansicht">
          <div class="sp-daypick" role="group" aria-label="Tag wählen">
            {#each week.weekDays as d, i (d)}
              {@const iso = d.slice(0, 10)}
              {@const c = coverageByDate.get(iso)}
              {@const short = !!c && !isClosedDay(iso) && c.coverageStatus !== "ok"}
              <button
                type="button"
                class="sp-daybtn"
                aria-pressed={dayIso === iso}
                aria-label="{DOW[i]} {fmtDayHeader(d)}.{short ? ', Besetzung unvollständig' : ''}"
                onclick={() => (pickedDay = iso)}
              >
                <small>{DOW[i]}</small>
                <b>{new Date(d).getDate()}</b>
                <span class="sp-daydot" class:sp-daydot--short={short} aria-hidden="true"></span>
              </button>
            {/each}
          </div>
          <div class="sp-daylist">
            <div class="sp-dayhead">
              <span>
                {DOW[week.weekDays.findIndex((d) => d.slice(0, 10) === dayIso)]}
                {fmtDayHeader(dayIso)}.
              </span>
              {@render staffing(dayIso)}
            </div>
            {#each shiftEmployees as u (u.id)}
              {@const s = shiftsByEmpDate.get(`${u.id}::${dayIso}`)}
              {@const av = availabilityByEmpDate.get(`${u.id}::${dayIso}`) ?? "available"}
              <div class="sp-dayrow">
                {@render whoInfo(u)}
                <div class="sp-daywhat">
                  {#if s}
                    <button
                      type="button"
                      class="shift-pill sp-shift-pill"
                      class:sp-shift-pill--conflict={s.conflictsWithLeave}
                      onclick={() => openEditShift(s)}
                      title={shiftTitle(s, dayIso)}
                    >
                      {shiftLabel(s)}
                      {#if s.conflictsWithLeave}
                        <span class="sp-mark" aria-hidden="true">!</span>
                        <span class="sr-only">Konflikt mit Urlaub</span>
                      {/if}
                    </button>
                  {:else if isClosedDay(dayIso)}
                    <span class="sp-closed-label">geschlossen</span>
                  {:else if av !== "available"}
                    {@render availBadge(av)}
                  {:else if !isPastDay(dayIso)}
                    <button
                      type="button"
                      class="btn btn-secondary sm"
                      onclick={() => onCellClick(u.id, dayIso)}
                    >
                      + Schicht
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <div class="sp-grid-foot">
          {#if closedView.hint}
            <p class="sp-hours-hint" role="status">{closedView.hint}</p>
          {/if}
          <ul class="sp-legend" aria-label="Legende">
            <li><span class="sp-key sp-key--shift"></span>Schicht</li>
            <li><span class="sp-key sp-key--under"></span>{ROSTER_LEGEND_PROBLEMS.under}</li>
            <li><span class="sp-key sp-key--conflict"></span>{ROSTER_LEGEND_PROBLEMS.conflict}</li>
            <li>
              <span class="sp-key" style:background="var({leaveTypeColor('VACATION').fill})"
              ></span>Urlaub
            </li>
            <li>
              <span class="sp-key sp-key--school"></span>Berufsschule
            </li>
            <li><span class="sp-key sp-key--closed"></span>geschlossen</li>
          </ul>
        </div>
      {/if}
    </div>
  </div>

  <!-- Modal: assign / edit shift -->
  <Modal
    bind:open={modalOpen}
    eyebrow="Schichtplanung"
    title={editingShiftId ? "Schicht bearbeiten" : "Schicht zuweisen"}
  >
    <p class="sp-modal-context">
      <strong>{modalEmployeeName}</strong> am {modalDate}
    </p>
    {#if modalError}
      <div class="callout error" role="alert">{modalError}</div>
    {/if}
    <div class="form-group">
      <label class="form-label" for="shift-tpl">Vorlage (optional)</label>
      <select
        id="shift-tpl"
        class="form-input"
        bind:value={modalTemplateId}
        onchange={onTemplateSelect}
      >
        <option value="">– Benutzerdefiniert –</option>
        {#each templates as tpl (tpl.id)}
          <option value={tpl.id}>{tpl.name} ({tpl.startTime}–{tpl.endTime})</option>
        {/each}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="shift-start">Startzeit *</label>
        <input id="shift-start" class="form-input" type="time" bind:value={modalStartTime} />
      </div>
      <div class="form-group">
        <label class="form-label" for="shift-end">Endzeit *</label>
        <input id="shift-end" class="form-input" type="time" bind:value={modalEndTime} />
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="shift-label">Bezeichnung (optional)</label>
      <input
        id="shift-label"
        class="form-input"
        type="text"
        bind:value={modalLabel}
        placeholder="z.B. Frühschicht"
      />
    </div>
    <div class="form-group">
      <label class="form-label" for="shift-note">Notiz (optional)</label>
      <textarea
        id="shift-note"
        class="form-input"
        rows="2"
        bind:value={modalNote}
        placeholder="Zusätzliche Informationen…"
      ></textarea>
    </div>
    {#snippet footer()}
      {#if editingShiftId}
        <button
          type="button"
          class="btn btn-danger sm"
          onclick={() => askDeleteShift(editingShiftId!, true)}
          disabled={shiftDeletePrecheckPending}
        >
          Löschen
        </button>
      {/if}
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (modalOpen = false)}
        >Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-primary sm"
        onclick={() => saveShift(false)}
        disabled={saving}
      >
        {saving ? "Speichern …" : "Speichern"}
      </button>
    {/snippet}
  </Modal>

  <ConfirmDialog
    bind:open={shiftDeleteConfirm.open}
    title="Schicht löschen?"
    description="Diese Schicht wird dauerhaft entfernt."
    confirmLabel="Löschen"
    danger
    onConfirm={confirmDeleteShift}
    onCancel={() => (shiftDeleteCollisions = null)}
  >
    {#snippet body()}
      {#if shiftDeleteCollisions}
        <CollisionWarnBody summary={shiftDeleteCollisions} variant="shift" />
      {/if}
    {/snippet}
  </ConfirmDialog>

  <!-- 260601-g8l: BS-Tag removal confirmation dialog. The description is built
       from the resolved employee name + DD.MM.YYYY date at the moment the user
       clicks the cell, so the user sees exactly which BS-Tag they're about to
       remove. -->
  <ConfirmDialog
    bind:open={vsRemoveConfirm.open}
    title="Berufsschultag entfernen?"
    description={`Berufsschultag für ${vsRemoveConfirm.employeeName} am ${formatDeDate(vsRemoveConfirm.date)} entfernen?`}
    confirmLabel="Entfernen"
    danger
    onConfirm={confirmRemoveVocationalSchool}
  />

  <!-- Phase 43-03: force-override dialog when API returns 409 SHIFT_CONFLICT_* -->
  <ConfirmDialog
    bind:open={conflictConfirm.open}
    title="Schicht trotz Urlaub/Abwesenheit zuweisen?"
    description={`${conflictConfirm.message} Aktion wird protokolliert.`}
    confirmLabel="Trotzdem zuweisen"
    danger
    onConfirm={confirmForceSave}
  />

  <!-- Phase 43-02: generate-week diff-preview modal -->
  <Modal bind:open={generateOpen} eyebrow="Schichtplanung" title="Muster auf die Woche anwenden">
    {#if pageSalonId !== null}
      <!-- Issue #558 D-10 — the bulk action keeps acting on the caller's whole reach. -->
      <p class="form-hint sp-bulk-scope" role="note">
        Diese Aktion gilt für alle Salons deiner Reichweite, nicht nur für den gewählten Salon.
      </p>
    {/if}
    {#if generating && !generateDiff}
      <div class="state-msg">Vorschau wird erstellt …</div>
    {:else if generateError}
      <div class="callout error" role="alert">{generateError}</div>
    {:else if generateDiff}
      <p class="sp-gen-intro">
        Vorschau für die Woche ab <strong>{shortGermanDay(generateDiff.weekStart)}</strong>. Es
        werden
        <strong>{generateDiff.create.length}</strong>
        Schicht(en) erstellt; <strong>{generateDiff.skip.length}</strong> Eintrag/Einträge werden übersprungen.
      </p>

      {#if generateDiff.create.length > 0}
        <h3 class="sp-gen-h">Zu erstellen ({generateDiff.create.length})</h3>
        <div class="sp-gen-list">
          {#each generateDiff.create as c (`${c.employeeId}::${c.date}`)}
            <div class="sp-gen-row">
              <span class="sp-gen-emp">{empName(c.employeeId)}</span>
              <span class="sp-gen-date">{shortGermanDay(c.date)}</span>
              <span class="sp-gen-time">{c.startTime}–{c.endTime}</span>
              {#if c.label}<span class="sp-gen-label">{c.label}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if generateDiff.skip.length > 0}
        <h3 class="sp-gen-h">Übersprungen ({generateDiff.skip.length})</h3>
        <div class="sp-gen-list sp-gen-list--skip">
          {#each generateDiff.skip as s (`${s.employeeId}::${s.date}::${s.reason}`)}
            <div class="sp-gen-row">
              <span class="sp-gen-emp">{empName(s.employeeId)}</span>
              <span class="sp-gen-date">{shortGermanDay(s.date)}</span>
              <span class="sp-gen-reason sp-gen-reason--{s.reason}"
                >{skipReasonLabel(s.reason)}</span
              >
            </div>
          {/each}
        </div>
      {/if}
    {/if}
    {#snippet footer()}
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (generateOpen = false)}
        >Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-primary sm"
        disabled={!generateDiff || generating || generateDiff.create.length === 0}
        onclick={commitGenerate}
      >
        {generating ? "Erstelle …" : `${generateDiff?.create.length ?? 0} Schicht(en) erstellen`}
      </button>
    {/snippet}
  </Modal>

  <!-- Phase 43-05: copy-week diff-preview modal (primary "Letzte Woche kopieren") -->
  <Modal bind:open={copyOpen} eyebrow="Schichtplanung" title="Woche kopieren">
    <p class="sp-gen-intro">
      Schichten von der ausgewählten Quellwoche werden in die aktuell angezeigte Woche kopiert.
      Mitarbeiter mit Urlaub, Krankheit oder bestehenden Schichten werden übersprungen.
    </p>
    {#if pageSalonId !== null}
      <!-- Issue #558 D-10 — the bulk action keeps acting on the caller's whole reach. -->
      <p class="form-hint sp-bulk-scope" role="note">
        Diese Aktion gilt für alle Salons deiner Reichweite, nicht nur für den gewählten Salon.
      </p>
    {/if}

    <div class="form-row sp-copy-pickers">
      <div class="form-group">
        <label class="form-label" for="copy-source">Quellwoche (Montag)</label>
        <input
          id="copy-source"
          class="form-input"
          type="date"
          bind:value={copySourceWeekStart}
          onchange={refreshCopyPreview}
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="copy-target">Zielwoche</label>
        <input id="copy-target" class="form-input" type="text" value={ymd(cursorMonday)} readonly />
      </div>
    </div>

    {#if copying && !copyDiff}
      <div class="state-msg">Vorschau wird erstellt …</div>
    {:else if copyError}
      <div class="callout error" role="alert">{copyError}</div>
    {:else if copyDiff}
      <p class="sp-gen-intro">
        Quelle: <strong>{copyDiff.sourceWeekStart}</strong> → Ziel:
        <strong>{copyDiff.targetWeekStart}</strong>.
        <strong>{copyDiff.create.length}</strong> Schicht(en) werden erstellt;
        <strong>{copyDiff.skip.length}</strong> Eintrag/Einträge werden übersprungen.
      </p>

      {#if copyDiff.create.length > 0}
        <h3 class="sp-gen-h">Werden erstellt ({copyDiff.create.length})</h3>
        <div class="sp-gen-list">
          {#each copyDiff.create as c (`${c.employeeId}::${c.date}`)}
            <div class="sp-gen-row">
              <span class="sp-gen-emp">{empName(c.employeeId)}</span>
              <span class="sp-gen-date">{shortGermanDay(c.date)}</span>
              <span class="sp-gen-time">{c.startTime}–{c.endTime}</span>
              {#if c.label}<span class="sp-gen-label">{c.label}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if copyDiff.skip.length > 0}
        <h3 class="sp-gen-h">Übersprungen ({copyDiff.skip.length})</h3>
        <div class="sp-gen-list sp-gen-list--skip">
          {#each copyDiff.skip as s (`${s.employeeId}::${s.date}::${s.reason}`)}
            <div class="sp-gen-row">
              <span class="sp-gen-emp">{empName(s.employeeId)}</span>
              <span class="sp-gen-date">{shortGermanDay(s.date)}</span>
              <span class="sp-gen-reason sp-gen-reason--{s.reason}"
                >{copySkipReasonLabel(s.reason)}</span
              >
            </div>
          {/each}
        </div>
      {/if}
    {/if}
    {#snippet footer()}
      <button type="button" class="btn btn-outline sm" onclick={refreshCopyPreview}>
        Vorschau
      </button>
      <div class="spacer"></div>
      <button type="button" class="btn btn-outline sm" onclick={() => (copyOpen = false)}
        >Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-primary sm"
        disabled={!copyDiff || copying || copyDiff.create.length === 0}
        onclick={commitCopy}
      >
        {copying ? "Übernehme …" : `Übernehmen (${copyDiff?.create.length ?? 0})`}
      </button>
    {/snippet}
  </Modal>
</div>

<style>
  /* Issue #853 (D-853-18): head and tab strip sit together, like the prototype's .head + .tabsbar;
     the page gap applies between this block and the rows below. */
  .roster-head {
    display: flex;
    flex-direction: column;
  }
  /* One row (prototype .toolbar2): the period on the left, the salon scope on the right. */
  .roster-period-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  /* The picker keeps its own label and arrows (block); only its page-sized padding goes, so the period
     starts at the page edge like the prototype's .period. */
  .roster-period-row :global(.month-bar) {
    padding: 0;
  }
  .roster-scope {
    order: 2;
    flex: 1 1 240px;
    min-width: 0;
    text-align: right;
  }
  .roster-scope :global(.salon-scope-label) {
    margin: 0;
  }
  /* The template chips are drag sources, not cards: a compact surface with the name and the time. */
  .sp-template-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .sp-tpl-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: var(--h-row);
    padding: 0 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    cursor: grab;
  }
  .sp-tpl-chip--shadow {
    visibility: hidden;
  }
  .sp-tpl-name {
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }
  .sp-tpl-time {
    font-size: var(--fs-sm);
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  /* v1.7.4 hotfix — Schulferien marker on empty (drop-target) cells.
     Light blue tint via --shift-blue (existing v1.5 token) at low opacity,
     so the cell stays clearly a drop-target but visually communicates
     "Azubi in Schulferien". BS-Absence cells (av === "vocational_school")
     win priority and never enter this branch. */
  .sp-cell--holiday {
    background: color-mix(in srgb, var(--shift-blue) 8%, transparent);
    position: relative;
  }
  .sp-holiday-badge {
    position: absolute;
    top: 4px;
    right: 4px;
    display: inline-block;
    padding: 2px 6px;
    border-radius: var(--r-pill);
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--shift-blue);
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--shift-blue) 30%, transparent);
    pointer-events: none;
    z-index: 1;
  }

  /* 260601-g8l — Click-to-remove affordance for BS-Tag cells (ADMIN/MANAGER).
     Pointer cursor + focus-visible ring; the badge inside still uses the
     brand-soft recipe above. Tokens-only, no hardcoded colors. */
  .sp-cell--vs-removable {
    cursor: pointer;
  }
  .sp-cell--vs-removable:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: var(--r-control);
  }

  /* Phase 65 follow-up: who-cell layout simplified — the row-action menu
     was removed when Berufsschultag insertion moved to the template strip
     drag chip. The who-cell-main wrapper stays so name + role stack cleanly. */
  .who-cell-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .sp-coverage-note {
    font-size: 11px;
    color: var(--text-2);
  }

  /* Issue #850 — the (i) behind which the Besetzung explanation sits (replaces the footnote). */
  .sp-info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1em;
    height: 1.1em;
    margin-left: 4px;
    border: 1px solid var(--line);
    border-radius: 50%;
    font-size: 0.85em;
    text-transform: none;
    cursor: help;
    vertical-align: middle;
  }

  .sp-modal-context {
    font-size: 14px;
    color: var(--text);
    margin: 0 0 12px;
  }

  /* Phase 43-02 — Generate-week diff preview */
  .sp-gen-intro {
    font-size: 14px;
    color: var(--text);
    margin: 0 0 16px;
  }
  .sp-bulk-scope {
    margin: 0 0 16px;
  }
  .sp-gen-h {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin: 16px 0 8px;
  }
  .sp-gen-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    padding: 8px;
    background: var(--sunk);
  }
  .sp-gen-list--skip {
    background: transparent;
  }
  .sp-gen-row {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr auto;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    padding: 4px 6px;
    border-radius: var(--r-control);
  }
  .sp-gen-row:hover {
    background: var(--card);
  }
  .sp-gen-emp {
    font-weight: 600;
    color: var(--text);
  }
  .sp-gen-date {
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--text-2);
  }
  .sp-gen-time {
    font-family: var(--font-ui);
    font-size: 12.5px;
    color: var(--text);
  }
  .sp-gen-label {
    font-size: 12.5px;
    color: var(--text-2);
  }
  .sp-gen-reason {
    font-size: 11.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--r-control);
    background: var(--card);
    color: var(--text-2);
    border: 1px solid var(--line);
  }
  .sp-gen-reason--leave {
    color: var(--bad);
    border-color: var(--bad);
  }
  .sp-gen-reason--absence {
    color: var(--warn);
    border-color: var(--warn);
  }
  .sp-gen-reason--existing {
    color: var(--text-2);
  }
  .sp-gen-reason--open-day {
    color: var(--text-2);
  }
  .sp-gen-reason--availability-unavailable {
    color: var(--bad);
    border-color: var(--bad);
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .form-row {
    display: flex;
    gap: 12px;
  }
  .form-row .form-group {
    flex: 1;
  }
  /* Phase 43-05 — copy-week source + target pickers above the diff preview */
  .sp-copy-pickers {
    margin-bottom: 12px;
  }

  /* Phase 47.1 — Empty roster callout when no SHIFT_BASED employees */
  .sp-empty-shift-roster {
    padding: 24px;
    text-align: center;
  }
  .sp-empty-shift-roster strong {
    display: block;
    margin-bottom: 8px;
    color: var(--text);
    font-size: 1rem;
  }
  .sp-empty-sub {
    margin: 0;
    font-size: 0.9375rem;
    color: var(--text-2);
    line-height: 1.5;
  }
  .sp-empty-sub a {
    color: var(--brand);
    text-decoration: underline;
  }
  /* ── Issue #923: the week grid on v2 ─────────────────────────────────────────── */
  .week-surface {
    min-width: 0;
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--card);
  }
  .week-body {
    min-width: 0;
  }
  .week-body .shift-grid {
    grid-template-columns: minmax(210px, 1.3fr) repeat(7, minmax(112px, 1fr));
    min-width: 1020px;
    border-radius: 0;
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    padding: 10px 12px 9px;
  }
  .sp-head-person {
    justify-content: space-between;
    font-weight: 500;
  }
  .sp-head-staff {
    display: inline-flex;
    align-items: center;
  }
  .sp-day {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-th);
    font-weight: 500;
    color: var(--text-2);
  }
  .head-date {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .today-col .sp-day,
  .today-col .head-date {
    color: var(--brand);
  }
  .sp-today {
    margin-left: auto;
    align-self: center;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    padding: 0 7px;
    border-radius: var(--r-pill);
    background: var(--brand);
    color: var(--brand-ink);
  }
  .shift-grid .head.today-col {
    background: var(--brand-tint);
  }

  /* Staffing under the day header: a bar and the figure x / y. */
  .sp-staff {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-2);
  }
  .sp-staff-bar {
    flex: 1;
    height: 5px;
    border-radius: 3px;
    background: var(--sunk);
    overflow: hidden;
  }
  .sp-staff-fill {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--line-2);
  }
  .sp-staff-num {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .sp-staff--ok .sp-staff-fill {
    background: var(--ok);
  }
  .sp-staff--ok .sp-staff-num {
    color: var(--ok);
  }
  .sp-staff--under .sp-staff-fill {
    background: var(--bad);
  }
  .sp-staff--warn .sp-staff-fill {
    background: var(--warn);
  }
  .sp-staff--under .sp-staff-num {
    color: var(--bad);
  }
  .sp-staff--warn .sp-staff-num {
    color: var(--warn);
  }
  .sp-staff--closed {
    color: var(--text-3);
  }
  .sp-coverage-note {
    font-size: 11px;
    color: var(--warn);
    white-space: nowrap;
  }

  /* The person cell carries Geplant / Vertrag. */
  .shift-grid .who-cell {
    flex-direction: row;
    align-items: center;
    padding: 10px 12px;
  }
  .sp-who-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    font-size: var(--fs-xs);
    color: var(--text-2);
  }
  .sp-who-meta .role::after {
    content: "·";
    margin-left: 6px;
  }
  .sp-who-meta .role:last-child::after {
    content: none;
  }
  .sp-hours {
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .sp-delta {
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
    padding: 0 7px;
    border-radius: var(--r-pill);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .sp-delta--ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .sp-delta--under {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .sp-delta--over {
    background: var(--info-soft);
    color: var(--info);
  }

  /* Day cells */
  .shift-grid .shift-cell {
    min-height: 60px;
    place-items: stretch;
    align-content: start;
    position: relative;
  }
  .shift-grid .shift-cell.sp-cell--today {
    background: var(--brand-tint);
  }
  .sp-cell--closed,
  .shift-grid .shift-cell.sp-cell--closed {
    background: repeating-linear-gradient(-45deg, var(--sunk) 0 6px, var(--card) 6px 12px);
    cursor: not-allowed;
    place-items: center;
    align-content: center;
  }
  .sp-closed-label {
    font-size: var(--fs-xs);
    color: var(--text-3);
    user-select: none;
  }
  .sp-cell--past {
    cursor: not-allowed;
  }
  .sp-cell--past .sp-shift-pill {
    cursor: default;
    opacity: 0.6;
  }

  /* The one shift chip (grid and day view). */
  .sp-shift-pill {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    border-left: 3px solid var(--brand);
    border-radius: 8px;
    padding: 6px 8px;
    background: var(--brand-soft);
    color: var(--brand);
    text-align: left;
    cursor: pointer;
    transition: box-shadow 0.12s var(--ease);
  }
  .sp-shift-pill:hover {
    box-shadow: var(--shadow);
  }
  .sp-shift-pill:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .sp-shift-pill--conflict {
    background: var(--warn-soft);
    border-left-color: var(--warn);
    color: var(--text);
    padding-right: 28px;
  }
  .sp-mark {
    position: absolute;
    right: 6px;
    top: 50%;
    translate: 0 -50%;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--warn);
    color: var(--card);
    font-size: 11px;
    font-weight: 700;
  }

  /* Absence in a cell: the colour pair of leave-colors.ts (set by the availBadge snippet). */
  .sp-avail-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: var(--fs-sm);
    font-weight: 600;
    background: var(--sunk);
    color: var(--text-2);
    white-space: nowrap;
  }
  /* The soft form of the colour pair (as in the approved mockup): a light tint of the fill with
     the fill as text. */
  .sp-avail-badge--leave {
    background: color-mix(in srgb, var(--sp-fill) 14%, var(--card));
    color: var(--sp-fill);
  }
  .sp-avail-badge--vocational-school {
    background: var(--info-soft);
    color: var(--info);
  }
  .sp-avail-badge--leave::before,
  .sp-avail-badge--vocational-school::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  /* Empty open cell: the whole cell is the button; „+ Schicht“ shows on hover and focus. */
  .sp-cell-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 6px;
  }
  .sp-add {
    opacity: 0;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--brand);
    border: 1px dashed var(--brand);
    border-radius: 8px;
    padding: 5px 9px;
    transition: opacity 0.15s var(--ease);
  }
  .sp-cell-empty:hover .sp-add,
  .sp-cell-empty:focus-visible .sp-add,
  .sp-cell-empty--pending .sp-add,
  .sp-cell--drop-hover .sp-add {
    opacity: 1;
  }
  .sp-cell-empty:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }

  /* Hint and legend below the grid. */
  .sp-grid-foot {
    padding: 10px 14px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 8px 16px;
    font-size: var(--fs-xs);
    color: var(--text-2);
  }
  .sp-hours-hint {
    margin: 0;
  }
  .sp-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 0 0 0 auto;
    padding: 0;
    list-style: none;
  }
  .sp-legend li {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .sp-key {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .sp-key--shift {
    background: var(--brand);
  }
  .sp-key--conflict {
    background: var(--warn);
  }
  .sp-key--under {
    background: var(--bad);
  }
  .sp-key--school {
    background: var(--info);
  }
  .sp-key--closed {
    background: repeating-linear-gradient(-45deg, var(--line-2) 0 2px, transparent 2px 4px);
  }

  /* Phone: a day view instead of the seven-day grid. */
  .sp-dayview {
    display: none;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }
  .sp-daypick {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
  }
  .sp-daybtn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 0 7px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    cursor: pointer;
  }
  .sp-daybtn small {
    font-size: 11px;
    color: var(--text-2);
  }
  .sp-daybtn b {
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .sp-daybtn[aria-pressed="true"] {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--brand-ink);
  }
  .sp-daybtn[aria-pressed="true"] small {
    color: var(--brand-ink);
  }
  .sp-daydot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .sp-daydot--short {
    background: var(--warn);
  }
  .sp-daylist {
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
  }
  .sp-dayhead {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    background: var(--sunk);
    font-weight: 600;
  }
  .sp-dayrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-top: 1px solid var(--line);
  }
  .sp-dayrow .who-cell-main {
    flex: 1;
  }
  .sp-daywhat {
    flex: none;
    display: flex;
    justify-content: flex-end;
  }
  @media (max-width: 760px) {
    .week-body .shift-grid {
      display: none;
    }
    .sp-dayview {
      display: flex;
    }
  }
</style>
