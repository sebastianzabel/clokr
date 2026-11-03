<!--
  Issue #610 (D-12, D-08, P-610-21): the "Meine Geräte" card of the profile - the person's WLAN
  presence consent and their coupled phones.

  Each device shows how it was coupled (QR code or typed in) and when it was last recognised in the
  salon WLAN. Switching the consent OFF while devices exist is a deliberate step: the dialog names
  the consequence (every device is removed) and only its confirmation sends the withdrawal, then the
  list is empty. The manual MAC entry stays for phones that cannot scan. Actions apply instantly with
  toast feedback (docs/ADMIN_STRUCTURE.md §3.2.1). The ConfirmDialog sits OUTSIDE the animated card:
  the card's transform would trap a fixed dialog inside it (#570).
-->
<script lang="ts">
  import { onMount } from "svelte";

  import {
    addMyDevice,
    getMyWifi,
    removeMyDevice,
    updateMyWifi,
    type MyWifiDevice,
  } from "$lib/api/presence";
  import { lastSeenLabel, pairedViaLabel } from "$lib/presence/device-labels";
  import { toasts } from "$stores/toast";
  import Card from "$components/ui/Card.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";

  let enabled = $state(false);
  let devices = $state<MyWifiDevice[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let withdrawOpen = $state(false);
  let newMac = $state("");
  let macLabel = $state("");
  let macAdding = $state(false);
  let macError = $state("");

  const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
  const MAC_FORMAT_ERROR = "Ungültige MAC-Adresse. Format: aa:bb:cc:dd:ee:ff";
  const newMacValid = $derived(MAC_REGEX.test(newMac.toLowerCase().trim()));

  onMount(async () => {
    try {
      const wifi = await getMyWifi();
      enabled = wifi.wifiPresenceEnabled;
      devices = wifi.devices;
      loadFailed = false;
    } catch {
      // It must not look like "opt-in is off, no devices" - that is indistinguishable from the real
      // thing and is why #238 went unnoticed from Phase 25 until it was fixed.
      loadFailed = true;
    } finally {
      loading = false;
    }
  });

  /** The switch was flipped; `bind:checked` has already applied the new value. */
  async function onToggle() {
    const next = enabled;
    if (!next && devices.length > 0) {
      // A withdrawal removes every device: ask first. The switch stays on until it is confirmed.
      enabled = true;
      withdrawOpen = true;
      return;
    }
    try {
      const res = await updateMyWifi(next);
      enabled = res.wifiPresenceEnabled;
      toasts.success(
        enabled
          ? "WLAN-Anwesenheitserkennung aktiviert."
          : "WLAN-Anwesenheitserkennung deaktiviert.",
      );
    } catch {
      enabled = !next;
      toasts.error("Fehler beim Speichern.");
    }
  }

  async function confirmWithdrawal() {
    try {
      await updateMyWifi(false);
    } catch {
      // The switch is still on and nothing was removed.
      toasts.error("Fehler beim Speichern.");
      return;
    }
    enabled = false;
    devices = [];
    toasts.success("Einwilligung widerrufen. Deine Geräte wurden entfernt.");
  }

  async function addMacDevice() {
    macError = "";
    const mac = newMac.toLowerCase().trim();
    if (!MAC_REGEX.test(mac)) {
      macError = MAC_FORMAT_ERROR;
      return;
    }
    macAdding = true;
    try {
      const device = await addMyDevice(mac, macLabel.trim() || undefined);
      devices = [...devices, device];
      newMac = "";
      macLabel = "";
      toasts.success("Gerät wurde hinzugefügt.");
    } catch (e: unknown) {
      macError =
        e instanceof Error
          ? e.message
          : "Gerät konnte nicht gespeichert werden. Bitte versuche es erneut.";
    } finally {
      macAdding = false;
    }
  }

  async function removeDevice(id: string) {
    try {
      await removeMyDevice(id);
      devices = devices.filter((d) => d.id !== id);
      toasts.success("Gerät wurde entfernt.");
    } catch {
      toasts.error("Gerät konnte nicht entfernt werden.");
    }
  }
</script>

<Card animate class="settings-card wifi-card">
  <h3 class="section-title">Meine Geräte</h3>

  <!-- GDPR notice - always visible, not dismissible -->
  <div class="alert alert-info wifi-gdpr-note" role="note">
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line
        x1="12"
        y1="16"
        x2="12.01"
        y2="16"
      /></svg
    >
    <span
      >Deine Geräteadresse wird nur für die Anwesenheitserkennung im Salon-WLAN gespeichert.
      Verbindungs- und Trennungszeitpunkte werden 90 Tage protokolliert und danach automatisch
      gelöscht. Pro gekoppeltem Gerät wird zusätzlich der Zeitpunkt der letzten Erkennung
      gespeichert, solange das Gerät gekoppelt ist.</span
    >
  </div>

  <!-- Opt-in toggle row -->
  <div class="wifi-toggle-row">
    <label class="wifi-toggle-label" for="wifi-optin">WLAN-Anwesenheitserkennung</label>
    <input
      type="checkbox"
      id="wifi-optin"
      class="wifi-toggle-input"
      role="switch"
      bind:checked={enabled}
      onchange={onToggle}
      disabled={loadFailed || loading}
    />
  </div>
  <p class="form-hint wifi-toggle-hint">
    Wenn aktiviert, erkennt Clokr deine Anwesenheit über das Salon-WLAN und stempelt automatisch. Du
    kannst die Einwilligung jederzeit widerrufen; dann werden alle deine Geräte entfernt.
  </p>

  <!-- Device list -->
  <div class="mac-list">
    {#if loading}
      <p class="text-muted mac-list-status">Laden…</p>
    {:else if loadFailed}
      <div class="callout error">
        <p>
          Die WLAN-Einstellungen konnten nicht geladen werden. Der angezeigte Stand ist deshalb
          nicht aussagekräftig – bitte lade die Seite neu.
        </p>
      </div>
    {:else if devices.length === 0}
      <p class="text-muted mac-list-status">
        Noch kein Gerät gekoppelt. Scanne dazu den QR-Code im Salon.
      </p>
    {:else}
      {#each devices as device (device.id)}
        <div class="mac-row">
          <div class="mac-main">
            <code class="mac-code">{device.mac}</code>
            {#if device.label}
              <span class="mac-label-text text-muted">{device.label}</span>
            {/if}
            <span class="badge">{pairedViaLabel(device.pairedVia)}</span>
            <span class="text-muted mac-seen">{lastSeenLabel(device.lastSeenAt)}</span>
          </div>
          <button
            type="button"
            class="btn btn-icon btn-ghost"
            aria-label="Gerät entfernen"
            onclick={() => removeDevice(device.id)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              ><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path
                d="M10 11v6"
              /><path d="M14 11v6" /><path d="M9 6V4h6v2" /></svg
            >
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <p class="form-hint">
    Am einfachsten koppelst du dein Handy, indem du den QR-Code im Salon scannst, während du mit dem
    Salon-WLAN verbunden bist.
  </p>

  <!-- Manual entry for phones that cannot scan -->
  <details class="mac-manual">
    <summary>MAC-Adresse manuell eintragen</summary>
    <div class="mac-add-form">
      <div class="mac-field">
        <label class="form-label" for="wifi-mac-input">MAC-Adresse</label>
        <input
          id="wifi-mac-input"
          class="form-input mac-input"
          type="text"
          bind:value={newMac}
          placeholder="z.B. aa:bb:cc:dd:ee:ff"
          onblur={() => {
            macError = newMac && !newMacValid ? MAC_FORMAT_ERROR : "";
          }}
        />
      </div>
      <div class="mac-field">
        <label class="form-label" for="wifi-mac-label">Bezeichnung (optional)</label>
        <input
          id="wifi-mac-label"
          class="form-input"
          type="text"
          bind:value={macLabel}
          placeholder="z.B. iPhone, Tablet"
        />
      </div>
      <button
        type="button"
        class="btn btn-primary"
        onclick={addMacDevice}
        disabled={!newMacValid || macAdding}
      >
        {macAdding ? "Hinzufügen…" : "Gerät hinzufügen"}
      </button>
    </div>
    {#if macError}
      <p class="form-error" role="alert">{macError}</p>
    {/if}
  </details>
</Card>

<ConfirmDialog
  bind:open={withdrawOpen}
  title="Einwilligung widerrufen?"
  description="Alle deine Geräte werden entfernt. Die Anwesenheitserkennung über das WLAN ist danach aus."
  confirmLabel="Widerrufen"
  danger
  onConfirm={confirmWithdrawal}
/>

<style>
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  :global(.wifi-card) {
    box-shadow: var(--shadow-md);
    margin-bottom: 1.5rem;
  }
  .wifi-gdpr-note {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
  }
  .wifi-toggle-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    min-height: 44px;
    margin: 1rem 0 0.5rem;
  }
  .wifi-toggle-label {
    flex: 1;
    font-size: 0.9375rem;
    cursor: pointer;
  }
  .wifi-toggle-input {
    appearance: none;
    -webkit-appearance: none;
    width: 2.75rem;
    height: 1.5rem;
    border-radius: 9999px;
    background: var(--border);
    cursor: pointer;
    position: relative;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .wifi-toggle-input::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bg-card);
    transition: transform 0.2s;
  }
  .wifi-toggle-input:checked {
    background: var(--brand);
  }
  .wifi-toggle-input:checked::after {
    transform: translateX(1.25rem);
  }
  .wifi-toggle-input:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .wifi-toggle-hint {
    margin-bottom: 1.25rem;
  }
  .mac-list {
    margin: 0 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mac-list-status {
    font-size: 0.8125rem;
  }
  .mac-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .mac-main {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.5rem;
    min-width: 0;
  }
  .mac-code {
    padding: 0.5rem 0.75rem;
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    border: 1px solid var(--border);
  }
  .mac-label-text {
    font-size: 0.8125rem;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mac-seen {
    font-size: 0.8125rem;
  }
  .mac-manual {
    margin-top: 0.75rem;
  }
  .mac-manual summary {
    cursor: pointer;
    font-size: 0.875rem;
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  .mac-add-form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: flex-end;
    margin-top: 0.5rem;
  }
  .mac-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    flex: 1;
    min-width: 180px;
  }
  .mac-input {
    font-family: var(--font-mono);
    font-size: 0.9375rem;
  }
  .form-error {
    color: var(--bad);
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }
</style>
