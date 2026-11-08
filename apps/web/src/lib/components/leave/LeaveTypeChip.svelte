<script lang="ts">
  /**
   * LeaveTypeChip — Issue #840 G-3. The one type chip of list rows (Team → Anträge, Inbox): its
   * colour comes only from the mapping in `leave-colors.ts`, never from the brand colour.
   *
   * A decided or active request is solid (the type fill with its AA `-text` partner). A request that
   * still waits (`requested`) wears the dashed outline of the „Beantragt“ timeline style on a light
   * tint of the type colour, so the cue is not the colour alone (WCAG 1.4.1). Built on the global
   * `.chip` recipe; the scoped style only binds the colour. Extra attributes (`data-testid`,
   * `data-row-status`) land on the root.
   */
  import type { HTMLAttributes } from "svelte/elements";
  import { leaveTypeColor } from "$lib/leave/leave-colors";

  interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
    /** The leave type code; `null` is the neutral absent pair. */
    code: string | null;
    label: string;
    requested?: boolean;
  }

  let { code, label, requested = false, class: className = "", ...rest }: Props = $props();

  const color = $derived(leaveTypeColor(code));
</script>

<span
  {...rest}
  class="chip leave-type-chip {className}"
  class:leave-type-chip--requested={requested}
  style:--chip-fill="var({color.fill})"
  style:--chip-text="var({color.text})">{label}</span
>

<style>
  .leave-type-chip {
    background: var(--chip-fill);
    color: var(--chip-text);
    border: 2px solid transparent;
  }

  .leave-type-chip--requested {
    background: color-mix(in srgb, var(--chip-fill) 14%, transparent);
    color: var(--text);
    border: 2px dashed var(--chip-fill);
  }
</style>
