<script lang="ts" module>
  /** Number of avatar colour pairs in tokens.css (--a1 ... --a6). */
  export const AVATAR_COLOURS = 6;

  /** Stable avatar colour index 1..6 for a key: the same key always gets the same colour. */
  export function avatarIndex(key: string): number {
    let hash = 0;
    for (const ch of key) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    return (hash % AVATAR_COLOURS) + 1;
  }

  /** Up to two initials from the first two words of a title. */
  export function initialsOf(title: string): string {
    const words = title.trim().split(/\s+/).filter(Boolean);
    return words
      .slice(0, 2)
      .map((w) => Array.from(w)[0]?.toUpperCase() ?? "")
      .join("");
  }
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 5) - one list row: avatar - title / subtitle - trailing snippet.
  // The task variant puts `actions` under the text instead of trailing. Text only, never raw markup;
  // `href` is passed by page code.
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    subtitle?: string;
    /** Key of the stable avatar colour; defaults to the title. */
    avatarKey?: string;
    /** Set false for a row without avatar. */
    avatar?: boolean;
    variant?: "default" | "task";
    /** Makes the text block a link. */
    href?: string;
    trailing?: Snippet;
    actions?: Snippet;
    /** Issue #845: content before the text in a row without avatar (a status chip). */
    leading?: Snippet;
  }

  let {
    title,
    subtitle,
    avatarKey,
    avatar = true,
    variant = "default",
    href,
    trailing,
    actions,
    leading,
  }: Props = $props();

  let colour = $derived(avatarIndex(avatarKey ?? title));
</script>

<li
  class="list-row"
  class:list-row--task={variant === "task"}
  class:list-row--bare={!avatar}
  class:list-row--leading={!avatar && !!leading}
>
  {#if avatar}
    <span
      class="list-avatar"
      style="--av: var(--a{colour}); --av-t: var(--a{colour}-t)"
      aria-hidden="true">{initialsOf(title)}</span
    >
  {/if}
  {#if leading && !avatar}<span class="list-leading">{@render leading()}</span>{/if}
  <div class="list-text">
    {#if href}
      <a class="list-title list-link" {href}>{title}</a>
    {:else}
      <span class="list-title">{title}</span>
    {/if}
    {#if subtitle}<span class="list-subtitle">{subtitle}</span>{/if}
  </div>
  {#if variant === "task"}
    {#if actions}<div class="list-actions">{@render actions()}</div>{/if}
  {:else if trailing}
    <div class="list-trailing">{@render trailing()}</div>
  {/if}
</li>

<style>
  .list-leading {
    flex: none;
    display: inline-flex;
    align-items: center;
  }
  .list-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    column-gap: var(--s-3);
    min-height: var(--h-row);
    padding: var(--s-2) var(--s-4);
    border-bottom: 1px solid var(--line);
    color: var(--text);
  }
  .list-row:last-child {
    border-bottom: 0;
  }
  .list-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--av);
    color: var(--av-t);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .list-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .list-title,
  .list-subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list-title {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }
  .list-link {
    text-decoration: none;
  }
  .list-link:hover {
    text-decoration: underline;
  }
  .list-subtitle {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .list-trailing {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    white-space: nowrap;
  }

  /* Task variant: the buttons sit under the text block, in the text column. */
  .list-row--task {
    align-items: start;
  }
  .list-actions {
    grid-column: 2 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    margin-top: var(--s-2);
  }
  .list-row--task {
    grid-template-columns: auto minmax(0, 1fr);
  }
  /* Without an avatar the text takes the first column. */
  .list-row--bare {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .list-row--bare.list-row--task {
    grid-template-columns: minmax(0, 1fr);
  }
  .list-row--leading {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .list-row--bare .list-actions {
    grid-column: 1;
  }
</style>
