<script lang="ts">
  // The old admin landing page: since #844 its URL redirects to Verwalten › Übersicht in routes/(app)/+layout.ts;
  // this stub only covers a client navigation that reaches the file without passing that load.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  onMount(() => goto("/verwalten", { replaceState: true }));
</script>
