<!-- Test harness (Issue #854, plan 16): owns the shared status and the change count the page owns, and shows both. -->
<script lang="ts">
  import { emptyPhorestStatus } from "$lib/settings/phorest";
  import PhorestConnectionPanel from "../PhorestConnectionPanel.svelte";
  import PhorestSyncPanel from "../PhorestSyncPanel.svelte";

  interface Props {
    panel?: "connection" | "sync";
    /** The configured flag the sync panel starts with (the connection panel learns it from the server). */
    configured?: boolean;
  }

  let { panel = "connection", configured = false }: Props = $props();

  let status = $state({ ...emptyPhorestStatus(), configured: false });
  let changes = $state(0);
  let synced = $state(0);

  // The sync panel is mounted on its own with a status the page would have received from the connection panel.
  $effect.pre(() => {
    if (panel === "sync") status.configured = configured;
  });
</script>

<p data-testid="h-configured">{status.configured}</p>
<p data-testid="h-test">{String(status.testOk)}</p>
<p data-testid="h-mapped">{status.mappedCount}/{status.staffTotal}</p>
<p data-testid="h-changes">{changes}</p>
<p data-testid="h-latest">{status.latestRun?.status ?? "none"}</p>
<p data-testid="h-synced">{synced}</p>

{#if panel === "connection"}
  <PhorestConnectionPanel bind:status bind:changes />
{:else}
  <PhorestSyncPanel bind:status onsynced={() => (synced += 1)} />
{/if}
