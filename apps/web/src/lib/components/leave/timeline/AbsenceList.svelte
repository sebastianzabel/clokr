<script lang="ts">
  /**
   * AbsenceList — Issue #840 (D-840-11).
   *
   * Below 768 px the timeline is too narrow, so the same model reads as a list per person: the own
   * person first, then the others by name. Every line names the type by TEXT (WCAG 1.4.1: the
   * colour dot is never the only cue), a requested absence says „beantragt“, a wish „Wunsch“ and a
   * masked bar „abwesend“ — the list shows exactly the label the model carries, so it can never
   * name a type the reader may not learn.
   *
   * It draws what it is given, writes nothing and renders no dialog.
   */
  import EmptyState from "$components/ui/EmptyState.svelte";
  import { ABSENT, leaveTypeColor } from "$lib/leave/leave-colors";
  import type { Period, TimelineBar, TimelinePerson } from "$lib/leave/timeline-model";

  interface Props {
    rows: TimelinePerson[];
    period: Period;
    holidays?: Array<{ day: string; name: string }>;
    onBarSelect?: (bar: TimelineBar) => void;
  }

  let { rows, period, holidays = [], onBarSelect }: Props = $props();

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function rangeLabel(bar: TimelineBar): string {
    const range =
      bar.start === bar.end ? fmtDate(bar.start) : `${fmtDate(bar.start)} – ${fmtDate(bar.end)}`;
    return bar.halfDay ? `${range} (halber Tag)` : range;
  }

  function dotColor(bar: TimelineBar): string {
    if (bar.style === "wunsch") return "var(--brand)";
    const color = bar.style === "abwesend" ? ABSENT : leaveTypeColor(bar.typeCode);
    return `var(${color.fill})`;
  }

  const groups = $derived(
    rows
      .map((person) => ({
        person,
        bars: person.bars
          .filter((bar) => bar.end >= period.startDay && bar.start <= period.endDay)
          .sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key)),
      }))
      .filter((group) => group.bars.length > 0)
      .sort(
        (a, b) =>
          Number(b.person.isOwn) - Number(a.person.isOwn) ||
          a.person.name.localeCompare(b.person.name, "de") ||
          a.person.employeeId.localeCompare(b.person.employeeId),
      ),
  );

  const periodHolidays = $derived(
    holidays
      .filter((holiday) => holiday.day >= period.startDay && holiday.day <= period.endDay)
      .sort((a, b) => a.day.localeCompare(b.day)),
  );
</script>

<div class="absence-list" data-testid="absence-list">
  {#if groups.length === 0}
    <EmptyState
      icon="calendar"
      title="Keine Abwesenheiten"
      description="In diesem Zeitraum ist niemand abwesend. Wähle einen anderen Zeitraum, wenn du weiterschauen möchtest."
    />
  {:else}
    {#if periodHolidays.length > 0}
      <p class="absence-list-holidays" data-testid="absence-list-holidays">
        Feiertage: {periodHolidays.map((h) => `${fmtDate(h.day)} ${h.name}`).join(", ")}
      </p>
    {/if}
    {#each groups as group (group.person.employeeId)}
      <section
        class="absence-list-person"
        data-testid="absence-list-person-{group.person.employeeId}"
      >
        <h3 class="absence-list-name">{group.person.name}</h3>
        <ul class="absence-list-lines">
          {#each group.bars as bar (bar.key)}
            <li class="absence-list-line" data-testid="absence-list-line-{bar.key}">
              {#if bar.style !== "wunsch" && onBarSelect}
                <button type="button" class="absence-list-select" onclick={() => onBarSelect(bar)}>
                  <span class="absence-list-dot" style:background={dotColor(bar)}></span>
                  <span class="absence-list-range">{rangeLabel(bar)}</span>
                  <span class="absence-list-type">{bar.label}</span>
                  {#if bar.style === "beantragt"}
                    <span class="badge badge-yellow">beantragt</span>
                  {/if}
                </button>
              {:else}
                <span class="absence-list-select absence-list-select--static">
                  <span class="absence-list-dot" style:background={dotColor(bar)}></span>
                  <span class="absence-list-range">{rangeLabel(bar)}</span>
                  <span class="absence-list-type">{bar.label}</span>
                  {#if bar.style === "beantragt"}
                    <span class="badge badge-yellow">beantragt</span>
                  {/if}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .absence-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .absence-list-holidays {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .absence-list-person {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 0.75rem;
  }

  .absence-list-name {
    margin: 0 0 0.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .absence-list-lines {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .absence-list-select {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font: inherit;
    font-size: 0.875rem;
    color: var(--text);
    text-align: left;
  }

  button.absence-list-select {
    cursor: pointer;
  }

  button.absence-list-select:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  .absence-list-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .absence-list-range {
    font-variant-numeric: tabular-nums;
  }

  .absence-list-type {
    color: var(--text-muted);
  }
</style>
