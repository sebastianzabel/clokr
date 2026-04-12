<script lang="ts" module>
  function getWeekNumber(dateStr: string): number {
    const d = new Date(dateStr + "T00:00:00");
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    return (
      1 +
      Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
    );
  }

  function formatShortDate(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return `${d.getDate()}.${d.getMonth() + 1}.`;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import Pagination from "$components/ui/Pagination.svelte";
  import { format, subMonths } from "date-fns";
  import { de } from "date-fns/locale";
  import {
    Chart,
    BarController,
    LineController,
    DoughnutController,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
    Filler,
  } from "chart.js";

  Chart.register(
    BarController,
    LineController,
    DoughnutController,
    BarElement,
    LineElement,
    PointElement,
    ArcElement,
    CategoryScale,
    LinearScale,
    Tooltip,
    Legend,
    Filler,
  );

  // ── Types ──────────────────────────────────────────────────────────────────
  interface DashboardStats {
    today: { workedHours: number; entries: number };
    week: { workedHours: number; targetHours: number };
    overtime: { balanceHours: number };
    vacation: { remaining: number; total: number; used: number };
  }

  interface TeamDay {
    date: string;
    status: "present" | "absent" | "clocked_in" | "missing" | "scheduled" | "none" | "holiday";
    workedHours: number;
    reason: string | null;
    shift?: { startTime: string; endTime: string; label: string | null; color: string | null };
    isWorkday?: boolean;
    expectedHours?: number;
  }

  interface TeamMember {
    id: string;
    name: string;
    employeeNumber: string;
    days: TeamDay[];
  }

  interface TeamWeek {
    weekStart: string;
    weekEnd: string;
    weekDays: string[];
    team: TeamMember[];
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let clockedIn = $state(false);
  let activeEntryId = $state<string | null>(null);
  let loading = $state(false);
  let chartsLoading = $state(true);
  let clockLoading = $state(false);
  let breakMinutes = $state(0);
  let currentTime = $state(new Date());
  let clockStart: Date | null = $state(null);

  let stats: DashboardStats | null = $state(null);
  let teamWeek: TeamWeek | null = $state(null);
  let teamPage = $state(1);
  let teamPageSize = $state(10);
  let pagedTeam = $derived(
    teamWeek ? teamWeek.team.slice((teamPage - 1) * teamPageSize, teamPage * teamPageSize) : [],
  );
  let weekOffset = $state(0);
  let todayShift: {
    startTime: string;
    endTime: string;
    label: string | null;
    template: { name: string; color: string } | null;
  } | null = $state(null);

  // Next personal absence
  let myNextLeave: { startDate: string; endDate: string; days: number; type: string } | null =
    $state(null);

  // My Week widget
  let myWeekOffset = $state(0);
  interface MyWeekDay {
    date: string;
    workedHours: number;
    expectedHours: number;
    status: string;
    isWorkday: boolean;
    holidayName: string | null;
  }
  let myWeekDays: MyWeekDay[] = $state([]);

  // Open items widget
  let openItems: {
    missingDays: string[];
    pendingRequests: number;
    invalidEntries: number;
    total: number;
  } | null = $state(null);

  // Charts
  let weeklyChartEl: HTMLCanvasElement;
  let overtimeChartEl: HTMLCanvasElement;
  let sickChartEl: HTMLCanvasElement;
  let weeklyChart: Chart | null = null;
  let overtimeChart: Chart | null = null;
  let sickChart: Chart | null = null;

  interface UpcomingLeave {
    employeeName: string;
    startDate: string;
    endDate: string;
    days: number;
    type: string;
  }
  let upcomingLeaves: UpcomingLeave[] = $state([]);

  interface MonthlyReportRow {
    workedHours: number;
    shouldHours: number;
    sickDays: number;
    vacationDays: number;
    totalAbsenceDays: number;
  }
  interface MonthlyReportResponse {
    rows: MonthlyReportRow[];
  }
  interface MonthlyReport {
    workedMinutes: number;
    shouldMinutes: number;
    sickDays: number;
    vacationDays: number;
    otherAbsenceDays: number;
  }

  interface OvertimeTrendResponse {
    snapshots: { month: string; teamCarryOverMinutes: number }[];
    currentTeamBalanceMinutes: number;
  }

  let timer: ReturnType<typeof setInterval>;
  let pollInterval: ReturnType<typeof setInterval>;

  const isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));

  // ── Load ───────────────────────────────────────────────────────────────────
  onMount(async () => {
    await loadData();
    timer = setInterval(() => {
      currentTime = new Date();
    }, 1000);
    pollInterval = setInterval(pollDashboard, 5000); // refresh team-week + clock status every 5s
  });

  onDestroy(() => {
    clearInterval(timer);
    if (pollInterval) clearInterval(pollInterval);
    weeklyChart?.destroy();
    overtimeChart?.destroy();
    sickChart?.destroy();
  });

  async function loadData() {
    loading = true;
    try {
      const today = format(new Date(), "yyyy-MM-dd");

      // Parallel laden — allSettled so a stats failure doesn't break clock state
      const [entriesResult, statsResult] = await Promise.allSettled([
        api.get<{ id: string; endTime: string | null; startTime: string }[]>(
          `/time-entries?from=${today}&to=${today}`,
        ),
        api.get<DashboardStats>("/dashboard"),
      ]);

      if (entriesResult.status === "fulfilled") {
        const entries = entriesResult.value;
        const openEntry = entries.find((e) => !e.endTime);
        if (openEntry) {
          clockedIn = true;
          activeEntryId = openEntry.id;
          clockStart = new Date(openEntry.startTime);
        } else {
          clockedIn = false;
          activeEntryId = null;
          clockStart = null;
        }
      } else {
        console.error("Failed to load time entries:", entriesResult.reason);
        toasts.error("Zeiteinträge konnten nicht geladen werden");
      }

      if (statsResult.status === "fulfilled") {
        stats = statsResult.value;
      } else {
        console.error("Failed to load dashboard stats:", statsResult.reason);
      }

      // Load today's shift
      try {
        const shiftData = await api.get<{
          weekDays: string[];
          shifts: Array<{
            date: string;
            startTime: string;
            endTime: string;
            label: string | null;
            template: { name: string; color: string } | null;
          }>;
        }>(`/shifts/week?date=${today}`);
        const myShifts = shiftData.shifts.filter((s) => s.date.startsWith(today));
        todayShift = myShifts.length > 0 ? myShifts[0] : null;
      } catch (err) {
        console.error("Failed to load today's shift:", err);
        todayShift = null;
      }

      // My Week + Open Items (all users)
      await loadMyWeek();
      try {
        openItems = await api.get<typeof openItems>("/dashboard/open-items");
      } catch {
        /* ignore */
      }

      // Team-Wochenübersicht für Manager/Admin
      if (isManager) {
        await loadTeamWeek();
      }

      // Load chart data (last 6 months)
      loadCharts();
    } finally {
      loading = false;
    }
  }

  async function pollDashboard() {
    await loadTeamWeek();
    // Also refresh clock-in status
    try {
      const today = format(new Date(), "yyyy-MM-dd");
      const entries = await api.get<{ id: string; endTime: string | null; startTime: string }[]>(
        `/time-entries?from=${today}&to=${today}`,
      );
      const openEntry = entries.find((e) => !e.endTime);
      if (openEntry) {
        clockedIn = true;
        activeEntryId = openEntry.id;
        clockStart = new Date(openEntry.startTime);
      } else {
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
      }
    } catch (err) {
      console.error("Failed to poll clock status:", err);
    }
  }

  async function loadMyWeek() {
    try {
      const d = new Date();
      d.setDate(d.getDate() + myWeekOffset * 7);
      const dateParam = format(d, "yyyy-MM-dd");
      const weekData = await api.get<{ weekDays: string[]; days: MyWeekDay[] }>(
        `/dashboard/my-week?date=${dateParam}`,
      );
      myWeekDays = weekData.days;
    } catch {
      /* ignore */
    }
  }

  function myWeekPrev() {
    myWeekOffset--;
    loadMyWeek();
  }
  function myWeekNext() {
    myWeekOffset++;
    loadMyWeek();
  }
  function myWeekCurrent() {
    myWeekOffset = 0;
    loadMyWeek();
  }

  async function loadTeamWeek() {
    try {
      const refDate = new Date();
      refDate.setDate(refDate.getDate() + weekOffset * 7);
      const dateParam = refDate.toISOString().split("T")[0];
      teamWeek = await api.get<TeamWeek>(`/dashboard/team-week?date=${dateParam}`);
    } catch (err) {
      console.error("Failed to load team week:", err);
    }
  }

  function prevWeek() {
    weekOffset--;
    loadTeamWeek();
  }
  function nextWeek() {
    weekOffset++;
    loadTeamWeek();
  }
  function currentWeek() {
    weekOffset = 0;
    loadTeamWeek();
  }

  async function loadCharts() {
    // ── Phase 1: fetch data ────────────────────────────────────────────────────
    let reports: MonthlyReport[] = [];
    let labels: string[] = [];
    let brandColor = "";
    const now = new Date();
    const months: { label: string; month: string }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = subMonths(now, i);
      months.push({
        label: format(d, "MMM yy", { locale: de }),
        month: format(d, "yyyy-MM"),
      });
    }
    let overtimeTrend: OvertimeTrendResponse = {
      snapshots: [],
      currentTeamBalanceMinutes: 0,
    };

    try {
      for (const m of months) {
        try {
          const [y, mo] = m.month.split("-");
          const resp = await api.get<MonthlyReportResponse>(
            `/reports/monthly?year=${y}&month=${mo}`,
          );
          // Aggregate all employee rows into totals
          const agg = (resp.rows ?? []).reduce(
            (acc, r) => ({
              workedMinutes: acc.workedMinutes + (r.workedHours ?? 0) * 60,
              shouldMinutes: acc.shouldMinutes + (r.shouldHours ?? 0) * 60,
              sickDays: acc.sickDays + (r.sickDays ?? 0),
              vacationDays: acc.vacationDays + (r.vacationDays ?? 0),
              otherAbsenceDays:
                acc.otherAbsenceDays +
                ((r.totalAbsenceDays ?? 0) - (r.sickDays ?? 0) - (r.vacationDays ?? 0)),
            }),
            {
              workedMinutes: 0,
              shouldMinutes: 0,
              sickDays: 0,
              vacationDays: 0,
              otherAbsenceDays: 0,
            },
          );
          reports.push(agg);
        } catch (err) {
          console.error(`Failed to load chart report for month:`, err);
          reports.push({
            workedMinutes: 0,
            shouldMinutes: 0,
            sickDays: 0,
            vacationDays: 0,
            otherAbsenceDays: 0,
          });
        }
      }

      // Load team overtime trend from the dedicated endpoint
      try {
        overtimeTrend = await api.get<OvertimeTrendResponse>("/dashboard/overtime-trend");
      } catch (err) {
        console.error("Failed to load overtime trend:", err);
      }

      labels = months.map((m) => m.label);
      brandColor =
        getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() ||
        "#6d28d9";
    } catch (err) {
      console.error("Failed to load chart data:", err);
    } finally {
      // CRITICAL: flip loading flag BEFORE Chart.js instantiation so canvases render into the DOM.
      chartsLoading = false;
    }

    // ── Phase 2: wait for Svelte to render the {:else} branch (canvases) ──────
    // Without this tick(), chartsLoading has been set to false but the DOM has not
    // yet been updated — bind:this refs (weeklyChartEl etc.) are still undefined.
    await tick();

    // ── Phase 3: instantiate charts ────────────────────────────────────────────

    // Weekly hours bar chart (Soll vs Ist)
    if (weeklyChartEl) {
      weeklyChart?.destroy();
      weeklyChart = new Chart(weeklyChartEl, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Ist (h)",
              data: reports.map((r) => +(r.workedMinutes / 60).toFixed(1)),
              backgroundColor: brandColor,
              borderRadius: 4,
            },
            {
              label: "Soll (h)",
              data: reports.map((r) => +(r.shouldMinutes / 60).toFixed(1)),
              backgroundColor: "#e5e7eb",
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          },
          scales: {
            y: { beginAtZero: true, grid: { color: "#f3f4f6" }, ticks: { font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          },
        },
      });
    }

    // Overtime trend line chart — absolute team saldo from SaldoSnapshots + live OvertimeAccount
    if (overtimeChartEl) {
      // Build a lookup of snapshot month → teamCarryOverMinutes
      const snapshotByMonth = new Map<string, number>();
      for (const s of overtimeTrend.snapshots) {
        // API returns "YYYY-MM-DD" (day is always 01); key by "YYYY-MM"
        snapshotByMonth.set(s.month.slice(0, 7), s.teamCarryOverMinutes);
      }

      // Align to the same 6-month window as `labels` (months[].month = "YYYY-MM")
      // For each month:
      //   - If it's the LAST month (current open month) → use currentTeamBalanceMinutes / 60
      //   - Else if a snapshot exists for that month → use teamCarryOverMinutes / 60
      //   - Else → fill-forward from the previous resolved value (or 0 for the leading edge)
      let lastKnown = 0;
      const absoluteHours: number[] = [];
      for (let i = 0; i < months.length; i++) {
        const isCurrent = i === months.length - 1;
        if (isCurrent) {
          lastKnown = overtimeTrend.currentTeamBalanceMinutes / 60;
        } else {
          const snap = snapshotByMonth.get(months[i].month);
          if (snap !== undefined) lastKnown = snap / 60;
          // else: fill-forward — lastKnown stays unchanged
        }
        absoluteHours.push(+lastKnown.toFixed(1));
      }

      overtimeChart?.destroy();
      overtimeChart = new Chart(overtimeChartEl, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Team-Überstunden (h)",
              data: absoluteHours,
              borderColor: brandColor,
              backgroundColor: brandColor + "20",
              fill: true,
              tension: 0.3,
              pointRadius: 4,
              pointBackgroundColor: brandColor,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { grid: { color: "#f3f4f6" }, ticks: { font: { size: 10 } } },
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          },
        },
      });
    }

    // Sick days trend line chart
    if (sickChartEl) {
      sickChart?.destroy();
      sickChart = new Chart(sickChartEl, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Krankheitstage",
              data: reports.map((r) => r.sickDays),
              borderColor: "#ef4444",
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              fill: true,
              tension: 0.3,
              pointRadius: 4,
              pointBackgroundColor: "#ef4444",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { stepSize: 1, font: { size: 10 } },
              grid: { color: "#f3f4f6" },
            },
            x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          },
        },
      });
    }

    // ── Phase 4: side fetches (leave data) ─────────────────────────────────────

    // Load own next leave (for all users)
    try {
      const myEmployeeId = $authStore.user?.employeeId;
      const myLeaves = await api.get<
        { startDate: string; endDate: string; days: number; leaveType: { name: string } }[]
      >(
        `/leave/requests?status=APPROVED&upcoming=true${myEmployeeId ? `&employeeId=${myEmployeeId}` : ""}`,
      );
      const next = (myLeaves ?? []).find((l) => new Date(l.startDate) > new Date());
      myNextLeave = next
        ? {
            startDate: next.startDate.split("T")[0],
            endDate: next.endDate.split("T")[0],
            days: Number(next.days),
            type: next.leaveType?.name ?? "Urlaub",
          }
        : null;
    } catch {
      /* ignore */
    }

    // Load upcoming leaves
    if (isManager) {
      try {
        const leaves = await api.get<
          {
            startDate: string;
            endDate: string;
            days: number;
            employee: { firstName: string; lastName: string };
            leaveType: { name: string };
          }[]
        >("/leave/requests?status=APPROVED&upcoming=true");
        upcomingLeaves = (leaves ?? [])
          .map((l) => ({
            employeeName: `${l.employee?.firstName ?? ""} ${l.employee?.lastName ?? ""}`.trim(),
            startDate: l.startDate?.split("T")[0] ?? "",
            endDate: l.endDate?.split("T")[0] ?? "",
            days: Number(l.days ?? 0),
            type: l.leaveType?.name ?? "Urlaub",
          }))
          .slice(0, 8);
      } catch (err) {
        console.error("Failed to load upcoming leaves:", err);
        upcomingLeaves = [];
      }
    }
  }

  // ── Clock In/Out ───────────────────────────────────────────────────────────
  async function handleClock() {
    clockLoading = true;
    try {
      if (!clockedIn) {
        const res = await api.post<{ entry: { id: string } }>("/time-entries/clock-in", {
          source: "MOBILE",
        });
        activeEntryId = res.entry.id;
        clockedIn = true;
        clockStart = new Date();
      } else if (activeEntryId) {
        await api.post(`/time-entries/${activeEntryId}/clock-out`, { breakMinutes });
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
        breakMinutes = 0;
      }
      await loadData();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Fehler beim Stempeln");
    } finally {
      clockLoading = false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function formatElapsed(start: Date | null, now: Date): string {
    if (!start) return "–";
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function fmtH(hours: number): string {
    return hours.toFixed(1).replace(".", ",") + "h";
  }

  function greeting(): string {
    const h = new Date().getHours();
    if (h < 12) return "Guten Morgen";
    if (h < 18) return "Guten Tag";
    return "Guten Abend";
  }

  function dayLabel(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return format(d, "EEE", { locale: de });
  }

  function dayNum(dateStr: string): string {
    return dateStr.slice(8, 10);
  }

  function isToday(dateStr: string): boolean {
    return dateStr === format(new Date(), "yyyy-MM-dd");
  }

  let userName = $derived($authStore.user?.firstName ?? $authStore.user?.email.split("@")[0] ?? "");
  let capitalizedName = $derived(userName.charAt(0).toUpperCase() + userName.slice(1));

  let overtimeBalance = $derived((stats as DashboardStats | null)?.overtime?.balanceHours ?? 0);
  let overtimeClass = $derived(
    Math.abs(overtimeBalance) >= 60
      ? "text-red"
      : Math.abs(overtimeBalance) >= 40
        ? "text-yellow"
        : "text-green",
  );
</script>

<svelte:head>
  <title>Dashboard – Clokr</title>
</svelte:head>

<div class="dashboard">
  <!-- Page Header -->
  <div class="page-header">
    <h1>{greeting()}, {capitalizedName}!</h1>
    <p>{format(new Date(), "EEEE, d. MMMM yyyy", { locale: de })}</p>
  </div>

  <!-- Clock-in Widget -->
  <div class="clock-card card card-body card-animate">
    {#if clockedIn}
      <!-- Eingestempelt -->
      <div class="clock-row">
        <div class="clock-left">
          <div class="clock-time-small font-mono">{format(currentTime, "HH:mm:ss")}</div>
          <div class="clock-status">
            <span class="clock-dot clock-dot--active"></span>
            <span class="clock-status-text"
              >Eingestempelt seit {clockStart ? format(clockStart, "HH:mm") : "–"} Uhr</span
            >
          </div>
        </div>
        <button onclick={handleClock} disabled={clockLoading} class="btn clock-btn clock-btn--out">
          {#if clockLoading}<span class="btn-spinner"></span>{/if}
          Ausstempeln
        </button>
      </div>
    {:else}
      <!-- Ausgestempelt -->
      <div class="clock-row">
        <div class="clock-left">
          <div class="clock-time-small font-mono">{format(currentTime, "HH:mm:ss")}</div>
          <div class="clock-status">
            <span class="clock-dot"></span>
            <span class="clock-status-text">Ausgestempelt</span>
          </div>
        </div>
        <button onclick={handleClock} disabled={clockLoading} class="btn clock-btn clock-btn--in">
          {#if clockLoading}<span class="btn-spinner"></span>{/if}
          Einstempeln
        </button>
      </div>
    {/if}
    {#if todayShift}
      <div class="clock-shift">
        <span
          class="clock-shift-badge"
          style="border-left-color: {todayShift.template?.color ?? '#6B7280'}"
        >
          {todayShift.label ?? "Schicht"}: {todayShift.startTime} – {todayShift.endTime}
        </span>
      </div>
    {/if}
  </div>

  <!-- Stats Row -->
  <div class="stats-grid">
    <div class="stat-card card-animate">
      <div class="stat-header-row">
        <p class="stat-label">Heute</p>
        <span class="stat-icon stat-icon--brand">
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
            ><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg
          >
        </span>
      </div>
      <p class="stat-value font-mono stat-value-animate">
        {#if clockedIn && clockStart}
          {formatElapsed(clockStart, currentTime)}
        {:else if stats}
          {fmtH(stats.today.workedHours)}
        {:else}
          <span class="skeleton-text" style="width:3rem;height:1.25em"></span>
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          {stats.today.entries} {stats.today.entries === 1 ? "Eintrag" : "Einträge"}
        {:else}
          <span class="skeleton-text"></span>
        {/if}
      </p>
    </div>

    <div class="stat-card card-animate">
      <div class="stat-header-row">
        <p class="stat-label">Diese Woche</p>
        <span class="stat-icon stat-icon--brand">
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
            ><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line
              x1="16"
              y1="2"
              x2="16"
              y2="6"
            /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg
          >
        </span>
      </div>
      <p class="stat-value font-mono stat-value-animate">
        {#if stats}
          {fmtH(stats.week.workedHours)}
        {:else}
          <span class="skeleton-text" style="width:3rem;height:1.25em"></span>
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          von {fmtH(stats.week.targetHours)} Soll
        {:else}
          <span class="skeleton-text"></span>
        {/if}
      </p>
    </div>

    <div class="stat-card card-animate">
      <div class="stat-header-row">
        <p class="stat-label">Überstunden</p>
        <span class="stat-icon stat-icon--brand">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg
          >
        </span>
      </div>
      <p class="stat-value {overtimeClass} font-mono stat-value-animate">
        {overtimeBalance >= 0 ? "+" : ""}{overtimeBalance.toFixed(1)}h
      </p>
      <p class="stat-sub">
        Stand heute &middot;
        {Math.abs(overtimeBalance) >= 60
          ? "Kritisch"
          : Math.abs(overtimeBalance) >= 40
            ? "Erhöht"
            : "Normal"}
      </p>
    </div>

    <div class="stat-card card-animate">
      <div class="stat-header-row">
        <p class="stat-label">Resturlaub</p>
        <span class="stat-icon stat-icon--brand">
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
            ><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></svg
          >
        </span>
      </div>
      <p class="stat-value font-mono stat-value-animate">
        {#if stats}
          {stats.vacation.remaining}
        {:else}
          <span class="skeleton-text" style="width:3rem;height:1.25em"></span>
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          von {stats.vacation.total} Tagen
        {:else}
          <span class="skeleton-text"></span>
        {/if}
      </p>
    </div>
  </div>

  <!-- Info Bar: Schicht / Nächster Urlaub -->
  {#if todayShift || myNextLeave}
    <div class="info-bar card-animate">
      {#if todayShift}
        <div class="info-bar-item">
          <span class="info-bar-icon">📋</span>
          <span
            >Heute: <strong>{todayShift.startTime}–{todayShift.endTime}</strong>{todayShift.label
              ? ` (${todayShift.label})`
              : ""}</span
          >
        </div>
      {/if}
      {#if myNextLeave}
        <div class="info-bar-item">
          <span class="info-bar-icon">🌴</span>
          <span
            >Nächster {myNextLeave.type}:
            <strong
              >{new Date(myNextLeave.startDate).toLocaleDateString("de-DE", {
                day: "2-digit",
                month: "2-digit",
              })}–{new Date(myNextLeave.endDate).toLocaleDateString("de-DE", {
                day: "2-digit",
                month: "2-digit",
              })}</strong
            >
            ({myNextLeave.days}
            {myNextLeave.days === 1 ? "Tag" : "Tage"})</span
          >
        </div>
      {/if}
    </div>
  {/if}

  <!-- My Week + Open Items — side by side on desktop -->
  <div class="widgets-row">
    <!-- My Week Widget -->
    {#if loading && myWeekDays.length === 0}
      <div class="my-week card card-body card-animate">
        <div class="skeleton-block" style="height:120px;border-radius:var(--radius-sm)"></div>
      </div>
    {:else if myWeekDays.length > 0}
      <div class="my-week card card-body card-animate">
        <div class="widget-header">
          <h3 class="widget-title">Meine Woche</h3>
          <div class="widget-nav">
            <button class="btn btn-sm btn-ghost" onclick={myWeekPrev}>‹</button>
            <button
              class="btn btn-sm btn-ghost"
              onclick={myWeekCurrent}
              disabled={myWeekOffset === 0}>Heute</button
            >
            <button class="btn btn-sm btn-ghost" onclick={myWeekNext}>›</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="team-table">
            <thead>
              <tr>
                {#each myWeekDays as day (day.date)}
                  {@const d = new Date(day.date + "T12:00:00")}
                  {@const dayName = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()]}
                  {@const isToday = day.date === new Date().toISOString().split("T")[0]}
                  <th class:is-today={isToday} class:is-weekend={!day.isWorkday}>
                    <span class="day-label">{dayName}.</span>
                    {d.getDate()}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              <tr>
                {#each myWeekDays as day (day.date)}
                  {@const todayStr = new Date().toISOString().split("T")[0]}
                  {@const isPast = day.date < todayStr}
                  {@const isToday = day.date === todayStr}
                  {@const dayOfWeek = new Date(day.date + "T12:00:00").getDay()}
                  {@const isWeekend = dayOfWeek === 0 || dayOfWeek === 6}
                  <td class:is-today={isToday}>
                    <a
                      href="/time-entries?view=list&date={day.date}"
                      class="week-cell"
                      title="{day.workedHours}h / {day.expectedHours}h Soll"
                    >
                      {#if day.status === "clocked_in"}
                        <span class="cell-badge cell-badge--clocked">●</span>
                      {:else if day.status === "complete"}
                        <span class="cell-badge cell-badge--ok">{day.workedHours.toFixed(1)}</span>
                      {:else if day.status === "partial"}
                        <span class="cell-badge cell-badge--partial"
                          >{day.workedHours.toFixed(1)}</span
                        >
                      {:else if day.status === "absent"}
                        <span
                          class="cell-badge cell-badge--absent"
                          title={day.reason ?? "Abwesend"}
                        >
                          {#if day.reason === "Krankmeldung" || day.reason === "Kinderkrank"}
                            🤒
                          {:else if day.reason === "Mutterschutz"}
                            🤰
                          {:else if day.reason === "Elternzeit"}
                            👶
                          {:else}
                            🌴
                          {/if}
                        </span>
                      {:else if day.status === "holiday"}
                        <span
                          class="cell-badge cell-badge--holiday"
                          title={day.holidayName ?? "Feiertag"}>☀️</span
                        >
                      {:else if day.status === "missing" && isPast && !isWeekend}
                        <span class="cell-badge cell-badge--missing">⚠️</span>
                      {:else}
                        <span class="cell-badge cell-badge--none">–</span>
                      {/if}
                    </a>
                  </td>
                {/each}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <!-- Open Items Widget -->
    {#if openItems && openItems.total > 0}
      <div class="open-items card card-body card-animate">
        <h3 class="widget-title">Offene Vorgänge</h3>
        <div class="open-items-list">
          {#if openItems.missingDays.length > 0}
            <div class="oi-group">
              <div class="oi-group-header">
                <span class="oi-dot oi-dot--warn"></span>
                <span>{openItems.missingDays.length} fehlende Zeiteinträge</span>
              </div>
              {#each openItems.missingDays as missDate (missDate)}
                {@const d = new Date(missDate + "T12:00:00")}
                {@const dayName = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()]}
                <a href="/time-entries?view=list&date={missDate}" class="oi-item">
                  <span
                    >{dayName}. {d.toLocaleDateString("de-DE", {
                      day: "2-digit",
                      month: "2-digit",
                    })}</span
                  >
                  <span class="oi-link">Nachtragen →</span>
                </a>
              {/each}
            </div>
          {/if}
          {#if openItems.pendingRequests > 0}
            <a href="/leave?view=requests" class="oi-row">
              <span class="oi-dot oi-dot--pending"></span>
              <span
                >{openItems.pendingRequests} offene{openItems.pendingRequests === 1
                  ? "r Antrag"
                  : " Anträge"}</span
              >
              <span class="oi-link">→</span>
            </a>
          {/if}
          {#if openItems.invalidEntries > 0}
            <a href="/time-entries" class="oi-row">
              <span class="oi-dot oi-dot--fix"></span>
              <span>{openItems.invalidEntries} zu korrigieren</span>
              <span class="oi-link">→</span>
            </a>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  <!-- /widgets-row -->

  <!-- ═══ Team-Bereich (nur Manager/Admin) ═══ -->
  {#if isManager}
    <div class="team-divider">
      <span class="team-divider-label">Team</span>
    </div>

    <!-- Charts (Team-Aggregation) -->
    <div class="charts-grid">
      <div class="chart-card card card-body card-animate">
        <h3 class="chart-title">Arbeitsstunden (6 Monate)</h3>
        <div class="chart-wrap">
          {#if chartsLoading}
            <div class="chart-skeleton" aria-hidden="true"></div>
          {:else}
            <canvas
              bind:this={weeklyChartEl}
              role="img"
              aria-label="Balkendiagramm: gearbeitete Stunden der letzten 6 Monate"
            ></canvas>
          {/if}
        </div>
      </div>

      <div class="chart-card card card-body card-animate">
        <h3 class="chart-title">Überstunden-Trend</h3>
        <div class="chart-wrap">
          {#if chartsLoading}
            <div class="chart-skeleton" aria-hidden="true"></div>
          {:else}
            <canvas
              bind:this={overtimeChartEl}
              role="img"
              aria-label="Liniendiagramm: Überstunden-Verlauf der letzten 6 Monate"
            ></canvas>
          {/if}
        </div>
      </div>

      <div class="chart-card card card-body card-animate">
        <h3 class="chart-title">Krankheitstage (6 Monate)</h3>
        <div class="chart-wrap">
          {#if chartsLoading}
            <div class="chart-skeleton" aria-hidden="true"></div>
          {:else}
            <canvas
              bind:this={sickChartEl}
              role="img"
              aria-label="Balkendiagramm: Krankheitstage der letzten 6 Monate"
            ></canvas>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <!-- Anstehende Urlaube (nur Manager/Admin) -->
  {#if isManager && upcomingLeaves.length > 0}
    <div class="upcoming-section card card-body card-animate">
      <h3 class="chart-title">Anstehende Urlaube</h3>
      <div class="upcoming-list">
        {#each upcomingLeaves as leave (`${leave.employeeName}-${leave.startDate}`)}
          <div class="upcoming-item">
            <span class="upcoming-name">{leave.employeeName}</span>
            <span class="upcoming-dates">
              {new Date(leave.startDate).toLocaleDateString("de-DE", {
                day: "2-digit",
                month: "2-digit",
              })}
              – {new Date(leave.endDate).toLocaleDateString("de-DE", {
                day: "2-digit",
                month: "2-digit",
              })}
            </span>
            <span class="upcoming-days">{leave.days} {leave.days === 1 ? "Tag" : "Tage"}</span>
            <span class="upcoming-type badge badge-blue">{leave.type}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Team Wochenübersicht (nur Manager/Admin) -->
  {#if isManager && teamWeek}
    <div class="team-section card-animate">
      <div class="team-header">
        <div>
          <h2 class="section-title" style="margin-bottom:0.125rem;">Team-Wochenübersicht</h2>
          <p class="section-sub text-muted" style="margin:0;">
            KW {getWeekNumber(teamWeek.weekStart)}: {formatShortDate(teamWeek.weekStart)} – {formatShortDate(
              teamWeek.weekEnd,
            )}
          </p>
        </div>
        <div class="team-nav">
          <button class="btn btn-sm btn-ghost" onclick={prevWeek} title="Vorherige Woche">‹</button>
          <button class="btn btn-sm btn-ghost" onclick={currentWeek} disabled={weekOffset === 0}
            >Heute</button
          >
          <button class="btn btn-sm btn-ghost" onclick={nextWeek} title="Nächste Woche">›</button>
        </div>
      </div>

      <div class="team-grid-wrap">
        <table class="team-grid">
          <thead>
            <tr>
              <th class="team-grid__name">Mitarbeiter</th>
              {#each teamWeek.weekDays as day (day)}
                <th class="team-grid__day" class:team-grid__day--today={isToday(day)}>
                  <span class="day-label">{dayLabel(day)}</span>
                  <span class="day-num">{dayNum(day)}</span>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each pagedTeam as member (member.id)}
              <tr>
                <td class="team-grid__name">
                  <span class="member-name">{member.name}</span>
                </td>
                {#each member.days as day (day.date)}
                  <td class="team-grid__cell" class:team-grid__day--today={isToday(day.date)}>
                    {#if day.status === "present"}
                      <span
                        class="cell-badge cell-badge--present"
                        title="{day.workedHours.toFixed(1)}h gearbeitet"
                      >
                        {day.workedHours.toFixed(1)}
                      </span>
                      {#if day.shift}
                        <span
                          class="shift-label"
                          style={day.shift.color ? `color: ${day.shift.color}` : ""}
                        >
                          {day.shift.startTime}–{day.shift.endTime}
                        </span>
                      {/if}
                    {:else if day.status === "clocked_in"}
                      <span class="cell-badge cell-badge--active" title="Eingestempelt"> ● </span>
                    {:else if day.status === "absent"}
                      <span class="cell-badge cell-badge--absent" title={day.reason ?? "Abwesend"}>
                        {#if day.reason === "Krankmeldung" || day.reason === "Kinderkrank"}
                          🤒
                        {:else if day.reason === "Mutterschutz"}
                          🤰
                        {:else if day.reason === "Elternzeit"}
                          👶
                        {:else}
                          🌴
                        {/if}
                      </span>
                    {:else if day.status === "holiday"}
                      <span class="cell-badge cell-badge--holiday" title={day.reason ?? "Feiertag"}
                        >☀️</span
                      >
                    {:else if day.status === "missing"}
                      <span
                        class="cell-badge cell-badge--missing"
                        title="Fehlt! {day.shift
                          ? day.shift.startTime + '–' + day.shift.endTime
                          : 'Arbeitstag'}"
                      >
                        ⚠️
                      </span>
                    {:else if day.status === "scheduled"}
                      <span
                        class="cell-badge cell-badge--scheduled"
                        title={day.shift
                          ? (day.shift.label ?? day.shift.startTime + "–" + day.shift.endTime)
                          : "Arbeitstag"}
                        style={day.shift?.color ? `border-color: ${day.shift.color}` : ""}
                      >
                        {#if day.shift}
                          <span class="shift-time">{day.shift.startTime}–{day.shift.endTime}</span>
                        {:else}
                          <span class="shift-time">{day.expectedHours}h</span>
                        {/if}
                      </span>
                    {:else}
                      <span class="cell-badge cell-badge--none">–</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
        <Pagination
          total={teamWeek.team.length}
          bind:page={teamPage}
          bind:pageSize={teamPageSize}
        />
      </div>

      <div class="legend">
        <span class="legend-item"
          ><span class="cell-badge cell-badge--present">5.0</span> Anwesend</span
        >
        <span class="legend-item"
          ><span class="cell-badge cell-badge--active">●</span> Eingestempelt</span
        >
        <span class="legend-item"><span class="cell-badge cell-badge--absent">🌴</span> Urlaub</span
        >
        <span class="legend-item"><span class="cell-badge cell-badge--absent">🤒</span> Krank</span>
        <span class="legend-item"><span class="cell-badge cell-badge--missing">⚠️</span> Fehlt</span
        >
        <span class="legend-item"
          ><span class="cell-badge cell-badge--holiday">🎉</span> Feiertag</span
        >
        <span class="legend-item"
          ><span class="cell-badge cell-badge--scheduled">9–17</span> Geplant</span
        >
        <span class="legend-item"
          ><span class="cell-badge cell-badge--none">–</span> Keine Daten</span
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .dashboard {
    /* max-width inherited from .app-main (1600px) */
    /* Prevent chart.js canvas from causing horizontal overflow on narrow viewports */
    overflow-x: hidden;
  }

  /* Clock Card */
  .clock-card {
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .clock-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }
  .clock-left {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .clock-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1.0625rem;
    font-weight: 600;
    color: var(--color-text);
  }

  .clock-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background-color: var(--gray-300);
    flex-shrink: 0;
  }

  .clock-dot--active {
    background-color: var(--color-green);
    box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.2);
  }

  .clock-time-small {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-text-heading);
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .clock-elapsed-big {
    font-size: 2rem;
    font-weight: 700;
    color: var(--color-text-heading);
    letter-spacing: -0.03em;
    line-height: 1;
  }

  .clock-btn {
    padding: 0.625rem 2.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: center;
    white-space: nowrap;
    min-width: 180px;
    transition: all 0.15s ease;
  }
  .clock-btn--in {
    background-color: var(--color-green);
    color: #fff;
    border-color: var(--color-green);
  }
  .clock-btn--in:hover:not(:disabled) {
    background-color: #15803d;
    border-color: #15803d;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(22, 163, 74, 0.3);
  }
  .clock-btn--out {
    background-color: var(--color-red);
    color: #fff;
    border-color: var(--color-red);
  }
  .clock-btn--out:hover:not(:disabled) {
    background-color: #b91c1c;
    border-color: #b91c1c;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(220, 38, 38, 0.3);
  }

  /* ── Skeleton loader ────────────────────────────── */
  .skeleton-block,
  .skeleton-text {
    background: linear-gradient(
      90deg,
      var(--gray-100) 25%,
      var(--gray-200) 50%,
      var(--gray-100) 75%
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
  }
  .skeleton-text {
    display: inline-block;
    width: 4rem;
    height: 0.875em;
    vertical-align: middle;
  }
  @keyframes shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  /* ── Widgets Row (side by side) ──────────────────── */
  .widgets-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
    align-items: start;
  }
  @media (max-width: 768px) {
    .widgets-row {
      grid-template-columns: 1fr;
    }
  }

  /* ── My Week Widget ──────────────────────────────── */
  .my-week {
    margin-bottom: 0;
    border-left: 3px solid var(--color-brand);
  }
  .widget-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .widget-nav {
    display: flex;
    gap: 0.25rem;
  }
  .widget-title {
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    margin-bottom: 0;
  }
  .widget-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    background: var(--color-red);
    color: #fff;
    font-size: 0.6875rem;
    font-weight: 700;
    margin-left: 0.375rem;
    vertical-align: middle;
  }
  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .my-week .team-table {
    width: 100%;
    border-collapse: collapse;
  }
  .my-week .team-table th {
    padding: 0.375rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-align: center;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .my-week .team-table th .day-label {
    display: block;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .my-week .team-table th.is-today {
    color: var(--color-brand);
    font-weight: 700;
  }
  .my-week .team-table th.is-weekend {
    color: var(--gray-400);
  }
  .my-week .team-table td {
    padding: 0.375rem;
    text-align: center;
  }
  .my-week .team-table td.is-today {
    background: var(--color-brand-tint);
    border-radius: var(--radius-sm);
  }
  .week-cell {
    display: flex;
    justify-content: center;
    text-decoration: none;
  }
  .cell-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    padding: 0.25rem 0.375rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
    font-family: var(--font-mono);
  }
  .cell-badge--ok {
    background: var(--color-green-bg);
    color: var(--color-green);
  }
  .cell-badge--partial {
    background: var(--color-yellow-bg);
    color: var(--color-yellow);
  }
  .cell-badge--missing {
    background: var(--color-red-bg);
    color: var(--color-red);
  }
  .cell-badge--clocked {
    background: var(--color-blue-bg);
    color: var(--color-blue);
  }
  .cell-badge--holiday {
    background: var(--color-blue-bg);
    color: var(--color-blue);
  }
  .cell-badge--none {
    color: var(--gray-400);
  }

  /* ── Open Items Widget ─────────────────────────────── */
  .open-items {
    margin-bottom: 0;
    border-left: 3px solid var(--color-brand);
  }
  .open-items-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 220px;
    overflow-y: auto;
  }
  .oi-group {
    display: flex;
    flex-direction: column;
  }
  .oi-group-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 0.125rem;
  }
  .oi-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .oi-dot--warn {
    background: var(--color-red);
  }
  .oi-dot--pending {
    background: var(--color-yellow);
  }
  .oi-dot--fix {
    background: var(--color-blue);
  }
  .oi-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0 0.25rem 1.25rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    text-decoration: none;
    border-left: 2px solid var(--color-border-subtle);
    transition: all 0.12s;
  }
  .oi-item:hover {
    color: var(--color-brand);
    border-left-color: var(--color-brand);
  }
  .oi-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text);
    text-decoration: none;
    transition: color 0.12s;
  }
  .oi-row:hover {
    color: var(--color-brand);
  }
  .oi-link {
    margin-left: auto;
    color: var(--color-brand);
    font-size: 0.75rem;
    font-weight: 500;
  }
  .team-divider {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 1rem 0 1.5rem;
  }
  .team-divider::before,
  .team-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }
  .team-divider-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--color-text-muted);
  }

  .info-bar {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    padding: 0.625rem 1rem;
    background: var(--color-bg-subtle);
    border: 1px solid var(--color-border-subtle);
    border-left: 3px solid var(--color-brand);
    border-radius: var(--radius-sm);
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
    color: var(--color-text);
  }
  .info-bar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .info-bar-icon {
    font-size: 1rem;
  }

  .clock-shift {
    display: flex;
    justify-content: center;
    margin-top: 0.25rem;
  }
  .clock-shift-badge {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    padding: 0.25rem 0.75rem;
    border-left: 3px solid var(--gray-300);
    background: var(--color-bg-subtle);
    border-radius: 0 4px 4px 0;
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Pending Approvals Banner */
  .pending-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    background: var(--color-yellow-bg);
    border: 1px solid var(--color-yellow-border);
    border-radius: var(--radius-sm);
    margin-bottom: 1rem;
    text-decoration: none;
    color: var(--color-text);
    transition:
      background-color 0.15s,
      box-shadow 0.15s;
  }
  .pending-banner:hover {
    background: var(--color-yellow-border);
    box-shadow: var(--shadow-xs);
  }
  .pending-banner-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.375rem;
    height: 1.375rem;
    padding: 0 0.375rem;
    border-radius: 9999px;
    background: var(--color-yellow);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
  }
  .pending-banner-text {
    flex: 1;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .pending-banner svg {
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  /* Stats */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  .stats-grid .stat-card {
    border-left: 3px solid var(--color-brand, #6d28d9);
    overflow: hidden;
    min-width: 0;
  }

  .stat-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .stat-header-row .stat-label {
    margin-bottom: 0;
  }

  .stat-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }

  .stat-icon--brand {
    background: var(--color-brand-tint);
    color: var(--color-brand);
  }

  .stats-grid .stat-value {
    font-size: 2rem;
  }

  .stats-grid .stat-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.8125rem;
  }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  .chart-card:last-child {
    grid-column: 1 / -1;
  }

  .chart-card {
    padding: 1.25rem 1.5rem;
    border-left: 3px solid var(--color-brand);
  }

  .chart-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin: 0 0 1rem;
  }

  .chart-wrap {
    position: relative;
    height: 240px;
  }

  .chart-skeleton {
    width: 100%;
    height: 100%;
    border-radius: var(--radius-sm);
    background: linear-gradient(
      90deg,
      var(--color-bg-subtle) 25%,
      var(--color-bg-muted) 50%,
      var(--color-bg-subtle) 75%
    );
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  .upcoming-section {
    margin-top: 1.75rem;
    margin-bottom: 1.75rem;
    border-left: 3px solid var(--color-brand);
  }

  .upcoming-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .upcoming-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.875rem;
    min-width: 0;
  }

  .upcoming-item:last-child {
    border-bottom: none;
  }

  .upcoming-name {
    font-weight: 500;
    min-width: 80px;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .upcoming-dates {
    color: var(--color-text-muted);
    font-variant-numeric: tabular-nums;
  }

  .upcoming-days {
    color: var(--color-text-muted);
    font-size: 0.8125rem;
  }

  .upcoming-type {
    margin-left: auto;
  }

  @media (max-width: 900px) {
    .charts-grid {
      grid-template-columns: 1fr;
    }
    .chart-wrap {
      height: 180px;
    }
  }

  /* ── Team Section ── */
  .team-section {
    margin-bottom: 2rem;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-left: 3px solid var(--color-brand);
    border-radius: var(--radius-md);
    padding: 1.25rem;
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
  }

  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin: 0 0 0.25rem;
  }

  .section-sub {
    font-size: 0.8125rem;
    margin: 0 0 1rem;
  }

  .team-grid-wrap {
    overflow-x: auto;
    margin: 0 -0.25rem;
    /* Negative margin must not create horizontal page overflow on narrow viewports */
    max-width: calc(100% + 0.5rem);
  }

  @media (max-width: 768px) {
    .team-grid-wrap {
      margin: 0;
      max-width: 100%;
    }
  }

  .team-grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .team-grid th,
  .team-grid td {
    padding: 0.5rem 0.375rem;
    text-align: center;
    border-bottom: 1px solid var(--color-border);
  }

  .team-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }

  .team-nav {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }

  .team-grid__name {
    text-align: left;
    white-space: nowrap;
    padding-left: 0.5rem;
    padding-right: 0.75rem;
    width: 1%;
  }

  .team-grid__day {
    width: 4.5rem;
  }

  .team-grid__day--today {
    background: var(--color-brand-tint);
  }

  .day-label {
    display: block;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--color-text-muted);
  }

  .day-num {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .member-name {
    font-weight: 500;
    color: var(--color-text);
  }

  .team-grid__cell {
    min-width: 3rem;
    text-align: center;
    vertical-align: middle;
  }

  /* Cell badges */
  .cell-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    padding: 0.1875rem 0.4375rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition: transform 0.15s ease;
  }

  .cell-badge--present {
    background: var(--color-green-bg);
    color: var(--color-green);
    border: 1px solid var(--color-green-border);
  }

  .cell-badge--active {
    background: var(--color-blue-bg);
    color: var(--color-blue);
    border: 1px solid var(--color-blue-border);
    animation: pulse-badge 2s ease-in-out infinite;
  }

  @keyframes pulse-badge {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .cell-badge--absent {
    background: var(--color-yellow-bg);
    color: var(--color-yellow);
    border: 1px solid var(--color-yellow-border);
    font-size: 0.875rem;
  }

  .cell-badge--missing {
    background: var(--color-red-bg);
    color: var(--color-red);
    border: 1px solid var(--color-red-border);
    font-size: 0.875rem;
  }

  .cell-badge--scheduled {
    background: var(--color-bg-subtle, #f3f4f6);
    color: var(--color-text-muted);
    border: 1px dashed var(--color-border);
    font-size: 0.6875rem;
  }

  .cell-badge--none {
    color: var(--color-text-muted);
    opacity: 0.4;
  }

  .shift-label {
    display: block;
    font-size: 0.625rem;
    line-height: 1;
    margin-top: 2px;
    opacity: 0.7;
  }

  .shift-time {
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }

  /* Legend */
  .legend {
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--color-border-subtle);
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  @media (max-width: 900px) {
    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 600px) {
    .clock-row {
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .clock-left {
      align-items: center;
    }
    .clock-btn {
      width: 100%;
      min-width: 0;
    }
    .clock-elapsed-big {
      font-size: 1.75rem;
    }
  }
</style>
