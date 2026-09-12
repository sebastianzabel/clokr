<!--
  Section — Admin section-card primitive.

  Owns title/sub/actions/footer structure. Replaces the
  `<Card animate class="sys-card"><CardHeader title sub/>` pattern in admin pages.
  NOT a replacement for `ui/Card.svelte` (used outside admin).

  Props:
    title    — 11px UPPERCASE section header label
    sub      — 13px muted description
    actions  — right-aligned header actions (snippet)
    footer   — per-card save area stripe (snippet)
    animate  — opt-in card-animate entrance (default: inherited via admin-animate context)
    tone     — "default" | "danger" (escape hatch; prefer DangerZone)
    dirty    — true while the section holds unsaved changes (Phase 109, D-11)
    children — section body (required)

  Example:
    <Section title="UNTERNEHMEN" sub="Firmenname & Region">
      <FormFields />
      {#snippet footer()}
        <button class="btn btn-primary btn-sm">Speichern</button>
      {/snippet}
    </Section>
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { getContext } from "svelte";

  interface Props {
    title?: string;
    sub?: string;
    actions?: Snippet;
    footer?: Snippet;
    animate?: boolean;
    tone?: "default" | "danger";
    dirty?: boolean;
    children: Snippet;
  }

  let {
    title,
    sub,
    actions,
    footer,
    animate,
    tone = "default",
    dirty = false,
    children,
  }: Props = $props();

  const contextAnimate = getContext<boolean | undefined>("admin-animate");
  const shouldAnimate = $derived(animate ?? contextAnimate ?? false);
</script>

<section class:card-animate={shouldAnimate} class:section--danger={tone === "danger"}>
  {#if title}
    <header class="section-hd">
      <div class="section-hd-text">
        <div class="section-title">{title}</div>
        {#if sub}<div class="section-sub">{sub}</div>{/if}
      </div>
      {#if actions}
        <div class="section-hd-actions">{@render actions()}</div>
      {/if}
    </header>
  {/if}

  <div class="section-body" class:section-body--no-header={!title}>
    {@render children()}
  </div>

  {#if footer}
    <footer class="section-footer">
      {@render footer()}
      {#if dirty}
        <span class="unsaved-hint" role="status">Nicht gespeichert</span>
      {/if}
    </footer>
  {/if}
</section>

<style>
  section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
    overflow: hidden;
  }

  section.section--danger {
    background: var(--bad-soft);
    border-color: var(--bad);
    box-shadow: none;
    margin-top: var(--s-8);
  }

  .section-hd {
    padding: var(--pad-card) var(--pad-card) var(--s-3);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-4);
  }

  .section-hd-text {
    flex: 1;
    min-width: 0;
  }

  .section-title {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text);
  }

  section.section--danger .section-title {
    color: var(--bad);
  }

  .section-sub {
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 400;
    color: var(--text-muted);
    margin-top: var(--s-1);
    line-height: 1.5;
  }

  .section-hd-actions {
    display: flex;
    gap: var(--s-2);
    align-items: center;
    flex-shrink: 0;
  }

  .section-body {
    padding: var(--s-3) var(--pad-card) var(--pad-card);
  }

  .section-body--no-header {
    padding: var(--pad-card);
  }

  .section-footer {
    border-top: 1px solid var(--border);
    padding: var(--s-4) var(--pad-card);
    display: flex;
    align-items: center;
    gap: var(--s-3);
    background: var(--bg-subtle);
  }
</style>
