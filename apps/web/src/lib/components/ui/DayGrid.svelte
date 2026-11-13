<script lang="ts" module>
  // Issue #843 (D-843-01 block 7) - weekday hours Mo...So with a live sum.
  export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  export type DayKey = (typeof DAY_KEYS)[number];
  /** Hours per weekday; null while a field is empty or not a number. */
  export type DayHours = Record<DayKey, number | null>;

  /** Maximum hours of one day; the API's Zod validation stays the authority (T-843-09). */
  export const DAY_HOURS_MAX = 24;

  const DAYS: ReadonlyArray<{ key: DayKey; short: string; full: string }> = [
    { key: "mon", short: "Mo", full: "Montag" },
    { key: "tue", short: "Di", full: "Dienstag" },
    { key: "wed", short: "Mi", full: "Mittwoch" },
    { key: "thu", short: "Do", full: "Donnerstag" },
    { key: "fri", short: "Fr", full: "Freitag" },
    { key: "sat", short: "Sa", full: "Samstag" },
    { key: "sun", short: "So", full: "Sonntag" },
  ];

  /** True for a number inside 0...24. Feedback only; the server validates again. */
  export function isValidDayHours(hours: number | null): hours is number {
    return hours !== null && Number.isFinite(hours) && hours >= 0 && hours <= DAY_HOURS_MAX;
  }

  /** Sum of the valid days, rounded to hundredths so float noise never shows. */
  export function sumDayHours(value: DayHours): number {
    let sum = 0;
    for (const key of DAY_KEYS) {
      const hours = value[key];
      if (isValidDayHours(hours)) sum += hours;
    }
    return Math.round(sum * 100) / 100;
  }

  /** The days with hours above 0 - the contract's working days per week. */
  export function workDayCount(value: DayHours): number {
    return DAY_KEYS.filter((key) => {
      const hours = value[key];
      return isValidDayHours(hours) && hours > 0;
    }).length;
  }

  /** Hours as a clock value, like every saldo of the app: 39,5 -> „39:30 h“. */
  export function clockHours(hours: number): string {
    const minutes = Math.round(hours * 60);
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
  }
</script>

<script lang="ts">
  interface Props {
    /** Hours per weekday (bindable). */
    value: DayHours;
    /** Accessible name of the group, e.g. "Wochenstunden je Tag". */
    label: string;
    /** Step of the number fields. */
    step?: number;
    disabled?: boolean;
    onchange?: (value: DayHours) => void;
    /** Test id of the sum row. */
    sumTestId?: string;
  }

  let {
    value = $bindable(),
    label,
    step = 0.25,
    disabled = false,
    onchange,
    sumTestId,
  }: Props = $props();

  const uid = $props.id();
  const groupId = `${uid}-group`;

  const sum = $derived(sumDayHours(value));
  const workDays = $derived(workDayCount(value));

  function update(key: DayKey, event: Event) {
    const parsed = (event.currentTarget as HTMLInputElement).valueAsNumber;
    value = { ...value, [key]: Number.isNaN(parsed) ? null : parsed };
    onchange?.(value);
  }
</script>

<div class="day-grid" role="group" aria-labelledby={groupId}>
  <p class="dg-label" id={groupId}>{label}</p>
  <div class="dg-days">
    {#each DAYS as day (day.key)}
      {@const invalid = !isValidDayHours(value[day.key])}
      <div class="dg-day">
        <span class="dg-day-name" aria-hidden="true">{day.short}</span>
        <input
          class="form-input dg-input"
          type="number"
          inputmode="decimal"
          min="0"
          max={DAY_HOURS_MAX}
          {step}
          {disabled}
          aria-label={day.full}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={invalid ? `${uid}-err-${day.key}` : undefined}
          value={value[day.key] ?? ""}
          oninput={(event) => update(day.key, event)}
        />
      </div>
    {/each}
  </div>
  {#each DAYS as day (day.key)}
    {#if !isValidDayHours(value[day.key])}
      <p class="dg-error" id="{uid}-err-{day.key}">
        <span class="dg-error-dot" aria-hidden="true"></span>
        {day.full}: Gib eine Zahl von 0 bis {DAY_HOURS_MAX} ein.
      </p>
    {/if}
  {/each}
  <!-- Issue #854 (owner review): one tinted sum row on every page - the working days on the left,
       the week's hours as a clock value on the right (the prototype's contract form). -->
  <p class="dg-sum" aria-live="polite" data-testid={sumTestId}>
    <span>{workDays} {workDays === 1 ? "Arbeitstag" : "Arbeitstage"} pro Woche</span>
    <strong class="dg-sum-value">{clockHours(sum)}</strong>
  </p>
</div>

<style>
  /* The block root is the container; the day row reacts to ITS width (D-843-03). */
  .day-grid {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    min-width: 0;
  }

  .dg-label {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  /* Two rows of four below 760 px container width, one row of seven from there. */
  .dg-days {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-2);
  }

  @container (min-width: 760px) {
    .dg-days {
      grid-template-columns: repeat(7, minmax(0, 1fr));
    }
  }

  .dg-day {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }

  .dg-day-name {
    text-align: center;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .dg-input {
    min-height: var(--h-control);
    padding-top: 0;
    padding-bottom: 0;
    font-size: var(--fs-base);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .dg-input[aria-invalid="true"] {
    border-color: var(--bad);
  }

  .dg-error {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--bad);
  }

  .dg-error-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: var(--r-pill);
    background: var(--bad);
  }

  .dg-sum {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-3);
    margin: 0;
    padding: var(--s-2) var(--s-3);
    background: var(--sunk);
    border-radius: var(--r-control);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .dg-sum-value {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>
