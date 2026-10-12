<!--
  Issue #87 (D-05, D-13): the salon selector of the clock card. Presentation only — the server
  decides whether a choice is offered, which salon is preselected and which salon a booked day is
  fixed to; hiding or showing this control is never an access control. Choosing a salon other than
  the preselected one is not marked in any way (AC-5).
-->
<script lang="ts">
  import type { ClockSalonView } from "$lib/dashboard/clock-salon";

  interface Props {
    view: ClockSalonView;
    value: string | null;
    disabled?: boolean;
    onselect: (salonId: string) => void;
  }

  let { view, value, disabled = false, onselect }: Props = $props();

  function handleChange(event: Event & { currentTarget: HTMLSelectElement }) {
    onselect(event.currentTarget.value);
  }
</script>

{#if view.kind === "select"}
  <label class="clock-salon">
    <span class="clock-salon-label">Salon</span>
    <span class="clock-salon-field">
      <select
        class="select filter-select clock-salon-select"
        value={value ?? ""}
        {disabled}
        onchange={handleChange}
      >
        {#if value === null}
          <option value="" disabled>Salon wählen</option>
        {/if}
        {#each view.salons as salon (salon.id)}
          <option value={salon.id}>{salon.name}</option>
        {/each}
      </select>
    </span>
  </label>
{:else if view.kind === "fixed"}
  <p class="clock-salon-note">Heute erfasst in {view.salon.name}</p>
{/if}

<style>
  .clock-salon {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
  }
  .clock-salon-label {
    font-family: var(--font-sans);
    font-size: 13px;
    color: inherit;
    opacity: 0.85;
    white-space: nowrap;
  }
  .clock-salon-field {
    position: relative;
    display: inline-flex;
    min-width: 0;
    flex: 1 1 auto;
  }
  /* The global .select recipe draws no chevron; the control shows its own to read as a choice. */
  .clock-salon-field::after {
    content: "";
    position: absolute;
    right: 12px;
    top: 50%;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid var(--text-muted);
    border-bottom: 1.5px solid var(--text-muted);
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
  }
  .clock-salon-select {
    width: 100%;
    max-width: 220px;
    min-height: 40px;
    padding: 0.375rem 2rem 0.375rem 0.75rem;
    font-size: 14px;
    text-overflow: ellipsis;
  }
  .clock-salon-note {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 13px;
    color: inherit;
    opacity: 0.85;
  }
  @media (max-width: 640px) {
    .clock-salon {
      width: 100%;
    }
    .clock-salon-select {
      max-width: none;
      min-height: 44px;
    }
  }
</style>
