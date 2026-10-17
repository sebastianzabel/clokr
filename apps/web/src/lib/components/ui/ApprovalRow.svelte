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
     * Issue #612 — additive "primary action" mode. When set, the row renders as a plain `div`
     * (never a button) and the name becomes the row's ONE link, stretched over the whole row
     * (`::after`); `actions` stay SIBLINGS of that link, above it, so no interactive element
     * is ever nested in another. Mutually exclusive with `onclick`: when both are passed,
     * `primaryHref` wins and `onclick` is ignored. Use this mode, not `onclick`, whenever the
     * row also carries `actions`.
     */
    primaryHref?: string;
    /** Issue #612 — accessible name of the primary link. Defaults to `name`. */
    primaryLabel?: string;
    /**
     * Issue #612 — click handler of the primary link. The caller decides: intercept a plain left
     * click (`isPlainLeftClick`) with `preventDefault()` for an in-page navigation and let a
     * modified or middle click open a new tab.
     */
    onPrimaryClick?: (e: MouseEvent) => void;
    /**
     * Right-aligned action cluster (buttons or chip). In the `onclick` mode callers MUST call
     * `e.stopPropagation()` inside button handlers to prevent the row's onclick from also firing
     * (a button in a button — prefer `primaryHref`, where the actions are siblings and need no
     * stopPropagation).
     */
    actions?: Snippet;
    /**
     * Optional richer meta content (e.g. chips + text). When provided,
     * the `meta` string prop is ignored.
     */
    metaContent?: Snippet;
  }

  let {
    avatar,
    name,
    meta,
    dates,
    onclick,
    primaryHref,
    primaryLabel,
    onPrimaryClick,
    actions,
    metaContent,
  }: Props = $props();
</script>

<!-- 4-col grid: 44px avatar / 1fr name+meta / auto dates / auto actions (docs/design/README.md §4) -->
{#if primaryHref}
  <div class="approval-row approval-row--stretched">
    <div class="approval-avatar" aria-hidden="true">{avatar}</div>
    <div class="approval-name-meta">
      <a
        class="approval-name approval-primary"
        href={primaryHref}
        data-sveltekit-noscroll
        aria-label={primaryLabel}
        onclick={onPrimaryClick}>{name}</a
      >
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
{:else if onclick}
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

<style>
  /* Issue #612 — primary-action mode: the name link is stretched over the whole row; the actions
     sit above it and stay separately clickable. */
  .approval-row--stretched {
    position: relative;
    cursor: default;
  }

  .approval-primary {
    display: block;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }

  .approval-primary::after {
    content: "";
    position: absolute;
    inset: 0;
  }

  .approval-row--stretched .approval-actions {
    position: relative;
    z-index: 1;
  }

  /* The focus ring is drawn on the whole row, not on the name text. */
  .approval-primary:focus-visible {
    outline: none;
  }

  .approval-primary:focus-visible::after {
    outline: 2px solid var(--brand-light);
    outline-offset: -2px;
    border-radius: var(--r-sm);
  }
</style>
