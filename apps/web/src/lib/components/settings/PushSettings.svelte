<!--
  Issue #608 (D-14, D-11): the "Push-Benachrichtigungen" section of the profile page.

  Shown only when the instance has VAPID keys (GET /me/push/config), so an instance without keys
  offers nothing. Enabling is one explicit click per device (consent, Art. 6 Abs. 1 lit. a DSGVO),
  disabling is as easy. Every browser decision lives in `$lib/push`; this component presents the
  states. Actions apply instantly with toast feedback (docs/ADMIN_STRUCTURE.md §3.2.1), there is no
  section save button.
-->
<script lang="ts">
  import { onMount } from "svelte";

  import {
    getPushConfig,
    listPushDevices,
    removePushDevice,
    sendTestPush,
    type PushDevice,
  } from "$lib/api/push";
  import {
    disableThisDevice,
    enableThisDevice,
    thisDeviceState,
    type ThisDeviceState,
  } from "$lib/push/device-subscription";
  import { pushErrorMessage } from "$lib/push/error-message";
  import { pushSupport, type PushSupport } from "$lib/push/support";
  import { toasts } from "$stores/toast";
  import Card from "$components/ui/Card.svelte";

  let enabled = $state(false);
  let publicKey = $state<string | null>(null);
  let support = $state<PushSupport>("supported");
  let devices = $state<PushDevice[]>([]);
  let thisDevice = $state<ThisDeviceState>({ state: "off", deviceId: null });
  let denied = $state(false);
  // The permission prompt was closed without an answer: calm hint, the enable button stays.
  let dismissed = $state(false);
  let loadFailed = $state(false);
  let busy = $state(false);
  // A reload after a SUCCESSFUL action failed: the list may be stale, but the action did succeed.
  let listStale = $state(false);

  const isOn = $derived(thisDevice.state === "on");

  function permissionDenied(): boolean {
    return typeof Notification !== "undefined" && Notification.permission === "denied";
  }

  async function refreshDevices() {
    devices = await listPushDevices();
    thisDevice = await thisDeviceState(devices);
  }

  /**
   * Reloads the list after an action that already succeeded. A failing reload must not turn that
   * success into an error toast (review IN-05): the list just says it may be out of date.
   */
  async function refreshQuietly() {
    try {
      await refreshDevices();
      listStale = false;
    } catch {
      listStale = true;
    }
  }

  onMount(async () => {
    try {
      const config = await getPushConfig();
      if (!config.enabled) return;
      publicKey = config.publicKey;
      support = pushSupport();
      denied = permissionDenied();
      enabled = true;
      await refreshDevices();
    } catch {
      // Without a readable config nothing is offered; with a readable one a failed list says so.
      loadFailed = enabled;
    }
  });

  async function enable() {
    if (busy || !publicKey) return;
    busy = true;
    try {
      // The click handler calls into `enableThisDevice` synchronously: its permission request
      // must be the first await, nothing may be awaited before it.
      const result = await enableThisDevice(publicKey);
      if (result.status === "denied") {
        denied = true;
        dismissed = false;
      } else if (result.status === "dismissed") {
        dismissed = true;
      } else if (result.status === "error") {
        toasts.error(result.message);
      } else {
        denied = false;
        dismissed = false;
        toasts.success("Push ist auf diesem Gerät aktiviert.");
        // Show the new device even if the reload below fails.
        devices = [...devices.filter((d) => d.id !== result.device.id), result.device];
        thisDevice = { state: "on", deviceId: result.device.id };
        await refreshQuietly();
      }
    } catch (error) {
      toasts.error(pushErrorMessage(error));
    } finally {
      busy = false;
    }
  }

  async function disable() {
    if (busy) return;
    busy = true;
    try {
      const result = await disableThisDevice();
      if (result.status === "error") {
        toasts.error(result.message);
        return;
      }
      toasts.success("Push ist auf diesem Gerät deaktiviert.");
      await refreshQuietly();
    } catch (error) {
      toasts.error(pushErrorMessage(error));
    } finally {
      busy = false;
    }
  }

  function deviceWord(count: number): string {
    return count === 1 ? "Gerät" : "Geräte";
  }

  async function sendTest() {
    if (busy) return;
    busy = true;
    try {
      const result = await sendTestPush();
      const count = (outcome: "SENT" | "REMOVED" | "FAILED") =>
        result.devices.filter((d) => d.outcome === outcome).length;
      const sent = count("SENT");
      const removed = count("REMOVED");
      const failed = count("FAILED");

      // Success only for devices that really received it (review WR-04).
      if (sent > 0) {
        toasts.success(`Testnachricht an ${sent} ${deviceWord(sent)} gesendet.`);
      }
      if (failed > 0) {
        toasts.error(
          `Die Testnachricht konnte an ${failed} ${deviceWord(failed)} nicht zugestellt werden. Versuche es später erneut.`,
        );
      }
      if (removed > 0) {
        // The push service reported the subscription gone and the server dropped the row.
        toasts.info(
          `${removed} ${deviceWord(removed)} ${removed === 1 ? "ist" : "sind"} beim Push-Dienst nicht mehr bekannt und wurde${removed === 1 ? "" : "n"} entfernt. Aktiviere Push dort erneut.`,
        );
        await refreshQuietly();
      }
      if (sent + failed + removed === 0) toasts.info("Es ist noch kein Gerät eingerichtet.");
    } catch (error) {
      toasts.error(pushErrorMessage(error));
    } finally {
      busy = false;
    }
  }

  async function removeDevice(device: PushDevice) {
    if (device.id === (thisDevice.state === "on" ? thisDevice.deviceId : null)) {
      await disable();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      await removePushDevice({ id: device.id });
      toasts.success("Gerät entfernt.");
      await refreshQuietly();
    } catch (error) {
      toasts.error(pushErrorMessage(error));
    } finally {
      busy = false;
    }
  }

  function since(iso: string): string {
    return new Date(iso).toLocaleDateString("de-DE");
  }
</script>

{#if enabled}
  <Card class="settings-card push-card">
    <h3 class="section-title">Push-Benachrichtigungen</h3>

    {#if support === "ios-needs-install"}
      <div class="alert alert-info push-note" role="note">
        <span
          >So bekommst du Push auf dem iPhone: Tippe in Safari auf „Teilen“ und dann auf „Zum
          Home-Bildschirm“. Öffne Clokr danach über das neue Symbol und aktiviere Push hier.</span
        >
      </div>
    {:else if support === "unsupported"}
      <p class="text-muted push-note">Dieser Browser unterstützt keine Push-Benachrichtigungen.</p>
    {:else}
      <p class="push-state" data-testid="push-state">
        {isOn ? "Auf diesem Gerät: an" : "Auf diesem Gerät: aus"}
      </p>

      {#if isOn}
        <div class="push-actions">
          <button type="button" class="btn btn-secondary" onclick={disable} disabled={busy}>
            Push deaktivieren
          </button>
        </div>
      {:else if denied}
        <p class="text-muted push-note">
          Benachrichtigungen sind für Clokr in den Browser-Einstellungen blockiert. Erlaube sie
          dort, dann kannst du Push hier aktivieren.
        </p>
      {:else}
        <div class="push-actions">
          <button type="button" class="btn btn-primary" onclick={enable} disabled={busy}>
            Push aktivieren
          </button>
        </div>
        {#if dismissed}
          <p class="text-muted push-note" role="status" data-testid="push-dismissed">
            Benachrichtigungen wurden nicht erlaubt. Tippe auf „Push aktivieren“ und erlaube sie, um
            es erneut zu versuchen.
          </p>
        {/if}
        <p class="form-hint">
          Mit dem Aktivieren erlaubst du Clokr, diesem Gerät Benachrichtigungen zu senden. Du kannst
          das hier jederzeit wieder abschalten.
        </p>
      {/if}

      <p class="form-hint">
        Auf dem Sperrbildschirm erscheint nur ein neutraler Hinweis – keine Namen, keine Zeiten,
        keine Gesundheitsdaten.
      </p>
    {/if}

    {#if listStale}
      <p class="text-muted push-note" role="status" data-testid="push-list-stale">
        Die Geräteliste konnte nicht aktualisiert werden. Lade die Seite neu, um sie zu prüfen.
      </p>
    {/if}
    {#if loadFailed}
      <p class="text-muted push-note">Deine Geräte konnten nicht geladen werden.</p>
    {:else if devices.length === 0}
      <p class="text-muted push-note">Noch kein Gerät eingerichtet.</p>
    {:else}
      <ul class="push-devices">
        {#each devices as device, index (device.id)}
          <li class="push-device">
            <span class="push-device-label">{device.deviceLabel}</span>
            {#if thisDevice.state === "on" && thisDevice.deviceId === device.id}
              <span class="badge badge-blue">Dieses Gerät</span>
            {/if}
            <span class="text-muted push-device-since">seit {since(device.consentedAt)}</span>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              aria-label={`Entfernen: ${device.deviceLabel}, Gerät ${index + 1} von ${devices.length}, seit ${since(device.consentedAt)}`}
              onclick={() => removeDevice(device)}
              disabled={busy}
            >
              Entfernen
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if support === "supported" || devices.length > 0}
      <div class="push-actions">
        <button
          type="button"
          class="btn btn-secondary"
          onclick={sendTest}
          disabled={busy || devices.length === 0}
        >
          Test senden
        </button>
      </div>
    {/if}
  </Card>
{/if}

<style>
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  :global(.push-card) {
    margin-bottom: 1.5rem;
  }
  .push-state {
    font-size: 0.9375rem;
    font-weight: 500;
    margin-bottom: 0.75rem;
  }
  .push-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  .push-note {
    font-size: 0.875rem;
    margin: 0.5rem 0;
  }
  .push-devices {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .push-device {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    min-height: 44px;
    border-bottom: 1px solid var(--line);
  }
  .push-device-label {
    font-size: 0.9375rem;
  }
  .push-device-since {
    flex: 1;
    font-size: 0.8125rem;
  }
</style>
