<script lang="ts">
  // 301-style redirect: per-rule edit page was replaced by an inline edit
  // modal inside /admin/vacation#sonderurlaub. Land users on the tab list.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  onMount(() => goto("/admin/vacation#sonderurlaub", { replaceState: true }));
</script>
