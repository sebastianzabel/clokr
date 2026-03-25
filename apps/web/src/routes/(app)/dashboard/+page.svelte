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
  import { onMount, onDestroy } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
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
    status: "present" | "absent" | "clocked_in" | "missing" | "scheduled" | "none";
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
  let activeEntryId: string | null = null;
  let loading = $state(false);
  let clockLoading = $state(false);
  let breakMinutes = $state(0);
  let recentEntries: { id: string; endTime: string | null; startTime: string }[] = $state([]);
  let currentTime = $state(new Date());
  let clockStart: Date | null = $state(null);

  let stats: DashboardStats | null = $state(null);
  let teamWeek: TeamWeek | null = $state(null);
  let weekOffset = $state(0);
  let todayShift: {
    startTime: string;
    endTime: string;
    label: string | null;
    template: { name: string; color: string } | null;
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

  let timer: ReturnType<typeof setInterval>;

  const isManager = $derived(["ADMIN", "MANAGER"].includes($authStore.user?.role ?? ""));

  // ── Load ───────────────────────────────────────────────────────────────────
  onMount(async () => {
    await loadData();
    timer = setInterval(() => {
      currentTime = new Date();
    }, 1000);
  });

  onDestroy(() => {
    clearInterval(timer);
    weeklyChart?.destroy();
    overtimeChart?.destroy();
    sickChart?.destroy();
  });

  async function loadData() {
    loading = true;
    try {
      const today = format(new Date(), "yyyy-MM-dd");

      // Parallel laden
      const [entries, dashStats] = await Promise.all([
        api.get<{ id: string; endTime: string | null; startTime: string }[]>(
          `/time-entries?from=${today}&to=${today}`,
        ),
        api.get<DashboardStats>("/dashboard"),
      ]);

      recentEntries = entries;
      stats = dashStats;

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
    try {
      const now = new Date();
      const months: { label: string; month: string }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = subMonths(now, i);
        months.push({
          label: format(d, "MMM yy", { locale: de }),
          month: format(d, "yyyy-MM"),
        });
      }

      const reports: MonthlyReport[] = [];
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

      const labels = months.map((m) => m.label);
      const brandColor =
        getComputedStyle(document.documentElement).getPropertyValue("--color-brand").trim() ||
        "#6d28d9";

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

      // Overtime trend line chart
      if (overtimeChartEl) {
        const overtimeData = reports.map(
          (r) => +((r.workedMinutes - r.shouldMinutes) / 60).toFixed(1),
        );
        let cumulative = 0;
        const cumulativeData = overtimeData.map((v) => {
          cumulative += v;
          return +cumulative.toFixed(1);
        });

        overtimeChart?.destroy();
        overtimeChart = new Chart(overtimeChartEl, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Überstunden kumuliert (h)",
                data: cumulativeData,
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
    } catch (err) {
      console.error("Failed to load chart data:", err);
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

  let userName = $derived($authStore.user?.email.split("@")[0] ?? "");
  let capitalizedName = $derived(userName.charAt(0).toUpperCase() + userName.slice(1));

  let overtimeBalance = $derived(stats?.overtime.balanceHours ?? 0);
  let overtimeClass = $derived(
    Math.abs(overtimeBalance) >= 60
      ? "text-red"
      : Math.abs(overtimeBalance) >= 40
        ? "text-yellow"
        : "text-green",
  );

  const quickLinks = [
    { href: "/time-entries", icon: "🕐", label: "Zeiteinträge", desc: "Alle Einträge anzeigen" },
    { href: "/leave", icon: "🌴", label: "Urlaub", desc: "Antrag stellen" },
    { href: "/overtime", icon: "⏱️", label: "Überstunden", desc: "Konto einsehen" },
    { href: "/reports", icon: "📊", label: "Berichte", desc: "Auswertungen" },
  ];
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

  <!-- Clock-in Card -->
  <div class="clock-card card card-body">
    <div class="clock-status">
      <span class="clock-dot" class:clock-dot--active={clockedIn}></span>
      <span class="clock-status-text">
        {clockedIn ? "Eingestempelt" : "Ausgestempelt"}
      </span>
    </div>

    {#if todayShift}
      <div class="shift-info">
        <span
          class="shift-info__badge"
          style="background: {todayShift.template?.color ??
            '#6B7280'}22; border-left: 3px solid {todayShift.template?.color ??
            '#6B7280'}; padding: 0.375rem 0.75rem; border-radius: 4px; font-size: 0.8125rem;"
        >
          {todayShift.label ?? "Schicht"}: {todayShift.startTime} – {todayShift.endTime}
        </span>
      </div>
    {/if}

    <div class="clock-time font-mono">
      {format(currentTime, "HH:mm:ss")}
    </div>

    {#if clockedIn && clockStart}
      <p class="clock-elapsed text-muted">
        Eingestempelt seit {format(clockStart, "HH:mm")} Uhr ·
        <span class="font-mono">{formatElapsed(clockStart, currentTime)}</span>
      </p>
    {/if}

    {#if clockedIn}
      <div class="clock-break">
        <label class="form-label" for="break-input">Pause (Minuten)</label>
        <input
          id="break-input"
          type="number"
          bind:value={breakMinutes}
          min="0"
          max="480"
          class="form-input clock-break-input"
        />
      </div>
    {/if}

    <button
      onclick={handleClock}
      disabled={clockLoading}
      class="btn clock-btn"
      class:clock-btn--in={!clockedIn}
      class:clock-btn--out={clockedIn}
    >
      {#if clockLoading}
        <span class="btn-spinner"></span>
      {/if}
      {clockedIn ? "Ausstempeln" : "Einstempeln"}
    </button>
  </div>

  <!-- Stats Row -->
  <div class="stats-grid">
    <div class="stat-card">
      <p class="stat-label">Heute</p>
      <p class="stat-value font-mono">
        {#if clockedIn && clockStart}
          {formatElapsed(clockStart, currentTime)}
        {:else if stats}
          {fmtH(stats.today.workedHours)}
        {:else}
          –
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          {stats.today.entries} {stats.today.entries === 1 ? "Eintrag" : "Einträge"}
        {:else}
          Laden…
        {/if}
      </p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Diese Woche</p>
      <p class="stat-value font-mono">
        {#if stats}
          {fmtH(stats.week.workedHours)}
        {:else}
          –
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          von {fmtH(stats.week.targetHours)} Soll
        {:else}
          Laden…
        {/if}
      </p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Überstunden</p>
      <p class="stat-value {overtimeClass} font-mono">
        {overtimeBalance >= 0 ? "+" : ""}{overtimeBalance.toFixed(1)}h
      </p>
      <p class="stat-sub">
        {Math.abs(overtimeBalance) >= 60
          ? "Kritisch"
          : Math.abs(overtimeBalance) >= 40
            ? "Erhöht"
            : "Normal"}
      </p>
    </div>

    <div class="stat-card">
      <p class="stat-label">Resturlaub</p>
      <p class="stat-value font-mono">
        {#if stats}
          {stats.vacation.remaining}
        {:else}
          –
        {/if}
      </p>
      <p class="stat-sub">
        {#if stats}
          von {stats.vacation.total} Tagen
        {:else}
          Laden…
        {/if}
      </p>
    </div>
  </div>

  <!-- Charts -->
  <div class="charts-grid">
    <div class="chart-card card card-body">
      <h3 class="chart-title">Arbeitsstunden (6 Monate)</h3>
      <div class="chart-wrap">
        <canvas bind:this={weeklyChartEl}></canvas>
      </div>
    </div>

    <div class="chart-card card card-body">
      <h3 class="chart-title">Überstunden-Trend</h3>
      <div class="chart-wrap">
        <canvas bind:this={overtimeChartEl}></canvas>
      </div>
    </div>

    <div class="chart-card card card-body">
      <h3 class="chart-title">Krankheitstage (6 Monate)</h3>
      <div class="chart-wrap">
        <canvas bind:this={sickChartEl}></canvas>
      </div>
    </div>
  </div>

  <!-- Anstehende Urlaube (nur Manager/Admin) -->
  {#if isManager && upcomingLeaves.length > 0}
    <div class="upcoming-section card card-body">
      <h3 class="chart-title">Anstehende Urlaube</h3>
      <div class="upcoming-list">
        {#each upcomingLeaves as leave}
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
    <div class="team-section">
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
              {#each teamWeek.weekDays as day}
                <th class="team-grid__day" class:team-grid__day--today={isToday(day)}>
                  <span class="day-label">{dayLabel(day)}</span>
                  <span class="day-num">{dayNum(day)}</span>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each teamWeek.team as member (member.id)}
              <tr>
                <td class="team-grid__name">
                  <span class="member-name">{member.name}</span>
                </td>
                {#each member.days as day}
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
                        {:else if day.reason === "Urlaub"}
                          🌴
                        {:else if day.reason === "Mutterschutz"}
                          🤰
                        {:else if day.reason === "Elternzeit"}
                          👶
                        {:else}
                          ✗
                        {/if}
                      </span>
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
          ><span class="cell-badge cell-badge--scheduled">9–17</span> Geplant</span
        >
        <span class="legend-item"
          ><span class="cell-badge cell-badge--none">–</span> Keine Daten</span
        >
      </div>
    </div>
  {/if}

  <!-- Quick Links -->
  <div class="quick-links-header">
    <h2>Schnellzugriff</h2>
  </div>
  <div class="quick-links">
    {#each quickLinks as link}
      <a href={link.href} class="quick-link card">
        <span class="quick-link-icon">{link.icon}</span>
        <div>
          <p class="quick-link-label">{link.label}</p>
          <p class="quick-link-desc text-muted">{link.desc}</p>
        </div>
      </a>
    {/each}
  </div>
</div>

<style>
  .dashboard {
    /* max-width inherited from .app-main (1600px) */
  }

  /* Clock Card */
  .clock-card {
    text-align: center;
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .shift-info {
    display: flex;
    justify-content: center;
  }

  .clock-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-text-muted);
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

  .clock-time {
    font-size: 3.5rem;
    font-weight: 700;
    color: var(--color-text-heading);
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .clock-elapsed {
    font-size: 0.875rem;
  }
  .clock-break {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .clock-break-input {
    width: 5rem;
    text-align: center;
  }

  .clock-btn {
    padding: 0.75rem 2.5rem;
    font-size: 1rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 160px;
    justify-content: center;
  }
  .clock-btn--in {
    background-color: var(--color-green);
    color: #fff;
    border-color: var(--color-green);
  }
  .clock-btn--in:hover:not(:disabled) {
    background-color: #15803d;
    border-color: #15803d;
    color: #fff;
  }
  .clock-btn--out {
    background-color: var(--color-red);
    color: #fff;
    border-color: var(--color-red);
  }
  .clock-btn--out:hover:not(:disabled) {
    background-color: #b91c1c;
    border-color: #b91c1c;
    color: #fff;
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

  /* Stats */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-bottom: 1.75rem;
  }

  .chart-card {
    padding: 1rem 1.25rem;
  }

  .chart-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin: 0 0 0.75rem;
  }

  .chart-wrap {
    position: relative;
    height: 200px;
  }

  .upcoming-section {
    margin-top: 1.75rem;
    margin-bottom: 1.75rem;
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
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.875rem;
  }

  .upcoming-item:last-child {
    border-bottom: none;
  }

  .upcoming-name {
    font-weight: 500;
    min-width: 120px;
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
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: 1.25rem;
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
    background: rgba(79, 70, 229, 0.05);
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
    min-width: 2rem;
    padding: 0.125rem 0.375rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .cell-badge--present {
    background: #dcfce7;
    color: #166534;
  }

  .cell-badge--active {
    background: #dbeafe;
    color: #1d4ed8;
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
    background: #fef3c7;
    color: #92400e;
    font-size: 0.875rem;
  }

  .cell-badge--missing {
    background: #fecaca;
    color: #991b1b;
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
    gap: 1rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
    font-size: 0.75rem;
    color: var(--color-text-muted);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  /* Quick Links */
  .quick-links-header {
    margin-bottom: 0.875rem;
  }
  .quick-links-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .quick-links {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
  }
  .quick-link {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 1.125rem 1.25rem;
    text-decoration: none;
    color: var(--color-text);
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .quick-link:hover {
    border-color: var(--color-brand-light);
    box-shadow: var(--shadow-md);
    color: var(--color-text);
  }
  .quick-link-icon {
    font-size: 1.5rem;
    flex-shrink: 0;
  }
  .quick-link-label {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--color-text-heading);
    margin-bottom: 0.125rem;
  }
  .quick-link-desc {
    font-size: 0.8125rem;
  }

  @media (max-width: 900px) {
    .stats-grid,
    .quick-links {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (max-width: 480px) {
    .clock-time {
      font-size: 2.5rem;
    }
  }
</style>
