<!--
  DienstplanSettingsPanel - „Einstellungen“ of Regeln › Dienstplan (Issue #854, D-854-03): the settings that
  govern the roster, moved here from the System and Urlaub pages. Every setting lives exactly once
  (lib/settings/settings-pages.ts). Each section keeps its own snapshot, shows its own SaveBar and sends only
  its own registry keys to `PUT /settings/work` (#878); a person sees a section only under the permission
  alternatives of the page it came from (D-854-05).

  Props:
    config  - the loaded `GET /settings/work` answer
    changes - bindable, the number of unsaved changes of all sections (the page sums it into markUnsaved)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { toasts } from "$stores/toast";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import { countChanges, pickSection } from "$lib/settings/section-state";
  import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";
  import {
    STORE_HOURS_MODES,
    hoursModeFrom,
    hoursModeWire,
    type DienstplanConfig,
    type HoursModeField,
    type HoursModeValues,
  } from "$lib/settings/dienstplan";

  interface Props {
    config: DienstplanConfig;
    changes?: number;
  }

  // `changes` is write-only here: the parent reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { config, changes = $bindable(0) }: Props = $props();

  const user = $derived($authStore.user);
  const show = $derived({
    hours: mayOpenSection(user, settingsSection("dienstplan-oeffnungszeiten")),
  });

  // ── Schichten und Öffnungszeiten ─────────────────────────────────────────────────────────────
  // The baseline is read once on purpose: afterwards the section owns its snapshot.
  let hoursSnapshot = $state<HoursModeValues>(untrack(() => hoursModeFrom(config)));
  let hours = $state<HoursModeValues>(untrack(() => hoursModeFrom(config)));
  let hoursSaving = $state(false);
  const hoursChanges = $derived(
    countChanges(
      hoursSnapshot,
      hours,
      settingsSection("dienstplan-oeffnungszeiten").keys as readonly HoursModeField[],
    ),
  );

  async function saveHours() {
    hoursSaving = true;
    try {
      // Minimal payload on purpose: only the mode (a tenant policy, #563 / #878).
      await api.put(
        "/settings/work",
        pickSection(
          hoursModeWire(hours) as Record<string, unknown>,
          settingsSection("dienstplan-oeffnungszeiten").keys,
        ),
      );
      hoursSnapshot = $state.snapshot(hours);
      toasts.success("Prüfmodus gespeichert.");
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Speichern fehlgeschlagen.");
    } finally {
      hoursSaving = false;
    }
  }

  function discardHours() {
    hours = $state.snapshot(hoursSnapshot);
  }

  $effect(() => {
    changes = hoursChanges;
  });
</script>

{#if show.hours}
  <SettingsGroup
    title="Schichten und Öffnungszeiten"
    description="Wie streng Schichten an die Öffnungszeiten des jeweiligen Salons gebunden werden. Die Öffnungszeiten selbst pflegst du je Salon unter Verwalten › Salons."
    changes={hoursChanges}
    errors={0}
    saving={hoursSaving}
    saveLabel="Prüfmodus speichern"
    onSave={saveHours}
    onDiscard={discardHours}
  >
    <fieldset class="mode-set" disabled={hoursSaving}>
      <legend class="mode-legend">Schicht-Zeiten an Öffnungszeiten binden</legend>
      {#each STORE_HOURS_MODES as mode (mode.value)}
        <label class="mode-option">
          <input
            type="radio"
            name="shiftStoreHoursMode"
            value={mode.value}
            bind:group={hours.shiftStoreHoursMode}
            data-testid={`dienstplan-oeffnungszeiten-${mode.value}`}
          />
          <span>
            <strong>{mode.label}</strong>
            <span class="mode-help">{mode.help}</span>
          </span>
        </label>
      {/each}
    </fieldset>
  </SettingsGroup>
{/if}

<style>
  .mode-set {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }

  .mode-legend {
    padding: 0;
    margin-bottom: var(--s-2);
    font-weight: 600;
    font-size: var(--fs-base);
    color: var(--text);
  }

  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: var(--s-3);
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    background: var(--card);
    cursor: pointer;
    font-size: var(--fs-base);
    color: var(--text);
    transition: border-color 0.12s var(--ease);
  }

  .mode-option:hover {
    border-color: var(--brand);
  }

  .mode-option input {
    margin-top: 0.2rem;
    flex-shrink: 0;
  }

  .mode-help {
    display: block;
    margin-top: var(--s-1);
    color: var(--text-2);
  }
</style>
