<!--
  Test harness for OpeningHoursEditor (Issue #563): binds `days` like the salon page does and
  mirrors the bound value into the DOM so a test can read what the editor wrote back.
-->
<script lang="ts">
  import OpeningHoursEditor from "$lib/components/admin/OpeningHoursEditor.svelte";
  import { prefillOpeningHours, type OpeningHoursDay } from "$lib/salons/opening-hours";

  interface Props {
    disabled?: boolean;
    errors?: Record<number, string>;
    initial?: OpeningHoursDay[];
  }

  let { disabled = false, errors = {}, initial }: Props = $props();

  // The initial week is read once on purpose: afterwards the editor owns the bound value.
  // svelte-ignore state_referenced_locally
  let days = $state<OpeningHoursDay[]>(initial ?? prefillOpeningHours(null));
</script>

<OpeningHoursEditor bind:days {disabled} {errors} idPrefix="harness" />
<pre data-testid="bound-days">{JSON.stringify(days)}</pre>
