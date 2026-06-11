<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import MonthBar from "$components/ui/MonthBar.svelte";
  import type { MonthBarStat } from "$components/ui/MonthBar.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import {
    format,
    startOfMonth,
    endOfMonth,
    addMonths,
    subMonths,
    startOfWeek,
    endOfWeek,
  } from "date-fns";
  import { de } from "date-fns/locale";
  import {
    isWorkDay,
    getDayExpectedHours,
    countWorkingDaysInMonth,
  } from "$lib/utils/work-schedule";

  interface Break {
    id?: string;
    startTime: string;
    endTime: string;
  }

  interface TimeEntry {
    id: string;
    date: string;
    startTime: string;
    endTime: string | null;
    breakMinutes: number;
    breaks?: Break[];
    type: string;
    source: "NFC" | "MOBILE" | "MANUAL" | "CORRECTION";
    note: string | null;
    isInvalid?: boolean;
    invalidReason?: string | null;
    isLocked?: boolean;
  }

  interface WorkSchedule {
    type?: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
    monthlyHours?: number | null;
    mondayHours: string | number;
    tuesdayHours: string | number;
    wednesdayHours: string | number;
    thursdayHours: string | number;
    fridayHours: string | number;
    saturdayHours: string | number;
    sundayHours: string | number;
    workDays?: number[];
  }

  type CalStatus =
    | "future"
    | "today-ok"
    | "today-partial"
    | "today-empty"
    | "ok"
    | "partial"
    | "missing"
    | "noExpect"
    | "absence";

  interface CalDay {
    date: Date;
    dateStr: string;
    dayNum: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isFuture: boolean;
    isWeekend: boolean;
    isHoliday: boolean;
    holidayName: string;
    expectedMin: number;
    workedMin: number;
    hasEntries: boolean;
    status: CalStatus;
    absenceType: string | null;
    absenceHalf: boolean;
    isBeforeHire: boolean;
    // bs-tage-in-calendar — Berufsschultag marker for the visible day. Mutually
    // exclusive in the cell label with absenceType (regular absence wins), but
    // both can be true in data (e.g. half-day vacation falling on a BS day).
    isVocationalSchool: boolean;
  }

  interface PublicHoliday {
    id: string;
    date: string;
    name: string;
  }

  interface Absence {
    id: string;
    startDate: string;
    endDate: string;
    typeCode: string;
    halfDay: boolean;
  }

  // 260611-ly6 — BS-Absences (Berufsschultage) from GET /vocational-school/upcoming.
  // Rendered as read-only rows in the list view; lifecycle stays on /shifts. Backend
  // (route handler) enforces self-scope for EMPLOYEE callers — no ?employeeId param.
  interface BsAbsence {
    id: string;
    employeeId: string;
    date: string; // YYYY-MM-DD
    source: "PATTERN" | "MANUAL";
  }

  // Discriminated union for the merged list view (TimeEntry + BsAbsence).
  type ListRow =
    | (TimeEntry & { kind: "TE" })
    | { kind: "BS"; id: string; date: string; source: "PATTERN" | "MANUAL" };

  interface ArbZGWarning {
    code: string;
    severity: "warning" | "error";
    message: string;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let entries: TimeEntry[] = $state([]);
  let schedule: WorkSchedule | null = $state(null);
  let holidays: Map<string, string> = $state(new Map()); // dateStr → name
  let calendarDays: CalDay[] = $state([]);
  let loading = $state(false);
  let error = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let arbzgEnabled = $state(true);
  let monthlyHoursHolidayDeduction = $state(false);

  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  let calMonth = $state(new Date(today.getFullYear(), today.getMonth(), 1));
  let fromDate = format(startOfMonth(today), "yyyy-MM-dd");
  let toDate = format(endOfMonth(today), "yyyy-MM-dd");

  // Ausgewählter Tag
  let selectedDate = $state(todayStr);

  let deleteConfirmId = $state("");
  let absences: Absence[] = $state([]);
  // 260611-ly6 — BS-Tage (Berufsschultage) merged into the list view client-side.
  // Self-scope is enforced server-side from req.user.employeeId.
  let bsAbsences: BsAbsence[] = $state([]);
  let overtimeTotalHours: number | null = $state(null);
  let hireDate: string | null = $state(null); // YYYY-MM-DD oder null
  let shiftMinByDate: Map<string, number> = $state(new Map()); // v1.8.8 — SHIFT_BASED Soll per dateStr
  // Phase 76.7 (D-16, UI-V19-04) — § 18 ArbZG-exempt: hide the
  // "+ Neuer Eintrag" CTA + the per-day calendar-cell add handler.
  // Existing entries (if any) continue to display normally. Read from
  // the existing GET /employees/:id payload (Plan 02 exposed the field).
  let isExempt = $state(false);
  let teView = $state<"calendar" | "list">("calendar");

  // Modal
  let modalOpen = $state(false);
  let editEntry: TimeEntry | null = $state(null);
  let formDate = $state(todayStr);
  let formStart = $state("09:00");
  let formEnd = $state("17:00");
  let formHasEnd = $state(true);
  let formBreaks = $state<{ start: string; end: string }[]>([]);
  let formBreakTotal = $derived(
    formBreaks.reduce((sum, b) => {
      if (!b.start || !b.end) return sum;
      const [sh, sm] = b.start.split(":").map(Number);
      const [eh, em] = b.end.split(":").map(Number);
      const diff = eh * 60 + em - (sh * 60 + sm);
      return sum + (diff > 0 ? diff : 0);
    }, 0),
  );
  let formNetMin = $derived.by(() => {
    if (!formHasEnd || !formStart || !formEnd) return null;
    const [sh, sm] = formStart.split(":").map(Number);
    const [eh, em] = formEnd.split(":").map(Number);
    const gross = eh * 60 + em - (sh * 60 + sm);
    if (gross <= 0) return 0;
    return Math.max(0, gross - formBreakTotal);
  });
  let formNote = $state("");
  let defaultBreakStart: string | null = $state(null);

  const ownEmployeeId = $authStore.user?.employeeId ?? null;

  // ── Laden ─────────────────────────────────────────────────────────────────
  onMount(async () => {
    // Read URL params
    const viewParam = $page.url.searchParams.get("view");
    if (viewParam === "list") teView = "list";
    const dateParam = $page.url.searchParams.get("date");
    if (dateParam) {
      selectedDate = dateParam;
      calMonth = new Date(dateParam + "T12:00:00");
      fromDate = format(startOfMonth(calMonth), "yyyy-MM-dd");
      toDate = format(endOfMonth(calMonth), "yyyy-MM-dd");
    }

    await loadAll();
  });

  async function loadAll() {
    loading = true;
    error = "";
    try {
      const year = calMonth.getFullYear();
      const activeEmpId = ownEmployeeId;
      const [
        rawEntries,
        rawSchedule,
        rawHolidays,
        rawAbsences,
        rawOvertime,
        rawEmployee,
        rawConfig,
        rawBsAbsences,
      ] = await Promise.all([
        api.get<TimeEntry[]>(`/time-entries?from=${fromDate}&to=${toDate}`),
        activeEmpId
          ? api.get<WorkSchedule>(`/settings/work/${activeEmpId}`).catch(() => null)
          : Promise.resolve(null),
        api.get<PublicHoliday[]>(`/holidays?year=${year}`).catch(() => [] as PublicHoliday[]),
        activeEmpId
          ? api
              .get<Absence[]>(`/leave/requests?status=APPROVED&employeeId=${activeEmpId}`)
              .catch(() => [] as Absence[])
          : Promise.resolve([] as Absence[]),
        activeEmpId
          ? api.get<{ balanceHours: number }>(`/overtime/${activeEmpId}`).catch(() => null)
          : Promise.resolve(null),
        activeEmpId
          ? api
              .get<{
                hireDate?: string;
                isTimeTrackingExempt?: boolean;
              }>(`/employees/${activeEmpId}`)
              .catch(() => null)
          : Promise.resolve(null),
        api
          .get<{
            arbzgEnabled?: boolean;
            defaultBreakStart?: string | null;
            monthlyHoursHolidayDeduction?: boolean;
          }>("/settings/work")
          .catch(() => null),
        // 260611-ly6 — own Berufsschultage (BS) for the current window.
        // The backend (vocational-school.ts) forces self-scope for EMPLOYEE callers
        // from req.user.employeeId — we deliberately omit ?employeeId here as belt
        // and suspenders. Failure tolerated (empty array) so the rest of the page
        // renders. Skipped entirely when activeEmpId is null (user without
        // linked employee row).
        activeEmpId
          ? api
              .get<BsAbsence[]>(`/vocational-school/upcoming?from=${fromDate}&to=${toDate}`)
              .catch(() => [] as BsAbsence[])
          : Promise.resolve([] as BsAbsence[]),
      ]);
      entries = rawEntries;
      schedule = rawSchedule;
      holidays = new Map(rawHolidays.map((h) => [h.date.split("T")[0], h.name]));
      absences = rawAbsences;
      bsAbsences = rawBsAbsences;
      overtimeTotalHours = rawOvertime ? Number(rawOvertime.balanceHours) : null;
      hireDate = rawEmployee?.hireDate ? rawEmployee.hireDate.split("T")[0] : null;
      // Phase 76.7 (D-16) — read isTimeTrackingExempt from the SAME fetch
      // (no extra round-trip). Fail-SAFE to false on missing field so a
      // stale cache or pre-Plan-02 backend never accidentally locks a
      // non-exempt user out of time-entry creation.
      isExempt = rawEmployee?.isTimeTrackingExempt === true;
      arbzgEnabled = rawConfig?.arbzgEnabled !== false;
      defaultBreakStart = rawConfig?.defaultBreakStart ?? null;
      monthlyHoursHolidayDeduction = rawConfig?.monthlyHoursHolidayDeduction === true;
      // v1.8.8 — fetch Shift rows for SHIFT_BASED so the calendar can render Soll.
      // EMPLOYEE role: no employeeId param — endpoint defaults to req.user.employeeId.
      // SHIFT_BASED removed from monthly-path shortcut: the workaround (monthly=true
      // with zero monthlyHours) produced expectedMin=0 anyway, and now conflicts with
      // the shiftMinByDate injection path.
      if (schedule?.type === "SHIFT_BASED") {
        const rawShifts = await api
          .get<
            Array<{ date: string; durationMin: number; durationMinNetto: number }>
          >(`/shifts/range?from=${fromDate}&to=${toDate}`)
          .catch(
            () => [] as Array<{ date: string; durationMin: number; durationMinNetto: number }>,
          );
        const m = new Map<string, number>();
        for (const s of rawShifts) {
          // v1.8.9 — Soll = netto (brutto − getEffectiveBreakDuration on the server).
          // Compares apples-to-apples against IST (worked minutes already netto in sumWorked).
          m.set(s.date, (m.get(s.date) ?? 0) + s.durationMinNetto);
        }
        shiftMinByDate = m;
      } else {
        shiftMinByDate = new Map();
      }
      calendarDays = buildCalendarDays(
        calMonth,
        entries,
        schedule,
        holidays,
        absences,
        hireDate,
        schedule?.type === "MONTHLY_HOURS" || schedule?.type === "FLEXTIME",
        shiftMinByDate,
        bsAbsences,
      );
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  let showMonthPicker = $state(false);
  let pickerYear = $state(new Date().getFullYear());

  async function gotoMonth(dir: 1 | -1) {
    calMonth = dir === 1 ? addMonths(calMonth, 1) : subMonths(calMonth, 1);
    fromDate = format(startOfMonth(calMonth), "yyyy-MM-dd");
    toDate = format(endOfMonth(calMonth), "yyyy-MM-dd");
    selectedDate = fromDate;
    await loadAll();
  }

  async function gotoMonthYear(m: number, y: number) {
    calMonth = new Date(y, m - 1, 1);
    fromDate = format(startOfMonth(calMonth), "yyyy-MM-dd");
    toDate = format(endOfMonth(calMonth), "yyyy-MM-dd");
    selectedDate = fromDate;
    showMonthPicker = false;
    await loadAll();
  }

  async function gotoToday() {
    const now = new Date();
    calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    fromDate = format(startOfMonth(calMonth), "yyyy-MM-dd");
    toDate = format(endOfMonth(calMonth), "yyyy-MM-dd");
    selectedDate = format(now, "yyyy-MM-dd");
    showMonthPicker = false;
    await loadAll();
  }

  const MONTH_NAMES_SHORT = [
    "Jan",
    "Feb",
    "Mär",
    "Apr",
    "Mai",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Okt",
    "Nov",
    "Dez",
  ];

  // ── Kalender-Tage aufbauen ─────────────────────────────────────────────────
  function buildCalendarDays(
    monthStart: Date,
    entries: TimeEntry[],
    sched: WorkSchedule | null,
    hols: Map<string, string>,
    absenceList: Absence[],
    hireDateStr: string | null = null,
    monthly: boolean = false,
    shiftMinByDate: Map<string, number> = new Map(), // v1.8.8 — sum of durationMin per dateStr for SHIFT_BASED
    bsAbsenceList: BsAbsence[] = [], // bs-tage-in-calendar — Berufsschultage to mark in the calendar
  ): CalDay[] {
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const key = (e.date ?? e.startTime).split("T")[0];
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(e);
    }

    // bs-tage-in-calendar — Berufsschultage als Set<dateStr> für O(1) Lookup
    // im makeCalDay-Loop. BsAbsence ist per definitionem single-day; kein
    // Range-Walk wie bei regular Absences nötig.
    const bsByDate = new Set<string>(bsAbsenceList.map((b) => b.date));

    // Abwesenheitstage auflösen: Datumsbereich → Map<dateStr, {type, half}>
    const absenceByDate = new Map<string, { type: string; half: boolean }>();
    for (const abs of absenceList) {
      const start = new Date(abs.startDate.split("T")[0]);
      const end = new Date(abs.endDate.split("T")[0]);
      const cur = new Date(start);
      while (cur <= end) {
        absenceByDate.set(format(cur, "yyyy-MM-dd"), { type: abs.typeCode, half: abs.halfDay });
        cur.setDate(cur.getDate() + 1);
      }
    }

    // For MONTHLY_HOURS: detect whether any per-day hours are configured.
    // When none are set (pure flexible Minijobber), treat Mon-Fri as workdays.
    const hasPerDayHours =
      monthly && sched
        ? ["mondayHours", "tuesdayHours", "wednesdayHours", "thursdayHours", "fridayHours"].some(
            (k) => Number(sched[k as keyof WorkSchedule] ?? 0) > 0,
          )
        : false;

    let dailySollMin = 0;
    if (monthly && sched) {
      const monthlyBudgetMin = Number(sched.monthlyHours ?? 0) * 60;
      if (monthlyBudgetMin > 0) {
        // Phase 15: holiday deduction logic for MONTHLY_HOURS.
        //
        // Toggle ON  (monthlyHoursHolidayDeduction=true):
        //   dailySollMin = budget / totalWorkdays  (fixed rate)
        //   Holiday days get expectedMin=0 → total reduces by holiday count × dailySollMin
        //   Matches backend: shouldMin = budget - sum(dailySollMin per holiday on workday)
        //
        // Toggle OFF:
        //   dailySollMin = budget / (totalWorkdays - holidayWorkdays)  (redistribution)
        //   Holiday days still get expectedMin=0, but the higher daily rate compensates
        //   → totalMonthExpected stays at full budget
        //
        // For flexible Minijobber (no per-day hours): treat Mon-Fri as workdays.

        // Identify qualifying holiday dates (holidays falling on configured workdays)
        const qualifyingHolidayDates = [...hols.keys()].filter((dateStr) => {
          const d = new Date(dateStr + "T12:00:00");
          if (hasPerDayHours) return isWorkDay(sched, d);
          const dow = d.getDay();
          return dow >= 1 && dow <= 5;
        });

        // When toggle is ON: use ALL workdays as denominator (holidays will zero out their days)
        // When toggle is OFF: exclude holidays from denominator so total redistributes to full budget
        const excludeForDenom = monthlyHoursHolidayDeduction ? [] : qualifyingHolidayDates;

        let workingDays: number;
        if (hasPerDayHours) {
          workingDays = countWorkingDaysInMonth(sched, monthStart, excludeForDenom);
        } else {
          // Flexible Minijobber: count Mon-Fri days in month
          const excludeSet = new Set(excludeForDenom);
          workingDays = 0;
          const end = endOfMonth(monthStart);
          const cur = new Date(monthStart);
          while (cur <= end) {
            const dow = cur.getDay();
            if (dow >= 1 && dow <= 5 && !excludeSet.has(format(cur, "yyyy-MM-dd"))) workingDays++;
            cur.setDate(cur.getDate() + 1);
          }
        }
        if (workingDays > 0) dailySollMin = Math.round(monthlyBudgetMin / workingDays);
      }
    }

    const monthEnd = endOfMonth(monthStart);
    const firstDow = (monthStart.getDay() + 6) % 7;
    const lastDow = (monthEnd.getDay() + 6) % 7;
    const days: CalDay[] = [];

    for (let i = firstDow - 1; i >= 0; i--) {
      const d = new Date(monthStart);
      d.setDate(d.getDate() - i - 1);
      days.push(
        makeCalDay(
          d,
          false,
          byDate,
          sched,
          hols,
          absenceByDate,
          hireDateStr,
          monthly,
          dailySollMin,
          hasPerDayHours,
          shiftMinByDate,
          bsByDate,
        ),
      );
    }
    const cur = new Date(monthStart);
    while (cur <= monthEnd) {
      days.push(
        makeCalDay(
          new Date(cur),
          true,
          byDate,
          sched,
          hols,
          absenceByDate,
          hireDateStr,
          monthly,
          dailySollMin,
          hasPerDayHours,
          shiftMinByDate,
          bsByDate,
        ),
      );
      cur.setDate(cur.getDate() + 1);
    }
    const remaining = (7 - ((lastDow + 1) % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(monthEnd);
      d.setDate(d.getDate() + i);
      days.push(
        makeCalDay(
          d,
          false,
          byDate,
          sched,
          hols,
          absenceByDate,
          hireDateStr,
          monthly,
          dailySollMin,
          hasPerDayHours,
          shiftMinByDate,
          bsByDate,
        ),
      );
    }
    return days;
  }

  function makeCalDay(
    date: Date,
    isCurrentMonth: boolean,
    byDate: Map<string, TimeEntry[]>,
    sched: WorkSchedule | null,
    hols: Map<string, string>,
    absenceByDate: Map<string, { type: string; half: boolean }>,
    hireDateStr: string | null = null,
    monthly: boolean = false,
    dailySollMin: number = 0,
    hasPerDayHours: boolean = true,
    shiftMinByDate: Map<string, number> = new Map(), // v1.8.8 — SHIFT_BASED Soll override
    bsByDate: Set<string> = new Set(), // bs-tage-in-calendar — set of yyyy-MM-dd that are Berufsschultage
  ): CalDay {
    const dateStr = format(date, "yyyy-MM-dd");
    const isToday = dateStr === todayStr;
    const isFuture = dateStr > todayStr;
    const dow = date.getDay(); // 0=So, 6=Sa
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = hols.has(dateStr);
    const holidayName = hols.get(dateStr) ?? "";
    const slots = byDate.get(dateStr) ?? [];
    const workedMin = sumWorked(slots);
    const hasEntries = slots.length > 0;

    const absence = absenceByDate.get(dateStr);
    const absenceType = absence?.type ?? null;
    const absenceHalf = absence?.half ?? false;
    const isBeforeHire = hireDateStr ? dateStr < hireDateStr : false;

    // Soll-Stunden: Feiertage + ganztägige Abwesenheiten zählen nicht; Tage vor hireDate = 0
    // Bei MONTHLY_HOURS: dailySollMin auf konfigurierten Arbeitstagen setzen.
    // Flexible Minijobber (keine per-day Stunden): Mo-Fr als Arbeitstage annehmen.
    // v1.8.8 — SHIFT_BASED: expectedMin comes from Shift rows (D-03 returns 0 intentionally).
    let expectedMin: number;
    if (monthly) {
      const isWorkday = hasPerDayHours
        ? dailySollMin > 0 && sched && isWorkDay(sched, date)
        : dailySollMin > 0 && dow >= 1 && dow <= 5;
      expectedMin = isWorkday ? dailySollMin : 0;
    } else if (sched?.type === "SHIFT_BASED") {
      // Soll for SHIFT_BASED comes from Shift rows (D-03). Sum already done
      // when building the map (multi-shift days).
      expectedMin = shiftMinByDate.get(dateStr) ?? 0;
    } else {
      expectedMin = sched ? getDayExpectedHours(sched, date) * 60 : 0;
    }
    if (isBeforeHire) expectedMin = 0;
    if (isHoliday) expectedMin = 0;
    else if (absence && !absence.half) expectedMin = 0;
    else if (absence && absence.half) expectedMin = Math.round(expectedMin / 2);

    let status: CalStatus = "noExpect";
    if (isFuture) status = "future";
    else if (absence && !absence.half && !isFuture) status = "absence";
    else if (monthly) {
      // MONTHLY_HOURS: no per-day targets — only show whether worked, never "missing"
      if (isToday) status = hasEntries ? "today-ok" : "today-empty";
      else if (hasEntries) status = "noExpect";
      else status = "noExpect";
    } else if (isToday && !hasEntries) status = "today-empty";
    else if (isToday && workedMin >= expectedMin) status = "today-ok";
    else if (isToday) status = "today-partial";
    else if (!hasEntries && expectedMin > 0 && !isHoliday) status = "missing";
    else if (workedMin >= expectedMin && expectedMin > 0) status = "ok";
    else if (workedMin > 0) status = "partial";

    // bs-tage-in-calendar — Berufsschultag flag for this day. Single Set lookup;
    // independent of regular absenceType so half-day vacations on a BS day still
    // surface the BS marker for the cell when the regular absence does not paint
    // the cell (e.g. weekend BS, half-day vacation).
    const isVocationalSchool = bsByDate.has(dateStr);

    return {
      date,
      dateStr,
      dayNum: date.getDate(),
      isCurrentMonth,
      isToday,
      isFuture,
      isWeekend,
      isHoliday,
      holidayName,
      expectedMin,
      workedMin,
      hasEntries,
      status,
      absenceType,
      absenceHalf,
      isBeforeHire,
      isVocationalSchool,
    };
  }

  // ── Hilfsfunktionen ────────────────────────────────────────────────────────
  function sumWorked(slots: TimeEntry[]): number {
    return slots.reduce((sum, e) => {
      if (!e.endTime || e.isInvalid) return sum;
      return (
        sum +
        Math.floor((new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60000) -
        (e.breakMinutes ?? 0)
      );
    }, 0);
  }

  function fmtTime(iso: string | null): string {
    if (!iso) return "–";
    return format(new Date(iso), "HH:mm");
  }

  function fmtMin(min: number): string {
    const h = Math.floor(Math.abs(min) / 60);
    const m = Math.abs(min) % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  function fmtBalance(min: number): string {
    if (min === 0) return "±0:00";
    return (min > 0 ? "+" : "−") + fmtMin(Math.abs(min));
  }

  function balClass(min: number): string {
    if (min > 0) return "pos";
    if (min < 0) return "neg";
    return "";
  }

  function balTone(min: number): "pos" | "neg" | undefined {
    if (min > 0) return "pos";
    if (min < 0) return "neg";
    return undefined;
  }

  function absenceLabel(type: string): string {
    const labels: Record<string, string> = {
      VACATION: "Urlaub",
      SICK: "Krank",
      SPECIAL: "Sonderurlaub",
      OVERTIME_COMP: "Freizeitausgl.",
    };
    return labels[type] ?? type;
  }

  function sourceBadge(s: TimeEntry["source"]): string {
    return s === "NFC"
      ? "badge-purple"
      : s === "MOBILE"
        ? "badge-blue"
        : s === "CORRECTION"
          ? "badge-yellow"
          : "badge-gray";
  }
  function sourceLabel(s: TimeEntry["source"]): string {
    return s === "NFC"
      ? "NFC"
      : s === "MOBILE"
        ? "Mobil"
        : s === "CORRECTION"
          ? "Korrektur"
          : "Manuell";
  }

  function fmtBreaks(e: TimeEntry): string {
    if (e.breaks && e.breaks.length > 0) {
      return e.breaks.map((b) => `${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`).join(", ");
    }
    if (e.breakMinutes) return e.breakMinutes + " Min.";
    return "—";
  }

  function slotNet(e: TimeEntry): string {
    if (!e.endTime) return "läuft…";
    const net =
      Math.floor((new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60000) -
      (e.breakMinutes ?? 0);
    return net < 0 ? "–" : fmtMin(net) + " h";
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  function addMinutesToTime(time: string, minutes: number): string {
    const [h, m] = time.split(":").map(Number);
    const total = h * 60 + m + minutes;
    const nh = Math.floor(total / 60) % 24;
    const nm = total % 60;
    return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
  }

  function openAdd(forDate?: string) {
    const targetDate = forDate ?? selectedDate;
    // If an entry already exists for this day, open it for editing instead
    const existing = entries.find((e) => (e.date ?? e.startTime).split("T")[0] === targetDate);
    if (existing) {
      openEdit(existing);
      return;
    }
    editEntry = null;
    formDate = targetDate;
    formStart = "09:00";
    formEnd = "17:00";
    formHasEnd = true;
    if (defaultBreakStart) {
      formBreaks = [{ start: defaultBreakStart, end: addMinutesToTime(defaultBreakStart, 30) }];
    } else {
      formBreaks = [];
    }
    formNote = "";
    saveError = "";
    modalOpen = true;
  }

  function openEdit(entry: TimeEntry) {
    editEntry = entry;
    formDate = (entry.date ?? entry.startTime).split("T")[0];
    formStart = format(new Date(entry.startTime), "HH:mm");
    formHasEnd = !!entry.endTime;
    formEnd = entry.endTime ? format(new Date(entry.endTime), "HH:mm") : "17:00";
    if (entry.breaks && entry.breaks.length > 0) {
      formBreaks = entry.breaks.map((b) => ({
        start: format(new Date(b.startTime), "HH:mm"),
        end: format(new Date(b.endTime), "HH:mm"),
      }));
    } else {
      formBreaks = [];
    }
    formNote = entry.note ?? "";
    saveError = "";
    modalOpen = true;
  }

  function closeModal() {
    modalOpen = false;
    editEntry = null;
    deleteConfirmId = "";
  }

  // The Modal primitive owns Escape/backdrop dismiss: it flips modalOpen to
  // false directly via bind:open. Mirror closeModal's state reset so those
  // paths leave the page in the same state as the explicit Abbrechen button.
  $effect(() => {
    if (!modalOpen) {
      editEntry = null;
      deleteConfirmId = "";
    }
  });

  async function saveEntry() {
    saving = true;
    saveError = "";
    const startISO = new Date(`${formDate}T${formStart}:00`).toISOString();
    const endISO = formHasEnd ? new Date(`${formDate}T${formEnd}:00`).toISOString() : null;
    // Convert break slots to full ISO timestamps
    const breaksPayload = formBreaks
      .filter((b) => b.start && b.end)
      .map((b) => ({
        startTime: new Date(`${formDate}T${b.start}:00`).toISOString(),
        endTime: new Date(`${formDate}T${b.end}:00`).toISOString(),
      }));
    try {
      if (editEntry) {
        await api.put(`/time-entries/${editEntry.id}`, {
          date: formDate,
          startTime: startISO,
          endTime: endISO,
          breakMinutes: formBreakTotal,
          breaks: breaksPayload,
          note: formNote || null,
        });
      } else {
        await api.post("/time-entries", {
          date: formDate,
          startTime: startISO,
          endTime: endISO,
          breakMinutes: formBreakTotal,
          breaks: breaksPayload,
          note: formNote || null,
        });
      }
      closeModal();
      await loadAll();
    } catch (e: unknown) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 403) {
        saveError = "Monat ist gesperrt";
      } else {
        saveError = e instanceof Error ? e.message : "Fehler beim Speichern";
      }
    } finally {
      saving = false;
    }
  }

  async function deleteEntry(id: string) {
    try {
      await api.delete(`/time-entries/${id}`);
      deleteConfirmId = "";
      await loadAll();
    } catch (e: unknown) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 403) {
        error = "Monat ist gesperrt";
      } else {
        error = e instanceof Error ? e.message : "Fehler beim Löschen";
      }
    }
  }

  async function revalidateEntry(id: string) {
    try {
      await api.patch(`/time-entries/${id}/revalidate`, {});
      await loadAll();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Revalidieren";
    }
  }

  // D-06: Derive lock state from entry data already loaded — no extra API request
  let monthIsLocked = $derived(entries.some((e) => e.isLocked === true));

  // D-07: Set of date strings (yyyy-MM-dd) that have a locked entry — for calendar cell icons
  let lockedDateSet = $derived(
    new Set(entries.filter((e) => e.isLocked === true).map((e) => e.date.slice(0, 10))),
  );

  // ArbZG-Prüfung für den ausgewählten Tag (Frontend-seitig, sofort)
  function checkArbZGFrontend(slots: TimeEntry[]): ArbZGWarning[] {
    const warnings: ArbZGWarning[] = [];
    const done = slots.filter((s) => s.endTime && !s.isInvalid);
    if (done.length === 0) return [];

    const sorted = [...done].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );

    let netMin = 0,
      explicitBreak = 0;
    for (const s of sorted) {
      const slotMin = (new Date(s.endTime!).getTime() - new Date(s.startTime).getTime()) / 60000;
      explicitBreak += s.breakMinutes ?? 0;
      netMin += slotMin - (s.breakMinutes ?? 0);
    }
    let gapBreak = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap =
        (new Date(sorted[i].startTime).getTime() - new Date(sorted[i - 1].endTime!).getTime()) /
        60000;
      if (gap > 0 && gap <= 120) gapBreak += gap; // Lücken > 2h sind separate Schichten, keine Pausen
    }
    const totalBreak = explicitBreak + gapBreak;

    if (netMin > 9 * 60 && totalBreak < 45)
      warnings.push({
        code: "§ 4",
        severity: "error",
        message: `Bei über 9h Arbeitszeit mind. 45 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });
    else if (netMin > 6 * 60 && totalBreak < 30)
      warnings.push({
        code: "§ 4",
        severity: "warning",
        message: `Bei über 6h Arbeitszeit mind. 30 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });

    if (netMin > 10 * 60)
      warnings.push({
        code: "§ 3",
        severity: "error",
        message: `Tägliche Höchstarbeitszeit von 10h überschritten (${(netMin / 60).toFixed(1)}h)`,
      });

    return warnings;
  }

  // ── Reaktive Ableitungen ───────────────────────────────────────────────────
  let isMonthlyHours = $derived(schedule?.type === "MONTHLY_HOURS");
  // Phase 49.1 — schedule types without a fixed daily target: per-day +/- diff is meaningless
  let isNoDailyTarget = $derived(
    schedule?.type === "MONTHLY_HOURS" ||
      schedule?.type === "FLEXTIME" ||
      schedule?.type === "SHIFT_BASED",
  );
  let monthlyTarget = $derived(
    isMonthlyHours && schedule?.monthlyHours ? Number(schedule.monthlyHours) * 60 : 0,
  );
  let hasMonthlyTarget = $derived(isMonthlyHours && monthlyTarget > 0);
  // Full-month expected: sum of all current-month days' expectedMin (incl. future).
  // For MONTHLY_HOURS this reflects the holiday-deducted Soll when the toggle is ON,
  // because buildCalendarDays computes dailySollMin after excluding qualifying holidays.
  let totalMonthExpected = $derived(
    calendarDays.filter((d) => d.isCurrentMonth).reduce((s, d) => s + d.expectedMin, 0),
  );
  let mBalance = $derived(
    // For MONTHLY_HOURS with a monthly target: compare worked against the full month budget
    // (totalMonthExpected), not the partial daily accrual (totalExpected). Using totalExpected
    // would only count workdays up to today × dailySollMin (e.g. 8 × 45min = 6h instead of 15h).
    // For FIXED_SCHEDULE and no-target MONTHLY_HOURS: keep the up-to-today accrual.
    hasMonthlyTarget ? totalWorked - totalMonthExpected : totalWorked - totalExpected,
  );
  // Check if there are entries for today
  let hasTodayEntries = $derived(
    entries.some((e) => {
      const d = (e.date ?? e.startTime).split("T")[0];
      return d === todayStr && e.endTime && !e.isInvalid;
    }),
  );
  // Worked + Expected up to cutoff: today if clocked, yesterday otherwise
  let totalWorked = $derived(
    entries
      .filter((e) => {
        if (!e.endTime || e.isInvalid) return false;
        if (hasTodayEntries) return true;
        const d = (e.date ?? e.startTime).split("T")[0];
        return d < todayStr;
      })
      .reduce(
        (s, e) =>
          s +
          Math.floor((new Date(e.endTime!).getTime() - new Date(e.startTime).getTime()) / 60000) -
          (e.breakMinutes ?? 0),
        0,
      ),
  );
  let totalExpected = $derived(
    calendarDays
      .filter((d) => {
        if (!d.isCurrentMonth || d.isFuture) return false;
        if (hasTodayEntries) return true;
        return !d.isToday;
      })
      .reduce((s, d) => s + d.expectedMin, 0),
  );
  // Phase 49.1 — FLEXTIME weekly diff: sum this week's worked vs expected
  let weekWorkedMin = $derived.by((): number => {
    const weekStart = format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const weekEnd = format(endOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    return entries
      .filter((e) => {
        if (!e.endTime || e.isInvalid) return false;
        const d = (e.date ?? e.startTime).split("T")[0];
        return d >= weekStart && d <= weekEnd;
      })
      .reduce(
        (s, e) =>
          s +
          Math.floor((new Date(e.endTime!).getTime() - new Date(e.startTime).getTime()) / 60000) -
          (e.breakMinutes ?? 0),
        0,
      );
  });
  let weekExpectedMin = $derived.by((): number => {
    const weekStart = format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const weekEnd = format(endOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
    return calendarDays
      .filter((d) => d.dateStr >= weekStart && d.dateStr <= weekEnd && !d.isFuture)
      .reduce((s, d) => s + d.expectedMin, 0);
  });
  // Stat tiles for the MonthBar primitive — empty until a schedule loads.
  let monthBarStats: MonthBarStat[] = $derived.by(() => {
    if (!schedule) return [];
    const stats: MonthBarStat[] = [];
    if (!isMonthlyHours || hasMonthlyTarget) {
      stats.push({
        label: hasMonthlyTarget ? "Soll" : "Soll (bisher)",
        value: fmtMin(hasMonthlyTarget ? totalMonthExpected : totalExpected),
        unit: "h",
      });
    }
    stats.push({ label: "Ist", value: fmtMin(totalWorked), unit: "h" });
    // Phase 49.1 — FLEXTIME: show this week's worked vs expected diff in the bar
    if (schedule.type === "FLEXTIME" && weekExpectedMin > 0) {
      const weekDiff = weekWorkedMin - weekExpectedMin;
      stats.push({
        label: "Woche Saldo",
        value: fmtBalance(weekDiff),
        unit: "h",
        tone: balTone(weekDiff),
      });
    }
    if (isMonthlyHours && !hasMonthlyTarget) {
      stats.push({ label: "Monat-Saldo", value: fmtMin(totalWorked), unit: "h" });
    } else {
      stats.push({
        label: "Monat-Saldo",
        value: fmtBalance(mBalance),
        unit: "h",
        tone: balTone(mBalance),
      });
    }
    if (overtimeTotalHours !== null) {
      const totalMin = Math.round(overtimeTotalHours * 60);
      stats.push({
        label: "Gesamt-Saldo",
        value: fmtBalance(totalMin),
        unit: "h",
        tone: balTone(totalMin),
      });
    }
    return stats;
  });
  // ArbZG live check for the modal: existing entries for formDate + current form values
  let modalWarnings = $derived.by(() => {
    if (!arbzgEnabled || !modalOpen || !formHasEnd || !formStart || !formEnd) return [];
    const otherSlots = entries
      .filter((e) => (e.date ?? e.startTime).split("T")[0] === formDate)
      .filter((e) => !editEntry || e.id !== editEntry.id);
    const formEntry = {
      id: "__form__",
      startTime: `${formDate}T${formStart}:00`,
      endTime: `${formDate}T${formEnd}:00`,
      breakMinutes: formBreakTotal,
    } as TimeEntry;
    return checkArbZGFrontend([...otherSlots, formEntry]);
  });
  // ArbZG-Verstoß-Map: dateStr → warnings[]
  let arbzgDayMap = $derived.by(() => {
    if (!arbzgEnabled) return new Map<string, ArbZGWarning[]>();
    const map = new Map<string, ArbZGWarning[]>();
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const d = (e.date ?? e.startTime).split("T")[0];
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(e);
    }
    for (const [dateStr, dayEntries] of byDate) {
      const warnings = checkArbZGFrontend(dayEntries);
      if (warnings.length > 0) map.set(dateStr, warnings);
    }
    return map;
  });

  // All entries for the current month, sorted by date descending then start time descending.
  // 260611-ly6 — merges TimeEntries (kind="TE") with own BS-Absences (kind="BS")
  // for the list view. BS rows are read-only synthetic rows; lifecycle stays on
  // /shifts. Self-scope is enforced server-side from req.user.employeeId.
  let allEntries = $derived.by<ListRow[]>(() => {
    const teRows: ListRow[] = entries.map((e) => ({ ...e, kind: "TE" as const }));
    const bsRows: ListRow[] = bsAbsences.map((b) => ({
      kind: "BS" as const,
      // Prefix with "bs-" so the {#each} key cannot collide with a TimeEntry UUID.
      id: `bs-${b.id}`,
      date: b.date,
      source: b.source,
    }));
    return [...teRows, ...bsRows].sort((a, b) => {
      const dA = a.kind === "TE" ? (a.date ?? a.startTime).split("T")[0] : a.date;
      const dB = b.kind === "TE" ? (b.date ?? b.startTime).split("T")[0] : b.date;
      if (dA !== dB) return dB.localeCompare(dA); // desc by date
      // Tiebreak: TE before BS so a working day stays grouped; within TE, descending
      // by startTime.
      if (a.kind !== b.kind) return a.kind === "TE" ? -1 : 1;
      if (a.kind === "TE" && b.kind === "TE") {
        return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      }
      return 0;
    });
  });
</script>

<svelte:head><title>Zeiterfassung – Clokr</title></svelte:head>
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && modalOpen) closeModal();
  }}
/>

<PageHead eyebrow="Mein Bereich" title="Zeiterfassung">
  {#snippet actions()}
    <!-- Phase 76.7 (D-16, UI-V19-04) — § 18 ArbZG-exempt users see no
         "+ Neuer Eintrag" CTA. Full HIDE, NOT disabled — don't teach
         exempt users to click a disabled control. -->
    {#if !isExempt}
      <button
        class="btn btn-primary btn-sm"
        onclick={() => openAdd()}
        data-testid="time-entries-add">+ Neuer Eintrag</button
      >
    {/if}
  {/snippet}
</PageHead>

<div data-testid="time-entries-page">
  <!-- ── View Tabs ──────────────────────────────────────────────────────── -->
  <div class="view-tabs" data-testid="time-entries-view-tabs">
    <button
      class="view-tab"
      class:view-tab--active={teView === "calendar"}
      onclick={() => (teView = "calendar")}
      data-testid="time-entries-view-calendar"
    >
      Kalender
    </button>
    <button
      class="view-tab"
      class:view-tab--active={teView === "list"}
      onclick={() => (teView = "list")}
      data-testid="time-entries-view-list"
    >
      Liste
    </button>
  </div>

  {#if error}
    <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
  {/if}

  <!-- ── Monat-Navigation + Mini-Stats (MonthBar primitive) ────────────────── -->
  <Card animate class="te-monthbar-card">
    <div data-testid="time-entries-summary">
      <MonthBar
        eyebrow="Buchungsmonat"
        date={calMonth}
        stats={monthBarStats}
        onPrev={() => gotoMonth(-1)}
        onNext={() => gotoMonth(1)}
        onToday={gotoToday}
        onSelectMonth={gotoMonthYear}
        testIdPrefix="calendar-month-header"
      >
        {#snippet extraActions()}
          {#if monthIsLocked}
            <span class="te-lock-chip" title="Monat ist abgeschlossen">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Abgeschlossen
            </span>
          {/if}
        {/snippet}
      </MonthBar>
    </div>
    <!-- /data-testid="time-entries-summary" -->
  </Card>

  <!-- ── Kalender ─────────────────────────────────────────────────────────── -->
  {#if teView === "calendar"}
    <div class="cal-section card card-animate" data-testid="calendar">
      <!-- Wochentage-Header -->
      <div class="cal-grid cal-header-row">
        {#each ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as d (d)}
          <div class="cal-dow">{d}</div>
        {/each}
      </div>

      <!-- Tage -->
      {#if loading}
        <div class="cal-grid">
          {#each Array(35) as _, i (i)}<div class="cal-cell skeleton"></div>{/each}
        </div>
      {:else}
        <div class="cal-grid" data-testid="calendar-grid">
          {#each calendarDays as day (day.dateStr)}
            <button
              type="button"
              data-date={day.dateStr}
              data-testid={`calendar-cell-${day.dateStr}`}
              class="cal-cell cal-cell--{day.status}{day.absenceType && !day.isWeekend
                ? ' cal-abs cal-abs-' + day.absenceType.toLowerCase()
                : day.isVocationalSchool && !day.absenceType && !day.isHoliday
                  ? ' cal-abs cal-abs-vocational_school'
                  : ''}"
              class:cal-other={!day.isCurrentMonth}
              class:cal-current={day.isCurrentMonth}
              class:cal-today={day.isToday}
              class:cal-weekend={day.isWeekend}
              class:cal-holiday={day.isHoliday && day.isCurrentMonth}
              class:cal-selected={day.dateStr === selectedDate && day.isCurrentMonth}
              class:cal-cell--disabled={day.isBeforeHire && day.isCurrentMonth}
              class:cal-cell--arbzg-warn={arbzgDayMap.has(day.dateStr) && day.isCurrentMonth}
              disabled={day.isBeforeHire || !day.isCurrentMonth || isExempt}
              title={day.isBeforeHire
                ? "Vor Eintrittsdatum"
                : isExempt
                  ? "Keine Zeiterfassungs-Pflicht (§ 18 ArbZG)"
                  : day.isHoliday
                    ? day.holidayName
                    : day.absenceType
                      ? absenceLabel(day.absenceType) + (day.absenceHalf ? " (halber Tag)" : "")
                      : day.isVocationalSchool
                        ? "Berufsschule"
                        : undefined}
              onclick={isExempt ? undefined : () => openAdd(day.dateStr)}
            >
              <span class="cal-day-num">{day.dayNum}</span>
              {#if day.isHoliday && day.isCurrentMonth}
                <span class="cal-holiday-label">{day.holidayName}</span>
              {:else if day.absenceType}
                <span class="cal-abs-type"
                  >{absenceLabel(day.absenceType)}{day.absenceHalf ? " ½" : ""}</span
                >
              {:else if day.isVocationalSchool && day.isCurrentMonth}
                <span class="cal-abs-type">Berufsschule</span>
              {/if}
              {#if day.isBeforeHire}
                <span class="day-before-hire">—</span>
              {:else if day.isCurrentMonth && day.hasEntries}
                {#if lockedDateSet.has(day.dateStr)}
                  <span class="cal-lock-icon" aria-label="Gesperrt">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      style:color="var(--text-muted)"
                      aria-hidden="true"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                    </svg>
                  </span>
                {/if}
                <span class="day-worked">{fmtMin(day.workedMin)}&thinsp;h</span>
                {#if day.expectedMin > 0 && !isNoDailyTarget}
                  {@const b = day.workedMin - day.expectedMin}
                  <span class="day-bal {balClass(b)}"
                    >{b >= 0 ? "+" : "−"}{fmtMin(Math.abs(b))}</span
                  >
                {/if}
              {:else if day.isCurrentMonth && day.expectedMin > 0 && !day.isFuture && !isNoDailyTarget}
                <span class="day-missing">−{fmtMin(day.expectedMin)}&thinsp;h</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Legende -->
      <div class="cal-legend">
        <span class="leg leg-ok">Soll erfüllt</span>
        <span class="leg leg-partial">Teilweise</span>
        <span class="leg leg-missing">Fehlt</span>
        <span class="leg leg-noexpect">Kein Soll</span>
        <span class="leg leg-abs-vacation">Urlaub</span>
        <span class="leg leg-abs-sick">Krank</span>
        <span class="leg leg-abs-special">Sonderurlaub</span>
        <span class="leg leg-abs-overtime_comp">Freizeitausgl.</span>
        <span class="leg leg-abs-vocational_school">Berufsschule</span>
      </div>
    </div>
  {/if}

  <!-- ── Listenansicht ──────────────────────────────────────────────────── -->
  {#if teView === "list"}
    <div class="card card-animate list-card" data-testid="time-entries-list">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Von</th>
              <th>Bis</th>
              <th>Pause</th>
              <th>Netto</th>
              <th>Quelle</th>
              <th>Notiz</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each allEntries as slot (slot.id)}
              {#if slot.kind === "TE"}
                {@const slotDate = (slot.date ?? slot.startTime).split("T")[0]}
                {@const slotArbzg = arbzgDayMap.get(slotDate)}
                <tr class:row-invalid={slot.isInvalid} data-testid={`time-entry-row-${slot.id}`}>
                  <td class="font-mono"
                    >{new Date(slot.startTime).toLocaleDateString("de-DE", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}{#if slotArbzg}
                      <span class="list-arbzg-hint"
                        >{slotArbzg.some((w) => w.severity === "error") ? "⛔" : "⚠️"}<span
                          class="arbzg-tooltip"
                          >{#each slotArbzg as w, i (i)}{w.message}{#if i < slotArbzg.length - 1}<br
                              />{/if}{/each}</span
                        ></span
                      >
                    {/if}</td
                  >
                  <td class="font-mono">{fmtTime(slot.startTime)}</td>
                  <td class="font-mono">
                    {#if slot.endTime}{fmtTime(slot.endTime)}
                    {:else}<span class="badge badge-green">Aktiv</span>{/if}
                  </td>
                  <td>{fmtBreaks(slot)}</td>
                  <td class="font-mono font-medium">{slotNet(slot)}</td>
                  <td
                    ><span class="badge {sourceBadge(slot.source)}">{sourceLabel(slot.source)}</span
                    ></td
                  >
                  <td class="note-cell text-muted">
                    {#if slot.isInvalid && slot.invalidReason}
                      <span class="invalid-reason">{slot.invalidReason}</span>
                    {:else}
                      {slot.note ?? "---"}
                    {/if}
                  </td>
                  <td class="action-cell">
                    {#if slot.isLocked}
                      <!-- Locked entries are read-only (D-08). Per Phase 73-03 +
                         74-01: render the buttons as disabled instead of
                         hiding so the row testids stay queryable for the
                         locked-month spec — matches the
                         `getByTestId(...-edit).toBeDisabled()` contract. -->
                      <span class="row-actions row-actions--visible">
                        <span
                          class="badge badge-locked"
                          title="Monat ist abgeschlossen"
                          data-testid={`time-entry-row-${slot.id}-locked-badge`}>🔒 Gesperrt</span
                        >
                        <button
                          class="btn-icon"
                          disabled
                          title="Eintrag gesperrt"
                          data-testid={`time-entry-row-${slot.id}-edit`}>✏️</button
                        >
                        <button
                          class="btn-icon btn-icon-danger"
                          disabled
                          title="Eintrag gesperrt"
                          data-testid={`time-entry-row-${slot.id}-delete`}>🗑</button
                        >
                      </span>
                    {:else if deleteConfirmId === slot.id}
                      <span class="del-confirm">
                        <span class="text-muted" style="font-size:0.8rem;">Löschen?</span>
                        <button
                          class="btn btn-sm btn-danger"
                          onclick={() => deleteEntry(slot.id)}
                          data-testid={`time-entry-row-${slot.id}-confirm-delete`}>Ja</button
                        >
                        <button
                          class="btn btn-sm btn-ghost"
                          onclick={() => (deleteConfirmId = "")}
                          data-testid={`time-entry-row-${slot.id}-cancel-delete`}>Nein</button
                        >
                      </span>
                    {:else}
                      <span class="row-actions row-actions--visible">
                        <button
                          class="btn-icon"
                          onclick={() => openEdit(slot)}
                          title="Bearbeiten"
                          data-testid={`time-entry-row-${slot.id}-edit`}>✏️</button
                        >
                        <button
                          class="btn-icon btn-icon-danger"
                          onclick={() => (deleteConfirmId = slot.id)}
                          title="Löschen"
                          data-testid={`time-entry-row-${slot.id}-delete`}>🗑</button
                        >
                      </span>
                    {/if}
                  </td>
                </tr>
              {:else}
                <!-- 260611-ly6 — BS row: read-only, single-day, no times, no breaks, no actions.
                     Distinct data-testid namespace (`bs-row-*`) so it never collides with the
                     existing `time-entry-row-*` testids used by E2E specs. -->
                <tr class="row-bs" data-testid={`bs-row-${slot.id}`}>
                  <td class="font-mono"
                    >{new Date(slot.date + "T12:00:00").toLocaleDateString("de-DE", {
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}</td
                  >
                  <td class="font-mono text-muted">—</td>
                  <td class="font-mono text-muted">—</td>
                  <td class="text-muted">—</td>
                  <td class="font-mono font-medium text-muted">—</td>
                  <td><span class="badge badge-blue">Berufsschule</span></td>
                  <td class="note-cell text-muted"
                    >{slot.source === "PATTERN" ? "Automatisch (Muster)" : "Manuell eingefügt"}</td
                  >
                  <td class="action-cell">
                    <span
                      class="text-muted"
                      style="font-size: 0.75rem;"
                      title="Berufsschultage werden unter Schichten verwaltet">Schichten →</span
                    >
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      {#if allEntries.length === 0}
        <div class="empty-state">
          <span class="empty-icon">📋</span>
          <h3>Keine Einträge</h3>
          <p class="text-muted">Keine Zeiteinträge in diesem Monat.</p>
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Modal (Modal primitive — owns backdrop/escape/focus-trap) ────────── -->
  <Modal
    bind:open={modalOpen}
    eyebrow={editEntry ? "Eintrag bearbeiten" : "Neuer Eintrag"}
    title={formDate
      ? format(new Date(formDate + "T12:00:00"), "EEEE, d. MMMM yyyy", { locale: de })
      : "Zeiteintrag"}
  >
    <!-- Phase 73-03: every interactive element in the time-entry modal gets a
       data-testid following [surface]-[element]-[action]? (D-05). The modal
       primitive owns role=dialog already; this wrapper exposes the modal
       root + body fields by stable id for spec consumers. -->
    <div data-testid="time-entry-modal">
      {#if saveError}
        <div class="alert alert-error" role="alert" data-testid="time-entry-modal-error">
          <span>⚠</span><span>{saveError}</span>
        </div>
      {/if}
      <div class="form-group">
        <label class="form-label" for="f-date">Datum</label>
        <input
          id="f-date"
          type="date"
          bind:value={formDate}
          class="form-input"
          data-testid="time-entry-modal-date"
        />
      </div>
      <div class="form-row-two">
        <div class="form-group">
          <label class="form-label" for="f-start">Arbeitsbeginn</label>
          <input
            id="f-start"
            type="time"
            bind:value={formStart}
            class="form-input"
            data-testid="time-entry-modal-start"
          />
        </div>
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label" for="f-end">Arbeitsende</label>
            <label class="end-toggle">
              <input
                type="checkbox"
                bind:checked={formHasEnd}
                aria-label="Arbeitsende erfasst"
                data-testid="time-entry-modal-end-toggle"
              />
              <span class="text-muted end-toggle-hint">erfasst</span>
            </label>
          </div>
          <input
            id="f-end"
            type="time"
            bind:value={formEnd}
            class="form-input"
            disabled={!formHasEnd}
            data-testid="time-entry-modal-end"
          />
        </div>
      </div>
      <div class="breaks-section" data-testid="break-slots-editor">
        <span class="form-label">Pausen</span>
        {#if editEntry && !editEntry.breaks?.length && (editEntry.breakMinutes ?? 0) > 0 && formBreaks.length === 0}
          <div class="break-legacy">
            <span class="text-muted">Pauschale: {editEntry.breakMinutes} Min.</span>
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              data-testid="break-slot-convert-legacy"
              onclick={() => {
                formBreaks = [
                  { start: "12:00", end: addMinutesToTime("12:00", editEntry!.breakMinutes) },
                ];
              }}>In Pausen umwandeln</button
            >
          </div>
        {/if}
        {#each formBreaks as brk, i (i)}
          <div class="break-row" data-testid={`break-slot-${i}`}>
            <input
              type="time"
              bind:value={brk.start}
              class="form-input"
              aria-label={`Pause ${i + 1} Beginn`}
              data-testid={`break-slot-${i}-start`}
            />
            <span class="break-sep">&ndash;</span>
            <input
              type="time"
              bind:value={brk.end}
              class="form-input"
              aria-label={`Pause ${i + 1} Ende`}
              data-testid={`break-slot-${i}-end`}
            />
            <button
              class="btn-icon"
              type="button"
              onclick={() => (formBreaks = formBreaks.filter((_, j) => j !== i))}
              title="Pause entfernen"
              data-testid={`break-slot-${i}-remove`}>✕</button
            >
          </div>
        {/each}
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          onclick={() => (formBreaks = [...formBreaks, { start: "12:00", end: "12:30" }])}
          data-testid="break-slot-add">+ Pause hinzufügen</button
        >
        {#if formBreakTotal > 0}
          <span class="text-muted break-total" data-testid="break-slots-total"
            >Gesamt: {formBreakTotal} Min.</span
          >
        {/if}
      </div>
      <div class="form-group">
        <label class="form-label" for="f-note"
          >Notiz <span class="text-muted">(optional)</span></label
        >
        <input
          id="f-note"
          type="text"
          bind:value={formNote}
          class="form-input"
          placeholder="z.B. Kundentermin…"
          maxlength="200"
          data-testid="time-entry-modal-note"
        />
      </div>
      {#if formNetMin !== null}
        <div class="net-display" data-testid="time-entry-modal-net">
          <span class="net-label">Netto</span>
          <span class="net-value {modalWarnings.some((w) => w.code === '§3') ? 'net-over' : ''}"
            >{fmtMin(formNetMin)}<span class="net-unit">h</span></span
          >
        </div>
      {/if}
      {#if modalWarnings.length > 0}
        <div class="modal-callouts" data-testid="time-entry-modal-warnings">
          {#each modalWarnings as w, i (i)}
            <div class="callout {w.severity === 'error' ? 'error' : ''}" role="alert">
              <svg
                class="ico"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <p><b>{w.code} ArbZG:</b> {w.message}</p>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {#snippet footer()}
      <button
        class="btn btn-ghost"
        onclick={closeModal}
        disabled={saving}
        data-testid="time-entry-modal-cancel">Abbrechen</button
      >
      <button
        class="btn btn-primary"
        onclick={saveEntry}
        disabled={saving}
        data-testid="time-entry-modal-save"
      >
        {saving ? "Speichern…" : editEntry ? "Änderungen speichern" : "Eintrag hinzufügen"}
      </button>
    {/snippet}
  </Modal>
</div>

<!-- /data-testid="time-entries-page" -->

<style>
  /* ── MonthBar card spacing (primitive owns its 18px 24px inner padding,
       same as .cal-monthbar — so header height matches /leave et al.) ──── */
  :global(.te-monthbar-card) {
    padding: 0;
    margin-bottom: 18px;
    /* Allow month-picker dropdown to escape .card overflow:clip and lift
       above sibling .card stacking contexts (each .card creates its own via
       backdrop-filter). Without these three lines the dropdown is invisible. */
    overflow: visible;
    position: relative;
    z-index: 30;
  }

  /* MonthBar + mini-stats styles live in the MonthBar primitive. */

  /* D-07: Lock icon overlay in calendar cells */
  .cal-lock-icon {
    display: block;
    line-height: 1;
    margin-bottom: 1px;
  }

  /* ── View Tabs ───────────────────────────────────────── */
  /* view-tabs, view-tab → global in app.css */

  /* ── List card (v1.5) ────────────────────────────────── */
  .list-card {
    padding: 0;
    overflow: hidden;
  }
  .list-card .table-wrapper {
    overflow-x: auto;
  }
  .list-card .empty-state {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-muted);
  }
  .list-card .empty-state .empty-icon {
    font-size: 32px;
    display: block;
    margin-bottom: 8px;
    opacity: 0.6;
  }
  .list-card .empty-state h3 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 18px;
    margin: 0 0 4px;
    color: var(--text);
  }
  .list-card .empty-state p {
    margin: 0;
    font-size: 13px;
  }

  /* ── List view actions always visible ────────────────── */
  .row-actions--visible {
    opacity: 1 !important;
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
    padding: 3px;
  }

  /* EMP-03: v1.5 mini-card calendar cells (Phase 29) */
  .cal-cell {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    min-height: 86px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: pointer;
    transition:
      border-color 160ms var(--ease),
      background 160ms var(--ease);
    position: relative;
  }
  .cal-cell:not(.cal-other):hover {
    border-color: var(--brand-light);
  }
  :global(.cal-cell.cal-today) {
    outline: 1.5px solid var(--brand-light);
    outline-offset: -1.5px;
  }
  :global(.cal-cell.cal-weekend:not(.cal-today)) {
    background: var(--bg-subtle);
  }
  /* Tage vor dem Eintrittsdatum */
  :global(.cal-cell.cal-cell--disabled) {
    opacity: 0.4;
    pointer-events: none;
    cursor: default;
    background: var(--bg-subtle) !important;
  }
  .day-before-hire {
    font-size: 0.75rem;
    color: var(--text-muted);
    opacity: 0.5;
  }
  /* Status accent: left rule only — keeps mini-card surface for v1.5 look */
  .cal-cell--ok {
    border-left: 3px solid var(--good);
  }
  .cal-cell--partial {
    border-left: 3px solid var(--warn);
  }
  .cal-cell--missing {
    border-left: 3px solid var(--bad);
  }
  .cal-cell--today-ok {
    border-left: 3px solid var(--good);
  }
  .cal-cell--today-partial {
    border-left: 3px solid var(--warn);
  }
  /* ArbZG over: border + warn glyph top-right via ::after */
  :global(.cal-cell.cal-cell--arbzg-warn) {
    border-color: var(--warn);
  }
  :global(.cal-cell.cal-cell--arbzg-warn::after) {
    content: "⚠";
    position: absolute;
    top: 6px;
    right: 6px;
    font-size: 12px;
    line-height: 1;
    color: var(--warn);
    pointer-events: none;
  }

  /* Abwesenheitsfarben – allgemein (überschreiben Status-Farben) */
  /* Absence cell backgrounds → global in app.css (.cal-abs-*) */

  /* Nachbarmonat-Tage mit Abwesenheit etwas heller darstellen */

  .cal-abs-type {
    display: block;
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.65;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .day-worked {
    font-family: var(--font-serif);
    font-size: 18px;
    font-variant-numeric: tabular-nums;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
  }
  /* When the cell is ArbZG-over, the hour total turns red */
  :global(.cal-cell--arbzg-warn .day-worked) {
    color: var(--bad);
  }
  .day-bal {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .day-bal.pos {
    color: var(--good);
  }
  .day-bal.neg {
    color: var(--bad);
  }
  .day-missing {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--bad);
    opacity: 0.75;
  }

  /* Legende */
  .cal-legend {
    display: flex;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
    flex-wrap: wrap;
  }
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-muted);
  }
  .leg::before {
    content: "";
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .leg-ok::before {
    background: var(--good-soft);
    border: 1px solid color-mix(in srgb, var(--good) 25%, transparent);
  }
  .leg-partial::before {
    background: var(--warn-soft);
    border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent);
  }
  .leg-missing::before {
    background: var(--bad-soft);
    border: 1px solid color-mix(in srgb, var(--bad) 25%, transparent);
  }
  .leg-noexpect::before {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
  }
  .leg-abs-vacation::before {
    background: var(--leave-type-vacation);
    border: none;
  }
  .leg-abs-sick::before {
    background: var(--leave-type-sick);
    border: none;
  }
  .leg-abs-special::before {
    background: var(--leave-type-special);
    border: none;
  }
  .leg-abs-overtime_comp::before {
    background: var(--leave-type-overtime);
    border: none;
  }
  /* bs-tage-in-calendar — Berufsschultag legend swatch. Mirrors the brand-tinted
     /shifts canonical BS treatment (sp-avail-badge--vocational-school). v1.5
     tokens only; no legacy color/gray namespaces. */
  .leg-abs-vocational_school::before {
    background: var(--brand);
    border: none;
  }

  /* bs-tage-in-calendar — Berufsschultag cell background. Uses --brand at the
     same 15% mix as the other .cal-abs-* recipes in app.css. Scoped to this
     page (mirrors the 260611-ly6 .row-bs scoped CSS pattern); a token-level
     --leave-type-vocational-school would be the long-term home if BS gets
     promoted to a first-class leave type. */
  :global(.cal-cell.cal-abs-vocational_school:not(.cal-selected)) {
    background: color-mix(in srgb, var(--brand) 15%, var(--bg-card)) !important;
    opacity: 1;
  }

  /* ── Tagesdetail ──────────────────────────────────────────────────── */
  .day-detail {
    padding: 0;
    overflow: hidden;
  }

  .day-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 1rem;
    gap: 1rem;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--bg-subtle);
    background: var(--bg-card);
  }

  .day-detail-title {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .day-detail-label {
    font-weight: 600;
    font-size: 0.9375rem;
    text-transform: capitalize;
  }

  .day-detail-stats {
    display: flex;
    gap: 0.875rem;
    flex-wrap: wrap;
    font-size: 0.8125rem;
  }

  .dstat {
    color: var(--text-muted);
  }
  .dstat strong {
    color: var(--text);
    font-weight: 600;
  }
  .dstat.bal.pos strong {
    color: var(--good);
  }
  .dstat.bal.neg strong {
    color: var(--bad);
  }

  .day-empty {
    padding: 1.5rem 1rem;
    display: flex;
    align-items: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  /* ── Slots-Tabelle ────────────────────────────────────────────────── */
  .slots-wrap {
    overflow-x: auto;
  }
  .slots-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .slots-table thead th {
    padding: 0.45rem 0.75rem;
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    text-align: left;
    white-space: nowrap;
    background: var(--bg-card);
    border-bottom: 1px solid var(--border);
  }
  .slots-table tbody td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--bg-subtle);
    vertical-align: middle;
  }
  .slots-table tbody tr:hover {
    background: var(--bg-card);
  }
  .note-cell {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions-cell {
    width: 80px;
    text-align: right;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .fw-med {
    font-weight: 500;
  }

  .row-actions {
    display: inline-flex;
    gap: 0.25rem;
    opacity: 0;
    transition: opacity 0.15s;
  }
  tr:hover .row-actions {
    opacity: 1;
  }
  .del-confirm {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .row-del td {
    background: var(--bad-soft);
  }

  .row-invalid {
    opacity: 0.5;
  }
  .row-invalid td {
    text-decoration: line-through;
    background: var(--bad-soft);
  }
  .row-invalid td:last-child {
    text-decoration: none;
  }
  .row-invalid .invalid-reason {
    color: var(--bad);
    font-size: 0.8rem;
    font-weight: 500;
    text-decoration: none;
  }

  /* 260611-ly6 — Berufsschultag list-row tint. UI Style Guide v1.5: only var(--brand) via color-mix; no legacy tokens. */
  .row-bs td {
    background: color-mix(in srgb, var(--brand) 6%, transparent);
  }

  .btn-xs {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }
  .btn-icon {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    font-size: 0.9375rem;
    line-height: 1;
    color: var(--text-muted);
    transition: background 0.15s;
  }
  .btn-icon:hover {
    background: var(--bg-subtle);
  }
  .btn-icon-danger {
    color: var(--text-muted);
  }
  .btn-icon-danger:hover {
    background: var(--bad-soft);
    color: var(--bad);
  }

  /* Ensure delete confirmation button has white text on red background */
  .del-confirm :global(.btn-danger) {
    color: #fff !important;
  }
  .btn-danger-sm {
    color: white;
    background: var(--bad);
    border-radius: 4px;
    font-size: 0.8125rem;
    padding: 0.125rem 0.375rem;
  }

  /* Modal styles live in the Modal primitive (.scrim/.modal/.modal-hd/.modal-foot). */

  .form-row-two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  /* ── Netto summary row (v1.5 EntryEditor reference) ──────────────── */
  .net-display {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    margin-top: 4px;
  }
  .net-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .net-value {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 24px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  .net-value.net-over {
    color: var(--bad);
  }
  .net-unit {
    font-family: var(--font-sans);
    font-variant-numeric: normal;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }
  .form-label-row {
    display: flex;
    align-items: center;
    margin-bottom: 0.25rem;
  }
  .form-label-row .form-label {
    margin-bottom: 0;
  }
  .end-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    margin-left: 0.5rem;
  }
  .btn-sm {
    padding: 0.35rem 0.75rem;
    font-size: 0.875rem;
  }

  /* ── Pausen-Slots ──────────────────────────────────────────────── */
  .breaks-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .break-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .break-row .form-input {
    flex: 1;
    min-width: 0;
  }
  .break-sep {
    color: var(--text-muted);
    font-weight: 600;
    flex-shrink: 0;
  }
  .break-total {
    font-size: 0.8125rem;
  }
  .break-legacy {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.625rem;
    background: var(--bg-card);
    border-radius: 6px;
    font-size: 0.8125rem;
  }
  .break-cell {
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  /* ── ArbZG-Warnungen ──────────────────────────────────────────────── */
  /* EMP-04: ArbZG callouts inside the entry editor modal */
  .modal-callouts {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 26px 4px;
    margin-top: 4px;
  }
  .list-arbzg-hint {
    margin-left: 0.375rem;
    cursor: help;
    font-size: 0.8rem;
    position: relative;
  }
  .arbzg-tooltip {
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    background: var(--text);
    color: #fff;
    font-size: 0.75rem;
    line-height: 1.4;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    white-space: nowrap;
    z-index: 50;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    margin-bottom: 0.25rem;
  }
  .list-arbzg-hint:hover .arbzg-tooltip {
    display: block;
  }
  .day-warnings {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 1rem 0;
  }

  /* Phase 29: legacy alert / warning / error scoped rules removed — see .callout recipe in app.css */

  /* ── Mobile calendar improvements ──────────────────────────────── */
  @media (max-width: 640px) {
    /* Reduce cell height on mobile but keep them tappable */
    .cal-cell {
      min-height: 72px;
      padding: 0.375rem 0.375rem;
    }

    /* Hide balance detail on mobile — show only worked hours */
    .day-bal,
    .day-missing {
      display: none;
    }

    /* Compact worked-hours display */
    .day-worked {
      font-size: 0.6875rem;
    }

    /* Smaller day numbers on mobile */
    .cal-day-num {
      font-size: 0.75rem;
    }

    /* Holiday/absence labels smaller on mobile */
    .cal-holiday-label,
    .cal-abs-type {
      font-size: 0.5rem;
    }

    /* Larger touch target for "+ Slot" button */
    .day-detail-header .btn-sm {
      min-height: 44px;
      min-width: 44px;
      padding: 0.5rem 1rem;
      font-size: 0.9375rem;
    }

    /* Legend wraps tighter */
    .cal-legend {
      gap: 0.5rem 0.75rem;
    }
  }
</style>
