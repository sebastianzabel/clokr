<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Avatar text (typically employee initials, e.g. "LM"). */
    avatar: string;
    /** Primary line — usually the requester's full name. */
    name: string;
    /**
     * Optional meta string (e.g. "Urlaub · Vacation"). Ignored when
     * `metaContent` snippet is provided. Rendered as plain text.
     */
    meta?: string;
    /** Tabular dates + day-count line, e.g. "2026-04-12 → 2026-04-18 · 5 Tage". */
    dates: string;
    /**
     * Optional whole-row click handler. When provided, the row renders as a
     * native `<button>` (semantic Enter/Space activation, focusable by
     * default). When omitted, the row renders as a plain div without
     * affordances.
     */
    onclick?: () => void;
    /**
     * Right-aligned action cluster (buttons or chip). Callers MUST call
     * `e.stopPropagation()` inside button handlers to prevent the row's
     * onclick from also firing.
     */
    actions?: Snippet;
    /**
     * Optional richer meta content (e.g. chips + text). When provided,
     * the `meta` string prop is ignored.
     */
    metaContent?: Snippet;
  }

  let { avatar, name, meta, dates, onclick, actions, metaContent }: Props = $props();
</script>

<!-- 4-col grid: 44px avatar / 1fr name+meta / auto dates / auto actions (docs/design/README.md §4) -->
{#if onclick}
  <button type="button" class="approval-row" {onclick}>
    <div class="approval-avatar" aria-hidden="true">{avatar}</div>
    <div class="approval-name-meta">
      <div class="approval-name">{name}</div>
      <div class="approval-meta">
        {#if metaContent}
          {@render metaContent()}
        {:else if meta}
          {meta}
        {/if}
      </div>
    </div>
    <div class="approval-dates">{dates}</div>
    {#if actions}
      <div class="approval-actions">{@render actions()}</div>
    {/if}
  </button>
{:else}
  <div class="approval-row">
    <div class="approval-avatar" aria-hidden="true">{avatar}</div>
    <div class="approval-name-meta">
      <div class="approval-name">{name}</div>
      <div class="approval-meta">
        {#if metaContent}
          {@render metaContent()}
        {:else if meta}
          {meta}
        {/if}
      </div>
    </div>
    <div class="approval-dates">{dates}</div>
    {#if actions}
      <div class="approval-actions">{@render actions()}</div>
    {/if}
  </div>
{/if}
