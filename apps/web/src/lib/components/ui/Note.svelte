<script lang="ts" module>
  export type NoteTone = "ok" | "warn" | "bad" | "info" | "brand";
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 8) - the soft-colour hint line. Tone pairs come from the shared tone
  // block of app.css; the dot is decoration (the text carries the meaning).
  import type { Snippet } from "svelte";

  interface Props {
    tone?: NoteTone;
    /** Leading dot; on by default. */
    icon?: boolean;
    children: Snippet;
  }

  let { tone = "info", icon = true, children }: Props = $props();
</script>

<p class="note note-{tone}">
  {#if icon}<span class="note-dot" aria-hidden="true"></span>{/if}
  <span>{@render children()}</span>
</p>
