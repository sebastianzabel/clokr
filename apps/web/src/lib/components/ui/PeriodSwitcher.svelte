<script lang="ts">
  /**
   * PeriodSwitcher — Issue #840 (D-840-13/31). The ONE period control of every absence view:
   * ‹ label › Heute for a year, a quarter or a month. A thin wrapper around the `PeriodPicker`
   * block (Issue #843) that emits no markup or class of its own, so the `.month-bar`
   * narrow-viewport proofs (Issue #553/#564) stay valid for it.
   */
  import PeriodPicker from "./PeriodPicker.svelte";
  import { periodLabel, type Period, type Zoom } from "$lib/leave/timeline-model";

  interface Props {
    period: Period;
    /** Move one period back (-1) or forward (1). */
    onShift: (step: -1 | 1) => void;
    onToday: () => void;
    nextDisabled?: boolean;
    testIdPrefix?: string;
  }

  let { period, onShift, onToday, nextDisabled = false, testIdPrefix }: Props = $props();

  // Display wording of the arrow names, inflected per unit; the zoom itself is decided by its code.
  const ARROW_NAMES: Record<Zoom, { prev: string; next: string }> = {
    jahr: { prev: "Vorheriges Jahr", next: "Nächstes Jahr" },
    quartal: { prev: "Vorheriges Quartal", next: "Nächstes Quartal" },
    monat: { prev: "Vorheriger Monat", next: "Nächster Monat" },
  };
</script>

<PeriodPicker
  label={periodLabel(period)}
  prevLabel={ARROW_NAMES[period.zoom].prev}
  nextLabel={ARROW_NAMES[period.zoom].next}
  {nextDisabled}
  {testIdPrefix}
  onPrev={() => onShift(-1)}
  onNext={() => onShift(1)}
  {onToday}
/>
