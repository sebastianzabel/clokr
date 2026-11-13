<script lang="ts">
  // The company shutdown list is the „Betriebsurlaub“ tab of Verwalten › Regeln › Abwesenheiten since #854; this
  // stub covers the old URL (/admin/shutdowns) and the table URL of the detail's parent
  // (/verwalten/regeln/betriebsurlaub). A shutdown's detail stays a sub-route below this directory.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";

  onMount(() => goto("/verwalten/regeln/abwesenheiten#betriebsurlaub", { replaceState: true }));
</script>
