<script lang="ts">
  // Issue #843 (D-843-01 block 11) - the static dialog panel for the themed frames of the example
  // page. A portaled overlay leaves the frame's data-theme/data-mode (the portal target is <body>),
  // so the frames show the panel in place: no portal, no overlay, no focus trap, no fixed
  // positioning. The panel markup is Dialog.svelte's own (`static` mode), so there is ONE source.
  import type { Snippet } from "svelte";
  import Dialog from "./Dialog.svelte";

  interface Props {
    title: string;
    eyebrow?: string;
    size?: "md" | "wide";
    children: Snippet;
    footer?: Snippet;
  }

  let { title, eyebrow, size = "md", children, footer }: Props = $props();
</script>

<Dialog static {title} {eyebrow} {size} {children} {footer} />
