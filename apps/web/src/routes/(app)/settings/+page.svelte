<script lang="ts">
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import PasswordStrength from "$lib/components/ui/PasswordStrength.svelte";
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
  let avatarKey = $state(0); // Force re-render after upload

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
  <h1 class="page-title">Mein Profil</h1>

  <div class="settings-grid">
    <!-- Avatar -->
    <div class="card settings-card">
      <h3 class="section-title">Profilbild</h3>
      <div class="avatar-section">
        {#if $authStore.user?.employeeId}
          {#key avatarKey}
            <img
              src="/api/v1/avatars/{$authStore.user.employeeId}?v={avatarKey}"
              alt="Avatar"
              class="avatar-preview"
              onerror={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          {/key}
        {/if}
        <label class="btn btn-ghost btn-sm avatar-upload-btn">
          {avatarUploading ? "Hochladen…" : "Bild ändern"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onchange={uploadAvatar}
            hidden
          />
        </label>
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
    gap: 1rem;
  }
  .avatar-preview {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    object-fit: cover;
    border: 3px solid var(--color-border);
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
</style>
