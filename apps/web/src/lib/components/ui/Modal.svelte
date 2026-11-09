<script lang="ts">
  // Issue #843 (D-843-01 block 11, D-843-16): Modal keeps its public API and renders through the
  // Dialog block, the one overlay implementation (portal to body, inert page, focus scope, scroll
  // lock, Escape layer, z-scale). Its callers stay untouched.
  import type { Snippet } from "svelte";
  import Dialog from "./Dialog.svelte";

  interface Props {
    /** Two-way bindable open state. Parent holds `let modalOpen = $state(false)`. */
    open: boolean;
    /** Optional eyebrow rendered above the title. */
    eyebrow?: string;
    /** Main heading rendered as H3 inside the modal header. */
    title: string;
    /** Overrides title for aria-label. Defaults to title. */
    ariaLabel?: string;
    /** Body content. */
    children: Snippet;
    /** Optional footer snippet (e.g. button row). */
    footer?: Snippet;
    /**
     * Issue #612 - additive. "md" (default) is the global `.modal` width; "wide" adds
     * `modal--wide` (880 px, capped to the viewport) for the person drill-down.
     */
    size?: "md" | "wide";
  }

  let {
    open = $bindable(),
    eyebrow,
    title,
    ariaLabel,
    children,
    footer,
    size = "md",
  }: Props = $props();
</script>

<Dialog bind:open {eyebrow} {title} {ariaLabel} {size} {children} {footer} />
