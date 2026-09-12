<script lang="ts">
  // The one error boundary. Placed twice (D-01 around the page content in (app),
  // D-02 around everything in the root layout) with a different `scope` each time.
  // A boundary makes a failure visible; it does not repair it — hence the honest
  // wording and a reload as the only offered action (D-04).
  import { clientLogger } from "$lib/utils/logger";

  interface Props {
    scope: "view" | "app";
    children?: import("svelte").Snippet;
  }

  let { scope, children }: Props = $props();

  const MESSAGES = {
    view: {
      title: "Diese Ansicht konnte nicht geladen werden.",
      detail:
        "Der Fehler wurde protokolliert. Über die Navigation erreichen Sie alle anderen Bereiche weiterhin.",
    },
    app: {
      title: "Die Anwendung konnte nicht geladen werden.",
      detail: "Der Fehler wurde protokolliert. Bitte laden Sie die Seite neu.",
    },
  } as const;

  let message = $derived(MESSAGES[scope]);

  function handleError(error: unknown) {
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
    <div class="callout error" role="alert">
      <div>
        <b>{message.title}</b>
        <p>{message.detail}</p>
        <button type="button" class="btn btn-outline btn-sm" onclick={reload}
          >Seite neu laden</button
        >
      </div>
    </div>
  {/snippet}
</svelte:boundary>
