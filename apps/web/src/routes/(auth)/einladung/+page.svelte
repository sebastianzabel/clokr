<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { api } from "$api/client";
  import PasswordStrength from "$lib/components/ui/PasswordStrength.svelte";

  let token = $state("");
  let password = $state("");
  let passwordConfirm = $state("");
  let error = $state("");
  let loading = $state(false);
  let pageState = $state<"form" | "success" | "expired" | "used" | "invalid">("form");

  let pwPolicy = $state({
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });

  onMount(async () => {
    token = page.url.searchParams.get("token") ?? "";
    if (!token) { pageState = "invalid"; return; }
    try {
      const p = await api.get<typeof pwPolicy>("/auth/password-policy");
      pwPolicy = p;
    } catch { /* use defaults */ }
  });

  async function handleSubmit() {
    if (password !== passwordConfirm) {
      error = "Passwörter stimmen nicht überein";
      return;
    }
    if (password.length < pwPolicy.passwordMinLength) {
      error = `Passwort muss mindestens ${pwPolicy.passwordMinLength} Zeichen haben`;
      return;
    }
    loading = true;
    error = "";
    try {
      await api.post("/invitations/accept", { token, password });
      pageState = "success";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("abgelaufen") || msg.includes("410")) {
        pageState = "expired";
      } else if (msg.includes("verwendet") || msg.includes("409")) {
        pageState = "used";
      } else {
        error = msg || "Fehler beim Aktivieren des Kontos";
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Konto aktivieren – Clokr</title>
</svelte:head>

<div class="login-page">
  <div class="login-card">
    <div class="login-logo">
      <img src="/clokr-logo.png" alt="Clokr" class="login-logo-img" />
    </div>

    {#if pageState === "invalid"}
      <div class="state-box state-error">
        <span class="state-icon">⚠</span>
        <h2>Ungültiger Link</h2>
        <p>Dieser Einladungslink ist ungültig. Bitte wenden Sie sich an Ihren Administrator.</p>
      </div>
    {:else if pageState === "expired"}
      <div class="state-box state-error">
        <span class="state-icon">⏰</span>
        <h2>Link abgelaufen</h2>
        <p>
          Dieser Einladungslink ist abgelaufen (gültig 24 Stunden). Bitte wenden Sie sich an Ihren
          Administrator, um einen neuen Link zu erhalten.
        </p>
      </div>
    {:else if pageState === "used"}
      <div class="state-box state-warning">
        <span class="state-icon">✓</span>
        <h2>Bereits aktiviert</h2>
        <p>
          Dieses Konto wurde bereits aktiviert. Sie können sich direkt <a href="/login">anmelden</a
          >.
        </p>
      </div>
    {:else if pageState === "success"}
      <div class="state-box state-success">
        <span class="state-icon">✓</span>
        <h2>Konto aktiviert!</h2>
        <p>Ihr Passwort wurde gesetzt. Sie können sich jetzt anmelden.</p>
        <a href="/login" class="btn btn-primary" style="margin-top:1rem;display:inline-block"
          >Zur Anmeldung</a
        >
      </div>
    {:else}
      <p class="login-subtitle" style="text-align:center;margin-bottom:1.5rem">
        Bitte setzen Sie ein Passwort für Ihr Konto.
      </p>

      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        class="login-form"
      >
        {#if error}
          <div class="alert alert-error" role="alert">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        {/if}

        <div class="form-group">
          <label class="form-label" for="password">Passwort</label>
          <input
            id="password"
            type="password"
            bind:value={password}
            required
            minlength="8"
            class="form-input"
            placeholder="Mindestens {pwPolicy.passwordMinLength} Zeichen"
            autocomplete="new-password"
          />
          <PasswordStrength {password} policy={pwPolicy} />
        </div>

        <div class="form-group">
          <label class="form-label" for="password-confirm">Passwort bestätigen</label>
          <input
            id="password-confirm"
            type="password"
            bind:value={passwordConfirm}
            required
            class="form-input"
            placeholder="Passwort wiederholen"
            autocomplete="new-password"
          />
        </div>

        <button type="submit" disabled={loading} class="btn btn-primary login-submit">
          {#if loading}
            <span class="login-spinner"></span>
            Aktivieren…
          {:else}
            Konto aktivieren
          {/if}
        </button>
      </form>
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
    margin-bottom: 1.5rem;
  }
  .login-logo-img {
    max-width: 160px;
    height: auto;
    margin-bottom: 0.75rem;
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

  .state-box {
    text-align: center;
    padding: 1.5rem;
    border-radius: var(--radius-md);
  }

  .state-icon {
    display: block;
    font-size: 2.5rem;
    margin-bottom: 0.75rem;
  }
  .state-box h2 {
    font-size: 1.25rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }
  .state-box p {
    font-size: 0.9375rem;
    color: var(--color-text-muted);
  }
  .state-box a {
    color: var(--color-brand);
  }

  .state-error {
    background: #fef2f2;
    color: #991b1b;
  }
  .state-warning {
    background: #fffbeb;
    color: #92400e;
  }
  .state-success {
    background: #f0fdf4;
    color: #166534;
  }

  .alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: var(--radius-md);
    font-size: 0.875rem;
    background: #fef2f2;
    color: #991b1b;
    border: 1px solid #fecaca;
  }
</style>
