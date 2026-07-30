<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api, ApiError } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
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
    contractSollMinutesByEmp?: Record<string, number>;
    // v1.7.4 hotfix — SchoolHolidayPeriod cells for the visible week.
    schoolHoliday?: SchoolHolidayEntry[];
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
  let week: WeekData | null = $state(null);
  let templates: Template[] = $state([]);
  // Phase 47.5 — Set of weekday indices (0=Mo..6=So) marked as closed in storeHours.
  let closedDays = $state<Set<number>>(new Set());
  let loading = $state(true);
  let error = $state("");
  let gated = $state(false);

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
        | "leave"
        | "absence"
        | "existing"
        | "no-pattern"
        | "open-day"
        | "availability-unavailable";
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
      generateError = e instanceof Error ? e.message : "Generierung fehlgeschlagen.";
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
  // Now: one onMount does the role check and triggers the initial load(); the
  // $effect only re-fires on genuine week-navigation (cursorMonday changes).
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
    const role = $authStore.user?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      gated = true;
      goto("/dashboard");
      return;
    }
    void load();
  });

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    if (gated) return;
    loading = true;
    // Phase 47 — clear leftover per-cell drop state when navigating weeks.
    dndCells = {};
    error = "";
    try {
      const date = ymd(cursorMonday);
      const [w, t, work] = await Promise.all([
        api.get<WeekData>(`/shifts/week?date=${date}`),
        api.get<Template[]>("/shifts/templates"),
        api.get<{ storeHours?: Array<{ day: number; closed?: boolean }> }>("/settings/work"),
      ]);
      week = w;
      templates = t;
      // Phase 47.5 — closed-day set used by grid to dim cells visually.
      closedDays = new Set(
        (work.storeHours ?? []).filter((s) => s.closed === true).map((s) => s.day),
      );
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
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
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
      void load();
    }
    prevCursorMondayTime = current;
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
      // Phase 65 follow-up: BS dropped onto an existing BS cell — already exists,
      // surface the same 409 message we'd get from the server.
      if (item.kind === "vocational_school") {
        toasts.error("Berufsschultag existiert bereits für diesen Tag");
      } else {
        toasts.error("Berufsschultag — Schichten können nicht eingeplant werden");
      }
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
        await api.post<Shift>("/shifts", {
          employeeId,
          templateId: tpl.id,
          date: iso,
          startTime: tpl.startTime,
          endTime: tpl.endTime,
          label: tpl.name,
        });
        toasts.success(`Schicht zugewiesen: ${tpl.name}`);
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
      await api.put<Shift>(`/shifts/${item.shiftId}`, {
        employeeId: newEmployeeId,
        date: newIso,
      });
      toasts.success("Schicht verschoben.");
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
  // Phase 47.5 — Closed-day check: dow from iso, then lookup in closedDays set.
  function isClosedDay(iso: string): boolean {
    const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
    const jsDow = d.getUTCDay();
    const dow = jsDow === 0 ? 6 : jsDow - 1;
    return closedDays.has(dow);
  }
  function shiftLabel(s: Shift): string {
    const start = s.startTime.slice(0, 5);
    const end = s.endTime.slice(0, 5);
    return `${start}–${end}`;
  }

  // Availability label (DE) + emoji
  function availLabel(a: AvailabilityEntry["availability"]): string {
    switch (a) {
      case "vacation":
        return "🏖 Urlaub";
      case "sick":
        return "🤒 Krank";
      case "special":
        return "📌 Sonder";
      // Phase 63 D-20: lock icon makes the "non-droppable" affordance obvious.
      case "vocational_school":
        return "🔒 Berufsschule";
      case "other":
        return "⚪ Abwesend";
      case "unavailable":
        return "✕ Nicht verfügbar";
      case "preferred":
        return "★ Bevorzugt";
      default:
        return "";
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

  // Coverage tooltip text
  function coverageTooltip(c: CoverageEntry | undefined): string {
    if (!c) return "";
    const parts: string[] = [];
    parts.push(`Σ Schicht-Gewicht: ${c.effectiveStaff.toFixed(2)} von ${c.minStaff.toFixed(2)}`);
    if (c.unsupervisedAzubis > 0 && !c.hasSupervisor) {
      parts.push(`${c.unsupervisedAzubis} aufsichtspflichtige(r) MA ohne Aufsicht`);
    } else if (c.unsupervisedAzubis > 0) {
      parts.push(`${c.unsupervisedAzubis} aufsichtspflichtige(r) MA, Aufsicht vorhanden`);
    }
    if (c.coverageStatus === "under") parts.push("⚠ Unterbesetzt");
    if (c.coverageStatus === "supervision-missing") parts.push("⚠ Aufsicht fehlt");
    return parts.join("\n");
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

  // 260601-g8l — Role gate for the BS-removal click handler. Mirrored in the
  // template so non-ADMIN/MANAGER users don't receive a misleading "Knopf"
  // affordance (role="button" / tabindex / title are omitted).
  const canRemoveVs = $derived(
    $authStore.user?.role === "ADMIN" || $authStore.user?.role === "MANAGER",
  );

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
        await api.put<Shift>(`/shifts/${editingShiftId}${qs}`, {
          templateId: modalTemplateId || undefined,
          startTime: modalStartTime,
          endTime: modalEndTime,
          label: modalLabel || undefined,
          note: modalNote || undefined,
        });
        toasts.success(force ? "Schicht trotz Konflikt aktualisiert." : "Schicht aktualisiert.");
      } else {
        await api.post<Shift>(`/shifts${qs}`, {
          employeeId: modalEmployeeId,
          templateId: modalTemplateId || undefined,
          date: modalDate,
          startTime: modalStartTime,
          endTime: modalEndTime,
          label: modalLabel || undefined,
          note: modalNote || undefined,
        });
        toasts.success(force ? "Schicht trotz Konflikt zugewiesen." : "Schicht zugewiesen.");
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
  <title>Schichtplanung – Clokr</title>
</svelte:head>

<!-- Phase 75-02 (D-01): data-testid surface for the Schichtplanung visual baseline.
     Matches the Phase 73-04/-05 convention (`<surface>-page`). -->
<div class="page" data-testid="shifts-page">
  <PageHead
    eyebrow="Team"
    title="Schichtplanung"
    accent="Schicht"
    sub="Wöchentliche Schichten zuweisen — mit Verfügbarkeit und Coverage-Heatmap. Vorlagen und Bedarfsregeln pflegt die Administration."
  />

  {#if error}
    <div class="callout error card-animate" role="alert">{error}</div>
  {/if}

  <!-- Template strip — Phase 47: draggable chips via use:dndzone, one chip per template.
       v1.7.4: Berufsschule chip removed — BS is now managed via the canonical
       EmployeeVocationalSchoolPattern + auto-generator path. -->
  {#if dndTemplates.length > 0}
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
          class="card sp-tpl-row sp-tpl-chip"
          class:sp-tpl-chip--shadow={!tpl}
          data-template-id={tpl?.id ?? ""}
        >
          {#if tpl}
            <div class="sp-tpl-text">
              <div class="serif-eyebrow sp-tpl-eyebrow">Vorlage</div>
              <div class="sp-tpl-name">{tpl.name}</div>
              <div class="sp-tpl-time">
                {tpl.startTime.slice(0, 5)}–{tpl.endTime.slice(0, 5)}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Week nav + grid card -->
  <Card animate class="week-card">
    <!-- Header dimensions/typography mirror .cal-monthbar / MonthBar
         (Buchungsmonat-Header auf /leave, /team/leave, /teamcal,
         /time-entries, /team/time-entries). -->
    <div class="week-header">
      <div class="week-header-nav">
        <button
          type="button"
          class="nav-btn"
          aria-label="Vorherige Woche"
          title="Vorherige Woche"
          onclick={prevWeek}
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
        <div class="week-header-center">
          <div class="serif-eyebrow week-header-eyebrow">Schichtwoche</div>
          <div class="week-header-title">{fmtRange()}</div>
        </div>
        <button
          type="button"
          class="nav-btn"
          aria-label="Nächste Woche"
          title="Nächste Woche"
          onclick={nextWeek}
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
        <button type="button" class="btn btn-ghost btn-sm week-header-today" onclick={goToToday}
          >Heute</button
        >
      </div>
      <div class="week-header-actions">
        <!-- Phase 43-05: "Letzte Woche kopieren" is the primary action;
             "Aus Mustern generieren" stays as a secondary/ghost button for
             tenants that have EmployeeShiftPattern rows configured. -->
        <button type="button" class="btn btn-primary sm" onclick={openCopy}>
          Letzte Woche kopieren
        </button>
        <button type="button" class="btn btn-ghost sm" onclick={openGenerate}>
          Aus Mustern generieren
        </button>
      </div>
    </div>

    <div class="week-body">
      {#if loading}
        <div class="state-msg">Lade Woche…</div>
      {:else if !week}
        <div class="state-msg">Keine Daten</div>
      {:else if shiftEmployees.length === 0}
        <div class="callout info card-animate sp-empty-shift-roster" role="status">
          <strong>Keine Mitarbeiter im Schichtsystem.</strong>
          <p class="sp-empty-sub">
            Um hier Schichten zu planen, weise mindestens einem Mitarbeiter den Schichtplan-Modus
            (SHIFT_BASED) zu. Wechsle das Arbeitszeitmodell in
            <a href="/admin/vacation">Administration → Personal &amp; Urlaub</a>.
          </p>
        </div>
      {:else}
        <div class="shift-grid">
          <div class="head">Person</div>
          {#each week.weekDays as d, i (d)}
            <div class="head" class:today-col={isToday(d)}>
              <div>{DOW[i]}</div>
              <div class="head-date">
                {fmtDayHeader(d)}
              </div>
            </div>
          {/each}

          {#each shiftEmployees as u (u.id)}
            <div class="who-cell">
              <div class="who-cell-main">
                <div class="name">{u.firstName} {u.lastName}</div>
                {#if u.classification}
                  <div class="role">{u.classification.toLowerCase()}</div>
                {/if}
              </div>
              <!-- Phase 65 follow-up: Berufsschultag insertion lives in the
                   template strip drag chip — no row-action menu needed. -->
            </div>
            {#each week.weekDays as d (d)}
              {@const iso = d.slice(0, 10)}
              {@const s = shiftsByEmpDate.get(`${u.id}::${iso}`)}
              {@const av = availabilityByEmpDate.get(`${u.id}::${iso}`) ?? "available"}
              {@const cellKey = `${u.id}::${iso}`}
              <!-- v1.7.4 hotfix — schoolHoliday marker. BS-Absence wins display
                   priority (av === "vocational_school" path renders BS, not
                   Ferien), but on empty days the Ferien badge surfaces so
                   managers see why an AZUBI is absent during school break.
                   Guard: only AZUBI rows ever get a holiday marker — the API
                   already filters (BBiG §15), this is defense-in-depth. -->
              {@const holiday = isAzubi(u)
                ? schoolHolidayByEmpDate.get(`${u.id}::${iso}`)
                : undefined}
              {#if s}
                <!-- Occupied cell: drag-source for the shift pill, NOT a drop-target.
                     Drops onto occupied cells are rejected client-side via
                     handleShiftMove (mirrors server's uniqueness constraint).
                     Phase 47.2 — past dates are read-only: dragDisabled + tooltip. -->
                <div
                  class="shift-cell sp-cell sp-cell--drop-blocked"
                  class:sp-cell--unavailable={av !== "available"}
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
                      title={isPastDay(iso)
                        ? "Schicht in der Vergangenheit (nur lesen)"
                        : s.conflictsWithLeave
                          ? "⚠ Konflikt mit Urlaub — bitte überprüfen oder entfernen"
                          : "Klicken zum Bearbeiten, ziehen zum Verschieben"}
                    >
                      {#if s.conflictsWithLeave}
                        <span aria-hidden="true">⚠ </span>
                      {/if}
                      {shiftLabel(s)}
                    </button>
                  {/each}
                </div>
              {:else if isClosedDay(iso)}
                <!-- Phase 47.5 — Closed-day cell: visually marked, no drop-target. -->
                <div
                  class="shift-cell sp-cell sp-cell--closed"
                  title="Geschäft an diesem Tag geschlossen"
                >
                  <span class="sp-closed-label">geschlossen</span>
                </div>
              {:else if av !== "available"}
                <!-- 260601-g8l: vocational_school cells are click-to-remove for
                     ADMIN/MANAGER. For EMPLOYEE (and other availability buckets)
                     the cell stays a plain non-interactive label — role="button"
                     and tabindex are conditionally omitted so screen readers
                     don't announce a misleading affordance. The dndzone wrapper
                     is INTENTIONALLY not added here — drop-targeting was already
                     rejected client-side in onCellFinalize (Phase 63 D-20), so
                     keeping this branch as a passive cell preserves the existing
                     drag-to-add semantics untouched. -->
                {#if av === "vocational_school" && canRemoveVs}
                  <div
                    class="shift-cell sp-cell sp-cell--unavailable sp-cell--vs-removable"
                    role="button"
                    tabindex={0}
                    title="Berufsschultag entfernen"
                    onclick={() => onVocationalSchoolCellClick(u.id, iso)}
                    onkeydown={(e) => onVocationalSchoolCellKeydown(e, u.id, iso)}
                  >
                    <span class={availClass(av)}>{availLabel(av)}</span>
                  </div>
                {:else}
                  <div class="shift-cell sp-cell sp-cell--unavailable">
                    <span class={availClass(av)}>{availLabel(av)}</span>
                  </div>
                {/if}
              {:else if isPastDay(iso)}
                <!-- Phase 47.2 — Past day, empty: no drag-target, no assign. -->
                <div
                  class="shift-cell sp-cell off sp-cell--past"
                  title="Vergangenheit – nicht änderbar"
                >
                  <span class="sp-past-dash" aria-hidden="true">—</span>
                </div>
              {:else}
                <!-- Empty available cell: drop-target only, NOT a drag-source.
                     v1.7.4 hotfix — when the day falls in a SchoolHolidayPeriod
                     the cell is tinted (sp-cell--holiday) + a small "Ferien"
                     badge surfaces with the holiday name as tooltip. Cell stays
                     a drop-target — Ferien is informational, not blocking. -->
                <div
                  class="shift-cell sp-cell off sp-cell--drop-target"
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
                    onclick={() => onCellClick(u.id, iso)}
                    aria-label="Schicht zuweisen"
                    disabled={dropPending === cellKey}
                  >
                    {dropPending === cellKey ? "speichere …" : "frei"}
                  </button>
                  {#each cellItems(cellKey) as item (item.id)}
                    <!-- Hidden placeholder while drag is hovering; svelte-dnd-action
                         renders the actual ghost in the document body via
                         .dnd-action-dragged-el. -->
                    <span style="display: none" data-dropped-id={item.id}></span>
                  {/each}
                </div>
              {/if}
            {/each}
            {#if sollRowByEmp.has(u.id)}
              {@const sr = sollRowByEmp.get(u.id)!}
              {@const reductionH = sr.leaveH + sr.absenceH}
              <div
                class="sp-soll-label"
                aria-label="Soll-Korrelation für {u.firstName} {u.lastName}"
              >
                <div
                  class="sp-soll-sublabel"
                  title="Soll = Ø-Methode − Urlaub/Abwesenheit/Feiertag + Berufsschule (Berufsschule zählt als erfüllte Arbeitszeit)"
                >
                  ↳ Soll-Korrelation
                </div>
              </div>
              <div
                class="sp-soll-cell sp-soll-cell--{sr.klass}"
                class:sp-soll-cell--under-coverage={sr.underCoverage}
                title="{u.firstName} {u.lastName}: Σ {formatHours(sr.assignedH)}h ({formatHours(
                  sr.shiftH,
                )}h Schicht{sr.bsH > 0
                  ? ` + ${formatHours(sr.bsH)}h Berufsschule`
                  : ''}), Soll {formatHours(sr.contractSollH)}h{reductionH > 0
                  ? ` (${formatHours(sr.weeklyH)}h − ${formatHours(
                      reductionH,
                    )}h Urlaub/Abwesenheit)`
                  : ''}, Abweichung {sr.diff >= 0 ? '+' : ''}{formatHours(sr.diff)}h"
              >
                <span class="sp-soll-num">Σ {formatHours(sr.assignedH)}h</span>
                {#if reductionH > 0}
                  <span class="sp-soll-soll">
                    / Soll {formatHours(sr.contractSollH)}h
                    <small class="sp-soll-reduction">
                      ({formatHours(sr.weeklyH)}h − {formatHours(reductionH)}h Urlaub/Abwesenheit)
                    </small>
                  </span>
                {:else}
                  <span class="sp-soll-soll">/ Soll {formatHours(sr.contractSollH)}h</span>
                {/if}
                <span class="sp-soll-diff">
                  {sr.diff >= 0 ? "+" : "−"}{formatHours(Math.abs(sr.diff))}h
                </span>
                {#if sr.underCoverage}
                  <span
                    class="sp-soll-under-coverage"
                    aria-label="Unterdeckung: {u.firstName} {u.lastName}"
                  >
                    ↓ Unterdeckung: Soll {formatHours(sr.contractSollH)}h − geplant {formatHours(
                      sr.geplantH,
                    )}h = {formatHours(sr.gapH)}h unterplant
                  </span>
                {/if}
              </div>
            {/if}
          {/each}

          <!-- Coverage heatmap row -->
          <div class="sp-coverage-label">Coverage</div>
          {#each week.weekDays as d (d)}
            {@const iso = d.slice(0, 10)}
            {@const c = coverageByDate.get(iso)}
            <div
              class="sp-coverage-cell"
              class:sp-coverage-cell--ok={c?.coverageStatus === "ok"}
              class:sp-coverage-cell--under={c?.coverageStatus === "under"}
              class:sp-coverage-cell--supervision={c?.coverageStatus === "supervision-missing"}
              title={coverageTooltip(c)}
            >
              {#if c}
                <div class="sp-coverage-num">
                  {c.effectiveStaff.toFixed(2)} / {c.minStaff.toFixed(2)}
                </div>
                {#if c.coverageStatus === "supervision-missing"}
                  <span class="sp-coverage-warn" aria-label="Aufsicht fehlt">⚠ Aufsicht</span>
                {:else if c.coverageStatus === "under"}
                  <span class="sp-coverage-warn" aria-label="Unterbesetzt">⚠ Bedarf</span>
                {:else}
                  <span class="sp-coverage-ok">OK</span>
                {/if}
              {:else}
                <span class="sp-coverage-num">—</span>
              {/if}
            </div>
          {/each}
        </div>

        <p class="sp-legend">
          Coverage = Σ Schicht-Gewicht der verfügbaren zugewiesenen MA. Default Min = 2.0 (oder
          Bedarfsregel aus Schicht-Konfiguration).
        </p>
      {/if}
    </div>
  </Card>

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
  <Modal bind:open={generateOpen} eyebrow="Schichtplanung" title="Woche generieren">
    {#if generating && !generateDiff}
      <div class="state-msg">Vorschau wird erstellt …</div>
    {:else if generateError}
      <div class="callout error" role="alert">{generateError}</div>
    {:else if generateDiff}
      <p class="sp-gen-intro">
        Vorschau für Woche ab <strong>{generateDiff.weekStart}</strong>. Es werden
        <strong>{generateDiff.create.length}</strong>
        Schicht(en) erstellt; <strong>{generateDiff.skip.length}</strong> Eintrag/Einträge werden übersprungen.
      </p>

      {#if generateDiff.create.length > 0}
        <h3 class="sp-gen-h">Zu erstellen ({generateDiff.create.length})</h3>
        <div class="sp-gen-list">
          {#each generateDiff.create as c (`${c.employeeId}::${c.date}`)}
            <div class="sp-gen-row">
              <span class="sp-gen-emp">{empName(c.employeeId)}</span>
              <span class="sp-gen-date">{c.date}</span>
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
              <span class="sp-gen-date">{s.date}</span>
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
              <span class="sp-gen-date">{c.date}</span>
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
              <span class="sp-gen-date">{s.date}</span>
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
  .sp-template-strip {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    margin-bottom: 18px;
  }
  .sp-tpl-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .sp-tpl-text {
    min-width: 0;
  }
  .sp-tpl-eyebrow {
    font-size: 13px;
  }
  .sp-tpl-name {
    font-family: var(--font-serif);
    font-size: 20px;
    font-weight: 400;
    margin-top: 4px;
    color: var(--text);
  }
  .sp-tpl-time {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  /* Card-Wrapper-Padding ist auf 0 gesetzt, damit der Header sein eigenes
     18px/24px-Padding besitzt — identisch zu .cal-monthbar / .month-bar. */
  :global(.week-card) {
    padding: 0;
  }
  .week-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .week-header-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }
  .week-header-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 200px;
    text-align: center;
  }
  .week-header-eyebrow {
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }
  .week-header-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 26px;
    line-height: 1.1;
    letter-spacing: 0.005em;
    color: var(--text);
    text-transform: capitalize;
    white-space: nowrap;
  }
  .week-header-today {
    margin-left: 4px;
  }
  .week-header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .week-body {
    padding: 18px;
  }
  .state-msg {
    padding: 40px;
    text-align: center;
    color: var(--text-muted);
  }
  .head-date {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--text);
    margin-top: 2px;
  }

  /* Per-cell availability dimming + badges */
  .sp-cell--unavailable {
    background: var(--bg-subtle);
    opacity: 0.85;
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
    background: var(--bg-card);
    border: 1px solid color-mix(in srgb, var(--shift-blue) 30%, transparent);
    pointer-events: none;
    z-index: 1;
  }
  /* Hide the badge on narrow viewports — the cell tint alone communicates
     Schulferien without crowding the assign affordance. Tooltip still works. */
  @media (max-width: 720px) {
    .sp-holiday-badge {
      display: none;
    }
  }
  .sp-avail-badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: var(--r-pill);
    font-size: 11.5px;
    font-weight: 500;
    background: var(--bg-card);
    color: var(--text-muted);
    border: 1px solid var(--border);
  }
  .sp-avail-badge--vacation {
    color: var(--brand);
    border-color: var(--brand-soft);
  }
  .sp-avail-badge--sick {
    color: var(--bad);
    border-color: var(--bad);
  }
  .sp-avail-badge--special {
    color: var(--warn);
    border-color: var(--warn);
  }
  .sp-avail-badge--other {
    color: var(--text-muted);
  }
  /* Phase 63 D-20 — brand-tinted Berufsschule badge with lock icon. v1.5
     tokens only; renders inside the existing .sp-cell--unavailable cell. */
  .sp-avail-badge--vocational-school {
    background: var(--brand-soft);
    color: var(--brand);
    border-color: var(--border);
    font-weight: 600;
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
    border-radius: var(--r-sm);
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

  /* Empty-cell button (renders as text "frei" but is keyboard-focusable) */
  .sp-cell-empty {
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 13px;
    padding: 6px 10px;
    width: 100%;
    height: 100%;
    border-radius: var(--r-sm);
  }
  .sp-cell-empty:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }

  .sp-shift-pill {
    border: none;
    cursor: pointer;
    transition: opacity 0.12s var(--ease);
  }
  .sp-shift-pill:hover {
    opacity: 0.78;
  }
  /* Phase 43-04: shift marked conflictsWithLeave by the reverse-hook */
  .sp-shift-pill--conflict {
    outline: 2px solid var(--bad);
    outline-offset: -2px;
    background: color-mix(in srgb, var(--bad) 18%, transparent);
    color: var(--text);
    font-weight: 700;
  }

  /* Coverage heatmap row */
  .sp-coverage-label {
    grid-column: 1;
    font-weight: 600;
    font-size: 12.5px;
    color: var(--text-muted);
    padding: 12px 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-top: 2px solid var(--border);
  }
  .sp-coverage-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 10px 6px;
    border-radius: var(--r-sm);
    border-top: 2px solid var(--border);
    text-align: center;
    font-size: 12px;
  }
  .sp-coverage-cell--ok {
    background: color-mix(in srgb, var(--good) 12%, transparent);
    color: var(--good);
  }
  .sp-coverage-cell--under,
  .sp-coverage-cell--supervision {
    background: color-mix(in srgb, var(--bad) 14%, transparent);
    color: var(--bad);
  }
  .sp-coverage-num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .sp-coverage-warn {
    font-size: 11px;
    font-weight: 600;
  }
  .sp-coverage-ok {
    font-size: 11px;
    font-weight: 600;
  }

  .sp-legend {
    margin: 12px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    font-style: italic;
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
  .sp-gen-h {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 16px 0 8px;
  }
  .sp-gen-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 8px;
    background: var(--bg-subtle);
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
    border-radius: var(--r-sm);
  }
  .sp-gen-row:hover {
    background: var(--bg-card);
  }
  .sp-gen-emp {
    font-weight: 600;
    color: var(--text);
  }
  .sp-gen-date {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .sp-gen-time {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
  }
  .sp-gen-label {
    font-size: 12.5px;
    color: var(--text-muted);
    font-style: italic;
  }
  .sp-gen-reason {
    font-size: 11.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--r-sm);
    background: var(--bg-card);
    color: var(--text-muted);
    border: 1px solid var(--border);
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
    color: var(--text-muted);
  }
  .sp-gen-reason--open-day {
    color: var(--text-muted);
    font-style: italic;
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

  /* Phase 45: SHIFT_BASED Soll-Row */
  .sp-soll-label {
    padding: 8px 8px 12px;
    border-top: 2px solid var(--border-strong);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .sp-soll-label .name {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text);
  }
  .sp-soll-sublabel {
    margin-top: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .sp-soll-cell {
    grid-column: 2 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 8px 16px;
    border-radius: var(--r-sm);
    border-top: 2px solid var(--border-strong);
    font-size: 13px;
  }
  .sp-soll-num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 12.5px;
  }
  .sp-soll-soll {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .sp-soll-diff {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 12.5px;
  }
  .sp-soll-cell--ok {
    background: color-mix(in srgb, var(--good) 12%, transparent);
    color: var(--good);
  }
  .sp-soll-cell--warn {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
  }
  .sp-soll-cell--bad {
    background: color-mix(in srgb, var(--bad) 14%, transparent);
    color: var(--bad);
  }
  /* Phase 76.23 — Unterdeckung (per-employee under-coverage vs contract Soll).
     Visually distinct from the per-day Coverage row (.sp-coverage-cell--under)
     which signals demand-slot Unterbesetzung (D-06). Uses --warn accent with a
     left border accent so the operator distinguishes "this employee is under-rostered
     vs their contract" from "this time-slot has too few people". */
  .sp-soll-cell--under-coverage {
    border-left: 3px solid var(--warn);
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .sp-soll-under-coverage {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    border-radius: var(--r-sm);
    padding: 2px 8px;
    margin-top: 2px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 640px) {
    .sp-soll-label,
    .sp-soll-cell {
      display: none;
    }
  }

  /* Phase 47.5 — Closed-day cells: striped background + label */
  .sp-cell--closed {
    background: repeating-linear-gradient(
      45deg,
      var(--bg-subtle),
      var(--bg-subtle) 6px,
      transparent 6px,
      transparent 12px
    );
    cursor: not-allowed;
  }
  .sp-cell--closed .sp-closed-label {
    display: block;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-style: italic;
    user-select: none;
  }

  /* Phase 47.2 — Past day cells: visually dimmed, not interactive */
  .sp-cell--past {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .sp-cell--past .sp-past-dash {
    display: block;
    text-align: center;
    color: var(--text-muted);
    font-size: 1.25rem;
    user-select: none;
  }
  .sp-cell--past .sp-shift-pill {
    cursor: default;
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
    color: var(--text-muted);
    line-height: 1.5;
  }
  .sp-empty-sub a {
    color: var(--brand);
    text-decoration: underline;
  }
</style>
