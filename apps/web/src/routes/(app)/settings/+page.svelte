<script lang="ts">
  import { pageLabel } from "$lib/nav/page-labels";
  import { api } from "$api/client";
  import { fetchAvatarObjectUrl } from "$api/avatar";
  import { authStore } from "$stores/auth";
  import { salonContext, roleNamesLabel } from "$stores/salon-context";
  import { toasts } from "$stores/toast";
  import { avatarVersion, bumpAvatarVersion } from "$stores/avatar";
  import PageHeader from "$components/ui/PageHeader.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import AppearanceSettings from "$components/settings/AppearanceSettings.svelte";
  import MyWorkSettings from "$components/settings/MyWorkSettings.svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import PasswordStrength from "$components/ui/PasswordStrength.svelte";
  import PushSettings from "$components/settings/PushSettings.svelte";
  import ReminderSettings from "$components/settings/ReminderSettings.svelte";
  import WifiPresenceSettings from "$components/settings/WifiPresenceSettings.svelte";
  import { onMount } from "svelte";

  let currentPassword = $state("");
  let newPassword = $state("");
  let confirmPassword = $state("");
  let saving = $state(false);
  let passwordOpen = $state(false);

  let pwPolicy = $state({
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });

  // Issue #851 (D-851-02): who is signed in, as the page subtitle (formerly a row under the sections).
  const profileSubtitle = $derived(
    [$authStore.user?.email, roleNamesLabel($salonContext)].filter(Boolean).join(" · "),
  );
  const displayName = $derived($authStore.user?.firstName ?? $authStore.user?.email ?? "");

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
      toasts.error("Die Passwörter stimmen nicht überein.");
      return;
    }
    saving = true;
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      toasts.success("Passwort geändert");
      currentPassword = newPassword = confirmPassword = "";
      passwordOpen = false;
    } catch (e: unknown) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "Das Passwort ließ sich nicht ändern. Bitte versuche es noch einmal.",
      );
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
      toasts.success("Profilbild aktualisiert");
    } catch (e: unknown) {
      toasts.error(
        e instanceof Error
          ? e.message
          : "Das Bild ließ sich nicht hochladen. Bitte versuche es noch einmal.",
      );
    } finally {
      avatarUploading = false;
      // Reset the input so picking the same file again still triggers onchange
      input.value = "";
    }
  }
</script>

<svelte:head><title>{pageLabel("/settings")} – Clokr</title></svelte:head>

<!-- Phase 851 (prototype „Ich › Profil“, #602): who you are on top, your work and your notifications on
     the left, appearance, phone clocking and security on the right. -->
<PageHeader title={pageLabel("/settings")} subtitle={profileSubtitle}>
  {#snippet actions()}
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      onclick={openAvatarPicker}
      disabled={avatarUploading}
    >
      {#if avatarUploading}<Spinner size={14} label="Bild wird hochgeladen" />{/if}
      Foto ändern
    </button>
  {/snippet}
</PageHeader>

<div class="profile-person">
  <button
    type="button"
    class="avatar-wrapper"
    onclick={openAvatarPicker}
    disabled={avatarUploading}
    aria-label="Profilbild ändern"
    title="Profilbild ändern"
  >
    {#if avatarSrc}
      <img src={avatarSrc} alt="" class="avatar-preview" width="56" height="56" />
    {:else}
      <span class="avatar-initials" aria-hidden="true">
        {(displayName || "?").charAt(0).toUpperCase()}
      </span>
    {/if}
  </button>
  <div class="profile-person-text">
    <b>{displayName}</b>
    <span>JPG, PNG oder WebP. Tippe auf das Bild, um es zu ändern.</span>
  </div>
  <input
    bind:this={avatarFileInput}
    type="file"
    accept="image/jpeg,image/png,image/webp"
    onchange={uploadAvatar}
    class="avatar-file-input"
    aria-label="Profilbild hochladen"
  />
</div>

<div class="profile-wrap">
  <div class="profile-grid">
    <div class="profile-col">
      <MyWorkSettings />
      <!-- Notifications: push per device and the shift reminders (Issue #608/#609) -->
      <PushSettings />
      <ReminderSettings />
    </div>

    <div class="profile-col">
      <AppearanceSettings />
      <!-- Stempeln mit dem Handy: WLAN presence and coupled phones (Issue #388/#610) -->
      <WifiPresenceSettings />
      <Section title="Sicherheit" sub="Dein Passwort für die Anmeldung.">
        <div>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onclick={() => (passwordOpen = true)}>Passwort ändern</button
          >
        </div>
      </Section>
    </div>
  </div>
</div>

<Dialog bind:open={passwordOpen} title="Passwort ändern">
  <form
    id="pw-form"
    onsubmit={(e) => {
      e.preventDefault();
      changePassword();
    }}
    class="pw-form"
  >
    <FormField label="Aktuelles Passwort">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          type="password"
          bind:value={currentPassword}
          required
          class="form-input"
          autocomplete="current-password"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      {/snippet}
    </FormField>
    <FormField label="Neues Passwort">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          type="password"
          bind:value={newPassword}
          required
          minlength={pwPolicy.passwordMinLength}
          class="form-input"
          autocomplete="new-password"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
        <PasswordStrength password={newPassword} policy={pwPolicy} />
      {/snippet}
    </FormField>
    <FormField
      label="Passwort bestätigen"
      error={passwordMismatch ? "Die Passwörter stimmen nicht überein." : undefined}
    >
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          type="password"
          bind:value={confirmPassword}
          required
          class="form-input"
          autocomplete="new-password"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      {/snippet}
    </FormField>
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (passwordOpen = false)}
      >Abbrechen</button
    >
    <button
      type="submit"
      form="pw-form"
      class="btn btn-primary"
      disabled={saving || !currentPassword || !newPassword || passwordMismatch}
    >
      {#if saving}<Spinner size={14} label="Passwort wird gespeichert" />{/if}
      Passwort speichern
    </button>
  {/snippet}
</Dialog>

<style>
  .profile-person {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    margin-bottom: var(--s-6);
  }
  .profile-person-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .profile-person-text span {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .profile-wrap {
    container-type: inline-size;
  }
  .profile-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--s-6);
  }
  @container (min-width: 760px) {
    .profile-grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  .profile-col {
    display: flex;
    flex-direction: column;
    gap: var(--s-6);
    min-width: 0;
  }
  .avatar-wrapper {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    cursor: pointer;
    padding: 0;
    background: transparent;
    border: 0;
    overflow: hidden;
    flex-shrink: 0;
  }
  .avatar-wrapper:disabled {
    cursor: wait;
    opacity: 0.7;
  }
  .avatar-wrapper:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .avatar-preview,
  .avatar-initials {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
  }
  .avatar-preview {
    object-fit: cover;
  }
  .avatar-initials {
    background: var(--brand-soft);
    color: var(--brand);
    font-size: 20px;
    font-weight: 600;
    align-items: center;
    justify-content: center;
  }
  .avatar-file-input {
    display: none;
  }
  .pw-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>
