<script lang="ts">
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Note from "$lib/components/ui/Note.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
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

  // Issue #855 (D-855-03): every state is a title, one sentence and one action.
  const STATE_TITLES = {
    form: "Konto aktivieren",
    success: "Konto aktiviert",
    expired: "Link abgelaufen",
    used: "Schon aktiviert",
    invalid: "Link ungültig",
  } as const;

  let pwPolicy = $state({
    passwordMinLength: 12,
    passwordRequireUpper: true,
    passwordRequireLower: true,
    passwordRequireDigit: true,
    passwordRequireSpecial: true,
  });

  onMount(async () => {
    token = page.url.searchParams.get("token") ?? "";
    if (!token) {
      pageState = "invalid";
      return;
    }
    try {
      const p = await api.get<typeof pwPolicy>("/auth/password-policy");
      pwPolicy = p;
    } catch {
      /* use defaults */
    }
  });

  async function handleSubmit() {
    if (password !== passwordConfirm) {
      error = "Die Passwörter stimmen nicht überein.";
      return;
    }
    if (password.length < pwPolicy.passwordMinLength) {
      error = `Dein Passwort braucht mindestens ${pwPolicy.passwordMinLength} Zeichen.`;
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
        error = msg || "Das Konto ließ sich nicht aktivieren. Bitte versuche es noch einmal.";
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Konto aktivieren – Clokr</title>
</svelte:head>

<AuthFrame
  title={STATE_TITLES[pageState]}
  subtitle={pageState === "form" ? "Leg ein Passwort für dein Konto fest." : undefined}
>
  {#if pageState === "invalid"}
    <div role="alert">
      <Note tone="bad"
        >Dieser Einladungslink ist ungültig. Bitte wende dich an deine Administration.</Note
      >
    </div>
    <a href="/login" class="btn btn-primary auth-submit">Zur Anmeldung</a>
  {:else if pageState === "expired"}
    <div role="alert">
      <Note tone="warn"
        >Dieser Einladungslink ist abgelaufen (er gilt 24 Stunden). Bitte deine Administration um
        einen neuen Link.</Note
      >
    </div>
    <a href="/login" class="btn btn-primary auth-submit">Zur Anmeldung</a>
  {:else if pageState === "used"}
    <div role="status">
      <Note tone="info">Dieses Konto ist schon aktiviert. Du kannst dich direkt anmelden.</Note>
    </div>
    <a href="/login" class="btn btn-primary auth-submit">Zur Anmeldung</a>
  {:else if pageState === "success"}
    <div role="status">
      <Note tone="ok">Dein Passwort ist gesetzt. Du kannst dich jetzt anmelden.</Note>
    </div>
    <a href="/login" class="btn btn-primary auth-submit">Zur Anmeldung</a>
  {:else}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      class="auth-form"
    >
      {#if error}
        <div role="alert"><Note tone="bad">{error}</Note></div>
      {/if}

      <FormField label="Passwort">
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="password"
            bind:value={password}
            required
            minlength="8"
            class="form-input"
            placeholder="Mindestens {pwPolicy.passwordMinLength} Zeichen"
            autocomplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
          <PasswordStrength {password} policy={pwPolicy} />
        {/snippet}
      </FormField>

      <FormField label="Passwort bestätigen">
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            type="password"
            bind:value={passwordConfirm}
            required
            class="form-input"
            placeholder="Passwort wiederholen"
            autocomplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        {/snippet}
      </FormField>

      <button type="submit" disabled={loading} class="btn btn-primary auth-submit">
        {#if loading}<Spinner size={16} label="Konto wird aktiviert" />{/if}
        Konto aktivieren
      </button>
    </form>
  {/if}
</AuthFrame>
