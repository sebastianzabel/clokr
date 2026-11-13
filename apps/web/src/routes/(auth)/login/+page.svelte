<script lang="ts">
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Note from "$lib/components/ui/Note.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
  import { homeHref } from "$lib/nav/routes";
  import { preventDefault } from "svelte/legacy";

  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  import { authPathWithNext, safeAppNext } from "$lib/nav/login-next";

  // Issue #608 (D-20): the page a notification tap (or a lost session) was heading to.
  const next = safeAppNext($page.url.searchParams.get("next"));

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
              employeeId: string | null;
              firstName: string | null;
              permissions?: string[];
            };
            sessionConfig?: { sessionTimeoutMinutes: number; rememberMeEnabled: boolean };
          }
        | { requiresOtp: true; userId: string }
      >("/auth/login", { email, password, rememberMe });

      if ("requiresOtp" in res && res.requiresOtp) {
        sessionStorage.setItem("otp_userId", res.userId);
        goto(authPathWithNext("/otp", next));
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
        goto(next ?? homeHref(res.user)); // #844 (Z-02): the start page of the person
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

<AuthFrame title="Anmelden" subtitle="Schön, dass du da bist.">
  <form onsubmit={preventDefault(handleLogin)} class="auth-form">
    {#if error}
      <div role="alert"><Note tone="bad">{error}</Note></div>
    {/if}

    <FormField label="E-Mail-Adresse">
      {#snippet field({ id, describedBy, invalid })}
        <input
          {id}
          type="email"
          bind:value={email}
          required
          class="form-input"
          placeholder="name@firma.de"
          autocomplete="email"
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      {/snippet}
    </FormField>

    <FormField label="Passwort">
      {#snippet field({ id, describedBy, invalid })}
        <div class="password-wrap">
          <input
            {id}
            type={showPassword ? "text" : "password"}
            bind:value={password}
            required
            class="form-input password-input"
            autocomplete="current-password"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
          <button
            type="button"
            class="password-toggle"
            onclick={() => {
              showPassword = !showPassword;
            }}
            aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
            aria-pressed={showPassword}
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
                aria-hidden="true"
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
                aria-hidden="true"
                ><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle
                  cx="12"
                  cy="12"
                  r="3"
                /></svg
              >
            {/if}
          </button>
        </div>
      {/snippet}
    </FormField>

    <div class="auth-row">
      <label class="remember-me">
        <input type="checkbox" bind:checked={rememberMe} />
        Angemeldet bleiben
      </label>
      <a href="/forgot-password" class="auth-link">Passwort vergessen?</a>
    </div>

    <button type="submit" disabled={loading} class="btn btn-primary auth-submit">
      {#if loading}<Spinner size={16} label="Anmeldung läuft" />{/if}
      Anmelden
    </button>
  </form>
</AuthFrame>

<style>
  .password-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .password-input {
    width: 100%;
    padding-right: var(--s-10);
  }

  .password-toggle {
    position: absolute;
    right: var(--s-1);
    width: var(--h-control-sm);
    height: var(--h-control-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: var(--r-control);
    color: var(--text-2);
    cursor: pointer;
  }

  .password-toggle:hover {
    color: var(--text);
    background: var(--hover);
  }

  .remember-me {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-2);
    cursor: pointer;
  }
</style>
