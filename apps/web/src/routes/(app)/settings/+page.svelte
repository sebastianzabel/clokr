<script lang="ts">
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PasswordStrength from "$lib/components/ui/PasswordStrength.svelte";
  import { onMount } from "svelte";
  import {
    getMyWifi,
    updateMyWifi,
    addMyDevice,
    removeMyDevice,
    type MyWifiDevice,
  } from "$api/presence";

  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let saving = $state(false);

  let pwPolicy = $state({
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });

  let passwordMismatch = $derived(confirmPassword.length > 0 && newPassword !== confirmPassword);

  // WiFi presence
  let wifiEnabled = $state(false);
  let wifiDevices = $state<MyWifiDevice[]>([]);
  let wifiLoading = $state(false);
  let newMac = $state("");
  let macLabel = $state("");
  let macAdding = $state(false);
  let macError = $state("");

  const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
  let newMacValid = $derived(MAC_REGEX.test(newMac.toLowerCase().trim()));

  // Avatar
  let avatarUploading = $state(false);
  let avatarKey = $state(0); // Force re-fetch after upload
  let avatarSrc = $state<string | null>(null);

  $effect(() => {
    const empId = $authStore.user?.employeeId;
    const token = $authStore.accessToken;
    // avatarKey is read to re-run after upload
    void avatarKey;
    if (!empId || !token) return;

    let objectUrl: string | null = null;
    fetch(`/api/v1/avatars/${empId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          avatarSrc = objectUrl;
        }
      })
      .catch(() => {});

    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });

  onMount(async () => {
    try {
      const p = await api.get<typeof pwPolicy>("/auth/password-policy");
      pwPolicy = p;
    } catch {
      /* defaults */
    }
    try {
      const wifi = await getMyWifi();
      wifiEnabled = wifi.wifiPresenceEnabled;
      wifiDevices = wifi.devices;
    } catch {
      /* non-fatal: section loads empty */
    }
  });

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      toasts.error("Passwörter stimmen nicht überein");
      return;
    }
    saving = true;
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      toasts.success("Passwort geändert");
      currentPassword = newPassword = confirmPassword = "";
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Fehler");
    } finally {
      saving = false;
    }
  }

  async function toggleWifi() {
    try {
      const res = await updateMyWifi(wifiEnabled);
      wifiEnabled = res.wifiPresenceEnabled;
      toasts.success(
        wifiEnabled ? "WiFi-Präsenzerkennung aktiviert." : "WiFi-Präsenzerkennung deaktiviert.",
      );
    } catch {
      // revert optimistic toggle
      wifiEnabled = !wifiEnabled;
      toasts.error("Fehler beim Speichern.");
    }
  }

  async function addMacDevice() {
    macError = "";
    const mac = newMac.toLowerCase().trim();
    if (!MAC_REGEX.test(mac)) {
      macError = "Ungültige MAC-Adresse. Format: aa:bb:cc:dd:ee:ff";
      return;
    }
    macAdding = true;
    try {
      const device = await addMyDevice(mac, macLabel.trim() || undefined);
      wifiDevices = [...wifiDevices, device];
      newMac = "";
      macLabel = "";
      toasts.success("Gerät wurde hinzugefügt.");
    } catch (e: unknown) {
      macError =
        e instanceof Error
          ? e.message
          : "Gerät konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.";
    } finally {
      macAdding = false;
    }
  }

  async function removeMacDevice(id: string) {
    try {
      await removeMyDevice(id);
      wifiDevices = wifiDevices.filter((d) => d.id !== id);
      toasts.success("Gerät wurde entfernt.");
    } catch {
      toasts.error("Gerät konnte nicht entfernt werden.");
    }
  }

  async function uploadAvatar(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const employeeId = $authStore.user?.employeeId;
    if (!employeeId) return;

    avatarUploading = true;
    try {
      const formData = new FormData();
      formData.append("file", file);
      await fetch(`/api/v1/avatars/${employeeId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${$authStore.accessToken}` },
        body: formData,
      });
      avatarKey++;
      toasts.success("Avatar aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Upload fehlgeschlagen");
    } finally {
      avatarUploading = false;
    }
  }
</script>

<svelte:head><title>Profil – Clokr</title></svelte:head>

<div class="settings-page">
  <div class="page-header">
    <h1 class="page-title">Mein Profil</h1>
    <p class="page-subtitle">Profilbild und Passwort verwalten</p>
  </div>

  <div class="settings-grid">
    <!-- Avatar -->
    <div class="card settings-card">
      <h3 class="section-title">Profilbild</h3>
      <div class="avatar-section">
        <div class="avatar-wrapper">
          {#if avatarSrc}
            <img src={avatarSrc} alt="Avatar" class="avatar-preview" />
          {/if}
          <div class="avatar-initials" style={$authStore.user?.employeeId ? "display:none" : ""}>
            {($authStore.user?.firstName ?? $authStore.user?.email?.[0] ?? "?")
              .charAt(0)
              .toUpperCase()}
          </div>
          <label class="avatar-overlay" title="Profilbild ändern">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
              /><circle cx="12" cy="13" r="4" /></svg
            >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onchange={uploadAvatar}
              hidden
            />
          </label>
        </div>
        <p class="avatar-hint text-muted">
          {avatarUploading ? "Hochladen…" : "Klicken zum Ändern"}
        </p>
      </div>
    </div>

    <!-- Password -->
    <div class="card settings-card">
      <h3 class="section-title">Passwort ändern</h3>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          changePassword();
        }}
        class="pw-form"
      >
        <div class="form-group">
          <label class="form-label" for="cur-pw">Aktuelles Passwort</label>
          <input
            id="cur-pw"
            type="password"
            bind:value={currentPassword}
            required
            class="form-input"
            autocomplete="current-password"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="new-pw">Neues Passwort</label>
          <input
            id="new-pw"
            type="password"
            bind:value={newPassword}
            required
            minlength={pwPolicy.passwordMinLength}
            class="form-input"
            autocomplete="new-password"
          />
          <PasswordStrength password={newPassword} policy={pwPolicy} />
        </div>
        <div class="form-group">
          <label class="form-label" for="confirm-pw">Passwort bestätigen</label>
          <input
            id="confirm-pw"
            type="password"
            bind:value={confirmPassword}
            required
            class="form-input"
            autocomplete="new-password"
          />
          {#if passwordMismatch}
            <p class="field-error">Passwörter stimmen nicht überein</p>
          {/if}
        </div>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={saving || !currentPassword || !newPassword || passwordMismatch}
        >
          {saving ? "Speichern…" : "Passwort ändern"}
        </button>
      </form>
    </div>
  </div>

  <!-- WiFi Presence: Meine Geräte -->
  <div class="card settings-card wifi-card card-animate" style="margin-bottom: 1.5rem;">
    <h3 class="section-title">Meine Geräte</h3>

    <!-- GDPR notice — always visible, not dismissible -->
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
        >Ihre MAC-Adresse wird lokal gespeichert. Verbindungs- und Trennungszeitpunkte werden für 90
        Tage protokolliert, danach automatisch gelöscht.</span
      >
    </div>

    <!-- Opt-in toggle row -->
    <div class="wifi-toggle-row">
      <label class="wifi-toggle-label" for="wifi-optin">WiFi-Präsenzerkennung aktivieren</label>
      <input
        type="checkbox"
        id="wifi-optin"
        class="wifi-toggle-input"
        role="switch"
        bind:checked={wifiEnabled}
        onchange={toggleWifi}
      />
    </div>
    <p class="form-hint" style="margin-bottom: 1.25rem;">
      Wenn aktiviert, kann Clokr Ihre Anwesenheit anhand Ihrer WLAN-Verbindung erkennen und
      automatisch stempeln.
    </p>

    <!-- MAC device list -->
    <div class="mac-list">
      {#if wifiLoading}
        <p class="text-muted" style="font-size: 0.8125rem;">Laden…</p>
      {:else if wifiDevices.length === 0}
        <p class="text-muted" style="font-size: 0.8125rem;">
          Noch kein Gerät eingetragen. Fügen Sie Ihre MAC-Adresse hinzu.
        </p>
      {:else}
        {#each wifiDevices as device (device.id)}
          <div class="mac-row">
            <code class="mac-code">{device.mac}</code>
            {#if device.label}
              <span class="mac-label-text text-muted">{device.label}</span>
            {/if}
            <button
              class="btn btn-icon btn-ghost"
              aria-label="Gerät entfernen"
              onclick={() => removeMacDevice(device.id)}
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

    <!-- Add MAC form -->
    <div class="mac-add-form">
      <input
        class="form-input mac-input"
        type="text"
        bind:value={newMac}
        placeholder="z.B. aa:bb:cc:dd:ee:ff"
        aria-label="MAC-Adresse"
        onblur={() => {
          if (newMac && !newMacValid) {
            macError = "Ungültige MAC-Adresse. Format: aa:bb:cc:dd:ee:ff";
          } else {
            macError = "";
          }
        }}
      />
      <input
        class="form-input"
        type="text"
        bind:value={macLabel}
        placeholder="Bezeichnung (optional)"
        aria-label="Gerätebezeichnung"
      />
      <button class="btn btn-primary" onclick={addMacDevice} disabled={!newMacValid || macAdding}>
        {macAdding ? "Hinzufügen…" : "Gerät hinzufügen"}
      </button>
    </div>
    {#if macError}
      <p class="form-error" role="alert">{macError}</p>
    {/if}
  </div>

  <div class="settings-info">
    <p class="text-muted"><strong>E-Mail:</strong> {$authStore.user?.email}</p>
    <p class="text-muted">
      <strong>Rolle:</strong>
      {$authStore.user?.role === "ADMIN"
        ? "Administrator"
        : $authStore.user?.role === "MANAGER"
          ? "Manager"
          : "Mitarbeiter"}
    </p>
  </div>
</div>

<style>
  .settings-page {
    max-width: 800px;
  }
  .page-title {
    font-size: 1.375rem;
    font-weight: 700;
    margin-bottom: 1.5rem;
  }
  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .settings-card {
    padding: 1.5rem;
  }
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  .avatar-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }
  .avatar-wrapper {
    position: relative;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    cursor: pointer;
  }
  .avatar-preview {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--color-border);
  }
  .avatar-initials {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: var(--color-brand-tint);
    color: var(--color-brand);
    font-size: 2.5rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 3px solid var(--color-border);
  }
  .avatar-overlay {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s;
    cursor: pointer;
    color: white;
  }
  .avatar-wrapper:hover .avatar-overlay {
    opacity: 1;
  }
  .avatar-hint {
    font-size: 0.8125rem;
  }
  .pw-form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  .field-error {
    color: var(--color-red);
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }
  .settings-info {
    display: flex;
    gap: 2rem;
    font-size: 0.875rem;
  }

  @media (max-width: 640px) {
    .settings-grid {
      grid-template-columns: 1fr;
    }
  }

  /* WiFi Meine Geräte card */
  .wifi-card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    backdrop-filter: blur(var(--glass-blur));
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
    background: var(--color-border);
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
    background: white;
    transition: transform 0.2s;
  }
  .wifi-toggle-input:checked {
    background: var(--color-brand);
  }
  .wifi-toggle-input:checked::after {
    transform: translateX(1.25rem);
  }
  .wifi-toggle-input:focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }
  .mac-list {
    margin: 0 0 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .mac-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .mac-code {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: var(--color-bg-subtle);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    border: 1px solid var(--color-border);
  }
  .mac-label-text {
    font-size: 0.8125rem;
    white-space: nowrap;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mac-add-form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .mac-input {
    font-family: var(--font-mono);
    font-size: 0.9375rem;
    flex: 1;
    min-width: 180px;
  }
  .form-error {
    color: var(--color-red);
    font-size: 0.8125rem;
    margin-top: 0.25rem;
  }
</style>
