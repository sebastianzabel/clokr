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
</script>

<script lang="ts">
  import { api } from "$api/client";
  import Icon from "$lib/components/Icon.svelte";

  // Phase 49.4 — Dashboard week view for non-SHIFT_BASED users.
  // Shows Mo–So with worked vs expected hours per AZ-Modell, holidays, leave, sickness.

  interface MyWeekShift {
    startTime: string;
    endTime: string;
    label: string | null;
    color: string | null;
  }
  interface MyWeekDay {
    date: string;
    workedHours: number;
    expectedHours: number;
    status: string;
    isWorkday: boolean;
    isWeekend: boolean;
    holidayName: string | null;
    leaveType: string | null;
    absenceType: string | null;
    shift: MyWeekShift | null;
  }
  interface MyWeekResponse {
    weekDays: string[];
    scheduleType: string | null;
    days: MyWeekDay[];
  }

  const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  function mondayOfWeek(d: Date): Date {
    const dow = d.getDay();
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
  function fmtShort(iso: string): string {
    const [, m, d] = iso.split("-");
    return `${d}.${m}.`;
  }
  function fmtHours(h: number): string {
    const total = Math.round(h * 60);
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${hours}:${String(mins).padStart(2, "0")}`;
  }

  let cursorMonday = $state(mondayOfWeek(new Date()));
  let data: MyWeekResponse | null = $state(null);
  let loading = $state(true);
  let error = $state("");

  const weekNumber = $derived(getWeekNumber(ymd(cursorMonday)));
  const weekRangeText = $derived(
    data && data.days.length >= 7
      ? `${fmtShort(data.days[0].date)} – ${fmtShort(data.days[6].date)}`
      : "",
  );
  const weeklyWorked = $derived(data ? data.days.reduce((s, d) => s + (d.workedHours || 0), 0) : 0);
  const weeklyExpected = $derived(
    data ? data.days.reduce((s, d) => s + (d.expectedHours || 0), 0) : 0,
  );

  async function load() {
    loading = true;
    error = "";
    try {
      const date = ymd(cursorMonday);
      data = await api.get<MyWeekResponse>(`/dashboard/my-week?date=${date}`);
    } catch (e) {
      error = e instanceof Error ? e.message : "Fehler beim Laden";
    } finally {
      loading = false;
    }
  }

  function prev() {
    const d = new Date(cursorMonday);
    d.setDate(d.getDate() - 7);
    cursorMonday = d;
  }
  function next() {
    const d = new Date(cursorMonday);
    d.setDate(d.getDate() + 7);
    cursorMonday = d;
  }
  function today() {
    cursorMonday = mondayOfWeek(new Date());
  }
  function isToday(iso: string): boolean {
    return iso === ymd(new Date());
  }

  // Trim trailing :00 seconds → 07:45:00 → 07:45
  function fmtTime(t: string): string {
    return t.slice(0, 5);
  }

  // Status → icon name + German label
  function statusIcon(day: MyWeekDay): { name: string; label: string; cls: string } {
    switch (day.status) {
      case "clocked_in":
        return { name: "circle-fill", label: "Eingestempelt", cls: "is-active" };
      case "complete":
        return { name: "check", label: "Anwesend", cls: "is-good" };
      case "partial":
        return { name: "clock", label: "Teilweise erfasst", cls: "is-warn" };
      case "leave":
        return { name: "umbrella", label: day.leaveType ?? "Urlaub", cls: "is-leave" };
      case "sick":
        return {
          name: "medical",
          label: day.absenceType === "SICK_CHILD" ? "Kinderkrank" : "Krank",
          cls: "is-bad",
        };
      case "absent":
        return {
          name: day.absenceType === "MATERNITY" ? "heart" : "users",
          label: day.absenceType === "MATERNITY" ? "Mutterschutz" : "Elternzeit",
          cls: "is-muted",
        };
      case "holiday":
        return { name: "sun", label: day.holidayName ?? "Feiertag", cls: "is-holiday" };
      case "missing":
        return { name: "alert", label: "Fehlt", cls: "is-bad" };
      case "scheduled": {
        // Phase 49.4-fix: show concrete plan instead of generic "Geplant"
        if (day.shift) {
          const time = `${fmtTime(day.shift.startTime)}–${fmtTime(day.shift.endTime)}`;
          const label = day.shift.label ? `${day.shift.label} · ${time}` : time;
          return { name: "calendar", label, cls: "is-scheduled" };
        }
        if (day.expectedHours > 0) {
          return {
            name: "calendar",
            label: `Geplant: ${fmtHours(day.expectedHours)}`,
            cls: "is-scheduled",
          };
        }
        return { name: "calendar", label: "Geplant", cls: "is-muted" };
      }
      case "weekend":
        return { name: "leaf", label: "Wochenende", cls: "is-muted" };
      case "requested":
        return {
          name: "clock",
          label: day.leaveType ? `Antrag: ${day.leaveType}` : "Antrag offen",
          cls: "is-requested",
        };
      default:
        return { name: "minus", label: "—", cls: "is-muted" };
    }
  }

  function hoursLine(day: MyWeekDay, scheduleType: string | null): string | null {
    if (day.status === "leave" || day.status === "sick" || day.status === "absent") return null;
    // Open (pending) leave request: no worked/expected pill, matching leave/sick/holiday.
    if (day.status === "requested") return null;
    if (day.status === "holiday") return null;
    if (day.status === "weekend") return null;
    // "scheduled" already carries the plan in the label — don't duplicate as right-side pill.
    if (day.status === "scheduled") return null;

    if (day.workedHours > 0 || day.expectedHours > 0) {
      if (scheduleType === "FIXED_SCHEDULE" && day.expectedHours > 0) {
        return `${fmtHours(day.workedHours)} / ${fmtHours(day.expectedHours)}`;
      }
      return fmtHours(day.workedHours);
    }
    return null;
  }

  function modelHint(scheduleType: string | null): string {
    switch (scheduleType) {
      case "FIXED_SCHEDULE":
        return "Festes Wochenpensum";
      case "FLEXTIME":
        return "Gleitzeit · freie Verteilung";
      case "MONTHLY_HOURS":
        return "Monatsstunden";
      case "SHIFT_BASED":
        return "Schichtbasiert";
      default:
        return "";
    }
  }

  $effect(() => {
    void cursorMonday;
    void load();
  });
</script>

{#if loading}
  <div class="card card-animate">
    <div class="skeleton skeleton-card"></div>
  </div>
{:else if error}
  <div class="card card-animate">
    <div class="alert alert-error" role="alert">
      Fehler beim Laden der Wochenübersicht. Bitte Seite neu laden.
    </div>
  </div>
{:else if data}
  <div class="card card-animate myweek-card">
    <div class="myweek-header">
      <div class="header-left">
        <span class="section-eyebrow">Meine Woche</span>
        <span class="section-title">KW {weekNumber}</span>
        <div class="week-range">
          {weekRangeText}
          {#if data.scheduleType}
            <span class="model-pill" title="Arbeitszeitmodell">
              {modelHint(data.scheduleType)}
            </span>
          {/if}
        </div>
      </div>
      <div class="header-right">
        <div class="weekly-total">
          <span class="wt-value">{fmtHours(weeklyWorked)}</span>
          {#if weeklyExpected > 0}
            <span class="wt-target">/ {fmtHours(weeklyExpected)}</span>
          {/if}
        </div>
        <div class="nav">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="Vorherige Woche"
            onclick={prev}>‹</button
          >
          <button type="button" class="btn btn-ghost btn-sm" onclick={today}>Heute</button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label="Nächste Woche"
            onclick={next}>›</button
          >
        </div>
      </div>
    </div>

    <div class="days">
      {#each data.days as day, idx (day.date)}
        {@const sicon = statusIcon(day)}
        {@const hours = hoursLine(day, data.scheduleType)}
        <div
          class="day-row"
          class:day-row--today={isToday(day.date)}
          class:day-row--weekend={day.isWeekend}
        >
          <div class="day-label">
            <div class="dow">{DOW[idx]}</div>
            <div class="date">{fmtShort(day.date)}</div>
          </div>
          <div class="day-content">
            <div class="status-icon {sicon.cls}" title={sicon.label}>
              <Icon name={sicon.name} size={18} />
            </div>
            <div class="status-label">{sicon.label}</div>
            {#if hours}
              <div class="hours" title="Arbeitszeit">{hours}</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .myweek-card {
    display: flex;
    flex-direction: column;
  }
  .myweek-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s-3);
    padding-bottom: var(--s-3);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--s-3);
  }
  .header-left {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .header-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--s-2);
  }
  .section-eyebrow {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }
  .week-range {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .model-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    color: var(--text-muted);
    font-family: var(--font-sans, inherit);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .weekly-total {
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-family: var(--font-mono);
  }
  .wt-value {
    font-size: 1.125rem;
    font-weight: 700;
    color: var(--text);
  }
  .wt-target {
    font-size: 0.875rem;
    color: var(--text-muted);
  }
  .nav {
    display: flex;
    gap: var(--s-2);
  }

  .days {
    display: flex;
    flex-direction: column;
  }
  .day-row {
    display: grid;
    grid-template-columns: 60px 1fr;
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .day-row:last-child {
    border-bottom: none;
  }
  .day-row--today {
    background: var(--brand-soft);
  }
  .day-row--weekend:not(.day-row--today) {
    background: var(--bg-subtle);
  }
  .day-label .dow {
    font-weight: 600;
    color: var(--text);
  }
  .day-label .date {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .day-content {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    align-items: center;
    gap: 12px;
  }
  .status-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--text-muted);
  }
  .status-icon.is-good {
    color: var(--good);
  }
  .status-icon.is-warn {
    color: var(--warn);
  }
  .status-icon.is-bad {
    color: var(--bad);
  }
  .status-icon.is-active {
    color: var(--brand);
  }
  .status-icon.is-leave {
    color: var(--brand);
  }
  .status-icon.is-holiday {
    color: var(--warn);
  }
  .status-icon.is-muted {
    color: var(--text-muted);
  }
  .status-icon.is-scheduled {
    color: var(--brand);
  }
  /* Open (pending) leave request — warn tone matches the team-week 'beantragt' badge. */
  .status-icon.is-requested {
    color: var(--warn);
  }
  .status-label {
    color: var(--text);
    font-size: 0.9375rem;
  }
  .hours {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text);
    font-size: 0.875rem;
    white-space: nowrap;
  }

  .alert {
    padding: var(--s-4);
    border-radius: var(--r-md);
    font-size: 0.9375rem;
  }
  .alert-error {
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid var(--bad);
    color: var(--text);
  }

  .skeleton-card {
    height: 360px;
    border-radius: var(--r-md);
    background: var(--bg-subtle);
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
