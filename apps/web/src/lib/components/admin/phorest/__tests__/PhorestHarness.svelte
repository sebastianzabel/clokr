<!-- Test harness (Issue #854, plan 16): owns the shared status and the change count the page owns, and shows both. -->
<script lang="ts">
  import { emptyPhorestStatus } from "$lib/settings/phorest";
  import PhorestConnectionPanel from "../PhorestConnectionPanel.svelte";

  let status = $state(emptyPhorestStatus());
  let changes = $state(0);
</script>

<p data-testid="h-configured">{status.configured}</p>
<p data-testid="h-test">{String(status.testOk)}</p>
<p data-testid="h-mapped">{status.mappedCount}/{status.staffTotal}</p>
<p data-testid="h-changes">{changes}</p>

<PhorestConnectionPanel bind:status bind:changes />
