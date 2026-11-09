<!--
  Issue #82 (D-12): the active salon selection in the Topbar. Presentation only — the server decides
  every request (DSGVO Art. 32); hiding this control is never an access control. An instant-apply
  view filter (docs/ADMIN_STRUCTURE.md §3.2.1, atomic single value), rendered only when the #64 rule
  in `showSalonOptions()` says so.
-->
<script lang="ts">
  import { ALL_SALONS, salonContext, showSalonOptions } from "$stores/salon-context";
  import Icon from "$lib/components/Icon.svelte";

  let visible = $derived(showSalonOptions($salonContext));
  let value = $derived($salonContext.selection ?? ALL_SALONS);

  function handleChange(event: Event & { currentTarget: HTMLSelectElement }) {
    salonContext.setSelection(event.currentTarget.value);
  }
</script>

{#if visible}
  <label class="salon-switcher">
    <span class="salon-switcher-label">Salon</span>
    <span class="salon-switcher-field">
      <span class="salon-switcher-icon" aria-hidden="true"><Icon name="store" size={15} /></span>
      <select class="select filter-select salon-switcher-select" {value} onchange={handleChange}>
        <option value={ALL_SALONS}>Alle Salons</option>
        {#each $salonContext.salons as salon (salon.id)}
          <option value={salon.id}>{salon.name}</option>
        {/each}
      </select>
    </span>
  </label>
{/if}

<style>
  .salon-switcher {
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
  /* Visually hidden, still the accessible name of the select (the pill shows the icon instead). */
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
  /* #844: the salon pill of design concept § 2 — icon, name, chevron; the native select keeps the keyboard
     and screen-reader behaviour. */
  .salon-switcher-field {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
  .salon-switcher-icon {
    position: absolute;
    left: 11px;
    display: inline-flex;
    color: var(--brand);
    pointer-events: none;
  }
  .salon-switcher-field::after {
    content: "";
    position: absolute;
    right: 12px;
    top: 50%;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid var(--text-2);
    border-bottom: 1.5px solid var(--text-2);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  .salon-switcher-select {
    max-width: 220px;
    height: 32px;
    min-height: 32px;
    padding: 0 30px 0 32px;
    border-radius: var(--r-pill);
    background: var(--sunk);
    border: 1px solid var(--line);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text);
    text-overflow: ellipsis;
  }
  @media (max-width: 720px) {
    .salon-switcher-select {
      max-width: 160px;
    }
  }
  @media (max-width: 640px) {
    /* WCAG 2.5.5 touch target on phones */
    .salon-switcher-select {
      height: 44px;
      min-height: 44px;
    }
  }
</style>
