<script lang="ts">
  import "../tokens.css";
  import "../app.css";
  // Stores apply data-theme / data-mode / data-density / data-skin to <html> at
  // module init via their own module-scope subscribe() calls
  // (see theme.ts / mode.ts / density.ts / skin.ts).
  // Import order matters: theme BEFORE mode, because theme.ts seeds localStorage.mode
  // for legacy 'hell' / 'dunkel' users (one-time, only if no mode key exists).
  import "$stores/theme";
  import "$stores/mode";
  import "$stores/density";
  import "$stores/skin";
  // Side-effect import: ensures DE + EN i18n bundles ship in the built asset (I18N-02).
  // No runtime locale switching this milestone — DE remains active everywhere.
  import "$lib/i18n";
  import Toast from "$lib/components/ui/Toast.svelte";
  import ErrorBoundary from "$lib/components/ui/ErrorBoundary.svelte";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();
</script>

<ErrorBoundary scope="app">
  {@render children?.()}
</ErrorBoundary>
<Toast />
