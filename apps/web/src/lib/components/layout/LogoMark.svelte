<!--
  The Clokr logo mark of the design prototype: a ring with a gap and a clock hand.
  Issue #842 shared building block; the final logo is Issue #852.

  The colour comes from the parent's `color` (every stroke uses currentColor), so the mark follows
  the theme and the mode without a token of its own.
  Decorative by default (aria-hidden); with `title` it becomes an image with that accessible name.
-->
<script lang="ts">
  interface Props {
    /** Edge length in pixels (the mark is square). */
    size?: number;
    /** Accessible name; leave empty for a purely decorative mark. */
    title?: string;
  }

  let { size = 24, title }: Props = $props();
</script>

<svg
  class="logo-mark"
  viewBox="0 0 40 40"
  width={size}
  height={size}
  fill="none"
  role={title ? "img" : undefined}
  aria-hidden={title ? undefined : "true"}
  focusable="false"
>
  {#if title}<title>{title}</title>{/if}
  <circle
    cx="20"
    cy="20"
    r="15"
    stroke="currentColor"
    stroke-width="5.5"
    stroke-linecap="round"
    stroke-dasharray="76 20"
    transform="rotate(-60 20 20)"
  />
  <path d="M20 20V12" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" />
  <path d="M20 20l6 3.5" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" />
</svg>

<style>
  .logo-mark {
    display: inline-block;
    flex: none;
    vertical-align: middle;
  }
</style>
