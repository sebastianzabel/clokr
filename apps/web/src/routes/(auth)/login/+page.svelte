<script lang="ts">
  import { preventDefault } from 'svelte/legacy';

  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);

  async function handleLogin() {
    loading = true;
    error = "";
    try {
      const res = await api.post<
        | { accessToken: string; refreshToken: string; user: { id: string; email: string; role: "ADMIN" | "MANAGER" | "EMPLOYEE"; employeeId: string | null } }
        | { requiresOtp: true; userId: string }
      >("/auth/login", { email, password });

      if ("requiresOtp" in res && res.requiresOtp) {
        sessionStorage.setItem("otp_userId", res.userId);
        goto("/otp");
        return;
      }

      if ("accessToken" in res) {
        authStore.login(res.accessToken, res.refreshToken, res.user);
        goto("/dashboard");
      }
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Anmeldung fehlgeschlagen";
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Anmelden – Clokr</title>
</svelte:head>

<div class="login-page">
  <div class="login-card">
    <div class="login-logo">
      <span class="login-logo-icon">✂️</span>
      <h1 class="login-title">Clokr</h1>
      <p class="login-subtitle">Bitte melden Sie sich an</p>
    </div>

    <form onsubmit={preventDefault(handleLogin)} class="login-form">
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
          placeholder="max@salon.de"
          autocomplete="email"
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="password">Passwort</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          class="form-input"
          placeholder="••••••••"
          autocomplete="current-password"
        />
      </div>

      <button type="submit" disabled={loading} class="btn btn-primary login-submit">
        {#if loading}
          <span class="login-spinner"></span>
          Anmelden…
        {:else}
          Anmelden
        {/if}
      </button>
    </form>

    <p class="login-footer">
      Salon Management &amp; Zeiterfassung
    </p>
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
    background: #fff;
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
    to { transform: rotate(360deg); }
  }

  .login-footer {
    text-align: center;
    margin-top: 1.75rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
  }
</style>
