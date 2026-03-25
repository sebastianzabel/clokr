<script lang="ts">
  import Settings from "./lib/Settings.svelte";
</script>

<main>
  <Settings />
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
  }

  main {
    padding: 1.5rem;
    max-width: 480px;
    margin: 0 auto;
  }
</style>
