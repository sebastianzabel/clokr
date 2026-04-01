<script lang="ts">
  import { preventDefault } from "svelte/legacy";

  import { api } from "$api/client";

  let email = $state("");
  let error = $state("");
  let loading = $state(false);
  let success = $state(false);

  async function handleSubmit() {
    loading = true;
    error = "";
    try {
      await api.post("/auth/forgot-password", { email });
      success = true;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Ein Fehler ist aufgetreten";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Passwort vergessen – Clokr</title>
</svelte:head>

<div class="login-page">
  <div class="login-card">
    <div class="login-logo">
      <span class="login-logo-icon">⏱️</span>
      <h1 class="login-title">Passwort vergessen</h1>
      <p class="login-subtitle">
        Geben Sie Ihre E-Mail-Adresse ein, um einen Link zum Zurücksetzen zu erhalten.
      </p>
    </div>

    {#if success}
      <div class="alert alert-success" role="alert">
        <span>✓</span>
        <span
          >Falls ein Konto mit dieser E-Mail existiert, haben wir einen Link zum Zurücksetzen
          gesendet.</span
        >
      </div>
      <div class="back-footer">
        <a href="/login" class="back-link">Zurück zur Anmeldung</a>
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
          <label class="form-label" for="email">E-Mail-Adresse</label>
          <input
            id="email"
            type="email"
            bind:value={email}
            required
            class="form-input"
            placeholder="max@clokr.de"
            autocomplete="email"
          />
        </div>

        <button type="submit" disabled={loading} class="btn btn-primary login-submit">
          {#if loading}
            <span class="login-spinner"></span>
            Senden…
          {:else}
            Link senden
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
    min-height: 100dvh;
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
