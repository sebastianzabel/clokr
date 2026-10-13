<!-- Test host: binds the editor's days so a test can read what the editor wrote back. -->
<script lang="ts">
  import { validateOpeningHours } from "$lib/operator/opening-hours";
  import type { OpeningHoursDay } from "$lib/operator/types";
  import OpeningHoursEditor from "../OpeningHoursEditor.svelte";

  interface Props {
    initial: OpeningHoursDay[];
    onChange: (days: OpeningHoursDay[]) => void;
  }

  let { initial, onChange }: Props = $props();
  // svelte-ignore state_referenced_locally
  let days = $state(initial);
  const errors = $derived(validateOpeningHours(days));

  $effect(() => {
    onChange($state.snapshot(days) as OpeningHoursDay[]);
  });
</script>

<OpeningHoursEditor bind:days {errors} />
