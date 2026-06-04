<script lang="ts">
  import { toasts } from "$stores/toast";

  /**
   * LanguageToggle (Phase 33-02, I18N-03).
   *
   * Shared DE/EN chip toggle (stub). DE is always active; clicking EN shows a
   * v1.6 toast and leaves the UI untouched. Used in the topbar (compact) and
   * Admin Themes (segmented). Per SHELL-04 the toggle is a visible affordance
   * only — runtime locale switching ships in I18N-04 (v1.6).
   */
  interface Props {
    variant?: "segmented" | "compact";
  }

  let { variant = "segmented" }: Props = $props();

  function handleEnglish() {
    toasts.info("Sprachumschaltung folgt in v1.6");
  }

  function handleGerman() {
    // No-op: DE is already the active language for v1.5.
  }
</script>

{#if variant === "segmented"}
  <div class="seg" role="group" aria-label="Sprache auswählen">
    <!--
      Note: no `aria-pressed` here. Per WR-02 review (Phase 33), the segmented
      variant is a v1.5 stub — clicking "English" only fires a toast and does
      not toggle state. A hardcoded `aria-pressed` would lie to AT users about
      a togglable state that never changes. The `.active` class is a visual
      affordance only; the "Bald" badge signals the not-yet state. Real toggle
      semantics ship with I18N-04 (v1.6).
    -->
    <button type="button" class="seg-btn active" onclick={handleGerman}> Deutsch </button>
    <button type="button" class="seg-btn" onclick={handleEnglish}>
      English
      <span class="badge-soon">Bald</span>
    </button>
  </div>
{:else}
  <button
    type="button"
    class="lang-btn"
    onclick={handleEnglish}
    title="Sprache"
    aria-label="Sprache wechseln"
  >
    DE
  </button>
{/if}

<style>
  /* Segmented variant — mirrors the .seg/.seg-btn recipe from /admin/themes. */
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: var(--bg-subtle);
    border-radius: var(--r-pill);
  }
  .seg-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--r-pill);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 120ms var(--ease-out),
      color 120ms var(--ease-out);
  }
  .seg-btn:hover {
    color: var(--text);
  }
  .seg-btn:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  .seg-btn.active {
    background: var(--bg-card);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  /* "Bald" badge — segmented EN affordance, signals stub state. */
  .badge-soon {
    font-family: var(--font-sans);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    margin-left: 6px;
    background: var(--brand-soft);
    color: var(--brand);
    border-radius: var(--r-pill);
    line-height: 1;
  }

  /* Compact variant — matches the .lang-btn recipe from Topbar.svelte. */
  .lang-btn {
    width: 36px;
    height: 36px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    background: transparent;
    display: grid;
    place-items: center;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.06em;
    transition:
      background 120ms var(--ease-out),
      color 120ms var(--ease-out);
  }
  .lang-btn:hover {
    background: var(--bg-subtle);
    color: var(--text);
  }
  .lang-btn:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
</style>
