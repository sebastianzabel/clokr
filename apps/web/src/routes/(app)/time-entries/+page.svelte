<script lang="ts">
  import { self } from "svelte/legacy";

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { format, startOfMonth, endOfMonth, parseISO, addMonths, subMonths } from "date-fns";
  import { de } from "date-fns/locale";

  interface TimeEntry {
    id: string;
    date: string;
    startTime: string;
    endTime: string | null;
    breakMinutes: number;
    type: string;
    source: "NFC" | "MOBILE" | "MANUAL" | "CORRECTION";
    note: string | null;
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

  // ── State ─────────────────────────────────────────────────────────────────
  let entries: TimeEntry[] = $state([]);
  let schedule: WorkSchedule | null = $state(null);
  let holidays: Map<string, string> = new Map(); // dateStr → name
  let calendarDays: CalDay[] = $state([]);
  let loading = $state(false);
  let error = $state("");
  let saving = $state(false);
  let saveError = $state("");
  let arbzgWarnings: ArbZGWarning[] = $state([]);
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

  // Modal
  let modalOpen = $state(false);
  let editEntry: TimeEntry | null = $state(null);
  let formDate = $state(todayStr);
  let formStart = $state("09:00");
  let formEnd = $state("17:00");
  let formHasEnd = $state(true);
  let formBreak = $state(0);
  let formNote = $state("");

  const employeeId = $authStore.user?.employeeId;

  // ── Laden ─────────────────────────────────────────────────────────────────
  onMount(loadAll);

  async function loadAll() {
    loading = true;
    error = "";
    try {
      const year = calMonth.getFullYear();
      const [
        rawEntries,
        rawSchedule,
        rawHolidays,
        rawAbsences,
        rawOvertime,
        rawEmployee,
        rawConfig,
      ] = await Promise.all([
        api.get<TimeEntry[]>(`/time-entries?from=${fromDate}&to=${toDate}`),
        employeeId
          ? api.get<WorkSchedule>(`/settings/work/${employeeId}`).catch(() => null)
          : Promise.resolve(null),
        api.get<PublicHoliday[]>(`/holidays?year=${year}`).catch(() => [] as PublicHoliday[]),
        employeeId
          ? api
              .get<Absence[]>(`/leave/requests?status=APPROVED&employeeId=${employeeId}`)
              .catch(() => [] as Absence[])
          : Promise.resolve([] as Absence[]),
        employeeId
          ? api.get<{ balanceHours: number }>(`/overtime/${employeeId}`).catch(() => null)
          : Promise.resolve(null),
        employeeId
          ? api.get<{ hireDate?: string }>(`/employees/${employeeId}`).catch(() => null)
          : Promise.resolve(null),
        api.get<{ arbzgEnabled?: boolean }>("/settings/work").catch(() => null),
      ]);
      entries = rawEntries;
      schedule = rawSchedule;
      holidays = new Map(rawHolidays.map((h) => [h.date.split("T")[0], h.name]));
      absences = rawAbsences;
      overtimeTotalHours = rawOvertime ? Number(rawOvertime.balanceHours) : null;
      hireDate = rawEmployee?.hireDate ? rawEmployee.hireDate.split("T")[0] : null;
      arbzgEnabled = rawConfig?.arbzgEnabled !== false;
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

  async function gotoMonth(dir: 1 | -1) {
    calMonth = dir === 1 ? addMonths(calMonth, 1) : subMonths(calMonth, 1);
    fromDate = format(startOfMonth(calMonth), "yyyy-MM-dd");
    toDate = format(endOfMonth(calMonth), "yyyy-MM-dd");
    // Selektion auf ersten Tag des neuen Monats setzen
    selectedDate = fromDate;
    await loadAll();
  }

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
      if (!e.endTime) return sum;
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

  function slotNet(e: TimeEntry): string {
    if (!e.endTime) return "läuft…";
    const net =
      Math.floor((new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60000) -
      (e.breakMinutes ?? 0);
    return net < 0 ? "–" : fmtMin(net) + " h";
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  function openAdd(forDate?: string) {
    editEntry = null;
    formDate = forDate ?? selectedDate;
    formStart = "09:00";
    formEnd = "17:00";
    formHasEnd = true;
    formBreak = 0;
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
    formBreak = entry.breakMinutes ?? 0;
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
    arbzgWarnings = [];
    const startISO = new Date(`${formDate}T${formStart}:00`).toISOString();
    const endISO = formHasEnd ? new Date(`${formDate}T${formEnd}:00`).toISOString() : null;
    try {
      let result: { entry: TimeEntry; warnings: ArbZGWarning[] };
      if (editEntry) {
        result = await api.put(`/time-entries/${editEntry.id}`, {
          date: formDate,
          startTime: startISO,
          endTime: endISO,
          breakMinutes: formBreak,
          note: formNote || null,
        });
      } else {
        result = await api.post("/time-entries", {
          date: formDate,
          startTime: startISO,
          endTime: endISO,
          breakMinutes: formBreak,
          note: formNote || null,
        });
      }
      closeModal();
      await loadAll();
      if (result?.warnings?.length) {
        arbzgWarnings = result.warnings;
        // nach 10s automatisch ausblenden
        setTimeout(() => {
          arbzgWarnings = [];
        }, 10000);
      }
    } catch (e: unknown) {
      saveError = e instanceof Error ? e.message : "Fehler beim Speichern";
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
      error = e instanceof Error ? e.message : "Fehler beim Löschen";
    }
  }

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
      if (gap > 0) gapBreak += gap;
    }
    const totalBreak = explicitBreak + gapBreak;

    if (netMin > 9 * 60 && totalBreak < 45)
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "error",
        message: `§ 4 ArbZG: Bei über 9h Arbeitszeit mind. 45 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });
    else if (netMin > 6 * 60 && totalBreak < 30)
      warnings.push({
        code: "BREAK_TOO_SHORT",
        severity: "warning",
        message: `§ 4 ArbZG: Bei über 6h Arbeitszeit mind. 30 Min. Pause erforderlich (${Math.round(totalBreak)} Min. erfasst)`,
      });

    if (netMin > 10 * 60)
      warnings.push({
        code: "MAX_DAILY_EXCEEDED",
        severity: "error",
        message: `§ 3 ArbZG: Tagesgrenze von 10h überschritten (${(netMin / 60).toFixed(1)}h)`,
      });
    else if (netMin > 8 * 60)
      warnings.push({
        code: "MAX_DAILY_EXCEEDED",
        severity: "warning",
        message: `§ 3 ArbZG: Reguläre Tagessoll von 8h überschritten (${(netMin / 60).toFixed(1)}h) – max. 10h erlaubt`,
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
  let selectedSlots = $derived(
    entries
      .filter((e) => (e.date ?? e.startTime).split("T")[0] === selectedDate)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
  );
  let selectedExpected = $derived(
    (() => {
      if (!schedule) return 0;
      const d = parseISO(selectedDate);
      return getDayExpected(schedule, d) * 60;
    })(),
  );
  let selectedWorked = $derived(sumWorked(selectedSlots));
  let selectedBalance = $derived(selectedWorked - selectedExpected);
  let totalWorked = $derived(
    entries.reduce((s, e) => {
      if (!e.endTime) return s;
      return (
        s +
        Math.floor((new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60000) -
        (e.breakMinutes ?? 0)
      );
    }, 0),
  );
  let totalExpected = $derived(
    calendarDays
      .filter((d) => d.isCurrentMonth && !d.isFuture)
      .reduce((s, d) => s + d.expectedMin, 0),
  );
  let dayWarnings = $derived(arbzgEnabled ? checkArbZGFrontend(selectedSlots) : []);
  // Formatierter Label für den ausgewählten Tag
  let selectedLabel = $derived(
    format(parseISO(selectedDate), "EEEE, d. MMMM yyyy", { locale: de }),
  );

  // ArbZG-Verstoß-Map: dateStr → true wenn Verstoß an diesem Tag
  let arbzgDayMap = $derived.by(() => {
    if (!arbzgEnabled) return new Map<string, boolean>();
    const map = new Map<string, boolean>();
    // Group entries by date
    const byDate = new Map<string, TimeEntry[]>();
    for (const e of entries) {
      const d = e.date.split("T")[0];
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(e);
    }
    for (const [dateStr, dayEntries] of byDate) {
      const warnings = checkArbZGFrontend(dayEntries);
      if (warnings.length > 0) map.set(dateStr, true);
    }
    return map;
  });
</script>

<svelte:head><title>Zeiteinträge – Clokr</title></svelte:head>

<div class="page-header">
  <div class="header-row">
    <div>
      <h1>Zeiteinträge</h1>
      <p>{schedule ? "Arbeitszeitplan aktiv" : "Kein Arbeitszeitplan hinterlegt"}</p>
    </div>
    <button class="btn btn-primary" onclick={() => openAdd()}>
      <span aria-hidden="true">＋</span> Slot hinzufügen
    </button>
  </div>
</div>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<!-- ── Monats-Übersicht ───────────────────────────────────────────────── -->
{#if schedule}
  <div class="month-stats-card card">
    {#if !isMonthlyHours || hasMonthlyTarget}
      <div class="mstat-item">
        <span class="mstat-label">{hasMonthlyTarget ? "Soll (Monat)" : "Soll (bisher)"}</span>
        <span class="mstat-value"
          >{fmtMin(hasMonthlyTarget ? monthlyTarget : totalExpected)}&thinsp;h</span
        >
      </div>
      <div class="mstat-sep"></div>
    {/if}
    <div class="mstat-item">
      <span class="mstat-label">{isMonthlyHours && !hasMonthlyTarget ? "Geleistet" : "Ist"}</span>
      <span class="mstat-value">{fmtMin(totalWorked)}&thinsp;h</span>
    </div>
    {#if !isMonthlyHours || hasMonthlyTarget}
      <div class="mstat-sep"></div>
      <div class="mstat-item">
        <span class="mstat-label">Monat-Saldo</span>
        <span class="mstat-value bal {balClass(mBalance)}">{fmtBalance(mBalance)}</span>
      </div>
    {/if}
    {#if overtimeTotalHours !== null}
      <div class="mstat-sep"></div>
      <div class="mstat-item mstat-item--total">
        <span class="mstat-label">Gesamt-Saldo</span>
        <span class="mstat-value bal {balClass(Math.round(overtimeTotalHours * 60))}"
          >{fmtBalance(Math.round(overtimeTotalHours * 60))}</span
        >
      </div>
    {/if}
  </div>
{/if}

<!-- ── Kalender ─────────────────────────────────────────────────────────── -->
<div class="cal-section card">
  <!-- Monat-Navigation -->
  <div class="cal-nav">
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
    <span class="cal-month-title">{format(calMonth, "MMMM yyyy", { locale: de })}</span>
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
  </div>

  <!-- Wochentage-Header -->
  <div class="cal-grid cal-header-row">
    {#each ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as d}
      <div class="cal-dow">{d}</div>
    {/each}
  </div>

  <!-- Tage -->
  {#if loading}
    <div class="cal-grid">
      {#each Array(35) as _}<div class="cal-day skeleton"></div>{/each}
    </div>
  {:else}
    <div class="cal-grid">
      {#each calendarDays as day (day.dateStr)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div
          class="cal-day cal-day--{day.status}{day.absenceType && !day.isWeekend
            ? ' cal-day--abs cal-day--abs-' + day.absenceType.toLowerCase()
            : ''}"
          class:other-month={!day.isCurrentMonth && !day.absenceType && !day.isWeekend}
          class:is-today={day.isToday}
          class:is-weekend={day.isWeekend}
          class:is-holiday={day.isHoliday && day.isCurrentMonth}
          class:is-selected={day.dateStr === selectedDate && day.isCurrentMonth}
          class:cal-day--disabled={day.isBeforeHire && day.isCurrentMonth}
          class:cal-day--arbzg-warn={arbzgDayMap.has(day.dateStr) && day.isCurrentMonth}
          title={day.isBeforeHire
            ? "Vor Eintrittsdatum"
            : day.isHoliday
              ? day.holidayName
              : day.absenceType
                ? absenceLabel(day.absenceType) + (day.absenceHalf ? " (halber Tag)" : "")
                : undefined}
          onclick={() => {
            if (day.isCurrentMonth && !day.isBeforeHire) selectedDate = day.dateStr;
          }}
        >
          <span class="day-num">{day.dayNum}</span>
          {#if day.isHoliday && day.isCurrentMonth}
            <span class="day-holiday-name">{day.holidayName}</span>
          {:else if day.absenceType}
            <span class="day-abs-type"
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

<!-- ── ArbZG-Warnungen ─────────────────────────────────────────────────── -->
{#if arbzgEnabled && arbzgWarnings.length > 0}
  <div class="arbzg-warnings">
    {#each arbzgWarnings as w (w.code)}
      <div class="arbzg-alert arbzg-{w.severity}" role="alert">
        <span class="arbzg-icon">{w.severity === "error" ? "⛔" : "⚠️"}</span>
        <span>{w.message}</span>
        <button
          class="arbzg-close"
          onclick={() => (arbzgWarnings = arbzgWarnings.filter((x) => x !== w))}>✕</button
        >
      </div>
    {/each}
  </div>
{/if}

<!-- ── Tagesdetail ──────────────────────────────────────────────────────── -->
<div class="day-detail card">
  <div class="day-detail-header">
    <div class="day-detail-title">
      <span class="day-detail-label">{selectedLabel}</span>
      {#if schedule}
        <div class="day-detail-stats">
          {#if !isMonthlyHours}
            <span class="dstat">Soll <strong>{fmtMin(selectedExpected)}&thinsp;h</strong></span>
          {/if}
          <span class="dstat">Ist <strong>{fmtMin(selectedWorked)}&thinsp;h</strong></span>
          {#if selectedSlots.some((s) => !s.endTime)}
            <span class="badge badge-green" style="font-size:0.75rem;">Aktiv</span>
          {:else if !isMonthlyHours}
            <span class="dstat bal {balClass(selectedBalance)}">
              Saldo <strong>{fmtBalance(selectedBalance)}</strong>
            </span>
          {/if}
        </div>
      {/if}
    </div>
    <button class="btn btn-primary btn-sm" onclick={() => openAdd(selectedDate)}>
      <span aria-hidden="true">＋</span> Slot
    </button>
  </div>

  {#if dayWarnings.length > 0}
    <div class="day-warnings">
      {#each dayWarnings as w (w.code)}
        <div class="arbzg-alert arbzg-{w.severity}" role="alert">
          <span class="arbzg-icon">{w.severity === "error" ? "⛔" : "⚠️"}</span>
          <span>{w.message}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if selectedSlots.length === 0}
    <div class="day-empty">
      {#if parseISO(selectedDate) > today}
        <span class="text-muted">Zukünftiger Tag – noch keine Einträge.</span>
      {:else}
        <span class="text-muted">Keine Einträge für diesen Tag.</span>
        <button
          class="btn btn-ghost btn-sm"
          onclick={() => openAdd(selectedDate)}
          style="margin-left:0.5rem;"
        >
          Slot hinzufügen
        </button>
      {/if}
    </div>
  {:else}
    <div class="slots-wrap">
      <table class="slots-table">
        <thead>
          <tr>
            <th>Von</th><th>Bis</th><th>Pause</th>
            <th>Netto</th><th>Quelle</th><th>Notiz</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each selectedSlots as slot (slot.id)}
            <tr class:row-del={deleteConfirmId === slot.id}>
              <td class="mono">{fmtTime(slot.startTime)}</td>
              <td class="mono">
                {#if slot.endTime}{fmtTime(slot.endTime)}
                {:else}<span class="badge badge-green">Aktiv</span>{/if}
              </td>
              <td>{slot.breakMinutes ? slot.breakMinutes + " Min." : "—"}</td>
              <td class="mono fw-med">{slotNet(slot)}</td>
              <td
                ><span class="badge {sourceBadge(slot.source)}">{sourceLabel(slot.source)}</span
                ></td
              >
              <td class="note-cell text-muted">{slot.note ?? "—"}</td>
              <td class="actions-cell">
                {#if deleteConfirmId === slot.id}
                  <span class="del-confirm">
                    <span class="text-muted" style="font-size:0.8rem;">Löschen?</span>
                    <button class="btn-icon btn-danger-sm" onclick={() => deleteEntry(slot.id)}
                      >✓</button
                    >
                    <button class="btn-icon" onclick={() => (deleteConfirmId = "")}>✕</button>
                  </span>
                {:else}
                  <span class="row-actions">
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
  {/if}
</div>

<!-- ── Modal ──────────────────────────────────────────────────────────────── -->
{#if modalOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={self(closeModal)} role="dialog" aria-modal="true">
    <div class="modal-card card">
      <div class="modal-header">
        <h2>{editEntry ? "Slot bearbeiten" : "Neuen Slot hinzufügen"}</h2>
        <button class="btn-icon modal-close" onclick={closeModal}>✕</button>
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
            <label class="form-label" for="f-end">
              Arbeitsende
              <label class="end-toggle">
                <input type="checkbox" bind:checked={formHasEnd} />
                <span class="text-muted" style="font-size:0.8rem;font-weight:400;">erfasst</span>
              </label>
            </label>
            <input
              id="f-end"
              type="time"
              bind:value={formEnd}
              class="form-input"
              disabled={!formHasEnd}
            />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="f-break">Pause (Minuten)</label>
          <input
            id="f-break"
            type="number"
            min="0"
            max="480"
            step="5"
            bind:value={formBreak}
            class="form-input"
            style="max-width:120px;"
          />
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
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeModal} disabled={saving}>Abbrechen</button>
        <button class="btn btn-primary" onclick={saveEntry} disabled={saving}>
          {saving ? "Speichern…" : editEntry ? "Änderungen speichern" : "Slot hinzufügen"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  /* ── Kalender ─────────────────────────────────────────────────────── */
  .cal-section {
    padding: 0;
    overflow: hidden;
    margin-bottom: 1rem;
  }

  .cal-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 1.25rem;
    border-bottom: 1px solid var(--gray-100, #f3f4f6);
  }

  .nav-btn {
    background: none;
    border: 1.5px solid var(--gray-200, #e5e7eb);
    border-radius: 8px;
    padding: 0.375rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: var(--color-text);
    transition: background 0.15s;
  }
  .nav-btn:hover {
    background: var(--gray-100, #f3f4f6);
  }

  .cal-month-title {
    font-size: 1.0625rem;
    font-weight: 700;
    text-transform: capitalize;
  }

  .bal.pos {
    color: #16a34a;
  }
  .bal.neg {
    color: #dc2626;
  }

  /* ── Monats-Übersicht ──────────────────────────────────────────────── */
  .month-stats-card {
    display: flex;
    align-items: stretch;
    gap: 0;
    padding: 0;
    overflow: hidden;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .mstat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 0.875rem 1.25rem;
    gap: 0.2rem;
    min-width: 100px;
  }
  .mstat-item--total {
    background: var(--gray-50, #f9fafb);
  }
  .mstat-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .mstat-value {
    font-size: 1.25rem;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-text);
  }
  .mstat-value.bal.pos {
    color: #16a34a;
  }
  .mstat-value.bal.neg {
    color: #dc2626;
  }
  .mstat-sep {
    width: 1px;
    background: var(--gray-100, #f3f4f6);
    align-self: stretch;
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
  }

  .cal-header-row {
    border-bottom: 1.5px solid var(--gray-200, #e5e7eb);
    background: var(--gray-50, #f9fafb);
  }

  .cal-dow {
    padding: 0.5rem;
    text-align: center;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }

  .cal-day {
    min-height: 100px;
    padding: 0.5rem 0.625rem;
    border-right: 1px solid var(--gray-100, #f3f4f6);
    border-bottom: 1px solid var(--gray-100, #f3f4f6);
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    cursor: pointer;
    transition: background 0.12s;
    position: relative;
  }
  .cal-day:nth-child(7n) {
    border-right: none;
  }

  .cal-day.other-month {
    opacity: 0.3;
    cursor: default;
    background: var(--gray-50, #f9fafb);
  }

  /* Tage vor dem Eintrittsdatum */
  :global(.cal-day.cal-day--disabled) {
    opacity: 0.4;
    pointer-events: none;
    cursor: default;
    background: var(--gray-50, #f9fafb) !important;
  }

  :global(.cal-day.cal-day--arbzg-warn) {
    border-left: 3px solid #f59e0b;
    background: rgba(245, 158, 11, 0.08);
  }
  .day-before-hire {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    opacity: 0.5;
  }
  .cal-day:not(.other-month):hover {
    background: color-mix(in srgb, var(--brand) 8%, transparent);
  }

  .cal-day.is-today {
    box-shadow: inset 0 0 0 2px var(--brand);
  }

  /* :global nötig – Svelte doppelt den Scope-Hash bei Compound-Selektoren */
  :global(.cal-day.is-selected:not(.other-month)) {
    background-color: #80377b !important;
    box-shadow: none !important;
  }
  :global(.cal-day.is-selected:not(.other-month) .day-num),
  :global(.cal-day.is-selected:not(.other-month) .day-worked),
  :global(.cal-day.is-selected:not(.other-month) .day-bal),
  :global(.cal-day.is-selected:not(.other-month) .day-missing) {
    color: white !important;
  }
  :global(.cal-day.is-selected.is-today:not(.other-month) .day-num) {
    background: rgba(255, 255, 255, 0.25);
    color: white;
  }

  /* Wochenende + Feiertage */
  :global(.cal-day.is-weekend:not(.is-selected)) {
    background-color: #f4f0fa !important;
  }
  :global(.cal-day.is-holiday:not(.other-month):not(.is-selected)) {
    background-color: #ede7f6 !important;
    border-left: 3px solid #80377b;
  }
  .day-holiday-name {
    display: block;
    font-size: 0.6rem;
    color: #80377b;
    font-weight: 600;
    line-height: 1.2;
    margin-top: 0.1rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Status-Farben */
  .cal-day--ok {
    background: #f0fdf4;
  }
  .cal-day--partial {
    background: #fffbeb;
  }
  .cal-day--missing {
    background: #fef2f2;
  }
  .cal-day--today-ok {
    background: #f0fdf4;
  }
  .cal-day--today-partial {
    background: #fffbeb;
  }

  /* Abwesenheitsfarben – allgemein (überschreiben Status-Farben) */
  :global(.cal-day.cal-day--abs-vacation:not(.is-selected)) {
    background: #dbeafe !important;
    opacity: 1;
  }
  :global(.cal-day.cal-day--abs-sick:not(.is-selected)) {
    background: #fee2e2 !important;
    opacity: 1;
  }
  :global(.cal-day.cal-day--abs-special:not(.is-selected)) {
    background: #ede9fe !important;
    opacity: 1;
  }
  :global(.cal-day.cal-day--abs-overtime_comp:not(.is-selected)) {
    background: #dcfce7 !important;
    opacity: 1;
  }
  /* Nachbarmonat-Tage mit Abwesenheit etwas heller darstellen */

  .day-abs-type {
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

  .day-num {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text-muted);
    line-height: 1;
  }
  .is-today .day-num {
    background: var(--brand);
    color: white;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
  }
  .day-worked {
    font-size: 0.75rem;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--color-text);
  }
  .day-bal {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .day-bal.pos {
    color: #16a34a;
  }
  .day-bal.neg {
    color: #dc2626;
  }
  .day-missing {
    font-size: 0.7rem;
    font-family: var(--font-mono);
    color: #dc2626;
    opacity: 0.75;
  }

  /* Legende */
  .cal-legend {
    display: flex;
    gap: 1rem;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--gray-100, #f3f4f6);
    flex-wrap: wrap;
  }
  .leg {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: var(--color-text-muted);
  }
  .leg::before {
    content: "";
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
  }
  .leg-ok::before {
    background: #dcfce7;
    border: 1px solid #16a34a40;
  }
  .leg-partial::before {
    background: #fef9c3;
    border: 1px solid #ca8a0440;
  }
  .leg-missing::before {
    background: #fee2e2;
    border: 1px solid #dc262640;
  }
  .leg-noexpect::before {
    background: var(--gray-100, #f3f4f6);
    border: 1px solid var(--gray-200);
  }
  .leg-abs-vacation::before {
    background: #dbeafe;
    border: 1px solid #3b82f640;
  }
  .leg-abs-sick::before {
    background: #fee2e2;
    border: 1px solid #ef444440;
  }
  .leg-abs-special::before {
    background: #ede9fe;
    border: 1px solid #8b5cf640;
  }
  .leg-abs-overtime_comp::before {
    background: #dcfce7;
    border: 1px solid #22c55e40;
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
  .btn-icon-danger:hover {
    background: #fef2f2;
    color: #dc2626;
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
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 1rem;
    backdrop-filter: blur(2px);
  }
  .modal-card {
    width: 100%;
    max-width: 460px;
    padding: 0;
    overflow: hidden;
    animation: modal-in 0.18s ease;
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

  /* ── ArbZG-Warnungen ──────────────────────────────────────────────── */
  .arbzg-warnings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
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

  .arbzg-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.875rem;
    color: inherit;
    opacity: 0.6;
    padding: 0;
    line-height: 1.5;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }
  .arbzg-close:hover {
    opacity: 1;
  }
</style>
