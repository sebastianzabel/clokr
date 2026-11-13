<script lang="ts">
  // Issue #843 (D-843-14) - the legacy name and import path of the Seitenkopf. The implementation
  // lives once in ui/PageHeader.svelte; this component only maps PageHead's props (`sub` is the
  // block's `subtitle`) and has no markup of its own. D-843-22 (owner request 10.11., design concept
  // 3/4): the head renders title, subtitle and actions only - `eyebrow` and `accent` are still
  // accepted but no longer rendered, so the 50+ callers and the tests pinning them stay untouched.
  import type { Snippet } from "svelte";
  import PageHeader from "../ui/PageHeader.svelte";

  interface Props {
    /** Inert since D-843-22 (owner request 10.11.): accepted so callers compile unchanged, never rendered. */
    eyebrow?: string;
    /** Main heading, e.g. "Guten Tag, Lena". Plain text. */
    title: string;
    /** Inert since D-843-22: accepted so callers compile unchanged; the title carries no accent word. */
    accent?: string;
    /** Optional muted sub-paragraph, max-width 560 px, below the heading. */
    sub?: string;
    /** Optional right-aligned action cluster (buttons) on the same row as the heading. */
    actions?: Snippet;
  }

  let { title, sub, actions }: Props = $props();
</script>

<PageHeader {title} subtitle={sub} {actions} />
