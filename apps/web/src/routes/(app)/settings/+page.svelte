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
        <div class="avatar-wrapper">
          {#if $authStore.user?.employeeId}
            {#key avatarKey}
              <img
                src="/api/v1/avatars/{$authStore.user.employeeId}?v={avatarKey}"
                alt="Avatar"
                class="avatar-preview"
                onerror={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  const next = (e.target as HTMLElement).nextElementSibling;
                  if (next) (next as HTMLElement).style.display = "flex";
                }}
              />
            {/key}
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
</style>
