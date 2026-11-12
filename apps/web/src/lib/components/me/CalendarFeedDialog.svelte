<script lang="ts">
  // Issue #597 (Phase 851, prototype „Dienstplan“ › Kalender abonnieren): the own calendar
  // subscription. The link is shown once, right after it was created or replaced, to copy into
  // Google or Apple Kalender; afterwards the page only knows that a subscription exists. Replacing
  // ends the old link at once, ending removes it. The content rules (Schicht, Urlaub, Abwesend,
  // Feiertage) live in the API (#903).
  import Dialog from "$components/ui/Dialog.svelte";
  import Note from "$components/ui/Note.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import {
    issueCalendarFeed,
    lastUsedText,
    revokeCalendarFeed,
    type CalendarFeedIssued,
    type CalendarFeedState,
  } from "$lib/me/calendar-feed";

  interface Props {
    open: boolean;
    feed: CalendarFeedState;
    onChange: (next: CalendarFeedState) => void;
  }

  let { open = $bindable(), feed, onChange }: Props = $props();

  let issued = $state<CalendarFeedIssued | null>(null);
  let busy = $state<"issue" | "revoke" | null>(null);
  let confirmRevoke = $state(false);

  $effect(() => {
    if (!open) {
      issued = null;
      confirmRevoke = false;
    }
  });

  async function issue() {
    busy = "issue";
    try {
      issued = await issueCalendarFeed();
      onChange({
        active: issued.active,
        createdAt: issued.createdAt,
        rotatedAt: issued.rotatedAt,
        lastUsedAt: issued.lastUsedAt,
      });
    } catch {
      toasts.error("Der Link ließ sich nicht erstellen. Bitte versuche es noch einmal.");
    } finally {
      busy = null;
    }
  }

  async function revoke() {
    busy = "revoke";
    try {
      await revokeCalendarFeed();
      onChange({ active: false, createdAt: null, rotatedAt: null, lastUsedAt: null });
      toasts.success("Kalender-Abo beendet · der Link funktioniert nicht mehr");
      open = false;
    } catch {
      toasts.error("Das Abo ließ sich nicht beenden. Bitte versuche es noch einmal.");
    } finally {
      busy = null;
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      toasts.success("Abo-Link kopiert · in Google oder Apple Kalender einfügen");
    } catch {
      toasts.error("Kopieren hat nicht geklappt. Markiere den Link und kopiere ihn selbst.");
    }
  }
</script>

<Dialog bind:open title="Kalender abonnieren">
  <div class="cf-body" data-testid="calendar-feed-dialog">
    <p class="cf-text">
      Deine Schichten, dein Urlaub und die Feiertage erscheinen in deinem Kalender und bleiben dort
      aktuell. Krankheit steht dort nur als „Abwesend“.
    </p>

    {#if issued}
      <Note tone="warn"
        >Dieser Link ist nur jetzt sichtbar. Wer ihn hat, sieht deinen Dienstplan - gib ihn nicht
        weiter.</Note
      >
      <input
        class="form-input cf-url"
        readonly
        value={issued.url}
        aria-label="Abo-Link"
        data-testid="calendar-feed-url"
        onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
      />
      <div class="cf-row">
        <button type="button" class="btn btn-primary btn-sm" onclick={copy}>Link kopieren</button>
        <a class="btn btn-secondary btn-sm" href={issued.webcalUrl}>In Kalender-App öffnen</a>
      </div>
    {:else if feed.active}
      <p class="cf-status" data-testid="calendar-feed-status">
        Dein Abo ist eingerichtet. {lastUsedText(feed)}.
      </p>
      {#if confirmRevoke}
        <Note tone="warn">Beenden? Dein Kalender zeigt den Dienstplan danach nicht mehr an.</Note>
      {:else}
        <p class="cf-hint">
          Neuer Link: der bisherige hört sofort auf zu funktionieren, zum Beispiel wenn du ihn aus
          Versehen geteilt hast.
        </p>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    {#if issued}
      <button type="button" class="btn btn-secondary" onclick={() => (open = false)}>Fertig</button>
    {:else if feed.active && confirmRevoke}
      <button type="button" class="btn btn-secondary" onclick={() => (confirmRevoke = false)}
        >Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-danger"
        disabled={busy !== null}
        onclick={revoke}
        data-testid="calendar-feed-revoke-confirm"
      >
        {#if busy === "revoke"}<Spinner size={14} label="Wird beendet" />{/if}
        Abo beenden
      </button>
    {:else if feed.active}
      <button type="button" class="btn btn-ghost" onclick={() => (confirmRevoke = true)}
        >Abo beenden</button
      >
      <button
        type="button"
        class="btn btn-primary"
        disabled={busy !== null}
        onclick={issue}
        data-testid="calendar-feed-issue"
      >
        {#if busy === "issue"}<Spinner size={14} label="Wird erstellt" />{/if}
        Neuen Link erstellen
      </button>
    {:else}
      <button type="button" class="btn btn-secondary" onclick={() => (open = false)}
        >Abbrechen</button
      >
      <button
        type="button"
        class="btn btn-primary"
        disabled={busy !== null}
        onclick={issue}
        data-testid="calendar-feed-issue"
      >
        {#if busy === "issue"}<Spinner size={14} label="Wird erstellt" />{/if}
        Link erstellen
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .cf-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .cf-text,
  .cf-status,
  .cf-hint {
    margin: 0;
    color: var(--text-2);
  }
  .cf-url {
    width: 100%;
    font-family: var(--font-code);
    font-size: 12.5px;
  }
  .cf-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
</style>
