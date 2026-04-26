<script lang="ts">
  import { self } from "svelte/legacy";

  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import Pagination from "$components/ui/Pagination.svelte";

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

  const SICK_CODES: TypeCode[] = ["SICK", "SICK_CHILD"];

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

  // Review-Modal
  let reviewModal: LeaveRequest | null = $state(null);
  let reviewOverlap: OverlapEntry[] = $state([]);
  let reviewNote = $state("");
  let reviewSaving = $state(false);
  let reviewError = $state("");

  // Attest-State im Review-Modal
  let reviewAttestPresent = $state(false);
  let reviewAttestFrom = $state("");
  let reviewAttestTo = $state("");

  // Highlighted request (from notification deep-link)
  let highlightRequestId: string | null = $state(null);

  // ── Kalender ──────────────────────────────────────────────────────────────
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
  }

  interface CalDay {
    date: Date;
    dateStr: string;
    dayNum: number;
    isCurrentMonth: boolean;
    isToday: boolean;
    isWeekend: boolean;
  }

  type View = "calendar" | "list" | "approvals";
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
    const n = new Date();
    const prevYear = calYear;
    calMonth = n.getMonth() + 1;
    calYear = n.getFullYear();
    showMonthPicker = false;
    loadCalendar();
    if (calYear !== prevYear) loadData();
  }

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
  async function loadData() {
    loading = true;
    error = "";
    try {
      const year = new Date().getFullYear();
      const [all, pending, emps] = await Promise.all([
        api.get<LeaveRequest[]>(`/leave/requests?year=${year}`),
        api.get<LeaveRequest[]>(`/leave/requests?status=PENDING`),
        api.get<Employee[]>("/employees"),
      ]);
      allTeamRequests = all;
      pendingRequests = pending;
      employees = emps;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    await loadData();
    loadCalendar();

    // Deep-link: highlight a specific request from notification
    const requestId = $page.url.searchParams.get("request");
    if (requestId) {
      highlightRequestId = requestId;
      view = "approvals";
      requestAnimationFrame(() => {
        const el = document.getElementById(`request-${requestId}`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      setTimeout(() => {
        highlightRequestId = null;
      }, 3000);
    }
  });

  // ── Review-Modal ──────────────────────────────────────────────────────────
  async function openReview(req: LeaveRequest) {
    reviewModal = req;
    reviewNote = "";
    reviewError = "";
    reviewOverlap = [];
    reviewAttestPresent = req.attestPresent ?? false;
    reviewAttestFrom = req.attestValidFrom ?? "";
    reviewAttestTo = req.attestValidTo ?? "";
    try {
      reviewOverlap = await api.get<OverlapEntry[]>(
        `/leave/overlap?startDate=${req.startDate}&endDate=${req.endDate}`,
      );
    } catch {
      /* ignore */
    }
  }

  function closeReview() {
    reviewModal = null;
  }

  async function submitReview(status: "APPROVED" | "REJECTED") {
    if (!reviewModal) return;
    reviewSaving = true;
    reviewError = "";
    try {
      await api.patch(`/leave/requests/${reviewModal.id}/review`, {
        status,
        reviewNote: reviewNote || null,
      });
      if (SICK_CODES.includes(reviewModal.typeCode)) {
        await api.patch(`/leave/requests/${reviewModal.id}/attest`, {
          attestPresent: reviewAttestPresent,
          attestValidFrom: reviewAttestPresent && reviewAttestFrom ? reviewAttestFrom : null,
          attestValidTo: reviewAttestPresent && reviewAttestTo ? reviewAttestTo : null,
        });
      }
      reviewModal = null;
      await Promise.all([loadData(), loadCalendar()]);
    } catch (e: unknown) {
      reviewError = e instanceof Error ? e.message : "Fehler";
    } finally {
      reviewSaving = false;
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

  // ── Mitarbeiter-Filter (global für alle Tabs) ────────────────────────────
  let filterEmployeeId = $state<string>("");
  let empSearch = $state("");
  let empDropdownOpen = $state(false);

  // Employee list sorted by lastName for dropdown
  let employeeOptions = $derived(
    employees
      .map((e) => ({ id: e.id, name: `${e.lastName}, ${e.firstName}` }))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
  );

  let filteredEmpOptions = $derived(
    employeeOptions.filter((e) => {
      if (!empSearch.trim()) return true;
      const q = empSearch.toLowerCase();
      return e.name.toLowerCase().includes(q);
    }),
  );

  function selectEmployee(emp: { id: string; name: string } | null) {
    filterEmployeeId = emp?.id ?? "";
    empSearch = "";
    empDropdownOpen = false;
  }

  // Filtered views based on selected employee
  let filteredCalEntries = $derived(
    filterEmployeeId ? calEntries.filter((e) => e.employeeId === filterEmployeeId) : calEntries,
  );
  let filteredPendingRequests = $derived(
    filterEmployeeId
      ? pendingRequests.filter((r) => r.employeeId === filterEmployeeId)
      : pendingRequests,
  );

  // Abgeleiteter Kalender (uses filteredCalEntries)
  let calMap = $derived(buildCalMap(filteredCalEntries));
  let calDays = $derived(buildCalDays(calYear, calMonth));

  // ── Anträge-Filter + Pagination ───────────────────────────────────────────
  let filterLeaveStatus = $state<Status | "">("");
  let filterLeaveType = $state<TypeCode | "">("");
  let teamReqPage = $state(1);
  let teamReqPageSize = $state(10);

  let filteredTeamRequests = $derived(
    allTeamRequests.filter((req) => {
      if (filterEmployeeId && req.employeeId !== filterEmployeeId) return false;
      if (filterLeaveStatus && req.status !== filterLeaveStatus) return false;
      if (filterLeaveType && req.typeCode !== filterLeaveType) return false;
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

  // ── iCal-Download ────────────────────────────────────────────────────────
  let icalDownloading = $state(false);

  async function downloadIcal() {
    icalDownloading = true;
    try {
      const auth = $authStore;
      const res = await fetch(`/api/v1/leave/ical/team`, {
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
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Download";
    } finally {
      icalDownloading = false;
    }
  }
</script>

<svelte:head>
  <title>Team-Abwesenheiten – Clokr</title>
</svelte:head>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") {
      if (reviewModal) {
        reviewModal = null;
        reviewError = "";
      }
    }
  }}
/>

<!-- ── Header ─────────────────────────────────────────────────────────────── -->
<div class="page-header-compact">
  <h1>Team-Abwesenheiten</h1>
</div>

{#if error}
  <div class="alert alert-error" role="alert"><span>⚠</span><span>{error}</span></div>
{/if}

<!-- ── Mitarbeiter-Filter ──────────────────────────────────────────────────── -->
<div class="employee-selector card-animate">
  <div class="emp-combobox" class:emp-combobox--open={empDropdownOpen}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="emp-input-wrap" onclick={() => (empDropdownOpen = !empDropdownOpen)}>
      {#if filterEmployeeId && !empDropdownOpen}
        <span class="emp-selected-name">
          {employeeOptions.find((e) => e.id === filterEmployeeId)?.name ?? "Alle Mitarbeiter"}
        </span>
      {:else}
        <input
          class="emp-search-input"
          type="text"
          placeholder={filterEmployeeId
            ? (employeeOptions.find((e) => e.id === filterEmployeeId)?.name ?? "Alle Mitarbeiter")
            : "Alle Mitarbeiter"}
          bind:value={empSearch}
          onfocus={() => (empDropdownOpen = true)}
          oninput={() => (empDropdownOpen = true)}
          aria-label="Mitarbeiter suchen"
          autocomplete="off"
        />
      {/if}
      <svg
        class="emp-chevron"
        class:emp-chevron--up={empDropdownOpen}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
    {#if empDropdownOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="emp-backdrop" onclick={() => (empDropdownOpen = false)}></div>
      <ul class="emp-dropdown" role="listbox" aria-label="Mitarbeiterliste">
        <li
          class="emp-dropdown-item"
          class:emp-dropdown-item--active={filterEmployeeId === ""}
          role="option"
          aria-selected={filterEmployeeId === ""}
          tabindex="0"
          onclick={() => selectEmployee(null)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") selectEmployee(null);
          }}
        >
          Alle Mitarbeiter
        </li>
        {#if filteredEmpOptions.length === 0}
          <li class="emp-dropdown-empty">Keine Treffer</li>
        {:else}
          {#each filteredEmpOptions as emp (emp.id)}
            <li
              class="emp-dropdown-item"
              class:emp-dropdown-item--active={emp.id === filterEmployeeId}
              role="option"
              aria-selected={emp.id === filterEmployeeId}
              tabindex="0"
              onclick={() => selectEmployee(emp)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") selectEmployee(emp);
              }}
            >
              {emp.name}
            </li>
          {/each}
        {/if}
      </ul>
    {/if}
  </div>
</div>

<!-- ── View-Toggle ────────────────────────────────────────────────────────── -->
<div class="view-tabs">
  <button
    class="view-tab"
    class:view-tab--active={view === "calendar"}
    onclick={() => (view = "calendar")}
  >
    Kalender
  </button>
  <button class="view-tab" class:view-tab--active={view === "list"} onclick={() => (view = "list")}>
    Anträge
  </button>
  <button
    class="view-tab"
    class:view-tab--active={view === "approvals"}
    onclick={() => (view = "approvals")}
  >
    Genehmigungen
    {#if filteredPendingRequests.length > 0}
      <span class="tab-badge">{filteredPendingRequests.length}</span>
    {/if}
  </button>
</div>

<!-- ── Kalender-Ansicht ──────────────────────────────────────────────────── -->
{#if view === "calendar"}
  <div class="cal-section card card-animate">
    <!-- Navigation -->
    <div class="cal-nav">
      <button class="nav-btn" onclick={prevMonth} title="Vorheriger Monat">
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
      <div class="cal-nav-right">
        <button class="nav-btn" onclick={nextMonth} title="Nächster Monat">
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
    </div>

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
          {@const absences = entries.filter((e) => !e.isHoliday)}
          {@const isHoliday = holidays.length > 0}
          <div
            class="cal-cell"
            class:cal-current={day.isCurrentMonth}
            class:cal-other={!day.isCurrentMonth}
            class:cal-today={day.isToday}
            class:cal-weekend={day.isWeekend && day.isCurrentMonth}
            class:cal-holiday={isHoliday && day.isCurrentMonth}
          >
            <span class="cal-day-num">{day.dayNum}</span>
            {#if isHoliday && day.isCurrentMonth}
              <div class="cal-holiday-label" title={holidays[0].typeName ?? ""}>
                {holidays[0].firstName}
              </div>
            {/if}
            <div class="cal-chips">
              {#each absences.filter((e) => e.isOwn || e.status === "APPROVED") as e (e.id)}
                {@const _dow = new Date(day.dateStr + "T00:00:00").getDay()}
                {@const _isBarStart = day.dateStr === e.startDate || _dow === 1}
                {@const _isBarEnd = day.dateStr === e.endDate || _dow === 0}
                {@const _showLabel = day.dateStr === e.startDate || _dow === 1}
                <div
                  class="cal-chip"
                  class:cal-chip--bar-start={_isBarStart && !_isBarEnd}
                  class:cal-chip--bar-end={!_isBarStart && _isBarEnd}
                  class:cal-chip--bar-middle={!_isBarStart && !_isBarEnd}
                  class:cal-chip--pending={e.status === "PENDING" ||
                    e.status === "CANCELLATION_REQUESTED"}
                  class:cal-chip--own={e.isOwn}
                  style="background:{typeColor(e.typeCode, e.status, e.isOwn)}"
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
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Legende -->
    <div class="cal-legend">
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-vacation)"></span>Urlaub</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-overtime)"
        ></span>ÜSt-Ausgleich</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-sick)"></span>Krank</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-sick-child)"
        ></span>Kinderkrank</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-special)"
        ></span>Sonderurlaub</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-education)"
        ></span>Bildungsurlaub</span
      >
      <span class="legend-item"
        ><span class="legend-dot" style="background:var(--leave-type-absent)"></span>Abwesend</span
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
          Team-Abwesenheiten als .ics-Datei herunterladen (Outlook, Google Calendar, Apple Kalender)
        </p>
      </div>
    </div>
    <div class="ical-actions">
      <button class="btn btn-ghost btn-sm" onclick={downloadIcal} disabled={icalDownloading}>
        {icalDownloading ? "Laden…" : "Team-Abwesenheiten"}
      </button>
    </div>
  </div>
{/if}

<!-- ── Anträge-Ansicht ────────────────────────────────────────────────────── -->
{#if view === "list"}
  <div class="section-header">
    <h2>Alle Anträge</h2>
  </div>

  {#if loading}
    <div class="card card-body" style="height:180px"></div>
  {:else if allTeamRequests.length === 0}
    <div class="empty-state card card-body">
      <span class="empty-icon">🏖️</span>
      <h3>Keine Anträge gefunden.</h3>
      <p class="text-muted">Es liegen noch keine Abwesenheitsanträge vor.</p>
    </div>
  {:else}
    <div class="filter-bar">
      <select
        class="form-input filter-select"
        bind:value={filterLeaveStatus}
        aria-label="Nach Status filtern"
      >
        <option value="">Alle Status</option>
        <option value="PENDING">Ausstehend</option>
        <option value="APPROVED">Genehmigt</option>
        <option value="REJECTED">Abgelehnt</option>
        <option value="CANCELLED">Storniert</option>
        <option value="CANCELLATION_REQUESTED">Stornierung beantragt</option>
      </select>
      <select
        class="form-input filter-select"
        bind:value={filterLeaveType}
        aria-label="Nach Art filtern"
      >
        <option value="">Alle Arten</option>
        {#each TYPE_OPTIONS as t (t.code)}
          <option value={t.code}>{t.label}</option>
        {/each}
      </select>
      <span class="filter-count">{filteredTeamRequests.length} Anträge</span>
    </div>

    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Mitarbeiter</th>
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
          {#each pagedTeamRequests as req (req.id)}
            <tr id="request-{req.id}" class:highlight-row={highlightRequestId === req.id}>
              <td class="font-medium">{req.employee.firstName} {req.employee.lastName}</td>
              <td>{typeName(req.typeCode)}</td>
              <td class="font-mono">{fmtDate(req.startDate)}</td>
              <td class="font-mono">{fmtDate(req.endDate)}</td>
              <td class="text-center">{daysLabel(Number(req.days), req.halfDay)}</td>
              <td>
                <span class="badge {statusClass(req.status)}">{statusLabel(req.status)}</span>
                {#if SICK_CODES.includes(req.typeCode) && req.status === "APPROVED"}
                  <span
                    class="badge {req.attestPresent ? 'badge-green' : 'badge-gray'}"
                    style="margin-left:0.25rem;font-size:0.7rem"
                  >
                    {req.attestPresent ? "Attest" : "Kein Attest"}
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
                {#if req.status === "PENDING" || req.status === "CANCELLATION_REQUESTED"}
                  <button class="btn btn-sm btn-ghost" onclick={() => openReview(req)}>
                    {req.status === "CANCELLATION_REQUESTED" ? "Stornierung prüfen" : "Prüfen"}
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <Pagination
        total={filteredTeamRequests.length}
        bind:page={teamReqPage}
        bind:pageSize={teamReqPageSize}
      />
    </div>
  {/if}
{/if}

<!-- ── Genehmigungen ──────────────────────────────────────────────────────── -->
{#if view === "approvals"}
  {#if !loading && filteredPendingRequests.length > 0}
    <div class="pending-list">
      {#each filteredPendingRequests as req (req.id)}
        <div
          class="pending-card card"
          id="request-{req.id}"
          class:highlight-row={highlightRequestId === req.id}
        >
          <div class="pending-info">
            <span class="pending-name">{req.employee.firstName} {req.employee.lastName}</span>
            {#if req.status === "CANCELLATION_REQUESTED"}
              <span class="badge badge-orange" style="font-size:0.75rem">Stornierung beantragt</span
              >
            {:else}
              <span class="pending-type">{typeName(req.typeCode)}</span>
            {/if}
            <span class="pending-dates">{fmtDate(req.startDate)} – {fmtDate(req.endDate)}</span>
            <span class="pending-days text-muted">{daysLabel(Number(req.days), req.halfDay)}</span>
            {#if req.note}
              <span class="pending-note text-muted">„{req.note}"</span>
            {/if}
          </div>
          <button class="btn btn-sm btn-ghost" onclick={() => openReview(req)}>
            {req.status === "CANCELLATION_REQUESTED" ? "Stornierung prüfen →" : "Prüfen →"}
          </button>
        </div>
      {/each}
    </div>
  {:else if !loading}
    <div class="empty-state card card-body">
      <span class="empty-icon">✅</span>
      <h3>Keine offenen Anträge</h3>
      <p class="text-muted">Alle Anträge wurden bearbeitet.</p>
    </div>
  {/if}
{/if}

<!-- ── Review-Modal ─────────────────────────────────────────────────────────── -->
{#if reviewModal}
  <div class="modal-backdrop" onclick={self(closeReview)} role="presentation">
    <div class="modal-card card" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-header">
        <h2>
          {reviewModal.status === "CANCELLATION_REQUESTED"
            ? "Stornierungsantrag prüfen"
            : "Antrag prüfen"}
        </h2>
        <button class="btn-icon" onclick={closeReview} aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body">
        <!-- Antrag-Details -->
        <div class="review-grid">
          <div class="review-field">
            <span class="review-label">Mitarbeiter</span>
            <span class="review-value"
              >{reviewModal.employee.firstName} {reviewModal.employee.lastName}</span
            >
          </div>
          <div class="review-field">
            <span class="review-label">Art</span>
            <span class="review-value">{typeName(reviewModal.typeCode)}</span>
          </div>
          <div class="review-field">
            <span class="review-label">Zeitraum</span>
            <span class="review-value font-mono"
              >{fmtDate(reviewModal.startDate)} – {fmtDate(reviewModal.endDate)}</span
            >
          </div>
          <div class="review-field">
            <span class="review-label">Umfang</span>
            <span class="review-value"
              >{daysLabel(Number(reviewModal.days), reviewModal.halfDay)}</span
            >
          </div>
          {#if reviewModal.note}
            <div class="review-field review-field--full">
              <span class="review-label">Anmerkung Mitarbeiter</span>
              <span class="review-value">„{reviewModal.note}"</span>
            </div>
          {/if}
        </div>

        <!-- Parallele Abwesenheiten -->
        <div class="overlap-box" style="margin-top:1.25rem">
          <p class="overlap-title">Kolleg:innen im gleichen Zeitraum</p>
          {#if reviewOverlap.filter((o) => o.status === "APPROVED").length === 0}
            <p class="text-muted overlap-empty">Niemand sonst abwesend ✓</p>
          {:else}
            <div class="overlap-list">
              {#each reviewOverlap.filter((o) => o.status === "APPROVED") as o (o.id)}
                <div class="overlap-row">
                  <span class="overlap-name">{o.employeeName}</span>
                  <span class="overlap-type">abwesend</span>
                  <span class="overlap-dates">{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Attest (nur für Krankmeldungen) -->
        {#if SICK_CODES.includes(reviewModal.typeCode)}
          <div class="attest-box" style="margin-top:1.25rem">
            <p class="attest-title">Attest / Arbeitsunfähigkeitsbescheinigung</p>
            <label class="toggle-label">
              <input type="checkbox" bind:checked={reviewAttestPresent} class="toggle-cb" />
              <span>Attest liegt vor</span>
            </label>
            {#if reviewAttestPresent}
              <div class="attest-dates">
                <div class="form-group">
                  <label class="form-label" for="r-attest-from">Gültig von</label>
                  <input
                    id="r-attest-from"
                    type="date"
                    bind:value={reviewAttestFrom}
                    class="form-input"
                    style="max-width:160px"
                  />
                </div>
                <div class="form-group">
                  <label class="form-label" for="r-attest-to">Gültig bis</label>
                  <input
                    id="r-attest-to"
                    type="date"
                    bind:value={reviewAttestTo}
                    class="form-input"
                    style="max-width:160px"
                  />
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Review-Notiz -->
        <div class="form-group" style="margin-top:1.25rem">
          <label class="form-label" for="review-note">Anmerkung (optional)</label>
          <input
            id="review-note"
            type="text"
            bind:value={reviewNote}
            class="form-input"
            placeholder="Grund für Ablehnung o.ä."
          />
        </div>

        {#if reviewError}
          <div class="alert alert-error" role="alert" style="margin-top:0.75rem">
            <span>⚠</span><span>{reviewError}</span>
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button class="btn btn-ghost" onclick={closeReview} disabled={reviewSaving}>
          Abbrechen
        </button>
        {#if reviewModal.employeeId !== $authStore.user?.employeeId}
          {#if reviewModal.status === "CANCELLATION_REQUESTED"}
            <button
              class="btn btn-ghost"
              onclick={() => submitReview("REJECTED")}
              disabled={reviewSaving}
            >
              {reviewSaving ? "…" : "Stornierung ablehnen"}
            </button>
            <button
              class="btn btn-danger"
              onclick={() => submitReview("APPROVED")}
              disabled={reviewSaving}
            >
              {reviewSaving ? "…" : "Stornierung genehmigen"}
            </button>
          {:else}
            <button
              class="btn btn-danger"
              onclick={() => submitReview("REJECTED")}
              disabled={reviewSaving}
            >
              {reviewSaving ? "…" : "Ablehnen"}
            </button>
            <button
              class="btn btn-primary"
              onclick={() => submitReview("APPROVED")}
              disabled={reviewSaving}
            >
              {reviewSaving ? "…" : "Genehmigen"}
            </button>
          {/if}
        {:else}
          <p class="text-muted" style="font-size:0.875rem;margin-right:auto">
            Eigene Anträge können nicht selbst genehmigt werden.
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── Employee selector / combobox ──────────────────────────────────── */
  .employee-selector {
    margin-bottom: 1rem;
  }

  .emp-combobox {
    position: relative;
    max-width: 360px;
  }

  .emp-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    box-shadow: var(--glass-shadow);
    cursor: pointer;
    min-height: 2.5rem;
  }

  .emp-combobox--open .emp-input-wrap {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-brand) 20%, transparent);
  }

  .emp-selected-name {
    flex: 1;
    font-size: 0.9375rem;
    font-weight: 500;
    color: var(--color-text);
  }

  .emp-search-input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    font-size: 0.9375rem;
    color: var(--color-text);
    min-width: 0;
  }

  .emp-search-input::placeholder {
    color: var(--color-text-muted);
  }

  .emp-chevron {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.15s;
  }

  .emp-chevron--up {
    transform: rotate(180deg);
  }

  .emp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }

  .emp-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    max-height: 280px;
    overflow-y: auto;
    z-index: 50;
  }

  .emp-dropdown-item {
    padding: 0.5rem 0.875rem;
    font-size: 0.9375rem;
    color: var(--color-text);
    cursor: pointer;
    transition: background 0.1s;
  }

  .emp-dropdown-item:hover,
  .emp-dropdown-item:focus {
    background: var(--color-bg-subtle);
    outline: none;
  }

  .emp-dropdown-item--active {
    color: var(--color-brand);
    font-weight: 600;
  }

  .emp-dropdown-empty {
    padding: 0.75rem 0.875rem;
    font-size: 0.875rem;
    color: var(--color-text-muted);
  }

  /* ── Highlight from notification deep-link ────────────────────────── */
  @keyframes highlight-fade {
    0% {
      background-color: var(--color-brand-tint-hover);
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
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }

  /* ── Overlap ──────────────────────────────────────────────────────── */
  .overlap-box {
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 0.875rem 1rem;
  }
  .overlap-title {
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
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
    color: var(--color-text-muted);
    font-size: 0.875rem;
  }
  .overlap-dates {
    font-family: var(--font-mono);
    font-size: 0.875rem;
    margin-left: auto;
  }

  /* ── Attest ───────────────────────────────────────────────────────── */
  .attest-box {
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.875rem 1rem;
  }
  .attest-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
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
    accent-color: var(--color-brand);
  }

  /* ── Pending Cards ────────────────────────────────────────────────── */
  .pending-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .pending-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
  }
  .pending-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }
  .pending-name {
    font-weight: 600;
    white-space: nowrap;
  }
  .pending-type {
    color: var(--color-brand);
    font-weight: 500;
  }
  .pending-dates {
    font-family: var(--font-mono);
    font-size: 0.9375rem;
    white-space: nowrap;
  }
  .pending-days {
    font-size: 0.875rem;
  }
  .pending-note {
    font-size: 0.875rem;
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
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
    color: var(--color-red, #dc2626);
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
    font-size: 1.0625rem;
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
    max-width: 560px;
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
  .modal-body {
    padding: 1.25rem 1.5rem;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.625rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--gray-200);
    background: var(--gray-50, #f9fafb);
  }

  /* ── Review Grid ──────────────────────────────────────────────────── */
  .review-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem 1.5rem;
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
    border-radius: 8px;
    padding: 1rem 1.25rem;
  }
  .review-field {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .review-field--full {
    grid-column: 1 / -1;
  }
  .review-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
  }
  .review-value {
    font-size: 0.9375rem;
    font-weight: 500;
  }

  /* ── Buttons ──────────────────────────────────────────────────────── */
  .btn-danger {
    background: var(--color-red, #dc2626);
    color: #fff;
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
    color: var(--color-text-muted);
  }

  /* ── View Tabs ────────────────────────────────────────────────────── */
  /* view-tabs, view-tab, tab-badge → global in app.css */

  /* ── Kalender ─────────────────────────────────────────────────────── */
  .cal-nav-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-self: end;
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    user-select: none;
    gap: 3px;
    padding: 3px;
  }

  .cal-cell {
    min-height: 36px;
    padding: 0.3rem 0.4rem 0.4rem;
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: visible;
    position: relative;
  }

  .cal-cell.cal-current {
    cursor: default;
  }
  .cal-cell.cal-current:hover {
    background: var(--color-bg-subtle, #f3f0ff);
  }

  .cal-day-num {
    z-index: 1;
  }

  .cal-chips {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-height: 0;
    overflow: visible;
    margin: 0 -0.4rem;
  }
  .cal-chip {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 2px 0.4rem;
    border-radius: 4px;
    color: #fff;
    font-size: 0.75rem;
    line-height: 1.4;
    overflow: hidden;
    cursor: default;
    min-height: 18px;
  }
  .cal-chip--bar-start {
    border-radius: 4px 0 0 4px;
    margin-right: -3px;
    height: 22px;
  }
  .cal-chip--bar-end {
    border-radius: 0 4px 4px 0;
    margin-left: -3px;
    height: 22px;
  }
  .cal-chip--bar-middle {
    border-radius: 0;
    margin-left: -3px;
    margin-right: -3px;
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
    font-size: 0.7rem;
    color: var(--color-text-muted);
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
    background: var(--color-brand-tint);
    border: 1.5px solid var(--color-brand);
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
    background: var(--gray-50, #f9fafb);
    border: 1px solid var(--gray-200);
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
    color: var(--color-text);
  }
  .ical-desc {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    margin: 0;
  }
  .ical-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* ── Responsive ───────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .review-grid {
      grid-template-columns: 1fr;
    }
    .pending-info {
      gap: 0.5rem;
    }
    .overlap-dates {
      margin-left: 0;
    }
    .cal-chip-type {
      display: none;
    }
  }
</style>
