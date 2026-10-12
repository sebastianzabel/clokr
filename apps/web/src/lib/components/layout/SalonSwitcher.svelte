<!--
  Issue #82 (D-12): the active salon selection in the Topbar. Presentation only — the server decides
  every request (DSGVO Art. 32); hiding this control is never an access control. An instant-apply
  view filter (docs/ADMIN_STRUCTURE.md §3.2.1, atomic single value), rendered only when the #64 rule
  in `showSalonOptions()` says so.
-->
<script lang="ts">
  import { ALL_SALONS, salonContext, showSalonOptions } from "$stores/salon-context";

  let visible = $derived(showSalonOptions($salonContext));
  let value = $derived($salonContext.selection ?? ALL_SALONS);

  function handleChange(event: Event & { currentTarget: HTMLSelectElement }) {
    salonContext.setSelection(event.currentTarget.value);
  }
</script>

{#if visible}
  <label class="salon-switcher">
    <span class="salon-switcher-label">Salon</span>
    <select class="select filter-select salon-switcher-select" {value} onchange={handleChange}>
      <option value={ALL_SALONS}>Alle Salons</option>
      {#each $salonContext.salons as salon (salon.id)}
        <option value={salon.id}>{salon.name}</option>
      {/each}
    </select>
  </label>
{/if}

<style>
  .salon-switcher {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .salon-switcher-label {
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .salon-switcher-select {
    max-width: 220px;
    min-height: 36px;
    padding: 0.375rem 0.75rem;
    font-size: 14px;
    text-overflow: ellipsis;
  }
  @media (max-width: 720px) {
    /* Visually hidden, still the accessible name of the select. */
    .salon-switcher-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .salon-switcher-select {
      max-width: 160px;
    }
  }
  @media (max-width: 640px) {
    .salon-switcher-select {
      min-height: 44px;
    }
  }
</style>
