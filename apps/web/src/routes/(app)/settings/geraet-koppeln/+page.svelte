<!--
  Issue #610 (D-11, P-610-20): the landing page of the salon QR code.

  The adapter's redirect puts the one-time pairing code in the query string. It is read ONCE here and
  handed to the component, which sends it to the API only in a JSON body. Once the preview request has
  settled, `onCodeHandled` takes the query out of the address bar with `replaceState`, so the code does
  not linger in the history entry (the client error log posts the path only). It must not happen
  earlier: a stale session's forced re-login carries the current location, and the code has to survive
  that round trip. The call goes through `stripCodeFromAddress`: it is skipped when the URL has no code
  and deferred past the first hydration, because `replaceState` throws before the router is ready
  (review WR-06).
-->
<script lang="ts">
  import { get } from "svelte/store";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";

  import PageHead from "$components/layout/PageHead.svelte";
  import DevicePairing from "$components/settings/DevicePairing.svelte";
  import { stripCodeFromAddress } from "$lib/presence/strip-code";

  // Read once at start, not reactive: the address bar loses the code after the preview.
  const code = get(page).url.searchParams.get("code");

  function onCodeHandled() {
    void stripCodeFromAddress({
      hasCode: () => get(page).url.searchParams.has("code"),
      strip: () => replaceState("/settings/geraet-koppeln", {}),
    });
  }
</script>

<svelte:head><title>Handy koppeln – Clokr</title></svelte:head>

<div class="pairing-page">
  <PageHead
    eyebrow="Mein Bereich"
    title="Handy koppeln"
    accent="koppeln"
    sub="Dein Handy im Salon-WLAN erkennen lassen"
  />
  <DevicePairing {code} {onCodeHandled} />
</div>

<style>
  .pairing-page {
    max-width: 560px;
  }
</style>
