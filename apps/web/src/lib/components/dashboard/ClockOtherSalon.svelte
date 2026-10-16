<!--
  Issue #70 (D-02/D-11): the finished-day action „In anderem Salon einstempeln“. Presentation only —
  the server decides whether a second salon may be chosen and which salons are offered (clockSalonChoice);
  this control reveals the offered salons and reports the choice. It starts a NEW entry in that salon,
  it never reopens the finished one (that is „Erneut einstempeln“, which carries no salon).
-->
<script lang="ts">
  import ClockSalonSelect from "./ClockSalonSelect.svelte";
  import type { ClockSalonOption } from "$lib/dashboard/clock-salon";

  interface Props {
    /** The salons the server offers for a second entry; the control renders nothing when empty. */
    salons: ClockSalonOption[];
    value: string | null;
    disabled?: boolean;
    /** True while the clock-in request is in flight. */
    loading?: boolean;
    /** True while no offered salon is selected. */
    blocked?: boolean;
    onselect: (salonId: string) => void;
    onstart: () => void;
  }

  let {
    salons,
    value,
    disabled = false,
    loading = false,
    blocked = false,
    onselect,
    onstart,
  }: Props = $props();

  let open = $state(false);
</script>

{#if salons.length > 0}
  {#if open}
    <div class="other-salon">
      <ClockSalonSelect view={{ kind: "select", salons }} {value} {disabled} {onselect} />
      <div class="other-salon-actions">
        <button
          type="button"
          class="btn timer-cta-primary"
          disabled={disabled || blocked}
          onclick={onstart}
        >
          {#if loading}<span class="btn-spinner"></span>{/if}
          Einstempeln
        </button>
        <button
          type="button"
          class="btn btn-ghost timer-cta-ghost"
          {disabled}
          onclick={() => (open = false)}
        >
          Abbrechen
        </button>
      </div>
    </div>
  {:else}
    <button
      type="button"
      class="btn btn-ghost timer-cta-ghost"
      aria-expanded="false"
      {disabled}
      onclick={() => (open = true)}
      title="Neuen Eintrag in einem anderen Salon beginnen — der abgeschlossene Eintrag bleibt unverändert"
    >
      In anderem Salon einstempeln
    </button>
  {/if}
{/if}

<style>
  .other-salon {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    max-width: 100%;
  }
  .other-salon-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  @media (max-width: 600px) {
    .other-salon {
      width: 100%;
    }
    .other-salon-actions {
      flex-direction: column;
    }
  }
</style>
