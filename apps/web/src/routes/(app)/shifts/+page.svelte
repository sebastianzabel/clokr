<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";

  // ── Types ──────────────────────────────────────────────────────────────────
  interface Employee {
    id: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
    role?: string;
  }
  interface Shift {
    id: string;
    employeeId: string;
    date: string; // ISO YYYY-MM-DD (possibly full datetime)
    startTime: string; // "HH:MM" or "HH:MM:SS"
    endTime: string;
    label: string | null;
    template?: { name: string; color: string } | null;
  }
  interface WeekData {
    weekDays: string[]; // 7 ISO dates Mon..Sun
    employees: Employee[];
    shifts: Shift[];
  }
  interface Template {
    id: string;
    name: string;
    startTime: string;
    endTime: string;
    color: string;
  }

  const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  // Coverage threshold (per handoff: at least 2 staff on any working day)
  const MIN_COVERAGE = 2;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function mondayOfWeek(d: Date): Date {
    const dow = d.getDay(); // Sun=0, Mon=1, ..., Sat=6
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
  let loading = $state(true);
  let error = $state("");
  let gated = $state(false);

  // ── Role gate ──────────────────────────────────────────────────────────────
  onMount(() => {
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
    error = "";
    try {
      const date = ymd(cursorMonday);
      const [w, t] = await Promise.all([
        api.get<WeekData>(`/shifts/week?date=${date}`),
        api.get<Template[]>("/shifts/templates"),
      ]);
      week = w;
      templates = t;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  // Re-fetch when cursor changes (after initial mount + role-gate)
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });
  $effect(() => {
    // Touch cursorMonday so $effect tracks it
    void cursorMonday;
    if (mounted && !gated) void load();
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

  // Coverage = count of shifts per day; flag non-Sunday days below MIN_COVERAGE
  const coveragePerDay = $derived.by(() => {
    if (!week) return [] as { date: string; count: number; under: boolean }[];
    const out: { date: string; count: number; under: boolean }[] = [];
    for (const d of week.weekDays) {
      const day = d.slice(0, 10);
      const dow = new Date(day).getDay();
      const isClosed = dow === 0; // Sunday closed in salon scenarios
      const count = week.shifts.filter((s) => s.date.slice(0, 10) === day).length;
      out.push({ date: day, count, under: !isClosed && count < MIN_COVERAGE });
    }
    return out;
  });

  const underStaffedDays = $derived(coveragePerDay.filter((c) => c.under));
  const totalShifts = $derived(week?.shifts.length ?? 0);

  const avgHoursPerEmployee = $derived.by(() => {
    if (!week || week.employees.length === 0) return 0;
    let totalMin = 0;
    for (const s of week.shifts) {
      const [sh, sm] = s.startTime.split(":").map(Number);
      const [eh, em] = s.endTime.split(":").map(Number);
      totalMin += eh * 60 + em - (sh * 60 + sm);
    }
    return Math.round((totalMin / 60 / week.employees.length) * 10) / 10;
  });

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
  function shiftLabel(s: Shift): string {
    const start = s.startTime.slice(0, 5);
    const end = s.endTime.slice(0, 5);
    return `${start}–${end}`;
  }
  function fmtCoverageDate(iso: string): string {
    const d = new Date(iso);
    return `${DOW[(d.getDay() + 6) % 7]}, ${d.getDate()}.${d.getMonth() + 1}.`;
  }
  function fmtUnderStaffed(days: { date: string; count: number }[]): string {
    return days.map((c) => `${fmtCoverageDate(c.date)} (${c.count}/${MIN_COVERAGE})`).join(", ");
  }
</script>

<PageHead
  eyebrow="Team"
  title="Schichtplanung"
  accent="Schicht"
  sub="Wöchentliche Schichten zuweisen — mit Vorlagen für wiederkehrende Muster."
/>

{#if error}
  <div class="callout error card-animate" role="alert">{error}</div>
{/if}

<!-- Template strip (top 3 templates) -->
{#if templates.length > 0}
  <div class="grid grid-3 template-strip">
    {#each templates.slice(0, 3) as tpl (tpl.id)}
      <Card animate>
        <div class="tpl-row">
          <div class="tpl-text">
            <div class="serif-eyebrow tpl-eyebrow">Vorlage</div>
            <div class="tpl-name">{tpl.name}</div>
            <div class="tpl-time">
              {tpl.startTime.slice(0, 5)}–{tpl.endTime.slice(0, 5)}
            </div>
          </div>
        </div>
      </Card>
    {/each}
  </div>
{/if}

<!-- Week nav + grid card -->
<Card animate class="week-card">
  <div class="week-header">
    <div class="serif-eyebrow week-label">
      Woche {fmtRange()}
    </div>
    <div class="spacer"></div>
    <button type="button" class="btn btn-ghost sm" aria-label="Vorherige Woche" onclick={prevWeek}
      >‹</button
    >
    <button type="button" class="btn btn-ghost sm" onclick={goToToday}>Heute</button>
    <button type="button" class="btn btn-ghost sm" aria-label="Nächste Woche" onclick={nextWeek}
      >›</button
    >
  </div>

  <div class="week-body">
    {#if loading}
      <div class="state-msg">Lade Woche…</div>
    {:else if !week}
      <div class="state-msg">Keine Daten</div>
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

        {#each week.employees as u (u.id)}
          <div class="who-cell">
            <div class="name">{u.firstName} {u.lastName}</div>
            {#if u.role}<div class="role">{u.role}</div>{/if}
          </div>
          {#each week.weekDays as d (d)}
            {@const s = shiftsByEmpDate.get(`${u.id}::${d.slice(0, 10)}`)}
            <div class="shift-cell" class:off={!s}>
              {#if s}
                <div class="shift-pill">{shiftLabel(s)}</div>
              {:else}
                frei
              {/if}
            </div>
          {/each}
        {/each}
      </div>

      <!-- Coverage callouts -->
      {#if underStaffedDays.length > 0}
        <div class="callout coverage-warn" role="status">
          <span class="ico" aria-hidden="true">⚠</span>
          <div>
            <b>Unterbesetzt:</b>
            {fmtUnderStaffed(underStaffedDays)}
            — bitte zusätzliche Schichten zuweisen.
          </div>
        </div>
      {/if}

      <div class="callout brand coverage-summary">
        <span class="ico" aria-hidden="true">ⓘ</span>
        <div>
          <b>Abdeckung dieser Woche:</b>
          {week.employees.length} Personen · {totalShifts} Schichten · {avgHoursPerEmployee} Std. Ø pro
          Person.
        </div>
      </div>
    {/if}
  </div>
</Card>

<style>
  .template-strip {
    margin-bottom: 18px;
  }
  .tpl-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .tpl-text {
    min-width: 0;
  }
  .tpl-eyebrow {
    font-size: 13px;
  }
  .tpl-name {
    font-family: var(--font-serif);
    font-size: 20px;
    font-weight: 400;
    margin-top: 4px;
    color: var(--text);
  }
  .tpl-time {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .week-card {
    padding: 0;
    overflow: hidden;
  }
  .week-header {
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .week-header .spacer {
    flex: 1;
  }
  .week-label {
    font-size: 15px;
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
  .coverage-warn,
  .coverage-summary {
    margin-top: 18px;
  }
</style>
