<!--
  VertragOverrides - the per-person overrides of the „Vertrag“ tab of the employee detail (Issue
  #854, plan 854-22): two groups, each with its own snapshot and its own SaveBar (finding H-14: no
  row of three separate „Speichern“ buttons).

    Pausendauer                       breakOver6hOverride / breakOver9hOverride (BREAK-06), with the
                                      § 11 JArbSchG hint and the one-click suggestion for a person
                                      under 18 (Issue #574)
    Phorest Vor- und Nachbereitung    phorestPrepMinutesOverride / phorestWrapupMinutesOverride
                                      (Phase 85.1.1)

  The overrides are a different scope than the company defaults on Regeln › Arbeitszeit & Verträge:
  they hold for this person only, and an empty field means „Unternehmensstandard“ (the API stores
  null). A group sends exactly its own keys in one `PATCH /employees/:id` (D-854-04, #878), so one
  group can never overwrite what the other one changed. The server stays the authority for every
  bound and its text is shown as it comes (Phase 64 D-08). The „Übliche Arbeitstage nachtragen“
  Nachtrag (#481) lives in VertragTab (it reads the same contract history); the Berufsschule
  overrides are BerufsschuleSection.

  The baseline is read once on purpose: the snapshot is the group's own afterwards, and a reload of
  the `employee` prop (another tab saved) must not discard what was typed here.

  Props:
    employee   the SAVED record (the overrides and the birth day)
    tenant     the company defaults for the placeholders, or null when they could not be read
    canEdit    employee:update (fields read-only without it; the API enforces it)
    changes    bindable, the number of unsaved changes of both groups
    onSaved    called with the keys a PATCH wrote
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import SettingsGroup from "$lib/components/admin/settings/SettingsGroup.svelte";
  import { dayOf } from "$lib/employees/person-form";
  import {
    PAUSE_KEYS,
    PHOREST_KEYS,
    UNDER_18_PAUSE,
    isUnder18,
    pauseMessages,
    pauseValuesOf,
    phorestMessages,
    phorestValuesOf,
    type OverrideEmployee,
    type OverrideTenant,
    type PauseValues,
    type PhorestValues,
  } from "$lib/employees/overrides-form";
  import { countChanges, pickSection, sectionErrors } from "$lib/settings/section-state";

  interface Props {
    employee: OverrideEmployee & { id: string };
    tenant: OverrideTenant | null;
    canEdit: boolean;
    changes?: number;
    onSaved?: (written: Partial<OverrideEmployee>) => void;
  }

  // `changes` is write-only here: the page reads it through `bind:changes`.
  // eslint-disable-next-line no-useless-assignment
  let { employee, tenant, canEdit, changes = $bindable(), onSaved }: Props = $props();

  // ── Pausendauer ──────────────────────────────────────────────────────────────

  let pauseSnapshot = $state<PauseValues>(
    untrack(() => $state.snapshot(pauseValuesOf(employee)) as PauseValues),
  );
  let pause = $state<PauseValues>(
    untrack(() => $state.snapshot(pauseValuesOf(employee)) as PauseValues),
  );
  let savingPause = $state(false);
  // The server's refusal of the last save (one of its verbatim German texts), shown until the next attempt.
  let pauseError = $state("");

  const pauseChanges = $derived(countChanges(pauseSnapshot, pause, PAUSE_KEYS));
  // An invalid value can only exist after an edit, so the messages show once the group has one.
  const pauseShown = $derived(pauseChanges > 0 ? pauseMessages(pause) : {});

  // § 11 JArbSchG: any person under 18, whatever the classification, decided from the SAVED birth day.
  let under18 = $derived(isUnder18(dayOf(employee.birthDate)));
  const bothPauseEmpty = $derived(
    pause.breakOver6hOverride === null && pause.breakOver9hOverride === null,
  );
  const showSuggestion = $derived(canEdit && under18 && bothPauseEmpty);

  const default6h = $derived(tenant?.defaultBreakOver6h ?? 30);
  const default9h = $derived(tenant?.defaultBreakOver9h ?? 45);

  function applyUnder18Suggestion() {
    // § 11 Abs. 1 JArbSchG: 30 Min above 4.5 h, 60 Min above 6 h - so both fields carry 60; the 4.5 h
    // band is enforced by the API's break regime for minors.
    pause.breakOver6hOverride = UNDER_18_PAUSE.breakOver6hOverride;
    pause.breakOver9hOverride = UNDER_18_PAUSE.breakOver9hOverride;
  }

  async function savePause() {
    if (Object.values(pauseShown).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingPause = true;
    pauseError = "";
    try {
      const body = pickSection($state.snapshot(pause) as PauseValues, PAUSE_KEYS);
      await api.patch(`/employees/${employee.id}`, body);
      pauseSnapshot = $state.snapshot(pause) as PauseValues;
      toasts.success("Pausendauer gespeichert.");
      onSaved?.(body);
    } catch (err) {
      pauseError = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
    } finally {
      savingPause = false;
    }
  }

  function discardPause() {
    pause = $state.snapshot(pauseSnapshot) as PauseValues;
    pauseError = "";
  }

  // ── Phorest prep and wrap-up buffers ─────────────────────────────────────────

  let phorestSnapshot = $state<PhorestValues>(
    untrack(() => $state.snapshot(phorestValuesOf(employee)) as PhorestValues),
  );
  let phorest = $state<PhorestValues>(
    untrack(() => $state.snapshot(phorestValuesOf(employee)) as PhorestValues),
  );
  let savingPhorest = $state(false);
  let phorestError = $state("");

  const phorestChanges = $derived(countChanges(phorestSnapshot, phorest, PHOREST_KEYS));
  const phorestShown = $derived(phorestChanges > 0 ? phorestMessages(phorest) : {});

  const defaultPrep = $derived(tenant?.phorestPrepMinutes ?? 0);
  const defaultWrapup = $derived(tenant?.phorestWrapupMinutes ?? 0);

  async function savePhorest() {
    if (Object.values(phorestShown).some(Boolean)) {
      toasts.error("Bitte prüf die markierten Felder.");
      return;
    }
    savingPhorest = true;
    phorestError = "";
    try {
      const body = pickSection($state.snapshot(phorest) as PhorestValues, PHOREST_KEYS);
      await api.patch(`/employees/${employee.id}`, body);
      phorestSnapshot = $state.snapshot(phorest) as PhorestValues;
      toasts.success("Vor- und Nachbereitungszeit gespeichert.");
      onSaved?.(body);
    } catch (err) {
      phorestError = err instanceof Error ? err.message : "Speichern fehlgeschlagen.";
    } finally {
      savingPhorest = false;
    }
  }

  function discardPhorest() {
    phorest = $state.snapshot(phorestSnapshot) as PhorestValues;
    phorestError = "";
  }

  $effect(() => {
    changes = pauseChanges + phorestChanges;
  });
</script>

<div data-testid="pausendauer-editor" class="vo-wrap">
  <SettingsGroup
    id="vertrag-pausendauer"
    title="Pausendauer"
    description={`Überschreibt den Unternehmensstandard für diese Person. Leer = Standard (${default6h}/${default9h} Min).`}
    changes={canEdit ? pauseChanges : 0}
    errors={sectionErrors(pauseShown)}
    saving={savingPause}
    saveLabel="Pausendauer speichern"
    onSave={savePause}
    onDiscard={discardPause}
  >
    {#if pauseError}
      <div role="alert" data-testid="pausendauer-error">
        <Note tone="bad">{pauseError}</Note>
      </div>
    {/if}

    {#if under18}
      <!-- § 11 JArbSchG: a recommendation, not a violation, so an info line -->
      <div role="status" data-testid="pausendauer-azubi-pill">
        <Note tone="info">Unter 18 — Pausen nach § 11 JArbSchG</Note>
      </div>
    {/if}
    {#if showSuggestion}
      <div>
        <button
          type="button"
          class="btn btn-secondary"
          onclick={applyUnder18Suggestion}
          data-testid="pausendauer-azubi-apply"
        >
          Vorschlag nach § 11 JArbSchG übernehmen (60 Min ab 6 h)
        </button>
      </div>
    {/if}

    <div class="vo-pair">
      <FormField
        label="Pause ab 6 Stunden (Min)"
        help="ArbZG-Minimum: 30 Min"
        error={pauseShown.breakOver6hOverride}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="30"
            max="120"
            step="1"
            bind:value={pause.breakOver6hOverride}
            placeholder={under18 ? "60 Min — nach § 11 JArbSchG" : `Standard: ${default6h} Min`}
            disabled={!canEdit || savingPause}
            data-testid="pausendauer-over6h"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <FormField
        label="Pause ab 9 Stunden (Min)"
        help="ArbZG-Minimum: 45 Min"
        error={pauseShown.breakOver9hOverride}
      >
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="45"
            max="180"
            step="1"
            bind:value={pause.breakOver9hOverride}
            placeholder={under18 ? "60 Min — nach § 11 JArbSchG" : `Standard: ${default9h} Min`}
            disabled={!canEdit || savingPause}
            data-testid="pausendauer-over9h"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
  </SettingsGroup>
</div>

<div data-testid="phorest-puffer-editor" class="vo-wrap">
  <SettingsGroup
    id="vertrag-phorest-puffer"
    title="Phorest Vor- und Nachbereitung"
    description={`Überschreibt den Unternehmensstandard für diese Person. Leer = Standard (${defaultPrep}/${defaultWrapup} Min).`}
    changes={canEdit ? phorestChanges : 0}
    errors={sectionErrors(phorestShown)}
    saving={savingPhorest}
    saveLabel="Vor- und Nachbereitung speichern"
    onSave={savePhorest}
    onDiscard={discardPhorest}
  >
    {#if phorestError}
      <div role="alert" data-testid="phorest-puffer-error">
        <Note tone="bad">{phorestError}</Note>
      </div>
    {/if}

    <div class="vo-pair">
      <FormField label="Vorbereitungszeit (Min)" error={phorestShown.phorestPrepMinutesOverride}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="0"
            max="30"
            step="1"
            bind:value={phorest.phorestPrepMinutesOverride}
            placeholder={`Standard: ${defaultPrep} Min`}
            disabled={!canEdit || savingPhorest}
            data-testid="phorest-puffer-prep"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>

      <FormField label="Nachbereitungszeit (Min)" error={phorestShown.phorestWrapupMinutesOverride}>
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            class="form-input"
            type="number"
            min="0"
            max="30"
            step="1"
            bind:value={phorest.phorestWrapupMinutesOverride}
            placeholder={`Standard: ${defaultWrapup} Min`}
            disabled={!canEdit || savingPhorest}
            data-testid="phorest-puffer-wrapup"
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
  </SettingsGroup>
</div>

<style>
  /* The test hook wrappers are the tab's sections (the Vertrag tab draws the hairline between them);
     each is its own container, so the field pair follows the section's width. */
  .vo-wrap {
    container-type: inline-size;
    min-width: 0;
  }

  /* Two fields side by side (the prototype's form row), one column on a phone. */
  .vo-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--s-4);
  }

  @container (min-width: 520px) {
    .vo-pair {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
