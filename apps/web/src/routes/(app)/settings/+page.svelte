<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  onMount(() => goto("/admin/vacation", { replaceState: true }));
</script>
