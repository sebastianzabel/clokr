<!--
  HomeSalonField - the required Stammsalon select of the employee create form (Issue #86, AC-86-1).

  In a tenant with more than one active salon the API refuses a new employee without a Stammsalon,
  so the field is shown and required; with one active salon the server resolves it and the field is
  not rendered at all. `salons` is null while the list is unavailable (no salon:read, or the read
  failed): no field either - a missing choice is then answered by the server's German error.

  Props:
    salons  - the tenant's salons as read from GET /salons, or null when not available
    value   - bindable salon id; "" = nothing chosen
    error   - optional message of the guided create flow (Issue #854), shown under the select
-->
<script lang="ts">
  import {
    homeSalonOptions,
    offerHomeSalonChoice,
    type SalonRef,
  } from "$lib/employees/salon-assignments";

  interface Props {
    salons: SalonRef[] | null;
    value?: string;
    error?: string;
  }

  let { salons, value = $bindable(""), error }: Props = $props();

  let options = $derived(salons === null ? [] : homeSalonOptions(salons));
  let offered = $derived(offerHomeSalonChoice(salons !== null, options.length));
</script>

{#if offered}
  <div class="form-group" data-testid="home-salon-field">
    <label class="form-label" for="c-home-salon">Stammsalon</label>
    <select
      id="c-home-salon"
      class="select"
      bind:value
      required
      aria-invalid={error ? "true" : undefined}
      aria-describedby={error ? "c-home-salon-error" : undefined}
    >
      <option value="">Bitte wählen</option>
      {#each options as salon (salon.id)}
        <option value={salon.id}>{salon.name}</option>
      {/each}
    </select>
    <p class="form-hint">
      Bei mehreren aktiven Salons ist die Angabe des Stammsalons erforderlich.
    </p>
    {#if error}
      <p class="form-error" id="c-home-salon-error">{error}</p>
    {/if}
  </div>
{/if}
