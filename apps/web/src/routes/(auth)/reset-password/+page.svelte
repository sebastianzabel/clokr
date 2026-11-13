<script lang="ts">
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Note from "$lib/components/ui/Note.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
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
  let canSubmit = $derived(
    password.length >= pwPolicy.passwordMinLength && password === confirmPassword && !loading,
  );

  onMount(async () => {
    try {
      const p = await api.get<typeof pwPolicy>("/auth/password-policy");
      pwPolicy = p;
    } catch {
      /* use defaults */
    }
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
  <title>Neues Passwort festlegen – Clokr</title>
</svelte:head>

<AuthFrame title="Neues Passwort festlegen" subtitle="Leg ein neues Passwort für dein Konto fest.">
  {#if success}
    <div role="status">
      <Note tone="ok">Dein Passwort ist geändert. Du kannst dich jetzt anmelden.</Note>
    </div>
    <a href="/login" class="btn btn-primary auth-submit">Zur Anmeldung</a>
  {:else if !token}
    <div role="alert">
      <Note tone="bad">Dieser Link ist ungültig. Fordere bitte einen neuen Link an.</Note>
    </div>
    <a href="/forgot-password" class="btn btn-primary auth-submit">Neuen Link anfordern</a>
  {:else}
    <form onsubmit={preventDefault(handleSubmit)} class="auth-form">
      {#if error}
        <div role="alert"><Note tone="bad">{error}</Note></div>
      {/if}

      <FormField label="Neues Passwort">
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="password"
            bind:value={password}
            required
            minlength={pwPolicy.passwordMinLength}
            class="form-input"
            placeholder="Mindestens {pwPolicy.passwordMinLength} Zeichen"
            autocomplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
          <PasswordStrength {password} policy={pwPolicy} />
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
            minlength="8"
            class="form-input"
            placeholder="Passwort wiederholen"
            autocomplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        {/snippet}
      </FormField>

      <button type="submit" disabled={!canSubmit} class="btn btn-primary auth-submit">
        {#if loading}<Spinner size={16} label="Passwort wird gespeichert" />{/if}
        Passwort speichern
      </button>
    </form>
  {/if}

  {#snippet footer()}
    <a href="/login" class="auth-link">Zurück zur Anmeldung</a>
  {/snippet}
</AuthFrame>
