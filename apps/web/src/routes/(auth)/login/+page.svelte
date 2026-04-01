<script lang="ts">
  import { preventDefault } from "svelte/legacy";

  import { goto } from "$app/navigation";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";

  let email = $state("");
  let password = $state("");
  let error = $state("");
  let loading = $state(false);
  let showPassword = $state(false);
  let rememberMe = $state(false);

  async function handleLogin() {
    loading = true;
    error = "";
    try {
      const res = await api.post<
        | {
            accessToken: string;
            refreshToken: string;
            user: {
              id: string;
              email: string;
              role: "ADMIN" | "MANAGER" | "EMPLOYEE";
              employeeId: string | null;
            };
            sessionConfig?: { sessionTimeoutMinutes: number; rememberMeEnabled: boolean };
          }
        | { requiresOtp: true; userId: string }
      >("/auth/login", { email, password, rememberMe });

      if ("requiresOtp" in res && res.requiresOtp) {
        sessionStorage.setItem("otp_userId", res.userId);
        goto("/otp");
        return;
      }

      if ("accessToken" in res) {
        authStore.login(res.accessToken, res.refreshToken, res.user);
        // Store session timeout for inactivity timer
        if (res.sessionConfig?.sessionTimeoutMinutes) {
          localStorage.setItem(
            "clokr_session_timeout",
            String(res.sessionConfig.sessionTimeoutMinutes),
          );
        }
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
  <div class="login-container">
    <!-- Left brand panel (desktop only) -->
    <div class="login-brand-panel">
      <div class="login-brand-content">
        <img src="/clokr-logo.png" alt="Clokr" class="login-brand-logo" />
        <h1 class="login-brand-title">Zeiterfassung, die einfach funktioniert.</h1>
        <ul class="login-brand-features">
          <li>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
            >
            Stempeluhr & NFC
          </li>
          <li>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
            >
            Urlaubs- & Abwesenheitsverwaltung
          </li>
          <li>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
            >
            Berichte & DATEV-Export
          </li>
          <li>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg
            >
            ArbZG-konform
          </li>
        </ul>
      </div>
    </div>

    <!-- Right form panel -->
    <div class="login-form-panel">
      <div class="login-card">
        <div class="login-logo">
          <img src="/clokr-icon.png" alt="Clokr" class="login-logo-img" />
          <span class="login-logo-text">Clokr</span>
        </div>
        <h2 class="login-heading">Willkommen zurück</h2>
        <p class="login-subtitle">Bitte melden Sie sich an</p>

        <form onsubmit={preventDefault(handleLogin)} class="login-form">
          {#if error}
            <div class="alert alert-error" role="alert">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line
                  x1="12"
                  x2="12.01"
                  y1="16"
                  y2="16"
                /></svg
              >
              <span>{error}</span>
            </div>
          {/if}

          <div class="form-group">
            <label class="form-label" for="email">E-Mail-Adresse</label>
            <div class="input-wrapper">
              <svg
                class="input-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><rect width="20" height="16" x="2" y="4" rx="2" /><path
                  d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"
                /></svg
              >
              <input
                id="email"
                type="email"
                bind:value={email}
                required
                class="form-input form-input--icon"
                placeholder="max@firma.de"
                autocomplete="email"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="password">Passwort</label>
            <div class="input-wrapper">
              <svg
                class="input-icon"
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path
                  d="M7 11V7a5 5 0 0 1 10 0v4"
                /></svg
              >
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                bind:value={password}
                required
                class="form-input form-input--icon form-input--password"
                placeholder="••••••••"
                autocomplete="current-password"
              />
              <button
                type="button"
                class="password-toggle"
                onclick={() => {
                  showPassword = !showPassword;
                }}
                aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
              >
                {#if showPassword}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><path
                      d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                    /><line x1="1" x2="23" y1="1" y2="23" /></svg
                  >
                {:else}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle
                      cx="12"
                      cy="12"
                      r="3"
                    /></svg
                  >
                {/if}
              </button>
            </div>
          </div>

          <div class="login-options">
            <label class="remember-me">
              <input type="checkbox" bind:checked={rememberMe} />
              Angemeldet bleiben
            </label>
            <a href="/forgot-password" class="forgot-link">Passwort vergessen?</a>
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
      </div>
    </div>
  </div>
</div>

<style>
  .login-page {
    min-height: 100dvh;
    background: var(--color-bg);
    display: flex;
    align-items: stretch;
    position: relative;
    overflow: hidden;
  }

  /* Animated gradient orbs in background */
  .login-page::before,
  .login-page::after {
    content: "";
    position: absolute;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.15;
    pointer-events: none;
    z-index: 0;
  }

  .login-page::before {
    width: 600px;
    height: 600px;
    background: var(--color-brand);
    top: -200px;
    right: -100px;
    animation: float-orb 20s ease-in-out infinite;
  }

  .login-page::after {
    width: 400px;
    height: 400px;
    background: var(--color-brand-light);
    bottom: -100px;
    left: -50px;
    animation: float-orb 15s ease-in-out infinite reverse;
  }

  @keyframes float-orb {
    0%,
    100% {
      transform: translate(0, 0) scale(1);
    }
    33% {
      transform: translate(30px, -30px) scale(1.05);
    }
    66% {
      transform: translate(-20px, 20px) scale(0.95);
    }
  }

  .login-container {
    display: flex;
    width: 100%;
    min-height: 100dvh;
    position: relative;
    z-index: 1;
  }

  /* ── Left brand panel ──────────────────────────────────── */
  .login-brand-panel {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3rem;
    background: linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-dark) 100%);
    color: #fff;
    position: relative;
    overflow: hidden;
  }

  .login-brand-panel::before {
    content: "";
    position: absolute;
    inset: 0;
    background: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
    opacity: 0.5;
  }

  .login-brand-content {
    position: relative;
    max-width: 400px;
  }

  .login-brand-logo {
    max-width: 180px;
    height: auto;
    margin-bottom: 2rem;
    border-radius: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  }

  .login-brand-title {
    font-size: 2rem;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 2rem;
    color: #fff;
    text-wrap: balance;
  }

  .login-brand-features {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .login-brand-features li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 1.0625rem;
    font-weight: 400;
    opacity: 0.9;
  }

  .login-brand-features svg {
    flex-shrink: 0;
    opacity: 0.8;
  }

  /* ── Right form panel ──────────────────────────────────── */
  .login-form-panel {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: var(--color-bg);
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    animation: page-enter 0.4s var(--ease-out, ease) both;
  }

  @keyframes page-enter {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .login-logo {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin-bottom: 2rem;
  }

  .login-logo-img {
    width: 40px;
    height: 40px;
    border-radius: 10px;
  }

  .login-logo-text {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-brand);
  }

  .login-heading {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--color-text-heading);
    margin-bottom: 0.375rem;
  }

  .login-subtitle {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
    margin-bottom: 2rem;
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* ── Input with icon ───────────────────────────────────── */
  .input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .input-icon {
    position: absolute;
    left: 0.875rem;
    color: var(--gray-400);
    pointer-events: none;
    z-index: 1;
  }

  .form-input--icon {
    padding-left: 2.5rem;
  }

  .form-input--password {
    padding-right: 2.75rem;
  }

  .password-toggle {
    position: absolute;
    right: 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.375rem;
    border-radius: var(--radius-sm);
    color: var(--gray-400);
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      color 0.15s,
      background-color 0.15s;
  }

  .password-toggle:hover {
    color: var(--color-text);
    background-color: var(--color-bg-subtle);
  }

  .login-submit {
    width: 100%;
    padding: 0.75rem 1.25rem;
    font-size: 1rem;
    margin-top: 0.5rem;
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

  .login-options {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: -0.25rem;
  }
  .remember-me {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: var(--color-text-muted);
    cursor: pointer;
  }
  .remember-me input {
    cursor: pointer;
  }
  .forgot-link {
    font-size: 0.8125rem;
    color: var(--color-brand);
    text-decoration: none;
  }
  .forgot-link:hover {
    text-decoration: underline;
  }

  .forgot-password-link a:hover {
    text-decoration: underline;
  }

  /* ── Responsive ────────────────────────────────────────── */
  @media (max-width: 900px) {
    .login-brand-panel {
      display: none;
    }

    .login-form-panel {
      padding: 1.5rem;
    }

    .login-card {
      max-width: 420px;
    }

    .login-logo {
      justify-content: center;
    }

    .login-heading,
    .login-subtitle {
      text-align: center;
    }
  }
</style>
