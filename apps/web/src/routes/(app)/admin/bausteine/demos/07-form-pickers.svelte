<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 7, the pickers. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 7,
    name: "Formular-Satz",
    entries: ["components/ui/Combobox.svelte", "components/ui/DatePicker.svelte"],
  };
</script>

<script lang="ts">
  import FormField from "$components/ui/FormField.svelte";
  import Combobox from "$components/ui/Combobox.svelte";
  import DatePicker from "$components/ui/DatePicker.svelte";

  const salons = [
    { value: "nord", label: "Salon Nord" },
    { value: "sued", label: "Salon Süd" },
    { value: "ost", label: "Salon Ost" },
    { value: "west", label: "Salon West" },
    { value: "mitte", label: "Salon Mitte" },
  ];

  let salon = $state("sued");
  let start = $state<string | null>("2026-11-01");
</script>

<div data-block="7" class="form-pickers-demo">
  <FormField label="Stammsalon" help="Tippen filtert die Liste.">
    {#snippet field({ id, describedBy, invalid })}
      <Combobox items={salons} bind:value={salon} {id} {describedBy} {invalid} />
    {/snippet}
  </FormField>

  <FormField label="Eintrittsdatum">
    {#snippet field({ id, describedBy, invalid })}
      <DatePicker label="Eintrittsdatum" bind:value={start} {id} {describedBy} {invalid} />
    {/snippet}
  </FormField>
</div>

<style>
  .form-pickers-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
