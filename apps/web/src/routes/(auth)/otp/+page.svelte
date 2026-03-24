<script lang="ts">
  import { preventDefault } from 'svelte/legacy';

  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";

  let code = $state("");
  let error = $state("");
  let loading = $state(false);
  let resending = $state(false);
  let resendSuccess = $state(false);
  let userId = "";

  onMount(() => {
    userId = sessionStorage.getItem("otp_userId") ?? "";
    if (!userId) goto("/login");
  });

  async function handleVerify() {
    if (code.length !== 6) return;
    loading = true;
    error = "";
    try {
      const res = await api.post<{
        accessToken: string;
        refreshToken: string;
        user: { id: string; email: string; role: "ADMIN" | "MANAGER" | "EMPLOYEE"; employeeId: string | null };
      }>("/auth/verify-otp", { userId, code });

      sessionStorage.removeItem("otp_userId");
      authStore.login(res.accessToken, res.refreshToken, res.user);
      goto("/dashboard");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Ungültiger Code";
      if (msg.includes("abgelaufen")) {
        error = "Der Code ist abgelaufen. Bitte melden Sie sich erneut an.";
        setTimeout(() => goto("/login"), 3000);
      } else {
        error = msg;
      }
      code = "";
    } finally {
      loading = false;
    }
  }

  async function handleResend() {
    resending = true;
    resendSuccess = false;
    error = "";
    try {
      await api.post("/auth/resend-otp", { userId });
      resendSuccess = true;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Fehler beim Senden";
    } finally {
      resending = false;
    }
  }

  function handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    code = input.value.replace(/\D/g, "").slice(0, 6);
    if (code.length === 6) handleVerify();
  }
</script>

<svelte:head>
  <title>2FA-Code – Clokr</title>
</svelte:head>

<div class="login-page">
  <div class="login-card">
    <div class="login-logo">
      <span class="login-logo-icon">✂️</span>
      <h1 class="login-title">Zwei-Faktor-Authentifizierung</h1>
      <p class="login-subtitle">Wir haben einen Code an Ihre E-Mail-Adresse gesendet.</p>
    </div>

    <form onsubmit={preventDefault(handleVerify)} class="login-form">
      {#if error}
        <div class="alert alert-error" role="alert">
          <span>⚠</span>
          <span>{error}</span>
        </div>
      {/if}
      {#if resendSuccess}
        <div class="alert alert-success" role="alert">
          <span>✓</span>
          <span>Code erneut gesendet.</span>
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="otp-code">6-stelliger Code</label>
        <input
          id="otp-code"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          value={code}
          oninput={handleInput}
          autofocus
          class="form-input otp-input"
          placeholder="000000"
          autocomplete="one-time-code"
        />
      </div>

      <button type="submit" disabled={loading || code.length !== 6} class="btn btn-primary login-submit">
        {#if loading}
          <span class="login-spinner"></span>
          Prüfen…
        {:else}
          Bestätigen
        {/if}
      </button>
    </form>

    <div class="otp-footer">
      <p class="login-footer">Code nicht erhalten?</p>
      <button class="btn btn-ghost btn-sm" onclick={handleResend} disabled={resending}>
        {resending ? "Senden…" : "Code erneut senden"}
      </button>
      <a href="/login" class="back-link">Zurück zur Anmeldung</a>
    </div>
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

  .login-logo { text-align: center; margin-bottom: 2rem; }
  .login-logo-icon { display: inline-block; font-size: 2.5rem; margin-bottom: 0.75rem; line-height: 1; }
  .login-title { font-size: 1.5rem; font-weight: 700; color: var(--color-brand); margin-bottom: 0.375rem; }
  .login-subtitle { font-size: 0.9375rem; color: var(--color-text-muted); }

  .login-form { display: flex; flex-direction: column; gap: 1.125rem; }

  .otp-input {
    text-align: center;
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: 0.5rem;
    font-variant-numeric: tabular-nums;
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

  @keyframes spin { to { transform: rotate(360deg); } }

  .otp-footer {
    text-align: center;
    margin-top: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .login-footer { font-size: 0.8125rem; color: var(--color-text-muted); margin: 0; }

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

  .alert-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
  .alert-success { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
</style>
