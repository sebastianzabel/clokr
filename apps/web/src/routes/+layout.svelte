<script lang="ts">
  import "../app.css";
  import { theme } from "$stores/theme";

  // Importing the store initializes its subscription, which applies
  // data-theme to <html> and persists the value to localStorage.
  theme.subscribe(() => {});

  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();
</script>

{@render children?.()}
