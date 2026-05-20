<script lang="ts">
  interface Props {
    /** Optional pixel size for the SVG (default 14). */
    size?: number;
    /** Accessible label for assistive tech. */
    label?: string;
  }

  let { size = 14, label = "Wird geladen" }: Props = $props();
</script>

<!--
  Tiny inline spinner used inside buttons (e.g. "<Spinner /> Speichern").
  Respects prefers-reduced-motion by switching to a static dot.
-->
<span class="spinner" role="status" aria-label={label} style="--spinner-size: {size}px;">
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="3"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
</span>

<style>
  .spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--spinner-size, 14px);
    height: var(--spinner-size, 14px);
    color: currentColor;
    flex-shrink: 0;
  }

  .spinner svg {
    animation: spinner-rotate 800ms linear infinite;
  }

  @keyframes spinner-rotate {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner svg {
      animation: none;
      opacity: 0.5;
    }
  }
</style>
