<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { get as getStore } from "svelte/store";
  import Pagination from "$components/ui/Pagination.svelte";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import KPIStat from "$components/ui/KPIStat.svelte";
  import {
    Chart,
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
    Tooltip,
    Legend,
  } from "chart.js";

  Chart.register(
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
    Tooltip,
    Legend,
  );

  // ── Types ──────────────────────────────────────────────────────────────────

  type TodayEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    status: "present" | "absent" | "clocked_in" | "missing" | "scheduled" | "none" | "holiday";
    reason: string | null;
  };

  type TodayAttendance = {
    date: string;
    employees: TodayEmployee[];
    summary: {
      present: number;
      absent: number;
      clockedIn: number;
      missing: number;
      holiday: number;
    };
  };

  type OvertimeEmployee = {
    id: string;
    name: string;
    employeeNumber: string;
    balanceHours: number;
    status: "NORMAL" | "ELEVATED" | "CRITICAL";
    snapshots: Array<{ periodStart: string; balanceMinutes: number; carryOver: number }>;
  };

  type OvertimeOverview = { employees: OvertimeEmployee[] };

  type LeaveOverviewRow = {
    employee: { id: string; firstName: string; lastName: string; employeeNumber: string };
    leaveType: { id: string; name: string };
    year: number;
    totalDays: number;
    carriedOverDays: number;
    usedDays: number;
    remainingDays: number;
    pendingDays: number;
  };

  // EMP-06: Employee monthly closes view
  type EmpMonthlyClose = {
    year: number;
    month: number; // 1-12
    label: string; // "April 2026"
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    isLocked: boolean;
  };

  type SnapshotRow = {
    periodType: "MONTHLY" | "YEARLY";
    periodStart: string;
    workedMinutes: number;
    expectedMinutes: number;
    balanceMinutes: number;
    isLocked: boolean;
  };

  // ── State ──────────────────────────────────────────────────────────────────

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  // Shared period selector — controls Team-Übersicht widgets
  let selectedMonth = $state(currentMonth);
  let selectedYear = $state(currentYear);

  // DATEV export card — own period selector
  let datevMonth = $state(currentMonth);
  let datevYear = $state(currentYear);
  let datevLoading = $state(false);
  let datevError = $state("");

  // Urlaubsbericht PDF (kombiniert: Urlaubsliste + Urlaubsübersicht)
  let leaveYear = $state(currentYear);
  let leaveLoading = $state(false);
  let leaveError = $state("");

  // Company monthly PDF (Firmenweiter Monatsbericht) — PDF-01 / PDF-03
  let companyPdfMonth = $state(currentMonth);
  let companyPdfYear = $state(currentYear);
  let companyPdfRole = $state<"all" | "EMPLOYEE" | "MANAGER">("all");
  let companyPdfLoading = $state(false);
  let companyPdfError = $state("");

  const months = [
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

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  // ── Role guard ─────────────────────────────────────────────────────────────

  let currentRole = $state<string | null>(null);
  let isManager = $derived(currentRole === "ADMIN" || currentRole === "MANAGER");

  // ── Heutige Anwesenheit state (RPT-03) ─────────────────────────────────────

  let todayAttendance: TodayAttendance | null = $state(null);
  let todayLoading = $state(false);
  let todayError = $state("");

  let todayPage = $state(1);
  let todayPageSize = $state(10);
  let pagedTodayRows = $derived(
    (todayAttendance?.employees ?? []).slice(
      (todayPage - 1) * todayPageSize,
      todayPage * todayPageSize,
    ),
  );

  $effect(() => {
    const _len = todayAttendance?.employees?.length ?? 0;
    todayPage = 1;
  });

  // ── Überstunden-Übersicht state (RPT-01 + SALDO-03) ───────────────────────

  let overtimeOverview: OvertimeOverview | null = $state(null);
  let overtimeLoading = $state(false);
  let overtimeError = $state("");

  let sortColumn: "name" | "balance" = $state("name");
  let sortDir: "asc" | "desc" = $state("asc");

  let sortedOvertime = $derived.by(() => {
    const rows = overtimeOverview?.employees ?? [];
    const copy = rows.slice();
    copy.sort((a, b) => {
      const cmp =
        sortColumn === "name"
          ? a.name.localeCompare(b.name, "de")
          : a.balanceHours - b.balanceHours;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  });

  let overtimePage = $state(1);
  let overtimePageSize = $state(10);
  let pagedOvertimeRows = $derived(
    sortedOvertime.slice((overtimePage - 1) * overtimePageSize, overtimePage * overtimePageSize),
  );

  $effect(() => {
    const _len = sortedOvertime.length;
    overtimePage = 1;
  });

  // ── Verfall-Warnungen state (Phase 44 — BUrlG § 7 Hinweispflicht) ─────────

  type CarryoverRow = {
    entitlementId: string;
    employee: { id: string; firstName: string; lastName: string; employeeNumber: string };
    leaveType: { id: string; name: string };
    year: number;
    carriedOverDays: number;
    deadline: string; // ISO
    daysUntilDeadline: number;
    lastWarningSentAt: string | null;
  };

  type CarryoverAtRisk = {
    horizonDays: number;
    summary: { employeesAtRisk: number; totalDaysAtRisk: number; warnedLast30: number };
    rows: CarryoverRow[];
  };

  let carryover: CarryoverAtRisk | null = $state(null);
  let carryoverLoading = $state(false);
  let carryoverError = $state("");
  let carryoverHorizon = $state(60);
  let carryoverWarnBusy = $state<Record<string, boolean>>({});
  let carryoverRowMsg = $state<Record<string, string>>({});

  let carryoverPage = $state(1);
  let carryoverPageSize = $state(10);
  let pagedCarryoverRows = $derived(
    (carryover?.rows ?? []).slice(
      (carryoverPage - 1) * carryoverPageSize,
      carryoverPage * carryoverPageSize,
    ),
  );

  $effect(() => {
    const _len = carryover?.rows.length ?? 0;
    carryoverPage = 1;
  });

  // ── Urlaubsübersicht state (RPT-02) ──────────────────────────────────────

  let leaveOverview: LeaveOverviewRow[] | null = $state(null);
  let leaveOverviewLoading = $state(false);
  let leaveOverviewError = $state("");

  let leaveOverviewRows = $derived.by(() => {
    const rows = leaveOverview ?? [];
    return rows.slice().sort((a, b) => {
      const ln = a.employee.lastName.localeCompare(b.employee.lastName, "de");
      if (ln !== 0) return ln;
      const fn = a.employee.firstName.localeCompare(b.employee.firstName, "de");
      if (fn !== 0) return fn;
      return a.leaveType.name.localeCompare(b.leaveType.name, "de");
    });
  });

  let leaveOverviewPage = $state(1);
  let leaveOverviewPageSize = $state(10);
  let pagedLeaveOverviewRows = $derived(
    leaveOverviewRows.slice(
      (leaveOverviewPage - 1) * leaveOverviewPageSize,
      leaveOverviewPage * leaveOverviewPageSize,
    ),
  );

  $effect(() => {
    const _len = leaveOverviewRows.length;
    leaveOverviewPage = 1;
  });

  // Map<employeeId, Chart> — key is employeeId so re-sort/pagination doesn't break identity
  const sparklineCharts = new Map<string, Chart>();
  // Canvas refs captured via use:registerCanvas action in {#each}
  const sparklineCanvases = new Map<string, HTMLCanvasElement>();

  function registerCanvas(el: HTMLCanvasElement, empId: string) {
    sparklineCanvases.set(empId, el);
    return {
      destroy() {
        sparklineCanvases.delete(empId);
      },
    };
  }

  // Per-employee download error state
  let empDownloadErrors = $state<Record<string, string>>({});

  // ── EMP-06: Employee monthly closes view ─────────────────────────────────
  let empMonthlyCloses: EmpMonthlyClose[] = $state([]);
  let empClosesLoading = $state(false);
  let empClosesError = $state("");

  const EMP_MONTH_NAMES = [
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

  async function loadEmployeeMonthlyCloses() {
    const auth = getStore(authStore);
    const myEmployeeId = auth.user?.employeeId;
    if (!myEmployeeId) {
      empMonthlyCloses = [];
      return;
    }
    empClosesLoading = true;
    empClosesError = "";
    try {
      const rows = await api.get<SnapshotRow[]>(`/overtime/snapshots/${myEmployeeId}`);
      empMonthlyCloses = rows
        .filter((r) => r.periodType === "MONTHLY")
        .slice(0, 12)
        .map((r) => {
          const d = new Date(r.periodStart);
          const y = d.getFullYear();
          const m = d.getMonth() + 1;
          return {
            year: y,
            month: m,
            label: `${EMP_MONTH_NAMES[m - 1]} ${y}`,
            workedMinutes: r.workedMinutes,
            expectedMinutes: r.expectedMinutes,
            balanceMinutes: r.balanceMinutes,
            isLocked: r.isLocked,
          };
        });
    } catch (e: unknown) {
      empClosesError =
        e instanceof Error ? e.message : "Monatsabschlüsse konnten nicht geladen werden";
      empMonthlyCloses = [];
    } finally {
      empClosesLoading = false;
    }
  }

  function fmtMinutesAsHrs(min: number): string {
    const sign = min < 0 ? "−" : "";
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${sign}${h}:${String(m).padStart(2, "0")} h`;
  }

  async function downloadEmployeeMonthlyPdf(year: number, month: number, label: string) {
    const auth = getStore(authStore);
    const myEmployeeId = auth.user?.employeeId;
    if (!myEmployeeId) return;
    try {
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${myEmployeeId}&year=${year}&month=${month}`,
        `Stundennachweis_${label.replace(/\s+/g, "_")}.pdf`,
      );
    } catch (e: unknown) {
      empClosesError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    }
  }

  // ── Reactive reload when period changes ────────────────────────────────────

  $effect(() => {
    const _m = selectedMonth;
    const _y = selectedYear;
    if (isManager) {
      void loadTodayAttendance();
      void loadOvertimeOverview();
      void loadLeaveOverview();
      void loadCarryoverAtRisk();
    }
  });

  // Refresh when horizon changes (independent of selectedMonth/selectedYear)
  $effect(() => {
    const _h = carryoverHorizon;
    if (isManager) void loadCarryoverAtRisk();
  });

  // ── onMount ────────────────────────────────────────────────────────────────

  onMount(async () => {
    const auth = getStore(authStore);
    currentRole = auth.user?.role ?? null;
    // Persona-aware: employees see their personal monthly closes table;
    // managers/admins keep their existing onMount-driven $effect-driven loads.
    const callerIsManager = currentRole === "ADMIN" || currentRole === "MANAGER";
    if (!callerIsManager) {
      await loadEmployeeMonthlyCloses();
    }
  });

  onDestroy(() => {
    for (const chart of sparklineCharts.values()) chart.destroy();
    sparklineCharts.clear();
    sparklineCanvases.clear();
  });

  // ── Sparkline lifecycle ────────────────────────────────────────────────────

  $effect(() => {
    const rows = pagedOvertimeRows;
    void tick().then(() => {
      // Destroy charts for employees not on the current page
      for (const [empId, chart] of sparklineCharts.entries()) {
        if (!rows.some((r) => r.id === empId)) {
          chart.destroy();
          sparklineCharts.delete(empId);
        }
      }
      // (Re)create chart for every visible row with >=2 snapshots
      for (const row of rows) {
        const canvas = sparklineCanvases.get(row.id);
        if (!canvas) continue;
        if (row.snapshots.length < 2) {
          const stale = sparklineCharts.get(row.id);
          if (stale) {
            stale.destroy();
            sparklineCharts.delete(row.id);
          }
          continue;
        }
        // Always destroy previous Chart before creating a new one
        const existing = sparklineCharts.get(row.id);
        if (existing) {
          existing.destroy();
          sparklineCharts.delete(row.id);
        }

        const labels = row.snapshots.map((s) => s.periodStart.slice(0, 7));
        const data = row.snapshots.map((s) => s.carryOver / 60);

        const brandColor =
          getComputedStyle(document.documentElement).getPropertyValue("--brand").trim() ||
          "#80377B";

        const chart = new Chart(canvas, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                data,
                borderColor: brandColor,
                backgroundColor: brandColor + "22",
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5,
              },
            ],
          },
          options: {
            responsive: false,
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
          },
        });
        sparklineCharts.set(row.id, chart);
      }
    });
  });

  // ── Loaders ────────────────────────────────────────────────────────────────

  async function loadTodayAttendance() {
    todayLoading = true;
    todayError = "";
    try {
      todayAttendance = await api.get<TodayAttendance>("/dashboard/today-attendance");
    } catch (e: unknown) {
      todayError = e instanceof Error ? e.message : "Fehler beim Laden der Anwesenheit";
    } finally {
      todayLoading = false;
    }
  }

  async function loadOvertimeOverview() {
    overtimeLoading = true;
    overtimeError = "";
    try {
      overtimeOverview = await api.get<OvertimeOverview>("/dashboard/overtime-overview");
    } catch (e: unknown) {
      overtimeError =
        e instanceof Error ? e.message : "Fehler beim Laden der Überstunden-Übersicht";
    } finally {
      overtimeLoading = false;
    }
  }

  async function loadCarryoverAtRisk() {
    if (!isManager) return;
    carryoverLoading = true;
    carryoverError = "";
    try {
      carryover = await api.get<CarryoverAtRisk>(
        `/reports/carryover-at-risk?days=${carryoverHorizon}`,
      );
    } catch (e: unknown) {
      carryoverError = e instanceof Error ? e.message : "Fehler beim Laden der Verfall-Warnungen";
      carryover = null;
    } finally {
      carryoverLoading = false;
    }
  }

  async function sendCarryoverWarning(row: CarryoverRow) {
    carryoverWarnBusy = { ...carryoverWarnBusy, [row.entitlementId]: true };
    carryoverRowMsg = { ...carryoverRowMsg, [row.entitlementId]: "" };
    try {
      const res = await api.post<{ ok: boolean; warned: number; skippedDedup: number }>(
        "/reports/carryover-warn",
        { entitlementId: row.entitlementId },
      );
      if (res.warned > 0) {
        carryoverRowMsg = {
          ...carryoverRowMsg,
          [row.entitlementId]: "Hinweis gesendet",
        };
        // Refresh to pick up new lastWarningSentAt
        void loadCarryoverAtRisk();
      } else {
        carryoverRowMsg = {
          ...carryoverRowMsg,
          [row.entitlementId]: "Bereits gewarnt (kein neuer Schwellwert erreicht)",
        };
      }
    } catch (e: unknown) {
      carryoverRowMsg = {
        ...carryoverRowMsg,
        [row.entitlementId]: e instanceof Error ? e.message : "Hinweis fehlgeschlagen",
      };
    } finally {
      carryoverWarnBusy = { ...carryoverWarnBusy, [row.entitlementId]: false };
    }
  }

  function formatDeDate(iso: string): string {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getFullYear()}`;
  }

  function formatLastWarning(iso: string | null): string {
    if (!iso) return "—";
    return formatDeDate(iso);
  }

  async function loadLeaveOverview() {
    if (!isManager) return;
    leaveOverviewLoading = true;
    leaveOverviewError = "";
    try {
      leaveOverview = await api.get<LeaveOverviewRow[]>(
        `/reports/leave-overview?year=${selectedYear}`,
      );
    } catch (e: unknown) {
      leaveOverviewError =
        e instanceof Error ? e.message : "Fehler beim Laden der Urlaubsübersicht";
      leaveOverview = null;
    } finally {
      leaveOverviewLoading = false;
    }
  }

  async function downloadDatev() {
    datevLoading = true;
    datevError = "";
    try {
      const { authStore: authSt } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authSt);

      const res = await fetch(`/api/v1/reports/datev?month=${datevMonth}&year=${datevYear}`, {
        headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_${datevYear}_${String(datevMonth).padStart(2, "0")}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      datevError = e instanceof Error ? e.message : "Download fehlgeschlagen";
    } finally {
      datevLoading = false;
    }
  }

  async function downloadPdf(url: string, filename: string) {
    const { authStore: authSt } = await import("$stores/auth");
    const { get } = await import("svelte/store");
    const auth = get(authSt);

    const res = await fetch(`/api/v1${url}`, {
      headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after a tick to ensure the download has started
    setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
  }

  async function downloadVacationPdf() {
    leaveLoading = true;
    leaveError = "";
    try {
      await downloadPdf(
        `/reports/vacation/pdf?year=${leaveYear}`,
        `Urlaubsbericht_${leaveYear}.pdf`,
      );
    } catch (e: unknown) {
      leaveError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      leaveLoading = false;
    }
  }

  async function downloadCompanyMonthlyPdf() {
    companyPdfLoading = true;
    companyPdfError = "";
    try {
      await downloadPdf(
        `/reports/monthly/pdf/all?month=${companyPdfMonth}&year=${companyPdfYear}&role=${companyPdfRole}`,
        `Monatsbericht_Alle_${companyPdfYear}_${String(companyPdfMonth).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      companyPdfError = e instanceof Error ? e.message : "PDF-Download fehlgeschlagen";
    } finally {
      companyPdfLoading = false;
    }
  }

  async function downloadEmployeePdf(employeeId: string, name: string) {
    const key = `pdf-${employeeId}`;
    empDownloadErrors = { ...empDownloadErrors, [key]: "" };
    try {
      await downloadPdf(
        `/reports/monthly/pdf?employeeId=${employeeId}&year=${selectedYear}&month=${selectedMonth}`,
        `Stundennachweis_${name.replace(/\s+/g, "_")}_${selectedYear}_${String(selectedMonth).padStart(2, "0")}.pdf`,
      );
    } catch (e: unknown) {
      empDownloadErrors = {
        ...empDownloadErrors,
        [key]: e instanceof Error ? e.message : "PDF-Download fehlgeschlagen",
      };
    }
  }

  async function downloadEmployeeDatev(employeeId: string, name: string) {
    const key = `datev-${employeeId}`;
    empDownloadErrors = { ...empDownloadErrors, [key]: "" };
    try {
      const { authStore: authSt } = await import("$stores/auth");
      const { get } = await import("svelte/store");
      const auth = get(authSt);
      const res = await fetch(
        `/api/v1/reports/datev/employee?employeeId=${employeeId}&year=${selectedYear}&month=${selectedMonth}`,
        {
          headers: auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {},
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Download fehlgeschlagen");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DATEV_${name.replace(/\s+/g, "_")}_${selectedYear}_${String(selectedMonth).padStart(2, "0")}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      empDownloadErrors = {
        ...empDownloadErrors,
        [`datev-${employeeId}`]: e instanceof Error ? e.message : "DATEV-Download fehlgeschlagen",
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function formatDays(n: number): string {
    return n.toLocaleString("de-DE", {
      minimumFractionDigits: n % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    });
  }

  function formatBalance(n: number): string {
    return n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function statusLabel(row: TodayEmployee): string {
    switch (row.status) {
      case "present":
        return "Anwesend";
      case "clocked_in":
        return "Eingestempelt";
      case "absent":
        return row.reason ?? "Abwesend";
      case "missing":
        return "Fehlend";
      case "scheduled":
        return "Geplant";
      case "holiday":
        return row.reason ?? "Feiertag";
      default:
        return "—";
    }
  }

  function statusClass(status: TodayEmployee["status"]): string {
    return `status-badge status-${status.replace("_", "-")}`;
  }

  function toggleSort(column: "name" | "balance") {
    if (sortColumn === column) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortColumn = column;
      sortDir = "asc";
    }
  }

  function statusBadgeClass(s: OvertimeEmployee["status"]): string {
    return `status-badge status-saldo-${s.toLowerCase()}`;
  }

  function statusBadgeLabel(s: OvertimeEmployee["status"]): string {
    return s === "NORMAL" ? "Normal" : s === "ELEVATED" ? "Erhöht" : "Kritisch";
  }

  // ── KPI summaries (v1.5) ───────────────────────────────────────────────────

  // Manager KPIs — derived from overtime + leave overview
  let kpiTeamSize = $derived(overtimeOverview?.employees?.length ?? 0);
  let kpiAvgBalance = $derived.by(() => {
    const rows = overtimeOverview?.employees ?? [];
    if (rows.length === 0) return 0;
    const sum = rows.reduce((acc, r) => acc + r.balanceHours, 0);
    return sum / rows.length;
  });
  let kpiCriticalCount = $derived(
    (overtimeOverview?.employees ?? []).filter((r) => r.status === "CRITICAL").length,
  );
  let kpiUsedDays = $derived((leaveOverview ?? []).reduce((acc, r) => acc + r.usedDays, 0));

  // Employee KPIs — derived from monthly closes
  let kpiClosedMonths = $derived(empMonthlyCloses.length);
  let kpiTotalWorkedMin = $derived(empMonthlyCloses.reduce((acc, r) => acc + r.workedMinutes, 0));
  let kpiTotalExpectedMin = $derived(
    empMonthlyCloses.reduce((acc, r) => acc + r.expectedMinutes, 0),
  );
  let kpiTotalBalanceMin = $derived(empMonthlyCloses.reduce((acc, r) => acc + r.balanceMinutes, 0));

  function fmtHoursFromMin(min: number): string {
    const sign = min < 0 ? "−" : "";
    const abs = Math.abs(min);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `${sign}${h}:${String(m).padStart(2, "0")}`;
  }

  function fmtHoursSigned(min: number): string {
    const prefix = min > 0 ? "+" : "";
    return `${prefix}${fmtHoursFromMin(min)}`;
  }
</script>

<svelte:head>
  <title>Berichte – Clokr</title>
</svelte:head>

<PageHead
  eyebrow="Mein Bereich"
  title="Berichte & Auswertungen"
  accent="Auswertungen"
  sub={isManager
    ? "Urlaubslisten, Monatsberichte und DATEV-Exporte erstellen"
    : "Persönliche Monatsabschlüsse — als PDF zum Download."}
/>

<!-- KPI cluster — Card + KPIStat primitives -->
{#if isManager}
  <div class="kpi-row">
    <Card animate>
      <KPIStat label="Mitarbeiter" value={String(kpiTeamSize)} />
    </Card>
    <Card animate>
      <KPIStat
        label="Ø Saldo"
        value={formatBalance(kpiAvgBalance)}
        unit="h"
        delta={kpiAvgBalance > 0 ? "positiv" : kpiAvgBalance < 0 ? "negativ" : undefined}
        deltaTone={kpiAvgBalance > 0 ? "good" : kpiAvgBalance < 0 ? "bad" : "neutral"}
      />
    </Card>
    <Card animate>
      <KPIStat
        label="Kritische Salden"
        value={String(kpiCriticalCount)}
        deltaTone={kpiCriticalCount > 0 ? "bad" : "neutral"}
      />
    </Card>
    <Card animate>
      <KPIStat label="Urlaub genutzt" value={formatDays(kpiUsedDays)} unit="Tage" />
    </Card>
  </div>
{:else}
  <div class="kpi-row">
    <Card animate>
      <KPIStat label="Abgeschlossen" value={String(kpiClosedMonths)} unit="Monate" />
    </Card>
    <Card animate>
      <KPIStat label="Soll" value={fmtHoursFromMin(kpiTotalExpectedMin)} unit="h" />
    </Card>
    <Card animate>
      <KPIStat label="Ist" value={fmtHoursFromMin(kpiTotalWorkedMin)} unit="h" />
    </Card>
    <Card animate>
      <KPIStat
        label="Saldo"
        value={fmtHoursSigned(kpiTotalBalanceMin)}
        unit="h"
        deltaTone={kpiTotalBalanceMin > 0 ? "good" : kpiTotalBalanceMin < 0 ? "bad" : "neutral"}
      />
    </Card>
  </div>
{/if}

{#if isManager}
  <div class="reports-grid">
    <!-- DATEV Export Card -->
    <div class="card card-body card-animate report-card">
      <div class="report-card-icon-section report-card-icon-section--green">
        <span class="report-icon-lg">📁</span>
      </div>
      <div class="report-card-header">
        <div>
          <h2 class="report-card-heading">DATEV Export</h2>
          <p class="report-card-desc text-muted">
            TXT-Datei für DATEV-Lohnabrechnung herunterladen
          </p>
        </div>
      </div>

      <div class="report-controls">
        <div class="form-group">
          <label class="form-label" for="datev-month">Monat</label>
          <select id="datev-month" bind:value={datevMonth} class="form-input">
            {#each months as name, i (i)}
              <option value={i + 1}>{name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="datev-year">Jahr</label>
          <select id="datev-year" bind:value={datevYear} class="form-input">
            {#each years as y (y)}
              <option value={y}>{y}</option>
            {/each}
          </select>
        </div>
      </div>

      <button class="btn btn-primary" onclick={downloadDatev} disabled={datevLoading}>
        {#if datevLoading}
          <span class="btn-spinner"></span>
          Vorbereiten…
        {:else}
          ↓ TXT herunterladen
        {/if}
      </button>

      {#if datevError}
        <div class="alert alert-error" role="alert">
          <span>⚠</span>
          <span>{datevError}</span>
        </div>
      {/if}
    </div>

    <!-- Urlaubsbericht PDF Card (kombiniert: Urlaubsliste + Urlaubsübersicht) -->
    <div class="card card-body card-animate report-card">
      <div class="report-card-icon-section report-card-icon-section--blue">
        <span class="report-icon-lg">🏖</span>
      </div>
      <div class="report-card-header">
        <div>
          <h2 class="report-card-heading">Urlaubsbericht PDF</h2>
          <p class="report-card-desc text-muted">
            Urlaubsliste &amp; Jahresübersicht der Ansprüche in einem PDF
          </p>
        </div>
      </div>

      <div class="report-controls">
        <div class="form-group">
          <label class="form-label" for="leave-year">Jahr</label>
          <select id="leave-year" bind:value={leaveYear} class="form-input">
            {#each years as y (y)}
              <option value={y}>{y}</option>
            {/each}
          </select>
        </div>
      </div>

      <button class="btn btn-primary" onclick={downloadVacationPdf} disabled={leaveLoading}>
        {#if leaveLoading}
          <span class="btn-spinner"></span>
          Vorbereiten…
        {:else}
          PDF herunterladen
        {/if}
      </button>

      {#if leaveError}
        <div class="alert alert-error" role="alert">
          <span>⚠</span>
          <span>{leaveError}</span>
        </div>
      {/if}
    </div>

    <!-- Company Monthly PDF Card (PDF-01 / PDF-03) -->
    <div class="card card-body card-animate report-card">
      <div class="report-card-icon-section report-card-icon-section--purple">
        <span class="report-icon-lg">📑</span>
      </div>
      <div class="report-card-header">
        <div>
          <h2 class="report-card-heading">Firmenweiter Monatsbericht</h2>
          <p class="report-card-desc text-muted">
            Alle Mitarbeiter in einer PDF — optional nach Rolle gefiltert
          </p>
        </div>
      </div>

      <div class="report-controls">
        <div class="form-group">
          <label class="form-label" for="company-pdf-month">Monat</label>
          <select id="company-pdf-month" bind:value={companyPdfMonth} class="form-input">
            {#each months as name, i (i)}
              <option value={i + 1}>{name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="company-pdf-year">Jahr</label>
          <select id="company-pdf-year" bind:value={companyPdfYear} class="form-input">
            {#each years as y (y)}
              <option value={y}>{y}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="company-pdf-role">Rolle</label>
        <select id="company-pdf-role" bind:value={companyPdfRole} class="form-input">
          <option value="all">Alle Mitarbeiter</option>
          <option value="EMPLOYEE">Nur Mitarbeiter</option>
          <option value="MANAGER">Nur Manager</option>
        </select>
      </div>

      <button
        class="btn btn-primary"
        onclick={downloadCompanyMonthlyPdf}
        disabled={companyPdfLoading}
      >
        {#if companyPdfLoading}
          <span class="btn-spinner"></span>
          Vorbereiten…
        {:else}
          PDF herunterladen
        {/if}
      </button>

      {#if companyPdfError}
        <div class="alert alert-error" role="alert">
          <span>⚠</span>
          <span>{companyPdfError}</span>
        </div>
      {/if}
    </div>
  </div>
{:else}
  <!-- EMP-06: Employee personal monthly closes -->
  <Card animate class="emp-closes-card" style="--card-idx: 1;">
    <div class="emp-closes-hd">
      <CardHeader title="Monatsabschlüsse" sub="Persönliche Bilanz je Monat" />
    </div>
    {#if empClosesLoading}
      <div class="emp-closes-loading">Lade Monatsabschlüsse…</div>
    {:else if empClosesError}
      <div class="emp-closes-error" role="alert">{empClosesError}</div>
    {:else}
      <div class="table-scroll">
        <table class="emp-closes-table">
          <thead>
            <tr>
              <th>Monat</th>
              <th class="num">Soll</th>
              <th class="num">Ist</th>
              <th class="num">Diff</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#if empMonthlyCloses.length === 0}
              <tr>
                <td colspan="6" class="emp-closes-empty">Noch keine abgeschlossenen Monate</td>
              </tr>
            {:else}
              {#each empMonthlyCloses as row (`${row.year}-${row.month}`)}
                <tr>
                  <td><b class="emp-month-label">{row.label}</b></td>
                  <td class="num">{fmtMinutesAsHrs(row.expectedMinutes)}</td>
                  <td class="num">{fmtMinutesAsHrs(row.workedMinutes)}</td>
                  <td
                    class="num"
                    class:diff-good={row.balanceMinutes > 0}
                    class:diff-bad={row.balanceMinutes < 0}
                    class:diff-zero={row.balanceMinutes === 0}
                  >
                    {row.balanceMinutes > 0 ? "+" : ""}{fmtMinutesAsHrs(row.balanceMinutes)}
                  </td>
                  <td>
                    {#if row.isLocked}
                      <span class="chip chip-good">
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          aria-hidden="true"
                        >
                          <rect x="3" y="11" width="18" height="11" rx="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        Gesperrt
                      </span>
                    {:else}
                      <span class="chip chip-warn"><span class="dot"></span> Offen</span>
                    {/if}
                  </td>
                  <td class="emp-pdf-cell">
                    <button
                      type="button"
                      class="btn btn-ghost xs"
                      onclick={() => downloadEmployeeMonthlyPdf(row.year, row.month, row.label)}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      PDF
                    </button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
{/if}

<!-- Team-Übersicht — ADMIN / MANAGER only -->
{#if isManager}
  <div class="team-overview-section card-animate">
    <div class="team-overview-header">
      <h2>Team-Übersicht</h2>
      <div class="team-period-controls">
        <select bind:value={selectedMonth} class="period-select">
          {#each months as name, i (i)}
            <option value={i + 1}>{name}</option>
          {/each}
        </select>
        <select bind:value={selectedYear} class="period-select">
          {#each years as y (y)}
            <option value={y}>{y}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Heutige Anwesenheit (RPT-03) -->
    <Card animate class="widget-card" style="--card-idx: 1;">
      <CardHeader title="Heutige Anwesenheit" sub="Status aller Mitarbeiter">
        {#snippet actions()}
          {#if todayAttendance}
            <span class="section-date">{todayAttendance.date}</span>
          {/if}
        {/snippet}
      </CardHeader>

      {#if todayLoading}
        <p class="section-placeholder">Lade Anwesenheit…</p>
      {:else if todayError}
        <p class="section-error">{todayError}</p>
      {:else if todayAttendance}
        <div class="attendance-summary">
          <div class="summary-chip">
            <span class="label">Anwesend</span>
            <span class="value">{todayAttendance.summary.present}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Eingestempelt</span>
            <span class="value">{todayAttendance.summary.clockedIn}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Abwesend</span>
            <span class="value">{todayAttendance.summary.absent}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Fehlend</span>
            <span class="value">{todayAttendance.summary.missing}</span>
          </div>
          {#if todayAttendance.summary.holiday > 0}
            <div class="summary-chip">
              <span class="label">Feiertag</span>
              <span class="value">{todayAttendance.summary.holiday}</span>
            </div>
          {/if}
        </div>

        <div class="table-wrap">
          <table class="attendance-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Nr.</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedTodayRows as row (row.id)}
                <tr>
                  <td>{row.name}</td>
                  <td>{row.employeeNumber}</td>
                  <td><span class={statusClass(row.status)}>{statusLabel(row)}</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          total={todayAttendance.employees.length}
          bind:page={todayPage}
          bind:pageSize={todayPageSize}
        />
      {/if}
    </Card>

    <!-- Verfall-Warnungen (Phase 44 — BUrlG § 7 Hinweispflicht / EuGH C-684/16) -->
    <Card animate class="widget-card" style="--card-idx: 2;">
      <CardHeader title="Verfall-Warnungen" sub="Resturlaub mit auslaufender Frist (§ 7 BUrlG)">
        {#snippet actions()}
          <label class="carryover-horizon-label" for="carryover-horizon">
            Horizont
            <select id="carryover-horizon" class="period-select" bind:value={carryoverHorizon}>
              <option value={30}>30 Tage</option>
              <option value={60}>60 Tage</option>
              <option value={90}>90 Tage</option>
              <option value={180}>180 Tage</option>
            </select>
          </label>
        {/snippet}
      </CardHeader>

      {#if carryoverLoading}
        <p class="section-placeholder">Lade Verfall-Warnungen…</p>
      {:else if carryoverError}
        <p class="section-error">{carryoverError}</p>
      {:else if carryover}
        <div class="carryover-summary">
          <div class="summary-chip">
            <span class="label">Betroffene MA</span>
            <span class="value">{carryover.summary.employeesAtRisk}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Tage im Risiko</span>
            <span class="value">{formatDays(carryover.summary.totalDaysAtRisk)}</span>
          </div>
          <div class="summary-chip">
            <span class="label">Hinweise (30 T.)</span>
            <span class="value">{carryover.summary.warnedLast30}</span>
          </div>
        </div>

        {#if carryover.rows.length === 0}
          <p class="section-placeholder">
            Kein Resturlaub mit Verfall in den nächsten {carryover.horizonDays} Tagen.
          </p>
        {:else}
          <div class="carryover-callout">
            Hinweispflicht: Mitarbeiter müssen gemäß EuGH C-684/16 ausdrücklich auf verfallenden
            Urlaub hingewiesen werden. Ohne dokumentierten Hinweis verfällt der Urlaub <strong
              >nicht</strong
            >.
          </div>
          <div class="table-wrap">
            <table class="carryover-table">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th>Nr.</th>
                  <th class="numeric">Anspruch (T.)</th>
                  <th>Verfällt am</th>
                  <th class="numeric">Verbleibend</th>
                  <th>Letzter Hinweis</th>
                  <th class="actions-col">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {#each pagedCarryoverRows as row (row.entitlementId)}
                  <tr>
                    <td>{row.employee.firstName} {row.employee.lastName}</td>
                    <td>{row.employee.employeeNumber}</td>
                    <td class="numeric">{formatDays(row.carriedOverDays)}</td>
                    <td>{formatDeDate(row.deadline)}</td>
                    <td class="numeric">
                      <span class={row.daysUntilDeadline <= 14 ? "danger" : ""}>
                        {row.daysUntilDeadline} T.
                      </span>
                    </td>
                    <td>{formatLastWarning(row.lastWarningSentAt)}</td>
                    <td class="row-actions">
                      <button
                        class="btn-ghost btn-warn-now"
                        disabled={carryoverWarnBusy[row.entitlementId]}
                        onclick={() => sendCarryoverWarning(row)}
                      >
                        {carryoverWarnBusy[row.entitlementId] ? "Senden…" : "Hinweis jetzt senden"}
                      </button>
                      {#if carryoverRowMsg[row.entitlementId]}
                        <span class="row-msg">{carryoverRowMsg[row.entitlementId]}</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <Pagination
            total={carryover.rows.length}
            bind:page={carryoverPage}
            bind:pageSize={carryoverPageSize}
          />
        {/if}
      {/if}
    </Card>

    <!-- Überstunden-Übersicht (RPT-01 + SALDO-03) -->
    <Card animate class="widget-card" style="--card-idx: 3;">
      <CardHeader title="Überstunden-Übersicht" sub="Saldo & Verlauf je Mitarbeiter" />

      {#if overtimeLoading}
        <p class="section-placeholder">Lade Überstunden-Saldo…</p>
      {:else if overtimeError}
        <p class="section-error">{overtimeError}</p>
      {:else if overtimeOverview}
        <div class="table-wrap">
          <table class="overtime-table">
            <thead>
              <tr>
                <th class="sortable" onclick={() => toggleSort("name")}>
                  Mitarbeiter
                  {#if sortColumn === "name"}<span class="sort-arrow"
                      >{sortDir === "asc" ? "▲" : "▼"}</span
                    >{/if}
                </th>
                <th>Nr.</th>
                <th class="sortable numeric" onclick={() => toggleSort("balance")}>
                  Saldo (h)
                  {#if sortColumn === "balance"}<span class="sort-arrow"
                      >{sortDir === "asc" ? "▲" : "▼"}</span
                    >{/if}
                </th>
                <th>Status</th>
                <th>Verlauf (6 Monate)</th>
                <th class="actions-col">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedOvertimeRows as row (row.id)}
                <tr>
                  <td>{row.name}</td>
                  <td>{row.employeeNumber}</td>
                  <td class="numeric">{formatBalance(row.balanceHours)}</td>
                  <td
                    ><span class={statusBadgeClass(row.status)}>{statusBadgeLabel(row.status)}</span
                    ></td
                  >
                  <td class="sparkline-cell">
                    {#if row.snapshots.length >= 2}
                      <canvas width="100" height="28" use:registerCanvas={row.id}></canvas>
                    {:else}
                      <span class="no-trend">(kein Verlauf)</span>
                    {/if}
                  </td>
                  <td class="row-actions">
                    <button
                      class="btn-icon btn-icon-pdf"
                      title="Stundennachweis PDF ({row.name})"
                      onclick={() => downloadEmployeePdf(row.id, row.name)}>PDF</button
                    >
                    <button
                      class="btn-icon btn-icon-datev"
                      title="DATEV LODAS ({row.name})"
                      onclick={() => downloadEmployeeDatev(row.id, row.name)}>TXT</button
                    >
                    {#if empDownloadErrors[`pdf-${row.id}`]}
                      <span class="row-dl-error">{empDownloadErrors[`pdf-${row.id}`]}</span>
                    {/if}
                    {#if empDownloadErrors[`datev-${row.id}`]}
                      <span class="row-dl-error">{empDownloadErrors[`datev-${row.id}`]}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          total={sortedOvertime.length}
          bind:page={overtimePage}
          bind:pageSize={overtimePageSize}
        />
      {/if}
    </Card>

    <!-- Urlaubsübersicht (RPT-02) -->
    <Card animate class="widget-card" style="--card-idx: 4;">
      <CardHeader title="Urlaubsübersicht" sub="Ansprüche, Genommen, Rest" />

      {#if leaveOverviewLoading}
        <p class="section-placeholder">Lade Urlaubsübersicht…</p>
      {:else if leaveOverviewError}
        <p class="section-error">{leaveOverviewError}</p>
      {:else if leaveOverviewRows.length === 0}
        <p class="section-placeholder">Keine Einträge für dieses Jahr</p>
      {:else}
        <div class="table-wrap">
          <table class="leave-overview-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Nr.</th>
                <th>Urlaubsart</th>
                <th class="numeric">Gesamt</th>
                <th class="numeric">Übertrag</th>
                <th class="numeric">Genommen</th>
                <th class="numeric">Geplant</th>
                <th class="numeric">Rest</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedLeaveOverviewRows as row (row.employee.employeeNumber + ":" + row.leaveType.id)}
                <tr>
                  <td>{row.employee.firstName} {row.employee.lastName}</td>
                  <td>{row.employee.employeeNumber}</td>
                  <td>{row.leaveType.name}</td>
                  <td class="numeric">{formatDays(row.totalDays)}</td>
                  <td class="numeric">{formatDays(row.carriedOverDays)}</td>
                  <td class="numeric">{formatDays(row.usedDays)}</td>
                  <td class="numeric">{formatDays(row.pendingDays)}</td>
                  <td class="numeric strong">{formatDays(row.remainingDays)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <Pagination
          total={leaveOverviewRows.length}
          bind:page={leaveOverviewPage}
          bind:pageSize={leaveOverviewPageSize}
        />
      {/if}
    </Card>
  </div>
{/if}

<style>
  /* ── KPI cluster (Card + KPIStat grid) ────────────────────────────────── */
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 20px;
  }

  @media (max-width: 960px) {
    .kpi-row {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 540px) {
    .kpi-row {
      grid-template-columns: 1fr;
    }
  }

  .reports-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.25rem;
    margin-bottom: 1.75rem;
  }

  .report-card {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
    overflow: hidden;
    transition:
      transform 0.2s var(--ease-out, ease),
      box-shadow 0.2s ease;
  }

  .report-card:hover {
    transform: translateY(-3px);
    box-shadow: var(--shadow-md, 0 8px 20px rgba(0, 0, 0, 0.12));
  }

  .report-card-icon-section {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: var(--r-sm);
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .report-card:hover .report-card-icon-section {
    transform: scale(1.05);
  }

  .report-card-icon-section--purple {
    background: var(--brand-soft);
  }

  .report-card-icon-section--green {
    background: var(--good-soft);
  }

  .report-card-icon-section--blue {
    background: var(--brand-soft);
  }

  .report-icon-lg {
    font-size: 1.5rem;
    line-height: 1;
  }

  .report-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.875rem;
  }

  .report-card-heading {
    font-size: 1.0625rem;
    margin-bottom: 0.25rem;
  }

  .report-card-desc {
    font-size: 0.875rem;
  }

  .report-controls {
    display: flex;
    gap: 0.875rem;
  }

  .report-controls .form-group {
    flex: 1;
  }

  .btn-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: var(--bg-card);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── Team overview section ───────────────────────────────────────────────── */

  .team-overview-section {
    margin-top: 2rem;
  }

  .team-overview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .team-overview-header h2 {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
  }

  .team-period-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .period-select {
    background: var(--bg-subtle);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.375rem 0.625rem;
    font-size: 0.875rem;
    font-family: inherit;
    cursor: pointer;
  }

  .period-select:focus {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  /* ── Manager widget cards ─────────────────────────────────────────────────── */

  .widget-card {
    margin-top: 1rem;
  }

  .section-date {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .section-placeholder,
  .section-error {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  .section-error {
    color: var(--bad);
  }

  /* Heutige Anwesenheit */

  .attendance-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .summary-chip {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .summary-chip .label {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .summary-chip .value {
    font-family: var(--font-mono);
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--text);
  }

  .table-wrap {
    overflow-x: auto;
  }

  .attendance-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .attendance-table th,
  .attendance-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .attendance-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge {
    display: inline-block;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .status-present,
  .status-clocked-in {
    background: var(--good-soft);
    color: var(--good);
  }

  .status-absent {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .status-holiday {
    background: var(--brand-soft);
    color: var(--brand);
  }

  .status-missing {
    background: var(--bad-soft);
    color: var(--bad);
  }

  .status-scheduled,
  .status-none {
    background: var(--bg-subtle);
    color: var(--text-muted);
  }

  /* Verfall-Warnungen (Phase 44 — BUrlG § 7 Hinweispflicht) */

  .carryover-summary {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 560px) {
    .carryover-summary {
      grid-template-columns: 1fr;
    }
  }

  .carryover-callout {
    background: var(--brand-soft);
    border: 1px solid var(--brand);
    border-radius: var(--r-md);
    color: var(--text);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .carryover-horizon-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .carryover-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .carryover-table th,
  .carryover-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .carryover-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .carryover-table td.numeric,
  .carryover-table th.numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .carryover-table .danger {
    color: var(--bad);
    font-weight: 700;
  }

  .btn-warn-now {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
  }

  .row-msg {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Überstunden-Übersicht */

  .overtime-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .overtime-table th,
  .overtime-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .overtime-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .overtime-table th.sortable {
    cursor: pointer;
    user-select: none;
  }

  .overtime-table th.sortable:hover {
    color: var(--text);
  }

  .overtime-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .sort-arrow {
    margin-left: 0.25rem;
    color: var(--brand);
  }

  .status-saldo-normal {
    background: var(--good-soft);
    color: var(--good);
  }

  .status-saldo-elevated {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .status-saldo-critical {
    background: var(--bad-soft);
    color: var(--bad);
  }

  .sparkline-cell {
    width: 120px;
  }

  .no-trend {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
  }

  /* ── Per-employee action buttons ─────────────────────────────────────────── */

  .actions-col {
    width: 110px;
    text-align: right;
  }

  .row-actions {
    text-align: right;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    justify-content: flex-end;
  }

  .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    font-family: var(--font-mono);
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s,
      border-color 0.15s;
    line-height: 1;
  }

  .btn-icon:hover {
    background: var(--brand-soft);
    color: var(--brand);
    border-color: var(--brand);
  }

  .btn-icon-pdf {
    color: var(--text-muted);
  }

  .btn-icon-datev {
    color: var(--text-muted);
  }

  .row-dl-error {
    font-size: 0.75rem;
    color: var(--bad);
    display: block;
    margin-top: 0.25rem;
  }

  /* ── Urlaubsübersicht ─────────────────────────────────────────────────────── */

  .leave-overview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .leave-overview-table th,
  .leave-overview-table td {
    padding: 0.625rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }

  .leave-overview-table th {
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .leave-overview-table .numeric {
    text-align: right;
    font-family: var(--font-mono);
  }

  .leave-overview-table .numeric.strong {
    font-weight: 700;
    color: var(--text);
  }

  /* ── Responsive ───────────────────────────────────────────────────────────── */

  @media (max-width: 720px) {
    .attendance-summary {
      grid-template-columns: repeat(2, 1fr);
    }

    .sparkline-cell {
      display: none;
    }

    .overtime-table th:nth-last-child(2),
    .overtime-table td:nth-last-child(2) {
      display: none;
    }

    .actions-col,
    .row-actions {
      display: none;
    }
  }

  @media (max-width: 700px) {
    .reports-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── EMP-06: Employee monthly closes table ──────────────────────── */
  .emp-closes-card {
    padding: 0;
    overflow: hidden;
  }
  .emp-closes-hd {
    padding: 16px 20px 0;
    margin-bottom: 0;
  }
  .emp-closes-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }
  .emp-closes-table th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .emp-closes-table td {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13.5px;
    vertical-align: middle;
  }
  .emp-closes-table tbody tr:last-child td {
    border-bottom: 0;
  }
  .emp-closes-table tbody tr:hover td {
    background: var(--bg-subtle);
  }
  .emp-closes-table .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .emp-month-label {
    font-weight: 600;
  }
  .diff-good {
    color: var(--good);
  }
  .diff-bad {
    color: var(--bad);
  }
  .diff-zero {
    color: var(--text-muted);
  }
  .emp-pdf-cell {
    text-align: right;
    white-space: nowrap;
  }
  .emp-closes-loading {
    padding: 32px;
    text-align: center;
    color: var(--text-muted);
  }
  .emp-closes-error {
    padding: 16px 24px;
    color: var(--bad);
    background: var(--bad-soft);
    border-bottom: 1px solid var(--border);
  }
  .emp-closes-empty {
    text-align: center;
    padding: 32px;
    color: var(--text-muted);
  }
</style>
