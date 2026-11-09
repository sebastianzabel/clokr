<script lang="ts">
  // Issue #843 (D-843-01 block 7) - date picker on bits-ui. The page exchanges ISO strings
  // (YYYY-MM-DD) with this component; the CalendarDate of @internationalized/date exists only
  // inside it. German segments (TT.MM.JJJJ), weeks start on Monday, the calendar is portaled.
  import { DatePicker } from "bits-ui";
  import { parseDate, type DateValue } from "@internationalized/date";

  interface Props {
    /** Two-way bindable ISO date (YYYY-MM-DD), null while empty. */
    value?: string | null;
    /** Accessible name of the segmented field. */
    label: string;
    /** Earliest selectable day, ISO. */
    min?: string;
    /** Latest selectable day, ISO. */
    max?: string;
    disabled?: boolean;
    /** FormField attrs: the id of the field, the describedby list and the invalid flag. */
    id?: string;
    describedBy?: string;
    invalid?: boolean;
    /** Two-way bindable open state of the calendar popover (closed by default). */
    open?: boolean;
    /** Called after the value changed through the field or the calendar. */
    onValueChange?: (value: string | null) => void;
  }

  let {
    value = $bindable(null),
    label,
    min,
    max,
    disabled = false,
    id,
    describedBy,
    invalid = false,
    open = $bindable(false),
    onValueChange,
  }: Props = $props();

  /** An unparsable string is treated as empty; the API validates every date on write. */
  function toDateValue(iso: string | null | undefined): DateValue | undefined {
    if (!iso) return undefined;
    try {
      return parseDate(iso);
    } catch {
      return undefined;
    }
  }

  // Writable derived: follows the bound ISO string, and the picker overrides it until the next change.
  let dateValue = $derived(toDateValue(value));
  const minValue = $derived(toDateValue(min));
  const maxValue = $derived(toDateValue(max));

  function onChange(next: DateValue | undefined) {
    const iso = next ? next.toString() : null;
    value = iso;
    onValueChange?.(iso);
  }

  /** Spoken part names; bits-ui ships English ones ("day, "). */
  const PART_LABELS: Record<string, string> = {
    day: "Tag",
    month: "Monat",
    year: "Jahr",
  };
</script>

<div class="datepicker">
  <DatePicker.Root
    bind:value={dateValue}
    bind:open
    onValueChange={onChange}
    locale="de-DE"
    weekStartsOn={1}
    weekdayFormat="short"
    calendarLabel={label}
    {minValue}
    {maxValue}
    {disabled}
    fixedWeeks
  >
    <DatePicker.Input
      {id}
      class="dp-field"
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid ? "true" : undefined}
      data-invalid={invalid ? "" : undefined}
    >
      {#snippet children({ segments })}
        <span class="dp-segments">
          {#each segments as seg, i (i)}
            <DatePicker.Segment part={seg.part as never}>
              {#snippet child({ props })}
                <span
                  {...props}
                  class:dp-literal={seg.part === "literal"}
                  class:dp-segment={seg.part !== "literal"}
                  aria-label={PART_LABELS[seg.part] ? `${PART_LABELS[seg.part]}, ` : undefined}
                  >{seg.value}</span
                >
              {/snippet}
            </DatePicker.Segment>
          {/each}
        </span>
        <DatePicker.Trigger class="dp-trigger" aria-label="Kalender öffnen">
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </DatePicker.Trigger>
      {/snippet}
    </DatePicker.Input>
    <DatePicker.Portal>
      <DatePicker.Content sideOffset={4} collisionPadding={8}>
        {#snippet child({ props, wrapperProps, open })}
          {#if open}
            <div {...wrapperProps} class="dp-wrapper">
              <div {...props} class="dp-content">
                <DatePicker.Calendar>
                  {#snippet children({ months, weekdays })}
                    <DatePicker.Header class="dp-header">
                      <DatePicker.PrevButton>
                        {#snippet child({ props })}
                          <button {...props} class="dp-nav" aria-label="Vorheriger Monat">
                            <svg
                              aria-hidden="true"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg
                            >
                          </button>
                        {/snippet}
                      </DatePicker.PrevButton>
                      <DatePicker.Heading class="dp-heading" />
                      <DatePicker.NextButton>
                        {#snippet child({ props })}
                          <button {...props} class="dp-nav" aria-label="Nächster Monat">
                            <svg
                              aria-hidden="true"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg
                            >
                          </button>
                        {/snippet}
                      </DatePicker.NextButton>
                    </DatePicker.Header>
                    {#each months as month (month.value.toString())}
                      <DatePicker.Grid class="dp-grid">
                        <DatePicker.GridHead>
                          <DatePicker.GridRow>
                            <!-- German weekday heads repeat (D, M, ...): key by index (RESEARCH P7) -->
                            {#each weekdays as weekday, w (w)}
                              <DatePicker.HeadCell class="dp-weekday">{weekday}</DatePicker.HeadCell
                              >
                            {/each}
                          </DatePicker.GridRow>
                        </DatePicker.GridHead>
                        <DatePicker.GridBody>
                          {#each month.weeks as weekDates, r (r)}
                            <DatePicker.GridRow>
                              {#each weekDates as date (date.toString())}
                                <DatePicker.Cell {date} month={month.value} class="dp-cell">
                                  <DatePicker.Day class="dp-day">
                                    {date.day}
                                  </DatePicker.Day>
                                </DatePicker.Cell>
                              {/each}
                            </DatePicker.GridRow>
                          {/each}
                        </DatePicker.GridBody>
                      </DatePicker.Grid>
                    {/each}
                  {/snippet}
                </DatePicker.Calendar>
              </div>
            </div>
          {/if}
        {/snippet}
      </DatePicker.Content>
    </DatePicker.Portal>
  </DatePicker.Root>
</div>

<style>
  .datepicker {
    min-width: 0;
  }

  /* The field: one 32 px box holding the segments and the calendar trigger. */
  .datepicker :global(.dp-field) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    min-height: var(--h-control);
    padding: 0 2px 0 var(--s-3);
    border: 1px solid var(--line-2);
    border-radius: var(--r-control);
    background: var(--card);
    color: var(--text);
    font-size: var(--fs-base);
  }

  .datepicker :global(.dp-field:focus-within) {
    border-color: var(--brand);
  }

  .datepicker :global(.dp-field[data-invalid]) {
    border-color: var(--bad);
  }

  .datepicker :global(.dp-field[data-disabled]) {
    opacity: 0.6;
  }

  .dp-segments {
    display: inline-flex;
    align-items: center;
  }

  .dp-segment {
    padding: 0 2px;
    border-radius: 4px;
    outline: none;
  }

  .dp-segment:focus {
    background: var(--brand);
    color: var(--brand-ink);
  }

  .dp-segment[data-placeholder] {
    color: var(--text-3);
  }

  .dp-literal {
    color: var(--text-2);
  }

  .datepicker :global(.dp-trigger) {
    display: inline-grid;
    place-items: center;
    width: var(--h-control-sm);
    height: var(--h-control-sm);
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }

  .datepicker :global(.dp-trigger:hover) {
    background: var(--hover);
  }

  .dp-wrapper {
    z-index: 1600;
  }

  .dp-content {
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--card);
    color: var(--text);
    box-shadow: var(--shadow-pop);
  }

  .dp-content :global(.dp-header) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--s-2);
  }

  .dp-content :global(.dp-heading) {
    font-size: var(--fs-base);
    font-weight: 600;
  }

  .dp-nav {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }

  .dp-nav:hover {
    background: var(--hover);
  }

  .dp-content :global(.dp-grid) {
    border-collapse: collapse;
  }

  .dp-content :global(.dp-weekday) {
    width: 36px;
    height: 28px;
    color: var(--text-2);
    font-size: var(--fs-xs);
    font-weight: 600;
    text-align: center;
  }

  .dp-content :global(.dp-cell) {
    padding: 0;
    text-align: center;
  }

  .dp-content :global(.dp-day) {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--r-control);
    font-size: var(--fs-base);
    cursor: pointer;
  }

  .dp-content :global(.dp-day:hover) {
    background: var(--hover);
  }

  .dp-content :global(.dp-day[data-today]) {
    box-shadow: inset 0 0 0 1.5px var(--brand);
  }

  .dp-content :global(.dp-day[data-selected]) {
    background: var(--brand);
    color: var(--brand-ink);
  }

  .dp-content :global(.dp-day[data-outside-month]),
  .dp-content :global(.dp-day[data-disabled]),
  .dp-content :global(.dp-day[data-unavailable]) {
    color: var(--text-3);
    cursor: default;
  }

  .dp-content :global(.dp-day[data-outside-month]:hover),
  .dp-content :global(.dp-day[data-disabled]:hover) {
    background: transparent;
  }
</style>
