<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 7. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 7,
    name: "Formular-Satz",
    entries: [
      "components/ui/FormField.svelte",
      "components/ui/SaveBar.svelte",
      "components/ui/SegmentedControl.svelte",
      "components/ui/DayGrid.svelte",
    ],
  };
</script>

<script lang="ts">
  import FormField from "$components/ui/FormField.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import DayGrid from "$components/ui/DayGrid.svelte";
  import type { DayHours } from "$components/ui/DayGrid.svelte";

  let position = $state("Stylistin");
  let weeklyHours = $state("abc");
  let schedule = $state("fixed");
  let days = $state<DayHours>({ mon: 8, tue: 8, wed: 8, thu: 8, fri: 7.5, sat: 0, sun: 0 });
</script>

<div data-block="7" class="form-set-demo">
  <FormField label="Funktion" help="So steht sie im Vertrag.">
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        bind:value={position}
        aria-describedby={describedBy}
        aria-invalid={invalid ? "true" : undefined}
      />
    {/snippet}
  </FormField>

  <FormField
    label="Wochenstunden"
    error="Gib die Stunden als Zahl ein, zum Beispiel 39,5."
    required
  >
    {#snippet field({ id, describedBy, invalid })}
      <input
        {id}
        class="form-input"
        type="text"
        inputmode="decimal"
        bind:value={weeklyHours}
        aria-describedby={describedBy}
        aria-invalid={invalid ? "true" : undefined}
      />
    {/snippet}
  </FormField>

  <SegmentedControl
    name="demo-schedule"
    ariaLabel="Arbeitszeitmodell"
    options={[
      { value: "fixed", label: "Feste Zeiten" },
      { value: "flex", label: "Gleitzeit" },
      { value: "shift", label: "Schichten" },
    ]}
    bind:value={schedule}
  />

  <DayGrid label="Stunden je Wochentag" bind:value={days} />

  <SaveBar
    changes={2}
    errors={1}
    saveLabel="Vertrag speichern"
    onSave={() => {}}
    onDiscard={() => {}}
  />
</div>

<style>
  .form-set-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
