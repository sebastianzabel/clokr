<script lang="ts">
  import { overtimeModeLocked, OVERTIME_MODE_LOCKED_HINT } from "$lib/utils/work-schedule";

  type Mode = "CARRY_FORWARD" | "TRACK_ONLY";

  interface Props {
    type: string;
    monthlyHours: number | string | null | undefined;
    value: Mode;
    onchange: (v: Mode) => void;
    /** Select id; the hint id derives from it. Defaults to the id the admin page has always used. */
    id?: string;
  }

  let { type, monthlyHours, value, onchange, id = "e-overtime-mode" }: Props = $props();

  // Display only (Issue #494 R5, D-05): the lock shows TRACK_ONLY but never writes it back,
  // so a stored CARRY_FORWARD survives typing 0 and then a real value again.
  const locked = $derived(overtimeModeLocked(type, monthlyHours));
</script>

<div class="form-group">
  <label class="form-label" for={id}>Überstunden-Modus</label>
  <select
    {id}
    class="form-input"
    aria-describedby={locked ? `${id}-hint` : undefined}
    value={locked ? "TRACK_ONLY" : value}
    disabled={locked}
    onchange={(e) => {
      if (!locked) onchange(e.currentTarget.value as Mode);
    }}
  >
    <option value="CARRY_FORWARD">Übertragen (CARRY_FORWARD)</option>
    <option value="TRACK_ONLY">Nur erfassen (TRACK_ONLY)</option>
  </select>
  {#if locked}
    <p class="form-hint" id="{id}-hint">{OVERTIME_MODE_LOCKED_HINT}</p>
  {/if}
</div>
