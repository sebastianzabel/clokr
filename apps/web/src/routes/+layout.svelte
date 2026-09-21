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
  import { onMount } from "svelte";
  import { clientLogger } from "$lib/utils/logger";

  interface Props {
    children?: import("svelte").Snippet;
  }

  let { children }: Props = $props();

  // Global error handlers belong in the ROOT layout (issue #149): installing them in
  // `(app)/+layout.svelte` left every `(auth)` page — login, OTP, invitation, password
  // reset — without a `window.onerror` / `unhandledrejection` handler. `install()` is
  // idempotent, so an extra call from a nested layout stays harmless.
  onMount(() => {
    clientLogger.install();
  });
</script>

<ErrorBoundary scope="app">
  {@render children?.()}
</ErrorBoundary>
<Toast />
