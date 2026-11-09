<!--
  BrandLogo — Issue #852: the clokr mark (and optionally the wordmark „clokr“) everywhere in the web
  app. The mark is the ONE file /brand/mark.svg, drawn as a CSS mask in the current text colour, so it
  takes each theme's brand colour (default var(--brand)) and a logo change only swaps that file
  (`pnpm --filter @clokr/web run brand:icons` regenerates the rasters). The wordmark is text in
  Figtree 700 (an SVG in an <img> could not load the web font).
-->
<script lang="ts">
  interface Props {
    /** Edge length of the mark in px; the wordmark scales with it. */
    size?: number;
    /** Show the wordmark „clokr“ next to the mark. */
    wordmark?: boolean;
    /** Colour of the mark (any CSS colour); the wordmark keeps the surrounding text colour. */
    color?: string;
    /** Accessible name; the logo is one image to assistive technology. */
    label?: string;
  }

  let { size = 22, wordmark = true, color = "var(--brand)", label = "Clokr" }: Props = $props();
</script>

<span
  class="brand-logo"
  role="img"
  aria-label={label}
  style:--brand-logo-size="{size}px"
  style:--brand-logo-color={color}
>
  <span class="brand-logo-mark" aria-hidden="true"></span>
  {#if wordmark}
    <span class="brand-logo-word" aria-hidden="true" translate="no">clokr</span>
  {/if}
</span>

<style>
  .brand-logo {
    display: inline-flex;
    align-items: center;
    gap: calc(var(--brand-logo-size) * 0.36);
    line-height: 1;
  }
  .brand-logo-mark {
    width: var(--brand-logo-size);
    height: var(--brand-logo-size);
    flex: none;
    background-color: var(--brand-logo-color);
    -webkit-mask: url("/brand/mark.svg") center / contain no-repeat;
    mask: url("/brand/mark.svg") center / contain no-repeat;
  }
  .brand-logo-word {
    font-family: "Figtree", var(--font-sans, system-ui), sans-serif;
    font-weight: 700;
    font-size: calc(var(--brand-logo-size) * 0.72);
    letter-spacing: -0.02em;
    color: inherit;
  }
</style>
