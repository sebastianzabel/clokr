<!--
  SalonDialog - "Salon anlegen" / "Salon bearbeiten" (Issue #89, AC-89-02/03/04, D-07a, D-10, D-13, D-14a).

  One dialog for both modes. Create starts with the Bundesland unchosen and the hours copied from
  the tenant's Standardsalon (else the API default); edit starts from the loaded salon and the save
  button stays disabled until the form is valid AND differs, because only the changed keys are sent
  (T-89-41). Nothing saves on blur. A refused save never closes the dialog: the machine code of the
  refusal decides where the sentence lands - FEDERAL_STATE_IN_USE on top with the Bundesland field
  pointing at it, BRANCH_ALREADY_COUPLED / SALON_INACTIVE at their coupling field, anything else in
  a dialog alert. The parent supplies the actual API call through `onSubmit`.
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { FEDERAL_STATE_OPTIONS } from "$lib/operator/labels";
  import {
    SALON_NAME_MAX,
    buildCreateSalonBody,
    diffSalonForm,
    emptySalonForm,
    isSalonFormValid,
    salonFormFromSalon,
    validateOpeningHours,
    validateSalonForm,
    type SalonFieldKey,
    type SalonFormValues,
  } from "$lib/operator/opening-hours";
  import { SALON_NOT_FOUND, failureText } from "$lib/operator/reasons";
  import type { CreateSalonBody, OperatorSalon, UpdateSalonBody } from "$lib/operator/types";
  import CouplingFields from "./CouplingFields.svelte";
  import OpeningHoursEditor from "./OpeningHoursEditor.svelte";
  import ReasonCallout from "./ReasonCallout.svelte";

  interface Props {
    open: boolean;
    mode: "create" | "edit";
    /** The salon being edited (edit mode). */
    salon?: OperatorSalon | null;
    /** The tenant's Standardsalon; its hours prefill a new salon. */
    defaultSalon?: OperatorSalon | null;
    /** Active salons of the tenant; exactly one shows the settings-overwrite hint (D-10). */
    activeSalonCount: number;
    /** Sends the body; rejects with the client's error on failure. The dialog closes on success. */
    onSubmit: (body: CreateSalonBody | UpdateSalonBody) => Promise<void>;
  }

  let {
    open = $bindable(),
    mode,
    salon = null,
    defaultSalon = null,
    activeSalonCount,
    onSubmit,
  }: Props = $props();

  const FORM_ID = "op-salon-form";
  const REASON_ID = "op-salon-reason-callout";
  /** Codes that belong to a field of the dialog; every other code is a dialog alert. */
  const FIELD_CODES = ["FEDERAL_STATE_IN_USE", "BRANCH_ALREADY_COUPLED", "SALON_INACTIVE"];

  let original = $state<SalonFormValues>(emptySalonForm(null));
  let form = $state<SalonFormValues>(emptySalonForm(null));
  let touched = $state<Partial<Record<SalonFieldKey, boolean>>>({});
  let submitted = $state(false);
  let pending = $state(false);
  let failure = $state<{ code?: string; message: string } | null>(null);

  let formEl: HTMLFormElement | undefined = $state();
  let alertEl: HTMLElement | undefined = $state();

  const fieldProblems = $derived(validateSalonForm(form));
  const hourErrors = $derived(validateOpeningHours(form.openingHours));
  const valid = $derived(isSalonFormValid(form));
  const patch = $derived(diffSalonForm(original, form));
  const changed = $derived(Object.keys(patch).length > 0);
  const canSubmit = $derived(valid && (mode === "create" || changed) && !pending);

  const fieldCode = $derived(
    failure?.code && FIELD_CODES.includes(failure.code) ? failure.code : null,
  );
  const alertMessage = $derived(failure && fieldCode === null ? failure.message : null);
  const couplingError = $derived(
    failure?.code === "BRANCH_ALREADY_COUPLED" || failure?.code === "SALON_INACTIVE"
      ? { code: failure.code }
      : null,
  );

  /** Client problems show after blur or a submit attempt. */
  function problemFor(key: SalonFieldKey): string | undefined {
    return touched[key] || submitted ? fieldProblems[key] : undefined;
  }

  function describedBy(key: SalonFieldKey, ...extra: Array<string | null>): string | undefined {
    const ids = [problemFor(key) ? `op-salon-msg-${key}` : null, ...extra].filter(
      (id): id is string => id !== null,
    );
    return ids.length > 0 ? ids.join(" ") : undefined;
  }

  const federalStateDescribedBy = $derived(
    describedBy(
      "federal-state",
      fieldCode === "FEDERAL_STATE_IN_USE" ? REASON_ID : null,
      "op-salon-federal-state-hint",
    ),
  );

  function touch(key: SalonFieldKey) {
    touched[key] = true;
  }

  async function focusFirstProblem() {
    await tick();
    const order: Array<[SalonFieldKey, string]> = [
      ["name", "op-salon-name"],
      ["postal-code", "op-salon-postal-code"],
      ["federal-state", "op-salon-federal-state"],
    ];
    const first = order.find(([key]) => problemFor(key));
    if (first) {
      formEl?.querySelector<HTMLElement>(`[data-testid="${first[1]}"]`)?.focus();
    } else if (fieldCode === "FEDERAL_STATE_IN_USE") {
      formEl?.querySelector<HTMLElement>('[data-testid="op-salon-federal-state"]')?.focus();
    } else if (fieldCode === "BRANCH_ALREADY_COUPLED") {
      formEl?.querySelector<HTMLElement>('[data-testid="op-salon-coupling-branch"]')?.focus();
    } else if (fieldCode === "SALON_INACTIVE") {
      formEl?.querySelector<HTMLElement>('[data-testid="op-salon-coupling-provider"]')?.focus();
    } else {
      alertEl?.focus();
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (pending) return;
    submitted = true;
    failure = null;
    if (!valid || (mode === "edit" && !changed)) {
      await focusFirstProblem();
      return;
    }

    pending = true;
    try {
      await onSubmit(mode === "create" ? buildCreateSalonBody(form) : patch);
      open = false;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      failure = {
        ...(typeof code === "string" ? { code } : {}),
        message: failureText(error, { notFoundCode: SALON_NOT_FOUND }),
      };
      await focusFirstProblem();
    } finally {
      pending = false;
    }
  }

  function close() {
    open = false;
  }

  // Each opening starts from the props as they are now; later prop changes never reset a form in
  // progress, hence the untrack.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      const start =
        mode === "edit" && salon ? salonFormFromSalon(salon) : emptySalonForm(defaultSalon);
      original = $state.snapshot(start);
      form = start;
      touched = {};
      submitted = false;
      pending = false;
      failure = null;
    });
  });
</script>

<Modal
  bind:open
  eyebrow="Salon"
  title={mode === "create" ? "Salon anlegen" : "Salon bearbeiten"}
  ariaLabel={mode === "create" ? "Salon anlegen" : "Salon bearbeiten"}
>
  <div class="dialog-root" data-testid="op-salon-dialog" data-mode={mode}>
    <form id={FORM_ID} class="form" novalidate bind:this={formEl} onsubmit={submit}>
      {#if fieldCode === "FEDERAL_STATE_IN_USE" && failure}
        <div data-testid="op-salon-reason" data-code={fieldCode}>
          <ReasonCallout code={fieldCode} id={REASON_ID} />
        </div>
      {/if}
      {#if alertMessage}
        <div
          class="alert alert-error"
          role="alert"
          tabindex="-1"
          data-testid="op-salon-error"
          data-code={failure?.code}
          bind:this={alertEl}
        >
          {alertMessage}
        </div>
      {/if}

      <div class="form-group">
        <label class="form-label" for="op-salon-name">Name *</label>
        <input
          id="op-salon-name"
          class="form-input"
          type="text"
          maxlength={SALON_NAME_MAX}
          autocomplete="off"
          data-testid="op-salon-name"
          aria-invalid={problemFor("name") ? "true" : undefined}
          aria-describedby={describedBy("name")}
          bind:value={form.name}
          onblur={() => touch("name")}
        />
        {#if problemFor("name")}
          <p
            class="form-error problem"
            id="op-salon-msg-name"
            data-testid="op-salon-field-error-name"
          >
            {problemFor("name")}
          </p>
        {/if}
      </div>

      <div class="form-group">
        <label class="form-label" for="op-salon-street">Straße und Hausnummer</label>
        <input
          id="op-salon-street"
          class="form-input"
          type="text"
          maxlength="200"
          autocomplete="street-address"
          data-testid="op-salon-street"
          bind:value={form.street}
        />
      </div>

      <div class="pair">
        <div class="form-group">
          <label class="form-label" for="op-salon-postal-code">PLZ</label>
          <input
            id="op-salon-postal-code"
            class="form-input"
            type="text"
            inputmode="numeric"
            maxlength="5"
            autocomplete="postal-code"
            data-testid="op-salon-postal-code"
            aria-invalid={problemFor("postal-code") ? "true" : undefined}
            aria-describedby={describedBy("postal-code")}
            bind:value={form.postalCode}
            onblur={() => touch("postal-code")}
          />
          {#if problemFor("postal-code")}
            <p
              class="form-error problem"
              id="op-salon-msg-postal-code"
              data-testid="op-salon-field-error-postal-code"
            >
              {problemFor("postal-code")}
            </p>
          {/if}
        </div>
        <div class="form-group">
          <label class="form-label" for="op-salon-city">Ort</label>
          <input
            id="op-salon-city"
            class="form-input"
            type="text"
            maxlength="100"
            autocomplete="address-level2"
            data-testid="op-salon-city"
            bind:value={form.city}
          />
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="op-salon-federal-state">Bundesland *</label>
        <select
          id="op-salon-federal-state"
          class="form-input"
          data-testid="op-salon-federal-state"
          aria-invalid={problemFor("federal-state") || fieldCode === "FEDERAL_STATE_IN_USE"
            ? "true"
            : undefined}
          aria-describedby={federalStateDescribedBy}
          bind:value={form.federalState}
          onchange={() => {
            if (fieldCode === "FEDERAL_STATE_IN_USE") failure = null;
          }}
          onblur={() => touch("federal-state")}
        >
          <option value="">Bundesland wählen</option>
          {#each FEDERAL_STATE_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
        {#if problemFor("federal-state")}
          <p
            class="form-error problem"
            id="op-salon-msg-federal-state"
            data-testid="op-salon-field-error-federal-state"
          >
            {problemFor("federal-state")}
          </p>
        {/if}
        <p class="form-hint" id="op-salon-federal-state-hint">
          Bestimmt die gesetzlichen Feiertage. Nach der ersten Zuordnung oder Zeiterfassung nicht
          mehr änderbar.
        </p>
      </div>

      {#if activeSalonCount === 1}
        <div class="callout brand" data-testid="op-salon-single-salon-hint">
          <p>
            Bei nur einem aktiven Salon überschreibt eine Änderung der Öffnungszeiten in den
            Mandanten-Einstellungen diesen Wert.
          </p>
        </div>
      {/if}

      <OpeningHoursEditor bind:days={form.openingHours} errors={hourErrors} />

      <CouplingFields
        bind:provider={form.provider}
        bind:externalBranchId={form.externalBranchId}
        initialProvider={original.provider}
        salonActive={mode === "create" ? true : (salon?.isActive ?? true)}
        fieldError={couplingError}
        showRequired={submitted}
      />
    </form>
  </div>

  {#snippet footer()}
    <span class="spacer"></span>
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="op-salon-cancel"
      disabled={pending}
      onclick={close}>Abbrechen</button
    >
    <button
      type="submit"
      form={FORM_ID}
      class="btn btn-primary"
      data-testid="op-salon-submit"
      disabled={!canSubmit}
    >
      {#if pending}
        <Spinner size={14} label={mode === "create" ? "Wird angelegt" : "Wird gespeichert"} />
        {mode === "create" ? "Wird angelegt …" : "Wird gespeichert …"}
      {:else}
        {mode === "create" ? "Salon anlegen" : "Salon speichern"}
      {/if}
    </button>
  {/snippet}
</Modal>

<style>
  .dialog-root {
    min-width: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .form-group,
  .form-input {
    min-width: 0;
  }

  .problem,
  .form-hint {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .alert {
    overflow-wrap: anywhere;
  }

  /* PLZ and Ort stack on a phone and share a line from 480 px of viewport. */
  .pair {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    min-width: 0;
  }

  @media (min-width: 480px) {
    .pair {
      grid-template-columns: minmax(96px, 1fr) 2fr;
    }
  }
</style>
