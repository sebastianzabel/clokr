<script lang="ts">
  // Issue #843 (D-843-14) - the legacy name and import path of the Seitenkopf. The implementation
  // lives once in ui/PageHeader.svelte; this component only maps PageHead's props (`sub` is the
  // block's `subtitle`) and has no markup of its own, so every page keeps rendering the same DOM.
  import type { Snippet } from "svelte";
  import PageHeader from "../ui/PageHeader.svelte";

  interface Props {
    /** Eyebrow line (Figtree, upright), e.g. "Mein Bereich". */
    eyebrow: string;
    /** Main heading, e.g. "Guten Tag, Lena". */
    title: string;
    /**
     * Optional explicit accent word. When omitted, the autoAccent rule applies: the last token
     * after the final `-` or whitespace separator is set apart in --brand; single-word titles
     * render plain (no `<em>` wrapper). Examples:
     *   "Team-Zeiten"          → "Team-<em>Zeiten</em>"
     *   "Mein Profil"          → "Mein <em>Profil</em>"
     *   "Urlaub & Abwesenheit" → "Urlaub & <em>Abwesenheit</em>"
     *   "Zeiterfassung"        → "Zeiterfassung" (no accent)
     * When this string is provided AND appears as a substring of `title`, the first occurrence is
     * wrapped in `<em>` (upright, --brand). Matching is case-sensitive; only the first occurrence
     * is wrapped. The substring is rendered as element text, never as HTML (T-27-01).
     */
    accent?: string;
    /** Optional muted sub-paragraph, max-width 560 px, below the heading. */
    sub?: string;
    /** Optional right-aligned action cluster (buttons) on the same row as the heading. */
    actions?: Snippet;
    /** Issue #845: the plain start-page head of the block (see PageHeader `compact`). */
    compact?: boolean;
  }

  let { eyebrow, title, accent, sub, actions, compact = false }: Props = $props();
</script>

<PageHeader {eyebrow} {title} {accent} subtitle={sub} {actions} {compact} />
