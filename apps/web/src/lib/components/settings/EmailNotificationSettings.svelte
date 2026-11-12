<script lang="ts">
  // Issue #602 (Phase 851, prototype „Benachrichtigungen“): which e-mails a person wants - one switch per
  // group of the tenant's switchable notifications (PERSONAL_EMAIL_OPT_OUT_FIELDS on the server). A
  // switch saves at once (docs/ADMIN_STRUCTURE.md §3.2.1). Security and legal notices (e.g. expiring
  // vacation) are always mailed and have no switch; the in-app notice stays in every case.
  import { onMount } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import { toasts } from "$stores/toast";
  import { fetchPreferences, savePreferences, type EmailOptOutField } from "$api/preferences";

  const GROUPS: { field: EmailOptOutField; title: string; sub: string }[] = [
    {
      field: "emailOnLeaveDecision",
      title: "Antrag entschieden",
      sub: "wenn dein Urlaub genehmigt, abgelehnt oder angepasst wird",
    },
    {
      field: "emailOnRetroEntry",
      title: "Zeitnachträge",
      sub: "wenn ein Nachtrag beantragt, geändert oder entschieden wird",
    },
    {
      field: "emailOnMissingEntries",
      title: "Fehlende Zeiten und Pausen",
      sub: "Hinweise auf fehlende Einträge und nicht bestätigte Pausen",
    },
    {
      field: "emailOnLeaveRequest",
      title: "Neue Anträge im Team",
      sub: "nur, wenn du Anträge entscheidest",
    },
  ];

  let loading = $state(true);
  let optOut = $state<EmailOptOutField[]>([]);
  let saving = $state<EmailOptOutField | null>(null);

  onMount(async () => {
    try {
      optOut = (await fetchPreferences()).emailOptOut ?? [];
    } finally {
      loading = false;
    }
  });

  async function toggle(field: EmailOptOutField, on: boolean) {
    const next = on ? optOut.filter((f) => f !== field) : [...new Set([...optOut, field])];
    const before = optOut;
    optOut = next;
    saving = field;
    try {
      optOut = (await savePreferences({ emailOptOut: next })).emailOptOut ?? next;
      toasts.success(on ? "E-Mails dazu eingeschaltet" : "E-Mails dazu ausgeschaltet");
    } catch {
      optOut = before;
      toasts.error("Die Einstellung ließ sich nicht speichern. Bitte versuche es noch einmal.");
    } finally {
      saving = null;
    }
  }
</script>

<Section
  title="Benachrichtigungen"
  sub="Welche E-Mails du bekommst. In Clokr siehst du jede Benachrichtigung weiterhin."
>
  {#if loading}
    <Skeleton shape="row" count={4} />
  {:else}
    <ul class="mail-list" data-testid="email-notification-settings">
      {#each GROUPS as g (g.field)}
        {@const on = !optOut.includes(g.field)}
        <li class="mail-row">
          <label class="mail-label" for="mail-{g.field}">
            <span class="mail-title">{g.title}</span>
            <span class="mail-sub">{g.sub}</span>
          </label>
          <input
            id="mail-{g.field}"
            type="checkbox"
            role="switch"
            class="mail-switch"
            checked={on}
            aria-checked={on}
            disabled={saving === g.field}
            onchange={(e) => toggle(g.field, (e.currentTarget as HTMLInputElement).checked)}
          />
        </li>
      {/each}
    </ul>
    <p class="mail-hint">
      Hinweise zur Sicherheit deines Kontos und gesetzliche Hinweise, etwa zu verfallendem Urlaub,
      bekommst du immer. E-Mails gehen nur raus, wenn dein Betrieb sie für diese Art eingeschaltet
      hat.
    </p>
  {/if}
</Section>

<style>
  .mail-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .mail-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    min-height: var(--h-row);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--line);
  }
  .mail-row:last-child {
    border-bottom: 0;
  }
  .mail-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;
  }
  .mail-title {
    font-weight: 500;
  }
  .mail-sub {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .mail-switch {
    appearance: none;
    flex-shrink: 0;
    width: 36px;
    height: 20px;
    border-radius: var(--r-pill);
    background: var(--line);
    position: relative;
    cursor: pointer;
    transition: background 0.15s;
  }
  .mail-switch::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--card);
    transition: transform 0.15s;
  }
  .mail-switch:checked {
    background: var(--brand);
  }
  .mail-switch:checked::after {
    transform: translateX(16px);
  }
  .mail-switch:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .mail-hint {
    margin: var(--s-3) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
</style>
