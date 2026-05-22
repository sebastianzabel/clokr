<script lang="ts">
  // Reusable Segmented Control primitive (Phase 260523-0qf, F-12/F-13).
  // Replaces ad-hoc radiogroup pill trios in AvailabilityWeekGrid and
  // AvailabilityEditModal. Uses radiogroup semantics with full keyboard nav.

  interface Option {
    value: string;
    label: string;
    glyph?: string;
    ariaLabel?: string;
  }

  interface Props {
    options: Option[];
    value?: string;
    name?: string;
    ariaLabel?: string;
    size?: "sm" | "md";
    disabled?: boolean;
    onchange?: (value: string) => void;
  }

  let {
    options,
    value = $bindable(""),
    name = "segmented-control",
    ariaLabel,
    size = "md",
    disabled = false,
    onchange,
  }: Props = $props();

  function select(v: string) {
    if (disabled) return;
    value = v;
    onchange?.(v);
  }

  function handleKeydown(e: KeyboardEvent, idx: number) {
    if (disabled) return;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (idx + 1) % options.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (idx - 1 + options.length) % options.length;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = options.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    select(options[next].value);
    // Focus the newly selected button
    const wrapper = (e.currentTarget as HTMLElement).closest('[role="radiogroup"]');
    const btns = wrapper?.querySelectorAll<HTMLButtonElement>("[role=radio]");
    btns?.[next]?.focus();
  }
</script>

<div
  class="seg-control seg-control--{size}"
  class:seg-control--disabled={disabled}
  role="radiogroup"
  aria-label={ariaLabel ?? name}
>
  {#each options as opt, idx (opt.value)}
    <button
      type="button"
      role="radio"
      aria-checked={value === opt.value}
      aria-label={opt.ariaLabel ?? opt.label}
      class="seg-btn"
      {disabled}
      tabindex={value === opt.value ? 0 : -1}
      onclick={() => select(opt.value)}
      onkeydown={(e) => handleKeydown(e, idx)}
    >
      {#if opt.glyph}
        <span class="seg-glyph" aria-hidden="true">{opt.glyph}</span>
      {/if}
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .seg-control {
    display: inline-flex;
    padding: 2px;
    gap: 0;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }

  .seg-control--disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .seg-btn {
    background: transparent;
    color: var(--text-muted);
    border: 0;
    border-radius: calc(var(--r-md) - 2px);
    font-weight: 500;
    cursor: pointer;
    transition:
      background 120ms,
      color 120ms;
    white-space: nowrap;
  }

  .seg-control--sm .seg-btn {
    padding: 6px 12px;
    font-size: 0.8125rem;
  }

  .seg-control--md .seg-btn {
    padding: 8px 16px;
    font-size: 0.875rem;
  }

  .seg-btn[aria-checked="true"] {
    background: var(--bg-card);
    color: var(--text);
    box-shadow: var(--shadow-sm);
    font-weight: 600;
  }

  .seg-btn:not([aria-checked="true"]):hover {
    color: var(--text);
  }

  .seg-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }

  .seg-glyph {
    margin-right: 4px;
    font-style: normal;
  }

  /* WCAG 2.5.5 — 44px min hit target on touch devices */
  @media (pointer: coarse) {
    .seg-btn {
      min-height: 44px;
    }
  }
</style>
