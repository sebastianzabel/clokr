<!--
  PairingGuide - the admin's setup help for coupling staff phones to the salon WLAN by QR code
  (Issue #610, D-13 revised, AC-1, AC-6, P-610-22).

  The admin types the LAN address and the pairing port of the FRITZ!Box adapter; the page builds
  http://<ip>:<port>/koppeln from it and draws a printable QR code. Everything happens in the
  browser: the address is local component state, it is neither stored nor sent anywhere, and this
  component imports no API client and no router. The QR is ONE own <path> inside an <svg> (the
  matrix comes from $lib/presence/qr-svg.ts); no markup string is injected.
-->
<script lang="ts">
  import {
    DEFAULT_PAIRING_PORT,
    pairingUrlFor,
    pairingUrlMessage,
  } from "$lib/presence/pairing-url";
  import { qrPathFor } from "$lib/presence/qr-svg";

  let address = $state("");
  let port = $state(DEFAULT_PAIRING_PORT);

  const result = $derived(pairingUrlFor(address, port));
  // No address typed yet: neither a QR nor an error.
  const touched = $derived(address.trim() !== "");
  const qr = $derived(result.ok ? qrPathFor(result.url) : null);
  const refusal = $derived(touched && !result.ok ? result.reason : null);
  const addressMessage = $derived(
    refusal && refusal !== "INVALID_PORT" ? pairingUrlMessage(refusal) : "",
  );
  const portMessage = $derived(refusal === "INVALID_PORT" ? pairingUrlMessage(refusal) : "");
</script>

<div class="pairing-guide">
  <div class="pairing-fields">
    <div class="form-group pairing-address">
      <label class="form-label" for="pairing-address">Adresse des Adapters im Salon-WLAN</label>
      <input
        id="pairing-address"
        class="form-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        placeholder="z. B. 192.168.178.20"
        bind:value={address}
        aria-invalid={addressMessage ? "true" : undefined}
        aria-describedby={addressMessage ? "pairing-address-error" : undefined}
      />
      {#if addressMessage}
        <div class="form-error" id="pairing-address-error" role="alert">{addressMessage}</div>
      {/if}
    </div>
    <div class="form-group pairing-port">
      <label class="form-label" for="pairing-port">Port</label>
      <input
        id="pairing-port"
        class="form-input"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        bind:value={port}
        aria-invalid={portMessage ? "true" : undefined}
        aria-describedby={portMessage ? "pairing-port-error" : undefined}
      />
      {#if portMessage}
        <div class="form-error" id="pairing-port-error" role="alert">{portMessage}</div>
      {/if}
    </div>
  </div>
  <p class="form-hint">
    Die Adresse wird nicht gespeichert und nirgendwohin gesendet. Der Code entsteht nur in diesem
    Browser.
  </p>

  {#if result.ok && qr}
    <div class="pairing-sheet">
      <svg
        class="pairing-qr"
        viewBox="0 0 {qr.size} {qr.size}"
        shape-rendering="crispEdges"
        role="img"
        aria-label="QR-Code für {result.url}"
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={qr.d} fill="#000000" />
      </svg>
      <p class="pairing-url">{result.url}</p>
      <p class="pairing-instruction">
        Scanne den Code mit der Handy-Kamera, während du mit dem Salon-WLAN verbunden bist, und
        tippe auf „Das ist mein Handy – koppeln“.
      </p>
    </div>
    <div class="pairing-actions">
      <button type="button" class="btn btn-secondary btn-sm" onclick={() => window.print()}>
        QR-Code drucken
      </button>
    </div>
  {/if}

  <div class="pairing-checklist">
    <div class="pairing-checklist-title">Das muss stimmen, bevor du den Code aushängst</div>
    <ul>
      <li>
        <strong>Das Salon-WLAN nutzt WPA2 oder WPA3.</strong> In offenen Netzen wechselt ein iPhone seine
        private Adresse; die Kopplung hält dort nicht und der Code ließe sich mitlesen.
      </li>
      <li>
        <strong>Kein Gast-WLAN mit Geräteisolation.</strong> Ein Gast-WLAN mit Geräteisolation (Client-Isolation)
        funktioniert nicht: Das Handy erreicht den Adapter dort nicht. Häng den Code nur für das Mitarbeiter-WLAN
        auf, in dem auch der Adapter hängt.
      </li>
      <li>
        <strong>Der Adapter ist eingeschaltet.</strong> Setze am Adapter
        <code>PAIRING_ENABLED=true</code>
        und
        <code>CLOKR_APP_URL</code>
        auf die https-Adresse deiner Clokr-Installation.
      </li>
      <li>
        <strong>Der Kopplungs-Port ist im WLAN freigegeben.</strong> Standardmäßig lauscht der
        Adapter nur auf dem Rechner selbst. Mit
        <code>PAIRING_HOST_BIND</code>
        legst du die LAN-Adresse fest, unter der die Handys ihn erreichen.
      </li>
      <li>
        <strong>Das Handy ist mit dem Salon-WLAN verbunden</strong>, nicht über Mobilfunk. Nur dann
        erkennt der Adapter, welches Gerät gerade scannt.
      </li>
    </ul>
  </div>
</div>

<style>
  .pairing-guide {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .pairing-fields {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
    gap: var(--s-3);
  }

  @media (max-width: 640px) {
    .pairing-fields {
      grid-template-columns: 1fr;
    }
  }

  .pairing-sheet {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-4);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    /* A QR code must be dark on light in every theme, so the sheet does not follow the tokens. */
    background: #ffffff;
    color: #000000;
    max-width: 22rem;
  }

  .pairing-qr {
    width: 100%;
    height: auto;
    max-width: 18rem;
  }

  .pairing-url {
    margin: 0;
    font-family: var(--font-mono, monospace);
    font-size: 0.875rem;
    word-break: break-all;
    text-align: center;
  }

  .pairing-instruction {
    margin: 0;
    font-size: 0.875rem;
    text-align: center;
  }

  .pairing-actions {
    display: flex;
    gap: var(--s-2);
  }

  .pairing-checklist-title {
    font-weight: 600;
    margin-bottom: var(--s-2);
    color: var(--text);
  }

  .pairing-checklist ul {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    color: var(--text);
    font-size: 0.9375rem;
    line-height: 1.5;
  }

  .pairing-checklist code {
    font-family: var(--font-mono, monospace);
    font-size: 0.875em;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    padding: 0 0.25rem;
  }

  /* Print: only the sheet (QR, URL, instruction) ends up on paper. */
  @media print {
    :global(body *) {
      visibility: hidden;
    }
    .pairing-sheet,
    .pairing-sheet :global(*) {
      visibility: visible;
    }
    .pairing-sheet {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      max-width: none;
      margin: 0 auto;
      border: none;
    }
    .pairing-qr {
      max-width: 14cm;
    }
    .pairing-url {
      font-size: 14pt;
    }
    .pairing-instruction {
      font-size: 14pt;
    }
  }
</style>
