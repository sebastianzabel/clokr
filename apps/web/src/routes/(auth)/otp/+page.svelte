<script lang="ts">
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Note from "$lib/components/ui/Note.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
  import { homeHref } from "$lib/nav/routes";
  import { preventDefault } from "svelte/legacy";

  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { authStore } from "$stores/auth";
  import { api } from "$api/client";
  import { authPathWithNext, safeAppNext } from "$lib/nav/login-next";

  // Issue #608 (D-20): handed over by the login page, validated again here.
  const next = safeAppNext($page.url.searchParams.get("next"));

  let code = $state("");
  let error = $state("");
  let loading = $state(false);
  let resending = $state(false);
  let resendSuccess = $state(false);
  let userId = "";

  onMount(() => {
    userId = sessionStorage.getItem("otp_userId") ?? "";
    if (!userId) goto(authPathWithNext("/login", next));
  });

  async function handleVerify() {
    if (code.length !== 6) return;
    loading = true;
    error = "";
    try {
      const res = await api.post<{
        accessToken: string;
        refreshToken: string;
        user: {
          id: string;
          email: string;
          employeeId: string | null;
          firstName: string | null;
          permissions?: string[];
        };
      }>("/auth/verify-otp", { userId, code });

      sessionStorage.removeItem("otp_userId");
      authStore.login(res.accessToken, res.refreshToken, res.user);
      goto(next ?? homeHref(res.user)); // #844 (Z-02): the start page of the person
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Ungültiger Code";
      if (msg.includes("abgelaufen")) {
        error = "Der Code ist abgelaufen. Bitte melde dich noch einmal an.";
        setTimeout(() => goto(authPathWithNext("/login", next)), 3000);
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
  <title>Code eingeben – Clokr</title>
</svelte:head>

<AuthFrame
  title="Code eingeben"
  subtitle="Wir haben dir einen Code an deine E-Mail-Adresse geschickt."
>
  <form onsubmit={preventDefault(handleVerify)} class="auth-form">
    {#if error}
      <div role="alert"><Note tone="bad">{error}</Note></div>
    {/if}
    {#if resendSuccess}
      <div role="status"><Note tone="ok">Wir haben dir einen neuen Code geschickt.</Note></div>
    {/if}

    <FormField label="6-stelliger Code">
      {#snippet field({ id, describedBy, invalid })}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          {id}
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
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        />
      {/snippet}
    </FormField>

    <button
      type="submit"
      disabled={loading || code.length !== 6}
      class="btn btn-primary auth-submit"
    >
      {#if loading}<Spinner size={16} label="Code wird geprüft" />{/if}
      Bestätigen
    </button>
  </form>

  {#snippet footer()}
    <div class="otp-resend">
      <span>Code nicht bekommen?</span>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        onclick={handleResend}
        disabled={resending}
      >
        {#if resending}<Spinner size={14} label="Code wird gesendet" />{/if}
        Code noch einmal senden
      </button>
    </div>
    <a href="/login" class="auth-link">Zurück zur Anmeldung</a>
  {/snippet}
</AuthFrame>

<style>
  .otp-resend {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
</style>
