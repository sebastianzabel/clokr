<script lang="ts" module>
  import type { ChipTone as Tone } from "./chip-tone";
  export type ChipTone = Tone;
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 8) - the status chip: a 22 px pill with a dot. The colour pairs live
  // once in the shared tone block of app.css (shared with the .badge-* recipes), so the #842
  // contrast proof covers the chip; this file only picks the tone class.
  import type { Snippet } from "svelte";

  interface Props {
    tone?: ChipTone;
    title?: string;
    children: Snippet;
  }

  let { tone = "neutral", title, children }: Props = $props();
</script>

<span class="chip chip-{tone}" {title}
  ><span class="dot" aria-hidden="true"></span>{@render children()}</span
>
