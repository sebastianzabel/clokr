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
  import { api, ApiError } from "$api/client";

  // Phase 49.1-04 — Dashboard section component for SHIFT_BASED employees
  // Extracted from apps/web/src/routes/(app)/my-shifts/+page.svelte (Phase 49-02)
  // Rendered conditionally by /dashboard when scheduleType === "SHIFT_BASED"

  interface OwnShift {
    id: string;
    templateName: string | null;
    templateColor: string | null;
    startTime: string;
    endTime: string;
    label: string | null;
    note: string | null;
  }
  interface ColleagueChip {
    firstName: string;
    startTime: string;
    endTime: string;
  }
  interface DayEntry {
    date: string;
    ownShifts: OwnShift[];
    colleagues: ColleagueChip[];
  }
  interface MyWeekResponse {
    weekStart: string;
    days: DayEntry[];
  }

  interface Props {
    onFallback?: () => void;
  }

  let { onFallback }: Props = $props();

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
  function fmtRangeDe(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }
  function fmtShortDate(iso: string): string {
    const [, m, d] = iso.split("-");
    return `${d}.${m}.`;
  }

  let cursorMonday = $state(mondayOfWeek(new Date()));
  let data: MyWeekResponse | null = $state(null);
  let loading = $state(true);
  let error = $state("");
  let notInShiftSystem = $state(false);

  const weekNumber = $derived(getWeekNumber(ymd(cursorMonday)));
  const weekRangeText = $derived(
    data && data.days.length >= 7
      ? `${fmtShortDate(data.days[0].date)} – ${fmtShortDate(data.days[6].date)}`
      : "",
  );

  async function load() {
    loading = true;
    error = "";
    notInShiftSystem = false;
    try {
      const date = ymd(cursorMonday);
      data = await api.get<MyWeekResponse>(`/shifts/my-week?date=${date}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        notInShiftSystem = true;
        onFallback?.();
      } else {
        error = e instanceof Error ? e.message : "Fehler beim Laden";
      }
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
  function shiftTime(s: OwnShift): string {
    return `${s.startTime.slice(0, 5)}–${s.endTime.slice(0, 5)}`;
  }

  $effect(() => {
    void cursorMonday;
    void load();
  });
</script>

{#if notInShiftSystem}
  <!-- render nothing — parent uses onFallback callback to switch to MyWeek -->
{:else if loading}
  <div class="card card-animate">
    <div class="skeleton skeleton-card"></div>
  </div>
{:else if error}
  <div class="card card-animate">
    <div class="alert alert-error" role="alert">
      Fehler beim Laden der Schichtdaten. Bitte Seite neu laden.
    </div>
  </div>
{:else if data}
  <div class="card card-animate">
    <div class="myshifts-header">
      <div class="header-left">
        <span class="section-eyebrow">Meine Schichten</span>
        <span class="section-title">KW {weekNumber}</span>
        <div class="week-range">{weekRangeText}</div>
      </div>
      <div class="nav">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-label="Vorherige Woche"
          onclick={prev}>‹</button
        >
        <button type="button" class="btn btn-ghost btn-sm" onclick={today}>Heute</button>
        <button type="button" class="btn btn-ghost btn-sm" aria-label="Nächste Woche" onclick={next}
          >›</button
        >
      </div>
    </div>

    <div class="days">
      {#each data.days as day, idx (day.date)}
        <div class="day-row" class:day-row--today={isToday(day.date)}>
          <div class="day-label">
            <div class="dow">{DOW[idx]}</div>
            <div class="date">{fmtRangeDe(day.date).slice(0, 5)}</div>
          </div>
          <div class="day-content">
            {#if day.ownShifts.length === 0}
              <div class="own-empty">— frei</div>
            {:else}
              {#each day.ownShifts as s (s.id)}
                <div class="own-pill" title={s.note ?? undefined}>
                  <div class="time">{shiftTime(s)}</div>
                  {#if s.templateName}
                    <div class="tpl">{s.templateName}</div>
                  {/if}
                </div>
              {/each}
            {/if}
            {#if day.colleagues.length > 0}
              <div class="colleagues">
                <span class="colleagues-label">Mit dir:</span>
                {#each day.colleagues as c}
                  <span class="colleague-chip">
                    {c.firstName} <span class="chip-time">{c.startTime.slice(0, 5)}</span>
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* ── Header ─────────────────────────────────────────────────── */
  .myshifts-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    padding-bottom: var(--s-3);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--s-4);
  }
  .header-left {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
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
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .nav {
    display: flex;
    gap: var(--s-2);
  }

  /* ── Day rows ────────────────────────────────────────────────── */
  .days {
    display: flex;
    flex-direction: column;
  }
  .day-row {
    display: grid;
    grid-template-columns: 60px 1fr;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .day-row:last-child {
    border-bottom: none;
  }
  .day-row--today {
    background: var(--brand-soft);
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
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .own-empty {
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.9375rem;
  }
  .own-pill {
    display: inline-flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    background: var(--brand-soft);
    border: 1px solid var(--brand);
    border-radius: var(--r-md);
    color: var(--text);
  }
  .own-pill .time {
    font-family: var(--font-mono);
    font-weight: 700;
    color: var(--brand);
  }
  .own-pill .tpl {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .colleagues {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 0.875rem;
  }
  .colleagues-label {
    color: var(--text-muted);
  }
  .colleague-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    padding: 2px 8px;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    color: var(--text);
  }
  .chip-time {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* ── Error state ─────────────────────────────────────────────── */
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

  /* ── Skeleton ────────────────────────────────────────────────── */
  .skeleton-card {
    height: 320px;
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
