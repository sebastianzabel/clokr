<!--
  Issue #610 (D-11, P-610-20): "Handy koppeln" - the page a signed-in person lands on after scanning
  the salon QR code.

  The code arrives as a prop (the route reads it from the address bar once). It goes to the API only
  in the JSON body of the preview and the confirm request, never in an API URL, and it stays only in
  this component's state. `onCodeHandled` fires once, as soon as the preview request has settled in
  any way, so the route can take the code out of the address bar. The one button is the consent: the
  mapping is made only by that tap of the signed-in person (only `confirmPairing` sends the consent flag).
  Hostnames and server messages are rendered as plain text interpolation, never as markup.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import { confirmPairing, previewPairing, type PairingPreview } from "$lib/api/presence";
  import {
    ALREADY_PAIRED_TEXT,
    CONSENT_TEXT,
    ERROR_TEXT,
    MISSING_CODE_TEXT,
    REPLACES_DEVICE_TEXT,
    SUCCESS_TEXT,
    deviceLabelText,
    isWellFormedPairingCode,
    macTailLabel,
    pairingFailure,
  } from "$lib/presence/pairing-view";
  import Card from "$components/ui/Card.svelte";

  interface Props {
    code: string | null;
    onCodeHandled?: () => void;
  }

  let { code, onCodeHandled }: Props = $props();

  type View = "loading" | "ready" | "success" | "invalid" | "taken" | "error";

  // The code is read once at mount: the route strips it from the address bar after the preview.
  // svelte-ignore state_referenced_locally
  const pairingCode: string | null = isWellFormedPairingCode(code) ? code : null;

  let view = $state<View>("loading");
  let preview = $state<PairingPreview | null>(null);
  let message = $state("");
  // Which request a retry repeats.
  let failedStage = $state<"preview" | "confirm">("preview");
  let submitting = $state(false);
  let handled = false;

  function codeHandled() {
    if (handled) return;
    handled = true;
    onCodeHandled?.();
  }

  async function loadPreview() {
    if (pairingCode === null) return;
    view = "loading";
    try {
      preview = await previewPairing(pairingCode);
      view = "ready";
    } catch (error) {
      const failure = pairingFailure(error);
      if (failure.kind === "invalid") {
        message = failure.message;
        view = "invalid";
      } else {
        failedStage = "preview";
        view = "error";
      }
    } finally {
      // After ANY outcome of the first preview: the code must not linger in the address bar.
      codeHandled();
    }
  }

  async function confirm() {
    if (pairingCode === null || submitting) return;
    submitting = true;
    try {
      await confirmPairing(pairingCode);
      view = "success";
    } catch (error) {
      const failure = pairingFailure(error);
      if (failure.kind === "invalid" || failure.kind === "taken") {
        message = failure.message;
        view = failure.kind;
      } else {
        failedStage = "confirm";
        view = "error";
      }
    } finally {
      submitting = false;
    }
  }

  function retry() {
    if (failedStage === "preview") void loadPreview();
    else void confirm();
  }

  onMount(() => {
    if (pairingCode === null) {
      codeHandled();
      return;
    }
    void loadPreview();
  });

  // The consent text stays next to the button that sends it, also when a retry is offered.
  const showForm = $derived(
    preview !== null && (view === "ready" || (view === "error" && failedStage === "confirm")),
  );
</script>

<Card class="pairing-card">
  <h2 class="section-title">Handy koppeln</h2>

  <div class="pairing-status" aria-live="polite">
    {#if pairingCode === null}
      <div class="callout error" role="alert" data-testid="pairing-missing">
        <p>{MISSING_CODE_TEXT}</p>
      </div>
    {:else if view === "loading"}
      <p class="text-muted" data-testid="pairing-loading">Einen Moment …</p>
    {:else if view === "invalid" || view === "taken"}
      <div class="callout error" role="alert" data-testid={`pairing-${view}`}>
        <p>{message}</p>
      </div>
    {:else if view === "success"}
      <div class="alert alert-success" data-testid="pairing-success">
        <span>{SUCCESS_TEXT}</span>
      </div>
      <p class="pairing-next"><a href="/settings">Zu meinem Profil</a></p>
    {:else if view === "error"}
      <div class="callout error" role="alert" data-testid="pairing-error">
        <p>{ERROR_TEXT}</p>
      </div>
      {#if !showForm}
        <div class="pairing-actions">
          <button type="button" class="btn btn-secondary" onclick={retry}>Erneut versuchen</button>
        </div>
      {/if}
    {/if}
  </div>

  {#if showForm && preview}
    <div class="pairing-device">
      <p class="pairing-device-name">
        <strong>{deviceLabelText(preview.deviceLabel)}</strong>
        <span class="badge" data-testid="pairing-mac-tail">{macTailLabel(preview.macTail)}</span>
      </p>
      {#if preview.replacesDevice}
        <p class="text-muted pairing-note">{REPLACES_DEVICE_TEXT}</p>
      {/if}
      {#if preview.alreadyPaired}
        <p class="text-muted pairing-note">{ALREADY_PAIRED_TEXT}</p>
      {/if}
    </div>

    <p class="form-hint pairing-consent">{CONSENT_TEXT}</p>

    <div class="pairing-actions">
      {#if view === "error"}
        <button type="button" class="btn btn-primary" onclick={retry} disabled={submitting}>
          Erneut versuchen
        </button>
      {:else}
        <button type="button" class="btn btn-primary" onclick={confirm} disabled={submitting}>
          Das ist mein Handy – koppeln
        </button>
      {/if}
    </div>
  {/if}
</Card>

<style>
  .section-title {
    font-size: 1.125rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  .pairing-status {
    margin-bottom: 0.75rem;
  }
  .pairing-device {
    margin: 0.75rem 0;
  }
  .pairing-device-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 1rem;
    margin: 0 0 0.25rem;
  }
  .pairing-note {
    font-size: 0.875rem;
    margin: 0.25rem 0;
  }
  .pairing-consent {
    margin: 0.75rem 0;
  }
  .pairing-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .pairing-actions .btn {
    min-height: 44px;
  }
  .pairing-next {
    margin-top: 0.75rem;
  }
</style>
