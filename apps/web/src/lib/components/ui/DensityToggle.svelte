<script lang="ts">
  import { density } from "$stores/density";

  /**
   * DensityToggle (Phase 33-02, I18N-03 success criterion #4).
   *
   * Segmented Komfortabel/Kompakt control bound to the `density` store. The
   * store side-effect updates `data-density` on <html> and localStorage, which
   * in turn flips --pad-card from 24px to 16px across every card (tokens.css).
   * Lifted from /admin/themes so Plan 33-03 (and future surfaces) can reuse it.
   */
  function setComfortable() {
    density.set("comfortable");
  }

  function setCompact() {
    density.set("compact");
  }
</script>

<div class="seg" role="group" aria-label="Dichte auswählen">
  <button
    type="button"
    class="seg-btn"
    class:active={$density === "comfortable"}
    aria-pressed={$density === "comfortable"}
    onclick={setComfortable}
  >
    Komfortabel
  </button>
  <button
    type="button"
    class="seg-btn"
    class:active={$density === "compact"}
    aria-pressed={$density === "compact"}
    onclick={setCompact}
  >
    Kompakt
  </button>
</div>

<style>
  /* Segmented control — mirrors the .seg/.seg-btn recipe from /admin/themes. */
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: var(--bg-subtle);
    border-radius: var(--r-pill);
  }
  .seg-btn {
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
</style>
