<script lang="ts">
  import { api } from "$api/client";
  import { fetchAvatarObjectUrl } from "$api/avatar";
  import { authStore } from "$stores/auth";
  import { salonContext, roleNamesLabel } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { avatarVersion, bumpAvatarVersion } from "$stores/avatar";
  import PageHead from "$components/layout/PageHead.svelte";
  import Card from "$components/ui/Card.svelte";
  import PasswordStrength from "$components/ui/PasswordStrength.svelte";
  import PushSettings from "$components/settings/PushSettings.svelte";
  import WifiPresenceSettings from "$components/settings/WifiPresenceSettings.svelte";
  import { onMount } from "svelte";

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

  // Avatar
  let avatarUploading = $state(false);
  let avatarSrc = $state<string | null>(null);
  let avatarFileInput: HTMLInputElement | null = $state(null);

  function openAvatarPicker() {
    avatarFileInput?.click();
  }

  $effect(() => {
    const empId = $authStore.user?.employeeId;
    const token = $authStore.accessToken;
    // Cross-component cache-bust: bumped via bumpAvatarVersion() after upload
    const cacheBust = $avatarVersion;
    if (!empId || !token) return;

    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAvatarObjectUrl(empId, token, cacheBust).then((url) => {
      // The effect can re-run (or the component unmount) before this resolves — in that
      // case the cleanup below has already run with objectUrl still null, so revoke here
      // instead of leaking the URL that arrived too late.
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      // null is assigned deliberately: after bumpAvatarVersion() on a DELETE the server
      // answers 204, and the previously shown avatar must disappear rather than linger.
      avatarSrc = url;
    });

    return () => {
      cancelled = true;
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
      // Phase 104 review (IN-06): via api.upload, so an expired access token is refreshed and
      // the upload retried instead of surfacing as "Upload fehlgeschlagen (401)".
      await api.upload(`/avatars/${employeeId}`, formData);
      bumpAvatarVersion();
      toasts.success("Avatar aktualisiert");
    } catch (e: unknown) {
      toasts.error(e instanceof Error ? e.message : "Upload fehlgeschlagen");
    } finally {
      avatarUploading = false;
      // Reset the input so picking the same file again still triggers onchange
      input.value = "";
    }
  }
</script>

<svelte:head><title>Profil – Clokr</title></svelte:head>

<div class="settings-page">
  <PageHead
    eyebrow="Mein Bereich"
    title="Mein Profil"
    accent="Profil"
    sub="Profilbild und Passwort verwalten"
  />

  <div class="settings-grid">
    <!-- Avatar -->
    <Card class="settings-card">
      <h3 class="section-title">Profilbild</h3>
      <div class="avatar-section">
        <button
          type="button"
          class="avatar-wrapper"
          onclick={openAvatarPicker}
          disabled={avatarUploading}
          aria-label="Profilbild ändern"
          title="Profilbild ändern"
        >
          {#if avatarSrc}
            <img src={avatarSrc} alt="Avatar" class="avatar-preview" width="120" height="120" />
          {:else}
            <div class="avatar-initials">
              {($authStore.user?.firstName ?? $authStore.user?.email?.[0] ?? "?")
                .charAt(0)
                .toUpperCase()}
            </div>
          {/if}
          <span class="avatar-overlay" aria-hidden="true">
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
          </span>
        </button>
        <input
          bind:this={avatarFileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onchange={uploadAvatar}
          class="avatar-file-input"
        />
        <p class="avatar-hint text-muted">
          {avatarUploading ? "Hochladen…" : "Klicken zum Ändern"}
        </p>
      </div>
    </Card>

    <!-- Password -->
    <Card class="settings-card">
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
    </Card>
  </div>

  <!-- WiFi presence: Meine Geräte (consent, coupled phones) -->
  <WifiPresenceSettings />

  <!-- Push notifications: per device, only offered when the instance has VAPID keys -->
  <PushSettings />

  <div class="settings-info">
    <p class="text-muted"><strong>E-Mail:</strong> {$authStore.user?.email}</p>
    <p class="text-muted">
      <strong>Rolle:</strong>
      {roleNamesLabel($salonContext) || "–"}
    </p>
  </div>
</div>

<style>
  .settings-page {
    max-width: 800px;
  }
  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  :global(.settings-card) {
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
    padding: 0;
    background: transparent;
    border: 0;
    overflow: hidden;
    display: block;
  }
  .avatar-wrapper:disabled {
    cursor: wait;
    opacity: 0.7;
  }
  .avatar-wrapper:focus-visible {
    outline: 2px solid var(--brand-light);
    outline-offset: 2px;
  }
  .avatar-preview {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--border);
    box-sizing: border-box;
    display: block;
  }
  .avatar-initials {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: var(--brand-soft);
    color: var(--brand);
    font-size: 2.5rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 3px solid var(--border);
    box-sizing: border-box;
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
    color: white;
    pointer-events: none;
  }
  .avatar-wrapper:hover .avatar-overlay,
  .avatar-wrapper:focus-visible .avatar-overlay {
    opacity: 1;
  }
  .avatar-file-input {
    display: none;
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
    color: var(--bad);
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
</style>
