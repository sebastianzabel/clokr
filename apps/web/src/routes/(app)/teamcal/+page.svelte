<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import MonthBar from "$components/ui/MonthBar.svelte";

  // ── Types ────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    role?: string;
  }
  interface LeaveRequest {
    id: string;
    employeeId: string;
    leaveType: { name: string };
    startDate: string; // YYYY-MM-DD (server returns ISO date strings)
    endDate: string;
    halfDay: boolean;
    status: string;
  }
  type CellKind = "vacation" | "sick" | "weekend" | "work";

  // German labels per docs/design/reference/i18n.js
  const MONTHS = [
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
  const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  // Categorize leave type names → render kind.
  // Matches the canonical names defined by LEAVE_TYPE_DEFS in apps/api/src/routes/leave.ts.
  const SICK_TYPE_NAMES = new Set(["Krankmeldung", "Kinderkrank"]);

  function leaveKind(typeName: string): "vacation" | "sick" {
    return SICK_TYPE_NAMES.has(typeName) ? "sick" : "vacation";
  }

  // ── State ────────────────────────────────────────────────────────────────
  const today = new Date();
  let cursorYear = $state(today.getFullYear());
  let cursorMonth = $state(today.getMonth()); // 0-11
  let employees: Employee[] = $state([]);
  let requests: LeaveRequest[] = $state([]);
  let loading = $state(true);
  let error = $state("");

  // ── Role gate ────────────────────────────────────────────────────────────
  onMount(() => {
    const role = $authStore.user?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      void goto("/dashboard");
      return;
    }
    void load();
  });

  // ── Derived ──────────────────────────────────────────────────────────────
  let cursorDate = $derived(new Date(cursorYear, cursorMonth, 1));
  let daysInMonth = $derived(new Date(cursorYear, cursorMonth + 1, 0).getDate());
  let days = $derived.by(() => {
    const arr: Date[] = [];
    for (let i = 1; i <= daysInMonth; i++) {
      arr.push(new Date(cursorYear, cursorMonth, i));
    }
    return arr;
  });
  // CSS grid-template-columns value: 200px sticky name col + N data cols
  let gridCols = $derived(`200px repeat(${daysInMonth}, minmax(22px, 1fr))`);

  // Build a fast lookup: employeeId → array of approved leave windows
  let absenceByEmployee = $derived.by(() => {
    const map = new Map<string, { kind: "vacation" | "sick"; start: string; end: string }[]>();
    for (const r of requests) {
      if (r.status !== "APPROVED") continue;
      const kind = leaveKind(r.leaveType?.name ?? "");
      const arr = map.get(r.employeeId) ?? [];
      arr.push({ kind, start: r.startDate.slice(0, 10), end: r.endDate.slice(0, 10) });
      map.set(r.employeeId, arr);
    }
    return map;
  });

  function ymd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function cellKind(employeeId: string, d: Date): CellKind {
    const key = ymd(d);
    const windows = absenceByEmployee.get(employeeId) ?? [];
    for (const w of windows) {
      if (key >= w.start && key <= w.end) return w.kind;
    }
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return "weekend";
    return "work";
  }

  function isToday(d: Date): boolean {
    const t = new Date();
    return (
      d.getDate() === t.getDate() &&
      d.getMonth() === t.getMonth() &&
      d.getFullYear() === t.getFullYear()
    );
  }
  function isoDow(d: Date): number {
    // Mon=0, Sun=6 (matches DOW array)
    const dow = d.getDay();
    return (dow + 6) % 7;
  }

  // ── Load ─────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    error = "";
    try {
      // Fetch employees once + all approved requests; filter to visible window client-side.
      // A ?from=&to= server filter could be added if perf becomes an issue (deferred).
      const [emp, leaves] = await Promise.all([
        api.get<Employee[]>("/employees"),
        api.get<LeaveRequest[]>("/leave/requests?status=APPROVED"),
      ]);
      employees = emp;
      requests = leaves;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  // Note: previously this file contained a $effect that re-fetched
  // /leave/requests?status=APPROVED whenever cursorYear/cursorMonth (or
  // employees.length) changed. That effect was removed (see REVIEW WR-01):
  //   - it caused a duplicate initial fetch (employees.length flips 0 → N
  //     after load(), retriggering the effect immediately after onMount),
  //   - it had no abort controller, so out-of-order responses from rapid
  //     month-nav clicks could overwrite newer state, and
  //   - it did not include the cursor in the query string, so navigation
  //     produced an identical payload — wasted bandwidth.
  // load() already fetches the full approved set once; if month-by-month
  // refresh is needed later, add a server-side ?from=&to= filter (see also
  // the comment in load()).

  function prevMonth() {
    if (cursorMonth === 0) {
      cursorMonth = 11;
      cursorYear--;
    } else {
      cursorMonth--;
    }
  }
  function nextMonth() {
    if (cursorMonth === 11) {
      cursorMonth = 0;
      cursorYear++;
    } else {
      cursorMonth++;
    }
  }
  function goToToday() {
    cursorYear = today.getFullYear();
    cursorMonth = today.getMonth();
  }
  function gotoMonthYear(m: number, y: number) {
    // MonthBar emits m as 1-12; cursorMonth is 0-11.
    cursorMonth = m - 1;
    cursorYear = y;
  }

  function initials(f: string, l: string): string {
    return ((f?.[0] ?? "") + (l?.[0] ?? "")).toUpperCase();
  }
</script>

<PageHead
  eyebrow="Team"
  title="Team-Kalender"
  accent="Team"
  sub="Abwesenheiten und Anwesenheit deines Teams im Überblick."
/>

{#if error}
  <div class="callout error card-animate" role="alert">{error}</div>
{/if}

<!-- Combined month nav (MonthBar primitive) -->
<Card animate class="teamcal-monthbar-card">
  <MonthBar
    eyebrow="Buchungsmonat"
    date={cursorDate}
    onPrev={prevMonth}
    onNext={nextMonth}
    onToday={goToToday}
    onSelectMonth={gotoMonthYear}
  >
    {#snippet extraActions()}
      <div class="legend">
        <span class="legend-item"><span class="swatch sw-vacation"></span>Urlaub</span>
        <span class="legend-item"><span class="swatch sw-sick"></span>Krankheit</span>
        <span class="legend-item"><span class="swatch sw-weekend"></span>Wochenende</span>
      </div>
    {/snippet}
  </MonthBar>
</Card>

<!-- Gantt grid card -->
<Card animate class="gantt-card" style="padding: 0;">
  {#if loading}
    <div class="gantt-loading">Lade Team-Kalender…</div>
  {:else if employees.length === 0}
    <div class="gantt-loading">Keine Teammitglieder gefunden.</div>
  {:else}
    <div class="gantt-scroll">
      <div class="gantt-inner" style:min-width="{700 + daysInMonth * 26}px">
        <!-- Header row: day numbers + DOW labels -->
        <div class="gantt-header" style:grid-template-columns={gridCols}>
          <div class="hd-name">Person</div>
          {#each days as d (d.getTime())}
            {@const todayCell = isToday(d)}
            {@const dow = isoDow(d)}
            <div class="hd-cell" class:today={todayCell} class:weekend={dow >= 5}>
              <div class="dow">{DOW[dow]}</div>
              <div class="dnum">{d.getDate()}</div>
            </div>
          {/each}
        </div>

        <!-- Body rows -->
        {#each employees as u (u.id)}
          <div class="gantt-row" style:grid-template-columns={gridCols}>
            <div class="row-name">
              <div class="row-avatar">{initials(u.firstName, u.lastName)}</div>
              <div class="row-name-text">
                <div class="row-name-line">{u.firstName} {u.lastName}</div>
                {#if u.role}<div class="row-role">{u.role}</div>{/if}
              </div>
            </div>
            {#each days as d (d.getTime())}
              {@const kind = cellKind(u.id, d)}
              {@const todayCell = isToday(d)}
              <div
                class="cell"
                class:cell-vacation={kind === "vacation"}
                class:cell-sick={kind === "sick"}
                class:cell-weekend={kind === "weekend"}
                class:cell-work={kind === "work"}
                class:cell-today-marker={todayCell && kind === "work"}
              ></div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Card>

<style>
  /* MonthBar primitive owns its styles; only the legend slot remains. */
  :global(.teamcal-monthbar-card) {
    padding: 0;
    margin-bottom: 18px;
    /* Allow month-picker dropdown to escape .card overflow:clip and lift
       above sibling .card stacking contexts — same fix as .cal-monthbar
       and .te-monthbar-card. */
    overflow: visible;
    position: relative;
    z-index: 30;
  }
  .legend {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-muted);
    align-items: center;
    flex-wrap: wrap;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    display: inline-block;
  }
  .sw-vacation {
    background: var(--brand);
  }
  .sw-sick {
    background: var(--warn);
  }
  .sw-weekend {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
  }

  .gantt-card {
    overflow: hidden;
  }
  .gantt-scroll {
    overflow-x: auto;
  }
  .gantt-inner {
    width: 100%;
  }
  .gantt-loading {
    padding: 80px;
    text-align: center;
    color: var(--text-muted);
  }

  .gantt-header {
    display: grid;
    position: sticky;
    top: 0;
    background: var(--bg-card);
    z-index: 2;
    border-bottom: 1px solid var(--border);
  }
  .hd-name {
    padding: 14px 16px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 600;
  }
  .hd-cell {
    padding: 14px 0;
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 500;
  }
  .hd-cell.weekend {
    color: var(--text-faint);
  }
  .hd-cell.today {
    color: var(--brand);
    font-weight: 700;
    background: var(--brand-soft);
    border-bottom: 2px solid var(--brand);
  }
  .hd-cell .dow {
    font-size: 9px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .hd-cell .dnum {
    font-weight: 600;
  }

  .gantt-row {
    display: grid;
    border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .gantt-row:last-child {
    border-bottom: 0;
  }

  .row-name {
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    position: sticky;
    left: 0;
    background: var(--bg-card);
    z-index: 1;
  }
  .row-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--brand-soft);
    color: var(--brand);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }
  :global([data-mode="dark"]) .row-avatar {
    color: var(--brand-light);
  }
  .row-name-text {
    min-width: 0;
  }
  .row-name-line {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-role {
    font-size: 11px;
    color: var(--text-muted);
  }

  .cell {
    height: 34px;
    margin: 4px 1px;
    border-radius: 4px;
  }
  .cell-vacation {
    background: var(--brand);
  }
  .cell-sick {
    background: var(--warn);
  }
  .cell-weekend {
    background: var(--bg-subtle);
    opacity: 0.6;
  }
  .cell-work {
    background: transparent;
  }
  /* Today marker — only on work cells (per handoff manager.jsx) */
  .cell-today-marker {
    border: 1px dashed var(--brand-light);
  }
</style>
