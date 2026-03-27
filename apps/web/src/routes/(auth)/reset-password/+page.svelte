<script lang="ts">
  import { preventDefault } from "svelte/legacy";
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { api } from "$api/client";
  import PasswordStrength from "$lib/components/ui/PasswordStrength.svelte";

  let password = $state("");
  let confirmPassword = $state("");
  let error = $state("");
  let loading = $state(false);
  let success = $state(false);

  let pwPolicy = $state({
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });

  let token = $derived($page.url.searchParams.get("token") ?? "");
  let passwordMismatch = $derived(confirmPassword.length > 0 && password !== confirmPassword);
  let canSubmit = $derived(password.length >= pwPolicy.passwordMinLength && password === confirmPassword && !loading);

  onMount(async () => {
    try {
      const p = await api.get<typeof pwPolicy>("/auth/password-policy");
      pwPolicy = p;
    } catch { /* use defaults */ }
  });

  async function handleSubmit() {
    if (password !== confirmPassword) {
      error = "Die Passwörter stimmen nicht überein.";
      return;
    }
    loading = true;
    error = "";
    try {
      await api.post("/auth/reset-password", { token, password });
      success = true;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Ein Fehler ist aufgetreten";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Passwort zurücksetzen – Clokr</title>
</svelte:head>

<div class="login-page">
  <div class="login-card">
    <div class="login-logo">
      <span class="login-logo-icon">⏱️</span>
      <h1 class="login-title">Passwort zurücksetzen</h1>
      <p class="login-subtitle">Vergeben Sie ein neues Passwort für Ihr Konto.</p>
    </div>

    {#if success}
      <div class="alert alert-success" role="alert">
        <span>✓</span>
        <span>Ihr Passwort wurde erfolgreich zurückgesetzt.</span>
      </div>
      <div class="back-footer">
        <a href="/login" class="btn btn-primary login-submit">Zur Anmeldung</a>
      </div>
    {:else if !token}
      <div class="alert alert-error" role="alert">
        <span>⚠</span>
        <span>Ungültiger Link. Bitte fordern Sie einen neuen Link an.</span>
      </div>
      <div class="back-footer">
        <a href="/forgot-password" class="back-link">Neuen Link anfordern</a>
      </div>
    {:else}
      <form onsubmit={preventDefault(handleSubmit)} class="login-form">
        {#if error}
          <div class="alert alert-error" role="alert">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        {/if}

        <div class="form-group">
          <label class="form-label" for="password">Neues Passwort</label>
          <input
            id="password"
            type="password"
            bind:value={password}
            required
            minlength={pwPolicy.passwordMinLength}
            class="form-input"
            placeholder="Mindestens {pwPolicy.passwordMinLength} Zeichen"
            autocomplete="new-password"
          />
          <PasswordStrength {password} policy={pwPolicy} />
        </div>

        <div class="form-group">
          <label class="form-label" for="confirm-password">Passwort bestätigen</label>
          <input
            id="confirm-password"
            type="password"
            bind:value={confirmPassword}
            required
            minlength="8"
            class="form-input"
            placeholder="Passwort wiederholen"
            autocomplete="new-password"
          />
          {#if passwordMismatch}
            <p class="field-error">Die Passwörter stimmen nicht überein.</p>
          {/if}
        </div>

        <button type="submit" disabled={!canSubmit} class="btn btn-primary login-submit">
          {#if loading}
            <span class="login-spinner"></span>
            Speichern…
          {:else}
            Passwort speichern
          {/if}
        </button>
      </form>

      <div class="back-footer">
        <a href="/login" class="back-link">Zurück zur Anmeldung</a>
      </div>
    {/if}
  </div>
</div>

<style>
  .login-page {
    min-height: 100vh;
    background-color: var(--color-bg-subtle);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .login-card {
    background: var(--color-surface, #fff);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: 2.5rem;
    width: 100%;
    max-width: 420px;
  }

  .login-logo {
    text-align: center;
    margin-bottom: 2rem;
  }
  .login-logo-icon {
    display: inline-block;
    font-size: 2.5rem;
    margin-bottom: 0.75rem;
    line-height: 1;
  }
  .login-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-brand);
    margin-bottom: 0.375rem;
  }
  .login-subtitle {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
  }

  .login-submit {
    width: 100%;
    padding: 0.7rem 1.25rem;
    font-size: 1rem;
    margin-top: 0.25rem;
    text-align: center;
    text-decoration: none;
    display: inline-block;
  }

  .login-spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .field-error {
    font-size: 0.8125rem;
    color: #dc2626;
    margin-top: 0.25rem;
  }

  .back-footer {
    text-align: center;
    margin-top: 1.5rem;
  }

  .back-link {
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    text-decoration: underline;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
  }

  .alert-error {
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }
  .alert-success {
    background: #f0fdf4;
    color: #166534;
    border: 1px solid #bbf7d0;
  }
</style>
