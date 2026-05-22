<script lang="ts">
  // Phase 46 — small primitive rendering one of the four availability pill variants.
  // Used inside AvailabilityWeekGrid (radio-button mode), AvailabilityOneOffList
  // (display mode), and AvailabilityEditModal (radio-button mode).
  //
  // German status labels are verbatim per 46-UI-SPEC §Copywriting:
  //   AVAILABLE   → "Verfügbar"
  //   UNAVAILABLE → "Nicht verfügbar"
  //   PREFERRED   → "Bevorzugt"
  //
  // WCAG 1.4.1: color is never the only indicator — the unicode glyph
  // (✓ / ✕ / ★ / ○) is always rendered alongside the colored background.

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED" | null;

  interface Props {
    status: Status;
    /** When true, hide the visible label and show glyph only (e.g. dense rows). */
    compact?: boolean;
    /** "span" = display-only pill, "button" = interactive (radio group). */
    as?: "span" | "button";
    /** Only meaningful for as="button" — false renders the pill as the inactive (default) variant. */
    selected?: boolean;
    /** Override the default German aria-label. */
    ariaLabel?: string;
    /** Click handler (forwarded only for as="button"). */
    onclick?: (e: MouseEvent) => void;
  }

  let {
    status,
    compact = false,
    as = "span",
    selected = true,
    ariaLabel,
    onclick,
  }: Props = $props();

  type Meta = { className: string; glyph: string; label: string };

  const META: Record<"AVAILABLE" | "UNAVAILABLE" | "PREFERRED" | "DEFAULT", Meta> = {
    AVAILABLE: { className: "av-pill--available", glyph: "✓", label: "Verfügbar" },
    UNAVAILABLE: { className: "av-pill--unavailable", glyph: "✕", label: "Nicht verfügbar" },
    PREFERRED: { className: "av-pill--preferred", glyph: "★", label: "Bevorzugt" },
    DEFAULT: { className: "av-pill--default", glyph: "○", label: "" },
  };

  const meta = $derived<Meta>(status == null ? META.DEFAULT : META[status]);

  // For radio-button mode: if not selected, render as inactive default pill regardless of status.
  const effectiveClass = $derived(
    as === "button" && selected === false ? META.DEFAULT.className : meta.className,
  );

  const effectiveAriaLabel = $derived(ariaLabel ?? (meta.label || "Kein Status"));
</script>

{#if as === "button"}
  <button
    type="button"
    class="av-pill {effectiveClass}"
    role="radio"
    aria-checked={selected}
    aria-label={effectiveAriaLabel}
    {onclick}
  >
    <span aria-hidden="true">{meta.glyph}</span>
    {#if !compact && meta.label}
      <span>{meta.label}</span>
    {/if}
  </button>
{:else}
  <span class="av-pill {meta.className}" aria-label={effectiveAriaLabel}>
    <span aria-hidden="true">{meta.glyph}</span>
    {#if !compact && meta.label}
      <span>{meta.label}</span>
    {/if}
  </span>
{/if}
