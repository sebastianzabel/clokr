<!--
  SignInSteps - the operator sign-in in two steps (Issue #89, D-03, D-04).

  Step 1 asks for e-mail and password and yields a short-lived challenge; step 2 redeems it with a
  six-digit authenticator code or a recovery code. The component knows nothing about the operator
  client or navigation: it takes the three calls as props, so it is mountable in a unit test.

  Rules it keeps:
  - Every failed step shows one generic message and never names the factor (T-89-08).
  - The sixth digit never submits. A pasted wrong code must not burn one of the five attempts
    (T-89-09), so the button is disabled below six digits and Enter or the button submits.
  - After a failed code the code field is emptied and refocused; the password is never refilled.
  - Branching is on the HTTP status, never on the German text of an error.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
  import type { OperatorAccessGrant, OperatorChallenge, OperatorFactor } from "$lib/operator/types";

  type Step = "password" | "code";
  type NoticeCode = "SESSION_EXPIRED" | "CHALLENGE_EXPIRED";

  interface Props {
    onLogin: (email: string, password: string) => Promise<OperatorChallenge>;
    onVerify: (challengeToken: string, factor: OperatorFactor) => Promise<OperatorAccessGrant>;
    onSuccess: (accessToken: string, expiresIn: number) => void;
    /** Client-side notice shown above step 1 (set by the page from `?abgelaufen=1`). */
    notice?: "SESSION_EXPIRED" | null;
    /** The page's probe found the operator surface switched off on this instance. */
    surfaceOff?: boolean;
  }

  let { onLogin, onVerify, onSuccess, notice = null, surfaceOff = false }: Props = $props();

  const NOTICE_TEXT: Record<NoticeCode, string> = {
    SESSION_EXPIRED: "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
    CHALLENGE_EXPIRED: "Die Eingabe ist abgelaufen. Bitte mit dem Passwort neu beginnen.",
  };

  const GENERIC_FAILURE = "Anmeldung fehlgeschlagen";
  const RATE_LIMITED = "Zu viele Versuche. Bitte später erneut versuchen.";
  const NO_CONNECTION = "Keine Verbindung zum Server. Bitte erneut versuchen.";
  const SERVER_FAILURE = "Der Server hat einen Fehler gemeldet. Bitte erneut versuchen.";

  let step = $state<Step>("password");
  let email = $state("");
  let password = $state("");
  let showPassword = $state(false);
  let code = $state("");
  let recovery = $state("");
  let useRecovery = $state(false);
  let challengeToken = $state("");

  let pending = $state(false);
  let done = $state(false);
  let errorText = $state("");
  let challengeExpired = $state(false);
  let noticeDismissed = $state(false);
  let surfaceOffSeen = $state(false);

  let emailEl = $state<HTMLInputElement | null>(null);
  let passwordEl = $state<HTMLInputElement | null>(null);
  let codeEl = $state<HTMLInputElement | null>(null);
  let recoveryEl = $state<HTMLInputElement | null>(null);

  let challengeTimer: ReturnType<typeof setTimeout> | undefined;

  const isOff = $derived(surfaceOff || surfaceOffSeen);
  const activeNotice = $derived<NoticeCode | null>(
    noticeDismissed ? null : challengeExpired ? "CHALLENGE_EXPIRED" : notice,
  );
  const canSubmitCode = $derived(
    !pending && !done && (useRecovery ? recovery.trim() !== "" : code.length === 6),
  );

  function clearChallengeTimer() {
    if (challengeTimer !== undefined) clearTimeout(challengeTimer);
    challengeTimer = undefined;
  }

  onMount(() => {
    emailEl?.focus();
  });

  onDestroy(clearChallengeTimer);

  function statusOf(error: unknown): number | undefined {
    const status = (error as { status?: unknown } | null | undefined)?.status;
    return typeof status === "number" ? status : undefined;
  }

  /** The text to show for a failed call; decided by status only. */
  function describeFailure(error: unknown): string {
    const status = statusOf(error);
    if (status === undefined) return NO_CONNECTION;
    if (status === 429) return RATE_LIMITED;
    if (status >= 500) return SERVER_FAILURE;
    // 401 and every other refusal carry the API's one generic message.
    const message = (error as { message?: unknown }).message;
    return status === 401 && typeof message === "string" && message.trim()
      ? message
      : GENERIC_FAILURE;
  }

  async function backToPassword() {
    clearChallengeTimer();
    step = "password";
    code = "";
    recovery = "";
    useRecovery = false;
    challengeToken = "";
    password = "";
    errorText = "";
    await tick();
    (email ? passwordEl : emailEl)?.focus();
  }

  function startChallengeTimer(expiresInSeconds: number) {
    clearChallengeTimer();
    challengeTimer = setTimeout(() => {
      challengeTimer = undefined;
      challengeExpired = true;
      noticeDismissed = false;
      void backToPassword();
    }, expiresInSeconds * 1000);
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    if (pending || email.trim() === "" || password === "") return;
    pending = true;
    errorText = "";
    noticeDismissed = true;
    challengeExpired = false;
    try {
      const challenge = await onLogin(email.trim(), password);
      challengeToken = challenge.challengeToken;
      password = "";
      showPassword = false;
      step = "code";
      startChallengeTimer(challenge.expiresIn);
      await tick();
      codeEl?.focus();
    } catch (error) {
      if (statusOf(error) === 404) {
        surfaceOffSeen = true;
      } else {
        errorText = describeFailure(error);
      }
    } finally {
      pending = false;
    }
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmitCode) return;
    pending = true;
    errorText = "";
    try {
      const factor: OperatorFactor = useRecovery ? { recoveryCode: recovery.trim() } : { code };
      const grant = await onVerify(challengeToken, factor);
      clearChallengeTimer();
      done = true;
      onSuccess(grant.accessToken, grant.expiresIn);
    } catch (error) {
      if (statusOf(error) === 404) {
        surfaceOffSeen = true;
        return;
      }
      errorText = describeFailure(error);
      code = "";
      recovery = "";
      await tick();
      (useRecovery ? recoveryEl : codeEl)?.focus();
    } finally {
      pending = false;
    }
  }

  function handleCodeInput(event: Event) {
    const el = event.currentTarget as HTMLInputElement;
    code = el.value.replace(/\D/g, "").slice(0, 6);
    el.value = code;
  }

  async function toggleRecovery() {
    useRecovery = !useRecovery;
    code = "";
    recovery = "";
    errorText = "";
    await tick();
    (useRecovery ? recoveryEl : codeEl)?.focus();
  }
</script>

<div class="op-signin">
  {#if isOff}
    <p class="op-off" data-testid="op-surface-off">
      Der Betreiberzugang ist auf dieser Instanz nicht eingerichtet.
    </p>
  {:else}
    {#if step === "password" && activeNotice}
      <div class="callout brand" data-testid="op-signin-notice" data-code={activeNotice}>
        <p>{NOTICE_TEXT[activeNotice]}</p>
      </div>
    {/if}

    {#if errorText}
      <div class="alert alert-error" role="alert" data-testid="op-signin-error">
        <span>{errorText}</span>
      </div>
    {/if}

    {#if step === "password"}
      <form class="op-form" data-testid="op-signin-step-password" onsubmit={submitPassword}>
        <div class="form-group">
          <label class="form-label" for="op-signin-email-input">E-Mail-Adresse</label>
          <input
            id="op-signin-email-input"
            type="email"
            class="form-input"
            data-testid="op-signin-email"
            autocomplete="username"
            required
            bind:value={email}
            bind:this={emailEl}
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="op-signin-password-input">Passwort</label>
          <div class="input-wrapper">
            <input
              id="op-signin-password-input"
              type={showPassword ? "text" : "password"}
              class="form-input form-input--password"
              data-testid="op-signin-password"
              autocomplete="current-password"
              required
              bind:value={password}
              bind:this={passwordEl}
            />
            <button
              type="button"
              class="password-toggle"
              data-testid="op-signin-password-toggle"
              aria-label={showPassword ? "Passwort verbergen" : "Passwort anzeigen"}
              onclick={() => {
                showPassword = !showPassword;
              }}
            >
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
              >
                {#if showPassword}
                  <path
                    d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                  />
                  <line x1="1" x2="23" y1="1" y2="23" />
                {:else}
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                {/if}
              </svg>
            </button>
          </div>
        </div>

        <button
          type="submit"
          class="btn btn-primary op-submit"
          data-testid="op-signin-next"
          disabled={pending}
        >
          {#if pending}
            <Spinner size={14} label="Wird geprüft" />
            Wird geprüft …
          {:else}
            Passwort bestätigen
          {/if}
        </button>
      </form>
    {:else}
      <form class="op-form" data-testid="op-signin-step-code" onsubmit={submitCode}>
        <div class="op-step-head">
          <h2 class="op-step-title">Code bestätigen</h2>
          <p class="op-step-sub">
            {#if useRecovery}
              Einen der Wiederherstellungscodes eingeben. Jeder Code gilt nur einmal.
            {:else}
              Sechsstelligen Code aus der Authenticator-App eingeben.
            {/if}
          </p>
        </div>

        {#if useRecovery}
          <div class="form-group">
            <label class="form-label" for="op-signin-recovery-input">Wiederherstellungscode</label>
            <input
              id="op-signin-recovery-input"
              type="text"
              class="form-input op-recovery"
              data-testid="op-signin-recovery"
              maxlength="64"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              bind:value={recovery}
              bind:this={recoveryEl}
            />
          </div>
        {:else}
          <div class="form-group">
            <label class="form-label" for="op-signin-code-input">6-stelliger Code</label>
            <input
              id="op-signin-code-input"
              type="text"
              class="form-input otp-input"
              data-testid="op-signin-code"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="000000"
              value={code}
              oninput={handleCodeInput}
              bind:this={codeEl}
            />
          </div>
        {/if}

        <button
          type="submit"
          class="btn btn-primary op-submit"
          data-testid="op-signin-submit"
          disabled={!canSubmitCode}
        >
          {#if pending}
            <Spinner size={14} label="Wird bestätigt" />
            Wird bestätigt …
          {:else}
            Anmeldung abschließen
          {/if}
        </button>

        <div class="op-step-links">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="op-signin-recovery-toggle"
            onclick={toggleRecovery}
          >
            {useRecovery
              ? "Stattdessen Authenticator-Code verwenden"
              : "Wiederherstellungscode verwenden"}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-testid="op-signin-back"
            onclick={backToPassword}
          >
            Zurück
          </button>
        </div>
      </form>
    {/if}
  {/if}
</div>

<style>
  .op-signin {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .op-off {
    margin: 0;
    font-size: 16px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .op-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .op-step-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .op-step-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }

  .op-step-sub {
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .op-recovery {
    font-family: var(--font-mono);
    text-transform: uppercase;
  }

  .op-submit {
    width: 100%;
    justify-content: center;
    gap: 8px;
  }

  .op-step-links {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
  }
</style>
