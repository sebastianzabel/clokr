<script lang="ts">
  // Issue #558 D-04 — the one shared "what do these figures refer to" label of every salon-filtered
  // page, plus the calm text shown when the server rejects the chosen salon (404). Presentation
  // only: the page decides the label through `salonScopeLabel()` and passes the rejection in.
  // Mountable: no `$app` import, no request.
  import { SALON_VIEW_UNAVAILABLE_TEXT } from "$lib/salons/page-scope";

  interface Props {
    /** „Salon: <Name>“ / „Alle Salons“; null while no salon options are shown. */
    label: string | null;
    /** The server answered the one 404 for the chosen salon. */
    rejected?: boolean;
  }

  let { label, rejected = false }: Props = $props();
</script>

{#if label !== null}
  <p class="salon-scope-label" data-testid="salon-scope-label">{label}</p>
{/if}
{#if rejected}
  <!-- Informational variant: a rejected salon is a calm hint, not a warning (D-04). -->
  <div class="callout brand salon-scope-calm" role="status" data-testid="salon-scope-unavailable">
    <p>{SALON_VIEW_UNAVAILABLE_TEXT}</p>
  </div>
{/if}

<style>
  .salon-scope-label {
    /* Own bottom spacing: the label is a stand-alone line and must not touch the next block. */
    margin: 0 0 var(--s-3);
    color: var(--text-muted);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  /* The brand variant keeps the informational tint; its own text colour is --brand-light in dark
     mode, 3.66:1 on the tint (measured, 558-06), so the text takes the body colour instead. The
     selector out-ranks the global `[data-mode="dark"] .callout.brand` rule on purpose. */
  .callout.salon-scope-calm {
    margin-bottom: var(--s-3);
    color: var(--text);
  }
</style>
