<script lang="ts">
  // The one error boundary. Placed twice (D-01 around the page content in (app),
  // D-02 around everything in the root layout) with a different `scope` each time.
  // A boundary makes a failure visible; it does not repair it — hence the honest
  // wording and a reload as the only offered action (D-04).
  //
  // Issue #161: Svelte keeps a boundary's failed state until the boundary is created anew,
  // and an in-app navigation only swaps its children. So the boundary resets itself when the
  // path changes — the view message promises that the other areas stay reachable through the
  // navigation, and without the reset the failure view survived every navigation. If the new
  // page throws too, the boundary simply fails again. Resetting here (not with a `{#key}`
  // in the layout) leaves the boundary's pinned position in both layouts unchanged.
  import { page } from "$app/stores";
  import { clientLogger } from "$lib/utils/logger";
  import Note from "./Note.svelte";

  interface Props {
    scope: "view" | "app";
    children?: import("svelte").Snippet;
  }

  let { scope, children }: Props = $props();

  const MESSAGES = {
    view: {
      title: "Diese Ansicht konnte nicht geladen werden.",
      detail:
        "Der Fehler wurde protokolliert. Über die Navigation erreichst du alle anderen Bereiche weiterhin.",
    },
    app: {
      title: "Die Anwendung konnte nicht geladen werden.",
      detail: "Der Fehler wurde protokolliert. Bitte lade die Seite neu.",
    },
  } as const;

  let message = $derived(MESSAGES[scope]);

  // The reset of the current failure and the path it happened on; null while nothing failed.
  let pendingReset = $state<{ reset: () => void; path: string } | null>(null);

  $effect(() => {
    const path = $page.url.pathname;
    if (pendingReset && path !== pendingReset.path) {
      const { reset } = pendingReset;
      pendingReset = null;
      reset();
    }
  });

  function handleError(error: unknown, reset: () => void) {
    pendingReset = { reset, path: $page.url.pathname };

    // D-06: keep the raw Error — and its clickable stack — in the dev console. A
    // boundary that hides the stack trades one diagnosis problem for another.
    if (import.meta.env.DEV) console.error("[clokr] svelte:boundary", scope, error);

    const err = error instanceof Error ? error : undefined;
    clientLogger.error(`Render-Fehler (${scope}): ${err?.message ?? String(error)}`, {
      stack: err?.stack,
      boundary: scope,
    });
  }

  function reload() {
    window.location.reload();
  }
</script>

<svelte:boundary onerror={handleError}>
  {@render children?.()}

  {#snippet failed()}
    <!-- #855 (D-855-07): the failure view is the error state of the design system — a bad Note with
         the reason and the one action a boundary can honestly offer. -->
    <div class="boundary-failed boundary-failed--{scope}" role="alert" data-boundary-failed={scope}>
      <Note tone="bad"><b>{message.title}</b> {message.detail}</Note>
      <button type="button" class="btn btn-secondary btn-sm" onclick={reload}
        >Seite neu laden</button
      >
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .boundary-failed {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
  }

  /* The app scope has no shell around it: centre the view on the page ground. */
  .boundary-failed--app {
    max-width: 520px;
    margin: var(--s-16) auto;
    padding: 0 var(--s-4);
  }
</style>
