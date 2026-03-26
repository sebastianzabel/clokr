<script lang="ts">
  import "../app.css";
  import { theme } from "$stores/theme";
  import Toast from "$lib/components/ui/Toast.svelte";

  // Importing the store initializes its subscription, which applies
  // data-theme to <html> and persists the value to localStorage.
  theme.subscribe(() => {});

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();
</script>

{@render children?.()}
<Toast />
