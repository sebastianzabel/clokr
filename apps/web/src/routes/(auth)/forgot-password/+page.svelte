<script lang="ts">
  import AuthFrame from "$lib/components/auth/AuthFrame.svelte";
  import FormField from "$lib/components/ui/FormField.svelte";
  import Note from "$lib/components/ui/Note.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
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

<AuthFrame
  title="Passwort vergessen"
  subtitle="Gib deine E-Mail-Adresse ein, dann schicken wir dir einen Link zum Zurücksetzen."
>
  {#if success}
    <div role="status">
      <Note tone="ok"
        >Falls es ein Konto mit dieser E-Mail-Adresse gibt, haben wir dir einen Link geschickt.
        Schau in dein Postfach.</Note
      >
    </div>
  {:else}
    <form onsubmit={preventDefault(handleSubmit)} class="auth-form">
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

      <button type="submit" disabled={loading} class="btn btn-primary auth-submit">
        {#if loading}<Spinner size={16} label="Link wird gesendet" />{/if}
        Link senden
      </button>
    </form>
  {/if}

  {#snippet footer()}
    <a href="/login" class="auth-link">Zurück zur Anmeldung</a>
  {/snippet}
</AuthFrame>
