<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Serif italic eyebrow line, e.g. "Mein Bereich". */
    eyebrow: string;
    /** Main heading, e.g. "Guten Tag, Lena". */
    title: string;
    /**
     * Optional explicit accent word. When omitted, the autoAccent rule applies:
     * the last token after the final `-` or whitespace separator is italicized;
     * single-word titles render plain (no `<em>` wrapper). Examples:
     *   "Team-Zeiten"          → "Team-*Zeiten*"
     *   "Mein Profil"          → "Mein *Profil*"
     *   "Urlaub & Abwesenheit" → "Urlaub & *Abwesenheit*"
     *   "Zeiterfassung"        → "Zeiterfassung" (no accent)
     * When this string is provided AND appears as a substring of `title`, the
     * first occurrence is wrapped in `<em>` (italic, --brand-light). Matching
     * is case-sensitive; only the first occurrence is wrapped. The substring
     * is rendered as element text (never as HTML) — see threat register
     * T-27-01: no `{@html}` is used, so prop values are always escaped.
     */
    accent?: string;
    /** Optional muted sub-paragraph, max-width 560 px, below the H1. */
    sub?: string;
    /** Optional right-aligned action cluster (buttons) on the same row as the H1. */
    actions?: Snippet;
  }

  let { eyebrow, title, accent, sub, actions }: Props = $props();

  // Derive a [pre, match, post] split for the H1.
  //
  // 1. Explicit `accent` (case-sensitive substring match): first occurrence wrapped.
  //    If accent is given but not found in title → render plain.
  // 2. autoAccent (no `accent` prop): split on the LAST `-` or whitespace
  //    separator and italicize the trailing token. Single-word titles render
  //    plain (no `<em>` wrapper).
  //
  // Both branches output element text only — never `{@html}` — so prop values
  // remain escaped (threat register T-27-01).
  const titleParts = $derived.by(() => {
    if (accent) {
      const idx = title.indexOf(accent);
      if (idx === -1) return { pre: title, match: "", post: "" };
      return {
        pre: title.slice(0, idx),
        match: accent,
        post: title.slice(idx + accent.length),
      };
    }
    // autoAccent: find last separator (- or whitespace), italicize last token.
    const matches = [...title.matchAll(/[\s-]/g)];
    if (matches.length === 0) return { pre: title, match: "", post: "" };
    const last = matches[matches.length - 1];
    const splitIdx = (last.index ?? 0) + 1;
    return {
      pre: title.slice(0, splitIdx),
      match: title.slice(splitIdx),
      post: "",
    };
  });
</script>

<header class="page-head">
  <div class="page-head-text">
    <div class="brand-rule" aria-hidden="true"></div>
    <div class="eyebrow" translate="no">{eyebrow}</div>
    {#if titleParts.match}
      <h1 translate="no">{titleParts.pre}<em>{titleParts.match}</em>{titleParts.post}</h1>
    {:else}
      <h1 translate="no">{title}</h1>
    {/if}
    {#if sub}
      <p class="sub">{sub}</p>
    {/if}
  </div>
  {#if actions}
    <div class="page-head-actions">
      {@render actions()}
    </div>
  {/if}
</header>

<style>
  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .page-head-text {
    flex: 1;
    min-width: 0;
  }

  .brand-rule {
    width: 42px;
    height: 2px;
    background: var(--brand);
    margin-bottom: 14px;
    border-radius: 1px;
  }

  .eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 14px;
    color: var(--brand-light);
    letter-spacing: 0.02em;
    margin-bottom: 4px;
  }

  .page-head h1 {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: clamp(28px, 3.4vw, 40px);
    line-height: 1.05;
    margin: 0;
    letter-spacing: 0.005em;
    color: var(--text);
  }

  .page-head h1 :global(em) {
    font-style: italic;
    color: var(--brand-light);
  }

  .page-head .sub {
    margin: 10px 0 0;
    max-width: 560px;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.55;
  }

  .page-head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
  }

  @media (max-width: 720px) {
    .page-head {
      flex-direction: column;
      align-items: flex-start;
    }
    .page-head-actions {
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
