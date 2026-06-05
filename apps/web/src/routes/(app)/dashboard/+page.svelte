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
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import MyShiftsWeek from "$lib/components/dashboard/MyShiftsWeek.svelte";
  import MyWeekView from "$lib/components/dashboard/MyWeekView.svelte";
  import Icon from "$lib/components/Icon.svelte";
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
    periodType?: "week" | "month";
    // Phase 49.1 — schedule type for per-model widget branching
    scheduleType?: "FIXED_SCHEDULE" | "FLEXTIME" | "MONTHLY_HOURS" | "SHIFT_BASED";
    month?: { workedHours: number; targetHours: number };
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

  // ── Open break (dashboard pause toggle) ──────────────────────────────────
  // Open breaks are not persisted on the server (Break records are always
  // closed segments — see CLAUDE.md "Break model"). We track the active
  // break-start time in localStorage keyed by the active TimeEntry id so it
  // survives page reloads. On "Pause beenden" we POST a complete Break
  // segment (start + end) to /api/v1/time-entries/:id/breaks.
  let breakStartedAt: Date | null = $state(null);
  let breakLoading = $state(false);
  const OPEN_BREAK_STORAGE_KEY = "clokr.dashboard.openBreak";

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

  // Phase 49.4: MyWeekView (non-SHIFT_BASED) and MyShiftsWeek (SHIFT_BASED) each
  // fetch their own data. shiftFallback flips to true when MyShiftsWeek reports 410,
  // so a SHIFT_BASED-flagged employee with no actual shifts still gets the hours view.
  let shiftFallback = $state(false);

  // Open items widget
  let openItems: {
    pendingApprovals: number;
    missingDays: string[];
    pendingRequests: number;
    invalidEntries: number;
    total: number;
  } | null = $state(null);

  // ── Heutiger Eintrag (row 2 col-7) ────────────────────────────────────────
  interface TodayEntry {
    id: string;
    startTime: string; // ISO
    endTime: string | null;
    breakMinutes: number;
  }
  let todayEntry = $state<TodayEntry | null>(null);

  // ── Aktivität (row 2 col-5) ───────────────────────────────────────────────
  interface ActivityItem {
    id: string;
    icon: "check" | "clock" | "inbox" | "edit" | "lock" | "info" | "x";
    who: string;
    what: string;
    when: string; // ISO
    category: "time" | "leave" | "close" | "audit";
  }
  let activityItems = $state<ActivityItem[]>([]);

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
          // Restore any in-progress break that was started in a previous page
          // load (localStorage). Stale entries (different entryId) are cleared.
          restoreOpenBreak();
        } else {
          clockedIn = false;
          activeEntryId = null;
          clockStart = null;
          breakStartedAt = null;
          clearStoredOpenBreak();
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

      // Load today's shift — only for SHIFT_BASED employees. Other schedule types
      // (FIXED_SCHEDULE / FLEXTIME / MONTHLY_HOURS) may still have shift records in
      // the DB from a previous schedule type (audit-proof: we don't delete shifts on
      // schedule-type change), but those records are not relevant to the current model
      // and should not surface in the employee's own dashboard.
      if (stats?.scheduleType === "SHIFT_BASED") {
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
      } else {
        todayShift = null;
      }

      // Phase 49.4: MyWeekView / MyShiftsWeek each fetch their own data — no prefetch here.
      try {
        openItems = await api.get<typeof openItems>("/dashboard/open-items");
      } catch {
        /* ignore */
      }

      // Today's entry breakdown (row 2 / col-7)
      if (entriesResult.status === "fulfilled") {
        const all = entriesResult.value as unknown as Array<{
          id: string;
          startTime: string;
          endTime: string | null;
          breakMinutes: number;
        }>;
        // Prefer the open entry; fall back to first entry of the day
        const openEntry = all.find((e) => !e.endTime);
        const ref = openEntry ?? all[0] ?? null;
        todayEntry = ref
          ? {
              id: ref.id,
              startTime: ref.startTime,
              endTime: ref.endTime,
              breakMinutes: ref.breakMinutes ?? 0,
            }
          : null;
      }

      // Activity feed (row 2 / col-5) — role-gated server-side
      try {
        const res = await api.get<{ items: ActivityItem[] }>("/activity?limit=5");
        activityItems = res.items ?? [];
      } catch {
        activityItems = [];
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
    if (isManager) await loadTeamWeek(); // only managers need team-week data
    // Also refresh clock-in status
    try {
      const today = format(new Date(), "yyyy-MM-dd");
      const entries = await api.get<{ id: string; endTime: string | null; startTime: string }[]>(
        `/time-entries?from=${today}&to=${today}`,
      );
      const openEntry = entries.find((e) => !e.endTime);
      if (openEntry) {
        const wasSameEntry = activeEntryId === openEntry.id;
        clockedIn = true;
        activeEntryId = openEntry.id;
        clockStart = new Date(openEntry.startTime);
        // If the active entry changed underneath us (rare — e.g. clock-out
        // happened in another tab), an in-memory open break is stale. Clear it.
        if (!wasSameEntry) {
          restoreOpenBreak();
        }
      } else {
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
        breakStartedAt = null;
        clearStoredOpenBreak();
      }
    } catch (err) {
      console.error("Failed to poll clock status:", err);
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
        getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() || "#80377B";
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

    // Weekly hours bar chart (Soll vs Ist) — matches Wochenbilanz weekly-bar styling
    if (weeklyChartEl) {
      weeklyChart?.destroy();
      const rootStyle = getComputedStyle(document.documentElement);
      const brandLight = rootStyle.getPropertyValue("--brand-light").trim() || brandColor;
      const bgSubtle = rootStyle.getPropertyValue("--bg-subtle").trim() || "#f5f3ef";
      weeklyChart = new Chart(weeklyChartEl, {
        type: "bar",
        data: {
          labels,
          datasets: [
            // Soll first → renders behind as the "track"
            {
              label: "Soll (h)",
              data: reports.map((r) => +(r.shouldMinutes / 60).toFixed(1)),
              backgroundColor: bgSubtle,
              borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
              borderSkipped: false,
              order: 2,
              stack: "wochenbilanz",
              grouped: false,
            },
            // Ist on top, overlapping inside Soll → matches Wochenbilanz fill-in-track look
            {
              label: "Ist (h)",
              data: reports.map((r) => +(r.workedMinutes / 60).toFixed(1)),
              backgroundColor: brandLight,
              borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
              borderSkipped: false,
              order: 1,
              stack: "wochenbilanz",
              grouped: false,
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
        // If a break is open, close it first so the time gets recorded before
        // we ask the server to clock out (otherwise the time would silently
        // be lost when activeEntryId is cleared).
        if (breakStartedAt) {
          try {
            await endOpenBreak();
          } catch (err) {
            toasts.error(err instanceof Error ? err.message : "Pause konnte nicht beendet werden");
            return; // abort clock-out — user can retry
          }
        }
        await api.post(`/time-entries/${activeEntryId}/clock-out`, { breakMinutes });
        clockedIn = false;
        activeEntryId = null;
        clockStart = null;
        breakMinutes = 0;
        clearStoredOpenBreak();
      }
      await loadData();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Fehler beim Stempeln");
    } finally {
      clockLoading = false;
    }
  }

  // ── Break toggle (Pause starten / Pause beenden) ─────────────────────────
  // Toggle semantics: starting just records a local timestamp; ending POSTs
  // the closed segment to the server. Disabled while not clocked in.
  async function handleBreakToggle() {
    if (!clockedIn || !activeEntryId || clockLoading) return;
    breakLoading = true;
    try {
      if (breakStartedAt) {
        await endOpenBreak();
      } else {
        startOpenBreak();
      }
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Pause fehlgeschlagen");
    } finally {
      breakLoading = false;
    }
  }

  function startOpenBreak() {
    breakStartedAt = new Date();
    persistOpenBreak();
  }

  async function endOpenBreak() {
    if (!breakStartedAt || !activeEntryId) return;
    const startedAt = breakStartedAt;
    const endedAt = new Date();
    // Guard against zero-length breaks (double-click): ensure the Break record
    // is at least 60s long by anchoring on endedAt and shifting the START into
    // the PAST when needed. We must never shift the END into the future — the
    // server rejects future-end timestamps ("Pausenende darf nicht in der
    // Zukunft liegen") and the local "now" is already at or after the server's
    // "now" once the request round-trips.
    //
    // The shifted start is also clamped to clockStart so the break never lies
    // before the entry's startTime (server validates that too).
    let effectiveStart = startedAt;
    if (endedAt.getTime() - startedAt.getTime() < 60_000) {
      effectiveStart = new Date(endedAt.getTime() - 60_000);
      if (clockStart && effectiveStart < clockStart) {
        effectiveStart = clockStart;
      }
    }
    const res = await api.post<{ breakMinutes: number }>(`/time-entries/${activeEntryId}/breaks`, {
      startTime: effectiveStart.toISOString(),
      endTime: endedAt.toISOString(),
    });
    breakMinutes = res.breakMinutes;
    breakStartedAt = null;
    clearStoredOpenBreak();
  }

  function persistOpenBreak() {
    if (typeof window === "undefined") return;
    if (!activeEntryId || !breakStartedAt) return;
    try {
      localStorage.setItem(
        OPEN_BREAK_STORAGE_KEY,
        JSON.stringify({ entryId: activeEntryId, startedAt: breakStartedAt.toISOString() }),
      );
    } catch {
      /* localStorage may be unavailable; ignore */
    }
  }

  function clearStoredOpenBreak() {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(OPEN_BREAK_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  function restoreOpenBreak() {
    if (typeof window === "undefined") return;
    if (!activeEntryId) return;
    try {
      const raw = localStorage.getItem(OPEN_BREAK_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { entryId: string; startedAt: string };
      if (parsed.entryId !== activeEntryId) {
        // Stale entry from a previous clock-in cycle.
        clearStoredOpenBreak();
        return;
      }
      const startedAt = new Date(parsed.startedAt);
      if (Number.isNaN(startedAt.getTime())) {
        clearStoredOpenBreak();
        return;
      }
      breakStartedAt = startedAt;
    } catch {
      clearStoredOpenBreak();
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

  function fmtHours(hours: number): string {
    const totalMin = Math.round(Math.abs(hours) * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, "0")}h`;
  }

  function fmtBalanceHours(hours: number): string {
    if (hours === 0) return "±0:00";
    return (hours > 0 ? "+" : "−") + fmtHours(hours);
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

  // Timer card derived state (Phase 29, EMP-01)
  const TIMER_TARGET_MS = 8 * 60 * 60 * 1000;
  let elapsedMs = $derived.by((): number => {
    const start = clockStart as Date | null;
    if (!clockedIn || !start) return 0;
    return currentTime.getTime() - start.getTime();
  });
  let pctTarget = $derived(Math.min(100, (elapsedMs / TIMER_TARGET_MS) * 100));
  let remainingTargetHours = $derived(Math.max(0, (TIMER_TARGET_MS - elapsedMs) / 3_600_000));
  let workedHoursLive = $derived(elapsedMs / 3_600_000);

  // ── Heutiger Eintrag derived ──────────────────────────────────────────────
  // Compute Start/End/Pause/Net from todayEntry.
  // - If clocked in (no endTime): "Ende" shows "—", break minutes are 0 (breaks only counted after clock-out)
  // - If clocked out: use entry.endTime; breakMinutes from entry
  let entryStartHHMM = $derived.by(() => {
    if (!todayEntry) return "—";
    const d = new Date(todayEntry.startTime);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  let entryEndHHMM = $derived.by(() => {
    if (!todayEntry || !todayEntry.endTime) return "—";
    const d = new Date(todayEntry.endTime);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  // Live-updating worked minutes: open entry => up to currentTime, closed => endTime - startTime
  let entryWorkedMin = $derived.by(() => {
    if (!todayEntry) return 0;
    const start = new Date(todayEntry.startTime).getTime();
    const end = todayEntry.endTime ? new Date(todayEntry.endTime).getTime() : currentTime.getTime();
    const gross = Math.max(0, (end - start) / 60000);
    return Math.max(0, gross - (todayEntry.breakMinutes ?? 0));
  });
  let entryBreakMin = $derived(todayEntry?.breakMinutes ?? 0);

  function fmtHm(min: number): string {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return `${h}:${String(m).padStart(2, "0")} h`;
  }
  let entryBreakLabel = $derived(todayEntry ? fmtHm(entryBreakMin) : "—");
  let entryNetLabel = $derived(todayEntry ? fmtHm(entryWorkedMin) : "—");

  // Timeline progress: % of 12h window from 07:00 start anchor
  let entryProgressPct = $derived.by(() => {
    if (!todayEntry) return 0;
    const start = new Date(todayEntry.startTime).getTime();
    const end = todayEntry.endTime ? new Date(todayEntry.endTime).getTime() : currentTime.getTime();
    const dur = Math.max(0, end - start);
    return Math.min(100, (dur / (12 * 3_600_000)) * 100);
  });

  // ArbZG § 4 callout message
  let arbzgCallout = $derived.by((): { title: string; body: string } => {
    if (!todayEntry) {
      return {
        title: "Noch nicht eingestempelt heute.",
        body: "Sobald du startest, wird die Pausenpflicht hier angezeigt.",
      };
    }
    const workedHours = entryWorkedMin / 60;
    if (workedHours < 6) {
      const need = Math.max(0, 30 - entryBreakMin);
      return {
        title: "§ 4 ArbZG: noch ausreichend Pausenzeit.",
        body:
          need > 0
            ? `${Math.round(need)} Min. Pause erforderlich ab 6:00 Std. Arbeit.`
            : "30 Min. Pause bereits genommen.",
      };
    }
    if (entryBreakMin < 30) {
      return {
        title: "§ 4 ArbZG verletzt.",
        body: "Bei mehr als 6 Std. Arbeit sind mind. 30 Min. Pause Pflicht — bitte Pause nachtragen.",
      };
    }
    if (workedHours > 9 && entryBreakMin < 45) {
      return {
        title: "§ 4 ArbZG verletzt.",
        body: "Bei mehr als 9 Std. Arbeit sind mind. 45 Min. Pause Pflicht.",
      };
    }
    return {
      title: "§ 4 ArbZG erfüllt.",
      body: `${Math.round(entryBreakMin)} Min. Pause genommen, keine weitere Pause erforderlich.`,
    };
  });

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    const now = currentTime.getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return "gerade eben";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `vor ${diffMin} Min.`;
    const sameDay = new Date(iso).toDateString() === new Date(now).toDateString();
    if (sameDay) {
      const d = new Date(iso);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    const diffDays = Math.floor(diffSec / 86400);
    if (diffDays === 1) return "gestern";
    if (diffDays < 7) {
      const d = new Date(iso);
      return format(d, "EEE", { locale: de });
    }
    return new Date(iso).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
    });
  }
</script>

<svelte:head>
  <title>Dashboard – Clokr</title>
</svelte:head>

<!-- Phase 75-02 (D-01): data-testid surface for the Dashboard visual baseline.
     Matches the Phase 73-04/-05 convention (`<surface>-page`). -->
<div class="dashboard" data-testid="dashboard-page">
  <!-- Page Header -->
  <PageHead
    eyebrow="Mein Bereich"
    title={`${greeting()}, ${capitalizedName}`}
    accent={capitalizedName}
  />

  <!-- Phase 49.4 (rearrange): two-column stack — LEFT (Timer → Heutiger Eintrag → Aktivität),
       RIGHT (KPI-pair → MyShifts/MyWeekView → Offene Vorgänge). Eliminates row-bound gaps
       where Timer-Card and Aktivität were short while MyShiftsWeek on the right was tall. -->
  <div class="dashboard-stacks">
    <!-- LEFT column (col-7) -->
    <div class="dashboard-stack dashboard-stack--left">
      <!-- Timer Card Hero (EMP-01) -->
      <Card animate class="timer-card col-7 timer-card-wrap" style="--card-idx: 0;">
        <div class="timer-hd">
          <div>
            <div class="timer-hd-title">
              {clockedIn ? "Du arbeitest gerade" : "Noch nicht eingestempelt"}
            </div>
            <div class="timer-status">
              {#if clockedIn && clockStart}
                <span class="live-dot" aria-hidden="true"></span>
                <span>gestartet um {format(clockStart, "HH:mm")}</span>
              {:else}
                <span class="timer-status-idle">Bereit zum Einstempeln</span>
              {/if}
            </div>
          </div>
          <div class="timer-hd-right">
            <div class="timer-hd-title timer-hd-date">
              {format(currentTime, "EEEE, d. MMMM", { locale: de })}
            </div>
            <div class="timer-now">
              {format(currentTime, "HH:mm")}
            </div>
          </div>
        </div>

        <div class="clock timer-display">
          {clockedIn && clockStart ? formatElapsed(clockStart, currentTime) : "00:00:00"}
        </div>
        {#if stats?.scheduleType === "FIXED_SCHEDULE"}
          <div class="timer-sub">
            {clockedIn
              ? `Noch ${fmtHours(remainingTargetHours)} bis zum Tagesziel`
              : "Bereit für deinen Tag"}
          </div>

          <div class="timer-progress">
            <div class="timer-progress-track">
              <div class="timer-progress-fill" style="width: {pctTarget}%;"></div>
            </div>
            <div class="timer-progress-labels">
              <span>{fmtHours(workedHoursLive)} gearbeitet</span>
              <span>Tagesziel 8:00</span>
            </div>
          </div>
        {:else}
          <div class="timer-sub">
            {clockedIn ? "Zeiterfassung läuft" : "Bereit für deinen Tag"}
          </div>
        {/if}

        <div class="card-foot timer-foot">
          <button
            onclick={handleClock}
            disabled={clockLoading}
            class="btn btn-primary timer-cta-primary"
            type="button"
          >
            {#if clockLoading}<span class="btn-spinner"></span>{/if}
            {clockedIn ? "Ausstempeln" : "Einstempeln"}
          </button>
          {#if clockedIn}
            <button
              type="button"
              class="btn btn-ghost timer-cta-ghost"
              class:timer-cta-ghost--active={breakStartedAt}
              disabled={clockLoading || breakLoading}
              onclick={handleBreakToggle}
              title={breakStartedAt
                ? "Aktive Pause beenden — die Zeit wird als Pause vom Eintrag abgezogen"
                : "Pause starten — die Zeit wird als Pause vom Eintrag abgezogen"}
            >
              {#if breakLoading}<span class="btn-spinner"></span>{/if}
              {breakStartedAt ? "Pause beenden" : "Pause starten"}
            </button>
          {/if}
        </div>

        {#if todayShift}
          <div class="timer-shift">
            <span class="timer-shift-label">
              {todayShift.label ?? "Schicht"}: {todayShift.startTime} – {todayShift.endTime}
            </span>
          </div>
        {/if}
      </Card>
      <!-- /timer-card -->

      <!-- Heutiger Eintrag (moved into left stack — Phase 49.4 rearrange) -->
      <Card animate class="today-entry-card" style="--card-idx: 3;">
        <CardHeader
          title="Heutiger Eintrag"
          sub={format(currentTime, "EEEE, d. MMMM yyyy", { locale: de })}
        >
          {#snippet actions()}
            <a
              href="/time-entries?view=list&date={format(currentTime, 'yyyy-MM-dd')}"
              class="btn btn-ghost btn-sm today-entry-edit"
              aria-label="Heutigen Eintrag bearbeiten"
            >
              ✎ Bearbeiten
            </a>
          {/snippet}
        </CardHeader>

        <div class="today-stats">
          <div class="today-stat">
            <div class="today-stat-label">Start</div>
            <div class="today-stat-value">{entryStartHHMM}</div>
          </div>
          <div class="today-stat">
            <div class="today-stat-label">Ende</div>
            <div class="today-stat-value">{entryEndHHMM}</div>
          </div>
          <div class="today-stat">
            <div class="today-stat-label">Pausen</div>
            <div class="today-stat-value">{entryBreakLabel}</div>
          </div>
          <div class="today-stat">
            <div class="today-stat-label">Netto</div>
            <div class="today-stat-value today-stat-accent">{entryNetLabel}</div>
          </div>
        </div>

        <div class="today-timeline">
          <div class="today-timeline-track"></div>
          <div class="today-timeline-fill" style="width: {entryProgressPct}%;"></div>
          <div class="today-timeline-marks">
            {#each ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] as h (h)}
              <span class="today-timeline-mark">{h}</span>
            {/each}
          </div>
        </div>

        <div class="callout brand today-arbzg">
          <span class="ico" aria-hidden="true">ℹ️</span>
          <div>
            <b>{arbzgCallout.title}</b>
            <span> {arbzgCallout.body}</span>
          </div>
        </div>
      </Card>
      <!-- /today-entry-card -->

      <!-- Aktivität (moved into left stack — Phase 49.4 rearrange) -->
      <Card animate class="activity-card" style="--card-idx: 4;">
        <CardHeader title="Aktivität" sub="Letzte Ereignisse" />

        <div class="activity-list">
          {#if activityItems.length === 0}
            <div class="activity-empty">Keine Ereignisse in der letzten Zeit.</div>
          {:else}
            {#each activityItems as item, i (item.id)}
              <div class="activity-row" class:activity-row--last={i === activityItems.length - 1}>
                <div class="activity-icon" aria-hidden="true">
                  {#if item.icon === "check"}
                    ✓
                  {:else if item.icon === "x"}
                    ✕
                  {:else if item.icon === "clock"}
                    ⏱
                  {:else if item.icon === "inbox"}
                    ✉
                  {:else if item.icon === "edit"}
                    ✎
                  {:else if item.icon === "lock"}
                    🔒
                  {:else}
                    •
                  {/if}
                </div>
                <div class="activity-text">
                  <b class="activity-who">{item.who}</b>
                  <span class="activity-what"> {item.what}</span>
                </div>
                <div class="activity-when">{relativeTime(item.when)}</div>
              </div>
            {/each}
          {/if}
        </div>
      </Card>
      <!-- /activity-card -->
    </div>
    <!-- /dashboard-stack--left -->

    <!-- RIGHT column (col-5) -->
    <div class="dashboard-stack dashboard-stack--right">
      <!-- KPI pair -->
      <Card animate class="kpi-pair" style="--card-idx: 1;">
        {#if stats}
          <KPIStat
            label="Urlaubstage"
            value={String(stats.vacation.remaining)}
            unit={`/ ${stats.vacation.total}`}
            delta={`verbleibend${stats.vacation.used > 0 ? ` · ${stats.vacation.used} verbraucht` : ""}`}
          />
          <KPIStat
            label="Überstundenkonto"
            value={fmtBalanceHours(stats.overtime.balanceHours)}
            delta={stats.overtime.balanceHours === 0
              ? "ausgeglichen"
              : stats.overtime.balanceHours > 0
                ? "↗ Guthaben"
                : "↘ offen"}
            deltaTone={stats.overtime.balanceHours === 0
              ? "neutral"
              : stats.overtime.balanceHours > 0
                ? "good"
                : "warn"}
          />
          {#if stats.scheduleType === "FLEXTIME"}
            {@const weekDiff = stats.week.workedHours - stats.week.targetHours}
            <KPIStat
              label="Diese Woche Soll"
              value={fmtHours(stats.week.workedHours)}
              unit={`/ ${fmtHours(stats.week.targetHours)}`}
              delta={weekDiff === 0
                ? "ausgeglichen"
                : weekDiff > 0
                  ? `↗ +${fmtHours(weekDiff)}`
                  : `↘ ${fmtHours(weekDiff)}`}
              deltaTone={weekDiff === 0 ? "neutral" : weekDiff > 0 ? "good" : "warn"}
            />
          {/if}
        {:else}
          <KPIStat label="Urlaubstage" value="–" />
          <KPIStat label="Überstundenkonto" value="–" />
        {/if}
      </Card>

      <!-- Phase 49.4 — Weekly view: MyShiftsWeek for SHIFT_BASED, MyWeekView for everyone else -->
      {#if stats?.scheduleType === "SHIFT_BASED" && !shiftFallback}
        <MyShiftsWeek
          onFallback={() => {
            shiftFallback = true;
          }}
        />
      {:else}
        <MyWeekView />
      {/if}

      <!-- Offene Vorgänge (moved into right stack — Phase 49.4 rearrange) -->
      {#if openItems}
        <Card animate class="open-items" style="--card-idx: 6;">
          <CardHeader title="Offene Vorgänge" sub="Letzte Übersicht">
            {#snippet actions()}
              <a href="/leave?view=approvals" class="btn btn-ghost btn-sm">Alle anzeigen →</a>
            {/snippet}
          </CardHeader>
          <div class="open-items-list">
            {#if openItems.total === 0}
              <p class="oi-empty">Keine offenen Vorgänge</p>
            {:else}
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
              {#if openItems.pendingApprovals > 0}
                <a href="/leave?view=approvals" class="oi-row">
                  <span class="oi-dot oi-dot--approval"></span>
                  <span
                    >{openItems.pendingApprovals} zu genehmigende{openItems.pendingApprovals === 1
                      ? "r Antrag"
                      : " Anträge"}</span
                  >
                  <span class="oi-link">→</span>
                </a>
              {/if}
            {/if}
          </div>
        </Card>
      {/if}
    </div>
    <!-- /dashboard-stack--right -->
  </div>
  <!-- /dashboard-stacks -->

  <!-- Phase 49.4 — Nächster Urlaub (Schicht-Pille entfernt: Info ist bereits in Timer-Card sichtbar) -->
  {#if myNextLeave}
    <div class="info-bar card-animate" style="--card-idx: 5;">
      <div class="info-bar-item">
        <span class="info-bar-icon"><Icon name="umbrella" size={16} /></span>
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
    </div>
  {/if}

  <!-- ═══ Team-Bereich (nur Manager/Admin) ═══ -->
  <!-- Single role gate: employees never see team charts, upcoming leaves, or team-week table -->
  {#if $authStore.user?.role === "MANAGER" || $authStore.user?.role === "ADMIN"}
    <div class="team-divider">
      <span class="team-divider-label">Team</span>
    </div>

    <!-- Charts (Team-Aggregation) -->
    <div class="charts-grid">
      <Card animate class="chart-card" style="--card-idx: 7;">
        <CardHeader title="Arbeitsstunden" sub="Letzte 6 Monate" />
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
      </Card>

      <Card animate class="chart-card" style="--card-idx: 8;">
        <CardHeader title="Überstunden-Trend" sub="Saldo-Verlauf" />
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
      </Card>

      <Card animate class="chart-card" style="--card-idx: 9;">
        <CardHeader title="Krankheitstage" sub="Letzte 6 Monate" />
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
      </Card>
    </div>

    <!-- Anstehende Urlaube -->
    {#if upcomingLeaves.length > 0}
      <Card animate class="upcoming-section card-body" style="--card-idx: 10;">
        <div class="widget-header">
          <h3 class="widget-title">Anstehende Urlaube</h3>
          <a href="/leave" class="widget-action">Urlaube →</a>
        </div>
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
      </Card>
    {/if}

    <!-- Team Wochenübersicht -->
    {#if teamWeek}
      <Card animate class="team-section" style="--card-idx: 11;">
        <CardHeader
          title="Team-Wochenübersicht"
          sub={`KW ${getWeekNumber(teamWeek.weekStart)}: ${formatShortDate(teamWeek.weekStart)} – ${formatShortDate(teamWeek.weekEnd)}`}
        >
          {#snippet actions()}
            <button class="btn btn-sm btn-ghost" onclick={prevWeek} title="Vorherige Woche"
              >‹</button
            >
            <button class="btn btn-sm btn-ghost" onclick={currentWeek} disabled={weekOffset === 0}
              >Heute</button
            >
            <button class="btn btn-sm btn-ghost" onclick={nextWeek} title="Nächste Woche">›</button>
          {/snippet}
        </CardHeader>

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
                          title="{fmtHours(day.workedHours)} gearbeitet"
                        >
                          {fmtHours(day.workedHours)}
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
                        <span class="cell-badge cell-badge--active" title="Eingestempelt">
                          <Icon name="circle-fill" size={14} />
                        </span>
                      {:else if day.status === "absent"}
                        <span
                          class="cell-badge cell-badge--absent"
                          class:cell-badge--bs={day.reason === "Berufsschule"}
                          title={day.reason ?? "Abwesend"}
                        >
                          {#if day.reason === "Krankmeldung" || day.reason === "Kinderkrank"}
                            <Icon name="medical" size={14} title={day.reason ?? "Krank"} />
                          {:else if day.reason === "Mutterschutz"}
                            <Icon name="heart" size={14} title="Mutterschutz" />
                          {:else if day.reason === "Elternzeit"}
                            <Icon name="users" size={14} title="Elternzeit" />
                          {:else if day.reason === "Berufsschule"}
                            <Icon name="graduation-cap" size={14} title="Berufsschule" />
                          {:else}
                            <Icon name="umbrella" size={14} title={day.reason ?? "Urlaub"} />
                          {/if}
                        </span>
                      {:else if day.status === "holiday"}
                        <span
                          class="cell-badge cell-badge--holiday"
                          title={day.reason ?? "Feiertag"}
                        >
                          <Icon name="sun" size={14} title={day.reason ?? "Feiertag"} />
                        </span>
                      {:else if day.status === "missing"}
                        <span
                          class="cell-badge cell-badge--missing"
                          title="Fehlt! {day.shift
                            ? day.shift.startTime + '–' + day.shift.endTime
                            : 'Arbeitstag'}"
                        >
                          <Icon name="alert" size={14} title="Fehlt" />
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
                            <span class="shift-time">{day.shift.startTime}–{day.shift.endTime}</span
                            >
                          {:else}
                            <span class="shift-time">{fmtHours(day.expectedHours)}</span>
                          {/if}
                        </span>
                      {:else}
                        <span class="cell-badge cell-badge--none" title="Frei">–</span>
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
          <span class="legend-item">
            <span class="cell-badge cell-badge--present">5.0</span> Anwesend
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--active"><Icon name="circle-fill" size={12} /></span>
            Eingestempelt
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--absent"><Icon name="umbrella" size={12} /></span>
            Urlaub
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--absent"><Icon name="medical" size={12} /></span>
            Krank
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--absent cell-badge--bs"
              ><Icon name="graduation-cap" size={12} /></span
            >
            Berufsschule
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--missing"><Icon name="alert" size={12} /></span>
            Fehlt
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--holiday"><Icon name="sun" size={12} /></span>
            Feiertag
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--scheduled">9–17</span> Geplant
          </span>
          <span class="legend-item">
            <span class="cell-badge cell-badge--none">–</span> Keine Daten
          </span>
        </div>
      </Card>
    {/if}
  {/if}
</div>

<style>
  .dashboard {
    /* max-width inherited from .app-main (1600px) */
    /* Prevent chart.js canvas from causing horizontal overflow on narrow viewports */
    overflow-x: hidden;
  }

  /* Continuous cascade across all dashboard widgets — overrides the
     :nth-child stagger from app.css (which resets per parent row).
     Each .card-animate carries a style="--card-idx: N" inline. */
  .dashboard :global(.card-animate) {
    animation-delay: calc(var(--card-idx, 0) * 60ms);
  }

  /* Phase 29: legacy .clock-card rules removed — see .timer-card in app.css */

  /* ── Phase 49.4 rearrange — two-column stack layout ───────────────────────
     LEFT column flows independently (Timer → Heutiger Eintrag → Aktivität),
     RIGHT column flows independently (KPI-pair → MyShifts/MyWeekView → Offene
     Vorgänge). Each column packs widgets top-down with no row-bound gaps. */
  .dashboard-stacks {
    margin-top: 32px;
    margin-bottom: 1.5rem;
    display: grid;
    grid-template-columns: 7fr 5fr;
    gap: 1.5rem;
    align-items: start;
  }
  .dashboard-stack {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-width: 0;
  }
  @media (max-width: 900px) {
    .dashboard-stacks {
      grid-template-columns: 1fr;
    }
  }

  :global(.today-entry-card),
  :global(.activity-card) {
    display: flex;
    flex-direction: column;
  }

  .today-entry-edit {
    font-size: 12px;
    padding: 4px 10px;
  }

  .today-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    padding: 6px 0 12px;
  }

  .today-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .today-stat-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .today-stat-value {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 28px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    margin-top: 4px;
  }

  .today-stat-accent {
    color: var(--brand);
  }

  .today-timeline {
    position: relative;
    margin-top: 12px;
    padding: 12px 0 4px;
  }

  .today-timeline-track {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 2px;
    background: var(--bg-subtle);
    border-radius: var(--r-pill, 99px);
    transform: translateY(-50%);
  }

  .today-timeline-fill {
    position: absolute;
    left: 0;
    top: 50%;
    height: 2px;
    background: var(--brand);
    border-radius: var(--r-pill, 99px);
    transform: translateY(-50%);
    transition: width 600ms var(--ease-out);
  }

  .today-timeline-marks {
    position: relative;
    display: flex;
    justify-content: space-between;
    padding: 0 4px;
    font-size: 11px;
    color: var(--text-faint);
  }

  .today-timeline-mark {
    background: var(--bg-card);
    padding: 4px 6px;
    border-radius: var(--r-sm, 4px);
    font-variant-numeric: tabular-nums;
  }

  .today-arbzg {
    margin-top: 14px;
  }

  /* ── Aktivität feed ── */
  .activity-list {
    display: flex;
    flex-direction: column;
  }

  .activity-empty {
    padding: 24px 8px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .activity-row {
    display: flex;
    gap: 11px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    align-items: center;
  }

  .activity-row--last {
    border-bottom: 0;
  }

  .activity-icon {
    width: 30px;
    height: 30px;
    border-radius: var(--r-md, 8px);
    background: var(--brand-soft);
    color: var(--brand);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1;
  }

  .activity-text {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .activity-who {
    font-weight: 600;
    color: var(--text);
  }

  .activity-what {
    color: var(--text-muted);
  }

  .activity-when {
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 768px) {
    .today-stats {
      grid-template-columns: repeat(2, 1fr);
    }
    .today-stat-value {
      font-size: 22px;
    }
  }

  /* Phase 49.4: .dashboard-side-stack replaced by .dashboard-stack--right */

  :global(.kpi-pair) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  .weekly-total-wrap {
    text-align: right;
  }
  .weekly-total {
    font-size: 26px;
    line-height: 1;
    font-family: var(--font-serif);
    font-weight: 400;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .weekly-total-target {
    font-size: 11px;
    color: var(--text-faint);
  }
  .weekly-chart {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    align-items: end;
    height: 80px;
    padding: 4px 2px 0;
  }
  .weekly-bar-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    height: 100%;
    justify-content: flex-end;
  }
  .weekly-bar-track {
    position: relative;
    width: 70%;
    background: var(--bg-subtle);
    border-radius: 4px 4px 0 0;
    height: 100%;
    display: flex;
    align-items: flex-end;
    overflow: hidden;
  }
  .weekly-bar-fill {
    width: 100%;
    background: var(--brand-light);
    border-radius: 4px 4px 0 0;
    transition: height 500ms var(--ease-out);
  }
  .weekly-bar-fill.weekly-bar-today {
    background: var(--brand);
  }
  .weekly-bar-target {
    position: absolute;
    left: 0;
    right: 0;
    border-top: 1px dashed var(--border-strong);
  }
  .weekly-bar-label {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--text-faint);
    letter-spacing: 0.08em;
  }
  .weekly-bar-label.weekly-bar-label-today {
    color: var(--brand);
  }
  @media (max-width: 960px) {
    :global(.kpi-pair) {
      grid-template-columns: 1fr;
    }
  }

  /* Timer card local layout overrides (v1.5 recipe lives in app.css .timer-card) */
  :global(.timer-card.timer-card-wrap) {
    display: flex;
    flex-direction: column;
  }
  :global(.timer-card-wrap .timer-hd) {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 14px;
  }
  :global(.timer-card-wrap .timer-hd-title) {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.7);
  }
  :global(.timer-card-wrap .timer-status-idle) {
    opacity: 0.7;
  }
  :global(.timer-card-wrap .timer-hd-right) {
    text-align: right;
  }
  :global(.timer-card-wrap .timer-hd-date) {
    color: rgba(255, 255, 255, 0.6);
  }
  :global(.timer-card-wrap .timer-status) {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 8px;
    font-size: 13px;
    opacity: 0.88;
  }
  :global(.timer-card-wrap .timer-now) {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 14px;
    margin-top: 4px;
    opacity: 0.85;
  }
  :global(.timer-card-wrap .timer-display) {
    position: relative;
    z-index: 1;
  }
  :global(.timer-card-wrap .timer-sub) {
    position: relative;
    z-index: 1;
  }
  :global(.timer-card-wrap .timer-progress) {
    margin-top: 18px;
    position: relative;
    z-index: 1;
  }
  :global(.timer-card-wrap .timer-progress-track) {
    height: 6px;
    background: rgba(255, 255, 255, 0.18);
    border-radius: 99px;
    overflow: hidden;
  }
  :global(.timer-card-wrap .timer-progress-fill) {
    height: 100%;
    background: rgba(255, 255, 255, 0.92);
    border-radius: 99px;
    transition: width 400ms var(--ease-out);
  }
  :global(.timer-card-wrap .timer-progress-labels) {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 11.5px;
    opacity: 0.75;
  }
  :global(.timer-card-wrap .timer-foot) {
    display: flex;
    gap: 10px;
    position: relative;
    z-index: 1;
    margin-top: 18px;
    padding-top: 18px;
  }
  :global(.timer-card-wrap .timer-cta-primary) {
    background: white;
    color: var(--brand-dark);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
    border-color: transparent;
  }
  :global(.timer-card-wrap .timer-cta-primary:hover:not(:disabled)) {
    background: rgba(255, 255, 255, 0.92);
    transform: translateY(-1px);
  }
  :global(.timer-card-wrap .timer-cta-ghost) {
    color: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
  }
  :global(.timer-card-wrap .timer-cta-ghost:hover:not(:disabled)) {
    background: rgba(255, 255, 255, 0.08);
    color: white;
  }
  /* Open-break state: emphasises that clicking now ENDS the break. */
  :global(.timer-card-wrap .timer-cta-ghost--active) {
    background: rgba(255, 255, 255, 0.16);
    border-color: rgba(255, 255, 255, 0.4);
    color: white;
  }
  :global(.timer-card-wrap .timer-shift) {
    position: relative;
    z-index: 1;
    margin-top: 14px;
    font-size: 12.5px;
    opacity: 0.85;
  }
  :global(.timer-card-wrap .timer-shift-label) {
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }

  /* ── Skeleton loader ────────────────────────────── */
  .skeleton-block,
  .skeleton-text {
    background: linear-gradient(
      90deg,
      var(--bg-subtle) 25%,
      var(--border) 50%,
      var(--bg-subtle) 75%
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

  .widget-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .widget-title {
    font-size: 0.875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
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
    background: var(--bad);
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
  .cell-badge--holiday {
    background: var(--brand-soft);
    color: var(--brand);
  }

  /* ── Open Items Widget (v1.5: relies on .card recipe; no border-left accent) ─── */
  :global(.open-items) {
    margin-bottom: 0;
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
    color: var(--text);
    margin-bottom: 0.125rem;
  }
  .oi-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .oi-dot--warn {
    background: var(--bad);
  }
  .oi-dot--pending {
    background: var(--warn);
  }
  .oi-dot--fix {
    background: #2563eb;
  }
  .oi-dot--approval {
    background: var(--brand);
  }
  .oi-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0 0.25rem 1.25rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-decoration: none;
    border-left: 2px solid var(--border);
    transition:
      color 0.12s ease,
      border-left-color 0.12s ease;
  }
  .oi-item:hover {
    color: var(--brand);
    border-left-color: var(--brand);
  }
  .oi-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
    transition: color 0.12s;
  }
  .oi-row:hover {
    color: var(--brand);
  }
  .oi-link {
    margin-left: auto;
    color: var(--brand);
    font-size: 0.75rem;
    font-weight: 500;
  }
  .oi-empty {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0;
    padding: 0.25rem 0;
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
    background: var(--border);
  }
  .team-divider-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .info-bar {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    padding: 0.625rem 1rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-left: 3px solid var(--brand);
    border-radius: var(--r-sm);
    margin-bottom: 1.5rem;
    font-size: 0.875rem;
    color: var(--text);
  }
  .info-bar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .info-bar-icon {
    font-size: 1rem;
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
    background: var(--warn-soft);
    border: 1px solid var(--warn-soft);
    border-radius: var(--r-sm);
    margin-bottom: 1rem;
    text-decoration: none;
    color: var(--text);
    transition:
      background-color 0.15s,
      box-shadow 0.15s;
  }
  .pending-banner:hover {
    background: var(--warn-soft);
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
    background: var(--warn);
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
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }

  :global(.chart-card:last-child) {
    grid-column: 1 / -1;
  }

  .chart-wrap {
    position: relative;
    height: 240px;
    margin-top: 4px;
  }

  .chart-skeleton {
    width: 100%;
    height: 100%;
    border-radius: var(--r-sm);
    background: linear-gradient(
      90deg,
      var(--bg-subtle) 25%,
      var(--bg-alt) 50%,
      var(--bg-subtle) 75%
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

  :global(.upcoming-section) {
    margin-top: 1.75rem;
    margin-bottom: 1.75rem;
    border-left: 3px solid var(--brand);
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
    border-bottom: 1px solid var(--border);
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
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .upcoming-days {
    color: var(--text-muted);
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

  /* ── Team Section (v1.5 .card recipe; no border-left accent, no backdrop-filter) ── */
  :global(.team-section) {
    margin-bottom: 1.5rem;
    box-shadow: var(--shadow-sm);
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
    border-bottom: 1px solid var(--border);
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
    background: var(--brand-soft);
  }

  .day-label {
    display: block;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .day-num {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .member-name {
    font-weight: 500;
    color: var(--text);
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
    background: var(--good-soft);
    color: var(--good);
    border: 1px solid var(--good-soft);
  }

  .cell-badge--active {
    background: rgba(37, 99, 235, 0.1);
    color: #2563eb;
    border: 1px solid rgba(37, 99, 235, 0.2);
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
    background: var(--brand-soft);
    color: var(--brand);
    border: 1px solid var(--brand-soft);
    font-size: 0.875rem;
  }

  /* Berufsschule day — distinct from generic absence so the 🎓 emoji reads as
     "operationally planned school day" rather than "leave/sick". Slightly
     lighter surface + neutral border to differentiate from vacation. */
  .cell-badge--bs {
    background: var(--bg-subtle);
    color: var(--text);
    border: 1px solid var(--border);
  }

  .bs-emoji {
    font-size: 0.875rem;
    line-height: 1;
  }

  .cell-badge--missing {
    background: var(--bad-soft);
    color: var(--bad);
    border: 1px solid var(--bad-soft);
    font-size: 0.875rem;
  }

  .cell-badge--scheduled {
    background: var(--bg-subtle);
    color: var(--text-muted);
    border: 1px dashed var(--border);
    font-size: 0.6875rem;
  }

  .cell-badge--none {
    color: var(--text-muted);
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
    border-top: 1px solid var(--border);
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  @media (max-width: 600px) {
    :global(.timer-card-wrap .timer-hd) {
      flex-direction: column;
      gap: 8px;
    }
    :global(.timer-card-wrap .timer-hd-right) {
      text-align: left;
    }
    :global(.timer-card-wrap .timer-display) {
      font-size: 48px;
    }
    :global(.timer-card-wrap .timer-foot) {
      flex-direction: column;
    }
    :global(.timer-card-wrap .timer-cta-primary),
    :global(.timer-card-wrap .timer-cta-ghost) {
      width: 100%;
    }
  }
</style>
