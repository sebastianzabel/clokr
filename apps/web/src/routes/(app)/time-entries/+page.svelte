<script lang="ts">
  import { self } from "svelte/legacy";

  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { format, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
  import { de } from "date-fns/locale";

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
  }

  interface WorkSchedule {
    type?: "FIXED_WEEKLY" | "MONTHLY_HOURS";
    monthlyHours?: number | null;
    mondayHours: string | number;
    tuesdayHours: string | number;
    wednesdayHours: string | number;
    thursdayHours: string | number;
    fridayHours: string | number;
    saturdayHours: string | number;
    sundayHours: string | number;
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

  interface ArbZGWarning {
    code: string;
    severity: "warning" | "error";
    message: string;
  }

  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber: string;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let entries: TimeEntry[] = $state([]);
  let schedule: WorkSchedule | null = $state(null);
  let holidays: Map<string, string> = new Map(); // dateStr → name
  let calendarDays: CalDay[] = $state([]);
  let loading = $state(false);
  let error = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let arbzgEnabled = $state(true);

  const today = new Date();
  const todayStr = format(today, "yyyy-MM-dd");
  let calMonth = $state(new Date(today.getFullYear(), today.getMonth(), 1));
  let fromDate = format(startOfMonth(today), "yyyy-MM-dd");
  let toDate = format(endOfMonth(today), "yyyy-MM-dd");

  // Ausgewählter Tag
  let selectedDate = $state(todayStr);

  let deleteConfirmId = $state("");
  let absences: Absence[] = [];
  let overtimeTotalHours: number | null = $state(null);
  let hireDate: string | null = $state(null); // YYYY-MM-DD oder null
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
  let formNote = $state("");
  let defaultBreakStart: string | null = $state(null);

  // Manager: employee selector
  let employees: Employee[] = $state([]);
  let selectedEmployeeId = $state<string | null>(null);

  const ownEmployeeId = $authStore.user?.employeeId ?? null;
  // The active employee ID: either the selected employee (for managers) or the logged-in user
  let employeeId = $derived(selectedEmployeeId ?? ownEmployeeId);
  let isViewingOther = $derived(
    selectedEmployeeId !== null && selectedEmployeeId !== ownEmployeeId,
  );
  let selectedEmployeeName = $derived.by(() => {
    if (!isViewingOther) return null;
    const emp = employees.find((e) => e.id === selectedEmployeeId);
    return emp ? `${emp.firstName} ${emp.lastName}` : null;
  });

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

    // Load employee list for managers
    const role = $authStore.user?.role;
    if (role === "ADMIN" || role === "MANAGER") {
      try {
        const rawEmployees = await api.get<Employee[]>("/employees");
        employees = rawEmployees;
      } catch {
        // Ignore — employee selector won't be shown
      }
    }
    await loadAll();
  });

  async function loadAll() {
    loading = true;
    error = "";
    try {
      const year = calMonth.getFullYear();
      const activeEmpId = employeeId;
      // When manager views another employee, pass employeeId to the API
      const empQuery =
        activeEmpId && activeEmpId !== ownEmployeeId ? `&employeeId=${activeEmpId}` : "";
      const [
        rawEntries,
        rawSchedule,
        rawHolidays,
        rawAbsences,
        rawOvertime,
        rawEmployee,
        rawConfig,
      ] = await Promise.all([
        api.get<TimeEntry[]>(`/time-entries?from=${fromDate}&to=${toDate}${empQuery}`),
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
          ? api.get<{ hireDate?: string }>(`/employees/${activeEmpId}`).catch(() => null)
          : Promise.resolve(null),
        api
          .get<{ arbzgEnabled?: boolean; defaultBreakStart?: string | null }>("/settings/work")
          .catch(() => null),
      ]);
      entries = rawEntries;
      schedule = rawSchedule;
      holidays = new Map(rawHolidays.map((h) => [h.date.split("T")[0], h.name]));
      absences = rawAbsences;
      overtimeTotalHours = rawOvertime ? Number(rawOvertime.balanceHours) : null;
      hireDate = rawEmployee?.hireDate ? rawEmployee.hireDate.split("T")[0] : null;
      arbzgEnabled = rawConfig?.arbzgEnabled !== false;
      defaultBreakStart = rawConfig?.defaultBreakStart ?? null;
      calendarDays = buildCalendarDays(
        calMonth,
        entries,
        schedule,
        holidays,
        absences,
        hireDate,
        schedule?.type === "MONTHLY_HOURS",
      );
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  async function onEmployeeChange(newId: string) {
    selectedEmployeeId = newId === "" ? null : newId;
    await loadAll();
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
  ): CalDay[] {
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const key = (e.date ?? e.startTime).split("T")[0];
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(e);
    }

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

    const monthEnd = endOfMonth(monthStart);
    const firstDow = (monthStart.getDay() + 6) % 7;
    const lastDow = (monthEnd.getDay() + 6) % 7;
    const days: CalDay[] = [];

    for (let i = firstDow - 1; i >= 0; i--) {
      const d = new Date(monthStart);
      d.setDate(d.getDate() - i - 1);
      days.push(makeCalDay(d, false, byDate, sched, hols, absenceByDate, hireDateStr, monthly));
    }
    const cur = new Date(monthStart);
    while (cur <= monthEnd) {
      days.push(
        makeCalDay(new Date(cur), true, byDate, sched, hols, absenceByDate, hireDateStr, monthly),
      );
      cur.setDate(cur.getDate() + 1);
    }
    const remaining = (7 - ((lastDow + 1) % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(monthEnd);
      d.setDate(d.getDate() + i);
      days.push(makeCalDay(d, false, byDate, sched, hols, absenceByDate, hireDateStr, monthly));
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
    // Bei MONTHLY_HOURS gibt es kein tägliches Soll
    let expectedMin = monthly ? 0 : sched ? getDayExpected(sched, date) * 60 : 0;
    if (isBeforeHire) expectedMin = 0;
    if (isHoliday) expectedMin = 0;
    else if (absence && !absence.half) expectedMin = 0;
    else if (absence && absence.half) expectedMin = Math.round(expectedMin / 2);

    let status: CalStatus = "noExpect";
    if (isFuture) status = "future";
    else if (absence && !absence.half && !isFuture) status = "absence";
    else if (monthly) {
      // Monatsstunden: kein tägliches Soll, nur zeigen ob gearbeitet wurde
      if (isToday) status = hasEntries ? "today-ok" : "today-empty";
      else if (hasEntries) status = "noExpect";
      else status = "noExpect";
    } else if (isToday && !hasEntries) status = "today-empty";
    else if (isToday && workedMin >= expectedMin) status = "today-ok";
    else if (isToday) status = "today-partial";
    else if (!hasEntries && expectedMin > 0 && !isHoliday) status = "missing";
    else if (workedMin >= expectedMin && expectedMin > 0) status = "ok";
    else if (workedMin > 0) status = "partial";

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

  function getDayExpected(s: WorkSchedule, date: Date): number {
    const keys = [
      "sundayHours",
      "mondayHours",
      "tuesdayHours",
      "wednesdayHours",
      "thursdayHours",
      "fridayHours",
      "saturdayHours",
    ] as const;
    return Number(s[keys[date.getDay()] as keyof WorkSchedule] ?? 0);
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
          ...(isViewingOther ? { employeeId: selectedEmployeeId } : {}),
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

  const isManager = $derived(
    $authStore.user?.role === "ADMIN" || $authStore.user?.role === "MANAGER",
  );

  // ArbZG-Prüfung für den ausgewählten Tag (Frontend-seitig, sofort)
  function checkArbZGFrontend(slots: TimeEntry[]): ArbZGWarning[] {
    const warnings: ArbZGWarning[] = [];
    const done = slots.filter((s) => s.endTime);
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
        code: "BREAK_TOO_SHORT",
        severity: "error",
        message: `Bei über 9h Arbeitszeit mind. 45 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });
    else if (netMin > 6 * 60 && totalBreak < 30)
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "warning",
        message: `Bei über 6h Arbeitszeit mind. 30 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });

    if (netMin > 10 * 60)
      warnings.push({
        code: "MAX_DAILY_EXCEEDED",
        severity: "error",
        message: `Tägliche Höchstarbeitszeit von 10h überschritten (${(netMin / 60).toFixed(1)}h)`,
      });

    return warnings;
  }

  // ── Reaktive Ableitungen ───────────────────────────────────────────────────
  let isMonthlyHours = $derived(schedule?.type === "MONTHLY_HOURS");
  let monthlyTarget = $derived(
    isMonthlyHours && schedule?.monthlyHours ? Number(schedule.monthlyHours) * 60 : 0,
  );
  let hasMonthlyTarget = $derived(isMonthlyHours && monthlyTarget > 0);
  let mBalance = $derived(
    isMonthlyHours ? totalWorked - monthlyTarget : totalWorked - totalExpected,
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

  // All entries for the current month, sorted by date descending then start time descending
  let allEntries = $derived(
    [...entries].sort((a, b) => {
      const dA = (a.date ?? a.startTime).split("T")[0];
      const dB = (b.date ?? b.startTime).split("T")[0];
      if (dA !== dB) return dB.localeCompare(dA);
      return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
    }),
  );
</script>

<svelte:head><title>Zeiterfassung – Clokr</title></svelte:head>
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && modalOpen) closeModal();
  }}
/>

<div class="page-header-compact">
  <h1>Zeiterfassung</h1>
  <button class="btn btn-primary" onclick={() => openAdd()}>
    <span aria-hidden="true">＋</span> Eintrag hinzufügen
  </button>
</div>

{#if isManager && employees.length > 0}
  <div class="employee-selector card-animate">
    <label class="form-label" for="emp-select">Mitarbeiter</label>
    <select
      id="emp-select"
      class="form-input"
      value={selectedEmployeeId ?? ""}
      onchange={(e) => onEmployeeChange(e.currentTarget.value)}
    >
      <option value="">Meine Einträge</option>
      {#each employees as emp (emp.id)}
        {#if emp.id !== ownEmployeeId}
          <option value={emp.id}>{emp.lastName}, {emp.firstName} ({emp.employeeNumber})</option>
        {/if}
      {/each}
    </select>
    {#if isViewingOther}
      <span class="viewing-other-hint">Einträge von {selectedEmployeeName}</span>
    {/if}
  </div>
{/if}

<!-- ── View Tabs ──────────────────────────────────────────────────────── -->
<div class="view-tabs">
  <button
    class="view-tab"
    class:view-tab--active={teView === "calendar"}
    onclick={() => (teView = "calendar")}
  >
    Kalender
  </button>
  <button
    class="view-tab"
    class:view-tab--active={teView === "list"}
    onclick={() => (teView = "list")}
  >
    Liste
  </button>
</div>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<!-- ── Monats-Übersicht ───────────────────────────────────────────────── -->
{#if schedule}
  <div class="month-summary card-animate">
    <div class="msummary-item">
      <span class="msummary-label"
        >{hasMonthlyTarget ? "Soll (Monat)" : isMonthlyHours ? "Soll" : "Soll (bisher)"}</span
      >
      <span class="msummary-value"
        >{fmtMin(hasMonthlyTarget ? monthlyTarget : isMonthlyHours ? 0 : totalExpected)}h</span
      >
    </div>
    <div class="msummary-item">
      <span class="msummary-label">Ist</span>
      <span class="msummary-value">{fmtMin(totalWorked)}h</span>
    </div>
    <div class="msummary-divider"></div>
    <div class="msummary-item">
      <span class="msummary-label">Monat-Saldo</span>
      <span
        class="msummary-value bal {isMonthlyHours && !hasMonthlyTarget ? '' : balClass(mBalance)}"
        >{isMonthlyHours && !hasMonthlyTarget
          ? fmtMin(totalWorked) + "h"
          : fmtBalance(mBalance)}</span
      >
    </div>
    {#if overtimeTotalHours !== null}
      <div class="msummary-divider"></div>
      <div class="msummary-item">
        <span class="msummary-label">Gesamt-Saldo</span>
        <span class="msummary-value bal {balClass(Math.round(overtimeTotalHours * 60))}"
          >{fmtBalance(Math.round(overtimeTotalHours * 60))}</span
        >
      </div>
    {/if}
  </div>
{/if}

<!-- ── Monat-Navigation (snippet, wiederverwendet in Kalender + Liste) ───── -->
{#snippet navContent()}
  <button class="nav-btn" onclick={() => gotoMonth(-1)} title="Vorheriger Monat">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"><polyline points="15 18 9 12 15 6" /></svg
    >
  </button>
  <div class="cal-nav-center">
    <button
      class="cal-nav-title"
      onclick={() => {
        pickerYear = calMonth.getFullYear();
        showMonthPicker = !showMonthPicker;
      }}
      title="Monat/Jahr wählen"
    >
      {format(calMonth, "MMMM yyyy", { locale: de })}
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
          {#each MONTH_NAMES_SHORT as name, i (i)}
            <button
              class="month-picker-btn"
              class:active={i === calMonth.getMonth() && pickerYear === calMonth.getFullYear()}
              onclick={() => gotoMonthYear(i + 1, pickerYear)}>{name}</button
            >
          {/each}
        </div>
        <button class="month-picker-today" onclick={gotoToday}>Heute</button>
      </div>
    {/if}
  </div>
  <button class="nav-btn" onclick={() => gotoMonth(1)} title="Nächster Monat">
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg
    >
  </button>
{/snippet}

<!-- ── Kalender ─────────────────────────────────────────────────────────── -->
{#if teView === "calendar"}
  <div class="cal-section card card-animate">
    <div class="cal-nav">
      {@render navContent()}
    </div>
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
      <div class="cal-grid">
        {#each calendarDays as day (day.dateStr)}
          <div
            data-date={day.dateStr}
            class="cal-cell cal-cell--{day.status}{day.absenceType && !day.isWeekend
              ? ' cal-abs cal-abs-' + day.absenceType.toLowerCase()
              : ''}"
            class:cal-other={!day.isCurrentMonth}
            class:cal-current={day.isCurrentMonth}
            class:cal-today={day.isToday}
            class:cal-weekend={day.isWeekend}
            class:cal-holiday={day.isHoliday && day.isCurrentMonth}
            class:cal-selected={day.dateStr === selectedDate && day.isCurrentMonth}
            class:cal-cell--disabled={day.isBeforeHire && day.isCurrentMonth}
            class:cal-cell--arbzg-warn={arbzgDayMap.has(day.dateStr) && day.isCurrentMonth}
            title={day.isBeforeHire
              ? "Vor Eintrittsdatum"
              : day.isHoliday
                ? day.holidayName
                : day.absenceType
                  ? absenceLabel(day.absenceType) + (day.absenceHalf ? " (halber Tag)" : "")
                  : undefined}
            role="button"
            tabindex="0"
            onclick={() => {
              if (day.isCurrentMonth && !day.isBeforeHire) openAdd(day.dateStr);
            }}
            onkeydown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && day.isCurrentMonth && !day.isBeforeHire)
                openAdd(day.dateStr);
            }}
          >
            <span class="cal-day-num">{day.dayNum}</span>
            {#if day.isHoliday && day.isCurrentMonth}
              <span class="cal-holiday-label">{day.holidayName}</span>
            {:else if day.absenceType}
              <span class="cal-abs-type"
                >{absenceLabel(day.absenceType)}{day.absenceHalf ? " ½" : ""}</span
              >
            {/if}
            {#if day.isBeforeHire}
              <span class="day-before-hire">—</span>
            {:else if day.isCurrentMonth && day.hasEntries}
              <span class="day-worked">{fmtMin(day.workedMin)}&thinsp;h</span>
              {#if !isMonthlyHours && day.expectedMin > 0}
                {@const b = day.workedMin - day.expectedMin}
                <span class="day-bal {balClass(b)}">{b >= 0 ? "+" : "−"}{fmtMin(Math.abs(b))}</span>
              {/if}
            {:else if day.isCurrentMonth && !isMonthlyHours && day.expectedMin > 0 && !day.isFuture}
              <span class="day-missing">−{fmtMin(day.expectedMin)}&thinsp;h</span>
            {/if}
          </div>
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
    </div>
  </div>
{/if}

<!-- ── Listenansicht ──────────────────────────────────────────────────── -->
{#if teView === "list"}
  <div class="cal-nav month-nav-standalone">
    {@render navContent()}
  </div>
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
          {@const slotDate = (slot.date ?? slot.startTime).split("T")[0]}
          {@const slotArbzg = arbzgDayMap.get(slotDate)}
          <tr class:row-invalid={slot.isInvalid}>
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
            <td><span class="badge {sourceBadge(slot.source)}">{sourceLabel(slot.source)}</span></td
            >
            <td class="note-cell text-muted">
              {#if slot.isInvalid && slot.invalidReason}
                <span class="invalid-reason">{slot.invalidReason}</span>
              {:else}
                {slot.note ?? "---"}
              {/if}
            </td>
            <td class="action-cell">
              {#if slot.isInvalid && isManager}
                <span class="row-actions row-actions--visible">
                  <button
                    class="btn btn-sm btn-warning"
                    onclick={() => revalidateEntry(slot.id)}
                    title="Eintrag revalidieren und freigeben">Freigeben</button
                  >
                  <button class="btn-icon" onclick={() => openEdit(slot)} title="Korrigieren"
                    >✏️</button
                  >
                </span>
              {:else if deleteConfirmId === slot.id}
                <span class="del-confirm">
                  <span class="text-muted" style="font-size:0.8rem;">Löschen?</span>
                  <button class="btn btn-sm btn-danger" onclick={() => deleteEntry(slot.id)}
                    >Ja</button
                  >
                  <button class="btn btn-sm btn-ghost" onclick={() => (deleteConfirmId = "")}
                    >Nein</button
                  >
                </span>
              {:else}
                <span class="row-actions row-actions--visible">
                  <button class="btn-icon" onclick={() => openEdit(slot)} title="Bearbeiten"
                    >✏️</button
                  >
                  <button
                    class="btn-icon btn-icon-danger"
                    onclick={() => (deleteConfirmId = slot.id)}
                    title="Löschen">🗑</button
                  >
                </span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if allEntries.length === 0}
    <div class="empty-state card card-body">
      <span class="empty-icon">📋</span>
      <h3>Keine Einträge</h3>
      <p class="text-muted">Keine Zeiteinträge in diesem Monat.</p>
    </div>
  {/if}
{/if}

<!-- ── Modal ──────────────────────────────────────────────────────────────── -->
{#if modalOpen}
  <div class="modal-backdrop" onclick={self(closeModal)} role="presentation">
    <div class="modal-card card" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2>
          {editEntry
            ? isViewingOther
              ? `Eintrag korrigieren (${selectedEmployeeName})`
              : "Eintrag bearbeiten"
            : isViewingOther
              ? `Neuer Eintrag für ${selectedEmployeeName}`
              : "Neuen Eintrag hinzufügen"}
        </h2>
        <button class="btn-icon modal-close" onclick={closeModal} aria-label="Schließen">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><line x1="18" x2="6" y1="6" y2="18" /><line x1="6" x2="18" y1="6" y2="18" /></svg
          >
        </button>
      </div>
      <div class="modal-body">
        {#if saveError}
          <div class="alert alert-error" role="alert"><span>⚠</span><span>{saveError}</span></div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="f-date">Datum</label>
          <input id="f-date" type="date" bind:value={formDate} class="form-input" />
        </div>
        <div class="form-row-two">
          <div class="form-group">
            <label class="form-label" for="f-start">Arbeitsbeginn</label>
            <input id="f-start" type="time" bind:value={formStart} class="form-input" />
          </div>
          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label" for="f-end">Arbeitsende</label>
              <label class="end-toggle">
                <input type="checkbox" bind:checked={formHasEnd} aria-label="Arbeitsende erfasst" />
                <span class="text-muted" style="font-size:0.8rem;font-weight:400;">erfasst</span>
              </label>
            </div>
            <input
              id="f-end"
              type="time"
              bind:value={formEnd}
              class="form-input"
              disabled={!formHasEnd}
            />
          </div>
        </div>
        <div class="breaks-section">
          <span class="form-label">Pausen</span>
          {#if editEntry && !editEntry.breaks?.length && (editEntry.breakMinutes ?? 0) > 0 && formBreaks.length === 0}
            <div class="break-legacy">
              <span class="text-muted">Pauschale: {editEntry.breakMinutes} Min.</span>
              <button
                class="btn btn-sm btn-ghost"
                type="button"
                onclick={() => {
                  formBreaks = [
                    { start: "12:00", end: addMinutesToTime("12:00", editEntry!.breakMinutes) },
                  ];
                }}>In Pausen umwandeln</button
              >
            </div>
          {/if}
          {#each formBreaks as brk, i (i)}
            <div class="break-row">
              <input
                type="time"
                bind:value={brk.start}
                class="form-input"
                aria-label={`Pause ${i + 1} Beginn`}
              />
              <span class="break-sep">&ndash;</span>
              <input
                type="time"
                bind:value={brk.end}
                class="form-input"
                aria-label={`Pause ${i + 1} Ende`}
              />
              <button
                class="btn-icon"
                type="button"
                onclick={() => (formBreaks = formBreaks.filter((_, j) => j !== i))}
                title="Pause entfernen">✕</button
              >
            </div>
          {/each}
          <button
            class="btn btn-sm btn-ghost"
            type="button"
            onclick={() => (formBreaks = [...formBreaks, { start: "12:00", end: "12:30" }])}
            >+ Pause hinzufügen</button
          >
          {#if formBreakTotal > 0}
            <span class="text-muted break-total">Gesamt: {formBreakTotal} Min.</span>
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
          />
        </div>
      </div>
      {#if modalWarnings.length > 0}
        <div class="modal-arbzg-warnings">
          {#each modalWarnings as w (w.code)}
            <div class="arbzg-alert arbzg-{w.severity}" role="alert">
              <span class="arbzg-icon">{w.severity === "error" ? "⛔" : "⚠️"}</span>
              <span>{w.message}</span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeModal} disabled={saving}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveEntry} disabled={saving}>
          {saving ? "Speichern…" : editEntry ? "Änderungen speichern" : "Eintrag hinzufügen"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* page-header-compact → global in app.css */

  /* ── Employee Selector (Manager) ────────────────────────────────── */
  .employee-selector {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
    background: var(--color-brand-tint);
    border: 1px solid var(--color-brand-tint-hover);
    border-radius: 8px;
  }
  .employee-selector .form-label {
    margin: 0;
    white-space: nowrap;
    font-weight: 500;
  }
  .employee-selector .form-input {
    max-width: 320px;
  }
  .viewing-other-hint {
    font-size: 0.85rem;
    color: var(--color-brand);
    font-weight: 500;
  }

  /* ── Warning button ────────────────────────────────────────────── */
  .btn-warning {
    background: var(--color-yellow);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 0.25rem 0.625rem;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
  }
  .btn-warning:hover {
    background: var(--color-yellow-border);
  }

  /* ── Kalender ─────────────────────────────────────────────────────── */
  .month-nav-standalone {
    border: 1px solid var(--gray-200, #e5e7eb);
    border-radius: var(--radius-lg, 0.75rem);
    margin-bottom: 1rem;
  }

  .bal.pos {
    color: #16a34a;
  }
  .bal.neg {
    color: #dc2626;
  }

  /* ── Summary Bar ─────────────────────────────────────── */
  .month-summary {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.875rem 1.25rem;
    background: var(--glass-bg, rgba(255, 255, 255, 0.6));
    border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.5));
    border-radius: var(--radius-md);
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
    font-size: 0.875rem;
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
  }
  .msummary-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .msummary-divider {
    width: 1px;
    height: 1.25rem;
    background: var(--color-border);
    flex-shrink: 0;
  }
  .msummary-label {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .msummary-value {
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-text-heading);
    font-size: 0.9375rem;
  }

  /* ── View Tabs ───────────────────────────────────────── */
  /* view-tabs, view-tab → global in app.css */

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

  .cal-cell {
    min-height: 72px;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    cursor: pointer;
    transition:
      background 0.12s,
      box-shadow 0.12s;
    position: relative;
  }

  /* Tage vor dem Eintrittsdatum */
  :global(.cal-cell.cal-cell--disabled) {
    opacity: 0.4;
    pointer-events: none;
    cursor: default;
    background: var(--gray-50, #f9fafb) !important;
  }

  :global(.cal-cell.cal-cell--arbzg-warn) {
    border-left: 3px solid var(--color-yellow);
    background: color-mix(in srgb, var(--color-yellow) 8%, transparent);
  }
  .day-before-hire {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    opacity: 0.5;
  }
  .cal-cell:not(.cal-other):hover {
    background: color-mix(in srgb, var(--color-brand) 8%, transparent);
    box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-brand) 25%, transparent);
  }

  /* Status-Farben */
  .cal-cell--ok {
    background: var(--color-green-bg);
    border-left: 3px solid var(--color-green);
  }
  .cal-cell--partial {
    background: var(--color-yellow-bg);
    border-left: 3px solid var(--color-yellow);
  }
  .cal-cell--missing {
    background: var(--color-red-bg);
    border-left: 3px solid var(--color-red);
  }
  .cal-cell--today-ok {
    background: var(--color-green-bg);
    border-left: 3px solid var(--color-green);
  }
  .cal-cell--today-partial {
    background: var(--color-yellow-bg);
    border-left: 3px solid var(--color-yellow);
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
    font-size: 0.75rem;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-text);
  }
  .day-bal {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .day-bal.pos {
    color: var(--color-green);
  }
  .day-bal.neg {
    color: var(--color-red);
  }
  .day-missing {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: var(--color-red);
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
    color: var(--color-text-muted);
  }
  .leg::before {
    content: "";
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .leg-ok::before {
    background: var(--color-green-bg);
    border: 1px solid color-mix(in srgb, var(--color-green) 25%, transparent);
  }
  .leg-partial::before {
    background: var(--color-yellow-bg);
    border: 1px solid color-mix(in srgb, var(--color-yellow) 25%, transparent);
  }
  .leg-missing::before {
    background: var(--color-red-bg);
    border: 1px solid color-mix(in srgb, var(--color-red) 25%, transparent);
  }
  .leg-noexpect::before {
    background: var(--gray-100, #f3f4f6);
    border: 1px solid var(--gray-200);
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
    border-bottom: 1px solid var(--gray-100, #f3f4f6);
    background: var(--gray-50, #f9fafb);
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
    color: var(--color-text-muted);
  }
  .dstat strong {
    color: var(--color-text);
    font-weight: 600;
  }
  .dstat.bal.pos strong {
    color: #16a34a;
  }
  .dstat.bal.neg strong {
    color: #dc2626;
  }

  .day-empty {
    padding: 1.5rem 1rem;
    display: flex;
    align-items: center;
    color: var(--color-text-muted);
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
    color: var(--color-text-muted);
    text-align: left;
    white-space: nowrap;
    background: var(--gray-50, #f9fafb);
    border-bottom: 1px solid var(--gray-200);
  }
  .slots-table tbody td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--gray-100, #f3f4f6);
    vertical-align: middle;
  }
  .slots-table tbody tr:hover {
    background: var(--gray-50, #f9fafb);
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
    background: #fef2f2;
  }

  .row-invalid {
    opacity: 0.5;
  }
  .row-invalid td {
    text-decoration: line-through;
    background: #fef2f2;
  }
  .row-invalid td:last-child {
    text-decoration: none;
  }
  .row-invalid .invalid-reason {
    color: #dc2626;
    font-size: 0.8rem;
    font-weight: 500;
    text-decoration: none;
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
    color: var(--color-text-muted);
    transition: background 0.15s;
  }
  .btn-icon:hover {
    background: var(--gray-100);
  }
  .btn-icon-danger {
    color: var(--color-text-muted);
  }
  .btn-icon-danger:hover {
    background: #fef2f2;
    color: #dc2626;
  }

  /* Ensure delete confirmation button has white text on red background */
  .del-confirm :global(.btn-danger) {
    color: #fff !important;
  }
  .btn-danger-sm {
    color: white;
    background: #ef4444;
    border-radius: 4px;
    font-size: 0.8125rem;
    padding: 0.125rem 0.375rem;
  }

  /* ── Modal ────────────────────────────────────────────────────────── */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 500;
    padding: 1rem;
    backdrop-filter: blur(4px);
    animation: backdrop-in 0.15s ease;
  }
  @keyframes backdrop-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  .modal-card {
    width: 100%;
    max-width: 460px;
    max-height: 88vh;
    overflow-y: auto;
    padding: 0;
    background: var(--glass-bg-strong, var(--color-surface));
    backdrop-filter: blur(var(--glass-blur, 16px));
    -webkit-backdrop-filter: blur(var(--glass-blur, 16px));
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    animation: modal-in 0.2s var(--ease-out);
  }
  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(12px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem 1rem;
    border-bottom: 1px solid var(--gray-200);
  }
  .modal-header h2 {
    font-size: 1.0625rem;
    font-weight: 600;
    margin: 0;
  }
  .modal-close {
    color: var(--color-text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background-color 0.15s,
      color 0.15s;
  }
  .modal-close:hover {
    background-color: var(--color-bg-subtle);
    color: var(--color-text);
  }
  .modal-body {
    padding: 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.625rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--gray-200);
    background: var(--gray-50, #f9fafb);
  }
  .form-row-two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
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
    color: var(--color-text-muted);
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
    background: var(--gray-50, #f9fafb);
    border-radius: 6px;
    font-size: 0.8125rem;
  }
  .break-cell {
    font-size: 0.8125rem;
    white-space: nowrap;
  }

  /* ── ArbZG-Warnungen ──────────────────────────────────────────────── */
  .modal-arbzg-warnings {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0 1.25rem 0.5rem;
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
    background: var(--gray-900, #111827);
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

  .arbzg-alert {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    font-size: 0.875rem;
    line-height: 1.5;
    animation: fadein 0.2s ease;
  }

  @keyframes fadein {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
    }
  }

  .arbzg-warning {
    background: #fffbeb;
    border: 1.5px solid #fbbf24;
    color: #92400e;
  }
  .arbzg-error {
    background: #fef2f2;
    border: 1.5px solid #f87171;
    color: #991b1b;
  }

  .arbzg-icon {
    font-size: 1rem;
    line-height: 1.5;
    flex-shrink: 0;
  }

  .arbzg-alert span:nth-child(2) {
    flex: 1;
  }

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
