<!--
  TenantCreateDialog - "Mandant anlegen" (Issue #89, AC-89-01, D-07a, D-13).

  One dialog creates the tenant together with its first administration. The Bundesland starts
  unchosen on purpose: it fixes the default salon's Bundesland and cannot be changed afterwards
  (Pitfall 6). Validation mirrors the API's strict schema (lib/operator/tenant-form.ts); the API
  stays authoritative, and a failed create never closes the dialog: a taken Kurzname / e-mail or a
  bad timezone attaches to its field by machine code, everything else to a dialog-level alert.
  On success the form is replaced by a result view that names the default salon and tells whether
  the invitation mail went out.
-->
<script lang="ts">
  import { tick } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import { FEDERAL_STATE_OPTIONS } from "$lib/operator/labels";
  import { suggestSlug } from "$lib/operator/slug";
  import {
    EMAIL_MAX,
    NAME_MAX,
    buildTenantBody,
    createFailureMessage,
    emptyTenantForm,
    serverFieldProblem,
    validateTenantForm,
    type FieldProblem,
    type TenantFieldKey,
  } from "$lib/operator/tenant-form";
  import type { CreateTenantBody, CreateTenantResult } from "$lib/operator/types";

  interface Props {
    open: boolean;
    /** Sends the body to the operator API; rejects with the client's error on failure. */
    onCreate: (body: CreateTenantBody) => Promise<CreateTenantResult>;
    /** Opens the created tenant's page. */
    onOpen: (tenantId: string) => void;
    /** Called once after a successful create so the list reloads from the server. */
    onCreated?: () => void;
  }

  let { open = $bindable(), onCreate, onOpen, onCreated }: Props = $props();

  const TIMEZONES = ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich"];
  const FORM_ID = "op-tenant-create-form";

  let values = $state(emptyTenantForm());
  let slugTouched = $state(false);
  let touched = $state<Partial<Record<TenantFieldKey, boolean>>>({});
  let submitted = $state(false);
  let serverProblems = $state<Partial<Record<TenantFieldKey, FieldProblem>>>({});
  let alertMessage = $state<string | null>(null);
  let pending = $state(false);
  let result = $state<CreateTenantResult | null>(null);
  let sentTo = $state("");

  let formEl: HTMLFormElement | undefined = $state();
  let alertEl: HTMLElement | undefined = $state();
  let resultOpenEl: HTMLButtonElement | undefined = $state();

  const clientProblems = $derived(validateTenantForm(values));
  const valid = $derived(Object.keys(clientProblems).length === 0);

  /** The problem to show for a field: a server problem wins; client ones appear after blur or submit. */
  function problemFor(key: TenantFieldKey): FieldProblem | undefined {
    const fromServer = serverProblems[key];
    if (fromServer) return fromServer;
    return touched[key] || submitted ? clientProblems[key] : undefined;
  }

  function messageId(key: TenantFieldKey): string {
    return `op-tenant-create-msg-${key}`;
  }

  function describedBy(key: TenantFieldKey, hintId?: string): string | undefined {
    const ids = [problemFor(key) ? messageId(key) : null, hintId ?? null].filter(
      (id): id is string => id !== null,
    );
    return ids.length > 0 ? ids.join(" ") : undefined;
  }

  function touch(key: TenantFieldKey) {
    touched[key] = true;
  }

  function clearServerProblem(key: TenantFieldKey) {
    if (serverProblems[key]) serverProblems = { ...serverProblems, [key]: undefined };
  }

  function onNameInput() {
    if (!slugTouched) {
      values.slug = suggestSlug(values.name);
      clearServerProblem("slug");
    }
  }

  function onSlugInput() {
    slugTouched = true;
    clearServerProblem("slug");
  }

  // Dialog order, used to focus the first invalid field.
  const FIELD_ORDER: TenantFieldKey[] = [
    "name",
    "slug",
    "federal-state",
    "timezone",
    "admin-email",
    "admin-first-name",
    "admin-last-name",
    "admin-employee-number",
  ];

  async function focusFirstProblem() {
    await tick();
    const first = FIELD_ORDER.find((key) => problemFor(key));
    if (first) {
      formEl?.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
    } else {
      alertEl?.focus();
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (pending || result) return;
    submitted = true;
    alertMessage = null;
    if (!valid) {
      await focusFirstProblem();
      return;
    }

    const body = buildTenantBody(values);
    pending = true;
    try {
      const created = await onCreate(body);
      sentTo = body.admin.email;
      result = created;
      onCreated?.();
      if (!open) toasts.success(`Mandant „${created.tenant.name}“ wurde angelegt.`);
      await tick();
      resultOpenEl?.focus();
    } catch (error) {
      const mapped = serverFieldProblem(error);
      if (mapped) {
        serverProblems = { ...serverProblems, [mapped.field]: mapped.problem };
      } else {
        alertMessage = createFailureMessage(error);
      }
      await focusFirstProblem();
    } finally {
      pending = false;
    }
  }

  function close() {
    open = false;
  }

  function openCreated() {
    if (result) onOpen(result.tenant.id);
  }

  function reset() {
    values = emptyTenantForm();
    slugTouched = false;
    touched = {};
    submitted = false;
    serverProblems = {};
    alertMessage = null;
    pending = false;
    result = null;
    sentTo = "";
  }

  // Each opening starts from a clean form; the element that opened the dialog gets focus back.
  $effect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reset();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  });
</script>

{#snippet problemText(key: TenantFieldKey)}
  {@const problem = problemFor(key)}
  {#if problem}
    <p
      class="form-error problem"
      id={messageId(key)}
      data-code={problem.code}
      data-testid={`op-tenant-create-field-error-${key}`}
    >
      {problem.message}
    </p>
  {/if}
{/snippet}

<Modal
  bind:open
  eyebrow="Neuer Mandant"
  title={result ? "Mandant angelegt" : "Mandant anlegen"}
  ariaLabel={result ? "Mandant angelegt" : "Mandant anlegen"}
>
  <div class="dialog-root" data-testid="op-tenant-create-dialog">
    {#if result}
      <div class="result" data-testid="op-tenant-create-result">
        <p class="lead">
          Der Mandant „{result.tenant.name}“ wurde mit einem Standardsalon angelegt.
        </p>
        {#if result.invitationMailSent}
          <div
            class="alert alert-success"
            data-testid="op-tenant-create-result-mail"
            data-state="sent"
          >
            Die Einladung wurde an {sentTo} gesendet.
          </div>
        {:else}
          <div class="callout" data-testid="op-tenant-create-result-mail" data-state="not-sent">
            <p>
              Die Einladung konnte nicht gesendet werden. Auf der Mandantenseite lässt sie sich
              erneut senden.
            </p>
          </div>
        {/if}
      </div>
    {:else}
      <form id={FORM_ID} class="form" novalidate bind:this={formEl} onsubmit={submit}>
        {#if alertMessage}
          <div
            class="alert alert-error"
            role="alert"
            tabindex="-1"
            data-testid="op-tenant-create-error"
            bind:this={alertEl}
          >
            {alertMessage}
          </div>
        {/if}

        <div class="form-group">
          <label class="form-label" for="op-tenant-create-name">Name *</label>
          <input
            id="op-tenant-create-name"
            class="form-input"
            type="text"
            maxlength={NAME_MAX}
            autocomplete="off"
            placeholder="z. B. Beispiel Friseure GmbH"
            data-field="name"
            data-testid="op-tenant-create-name"
            aria-invalid={problemFor("name") ? "true" : undefined}
            aria-describedby={describedBy("name")}
            bind:value={values.name}
            oninput={onNameInput}
            onblur={() => touch("name")}
          />
          {@render problemText("name")}
        </div>

        <div class="form-group">
          <label class="form-label" for="op-tenant-create-slug">Kurzname *</label>
          <input
            id="op-tenant-create-slug"
            class="form-input mono"
            type="text"
            maxlength="63"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            data-field="slug"
            data-testid="op-tenant-create-slug"
            aria-invalid={problemFor("slug") ? "true" : undefined}
            aria-describedby={describedBy("slug", "op-tenant-create-slug-hint")}
            bind:value={values.slug}
            oninput={onSlugInput}
            onblur={() => touch("slug")}
          />
          {@render problemText("slug")}
          <p class="form-hint" id="op-tenant-create-slug-hint">
            3 bis 63 Zeichen: Kleinbuchstaben, Ziffern und Bindestriche. Wird aus dem Namen
            vorgeschlagen.
          </p>
        </div>

        <div class="form-group">
          <label class="form-label" for="op-tenant-create-federal-state">Bundesland *</label>
          <select
            id="op-tenant-create-federal-state"
            class="form-input"
            data-field="federal-state"
            data-testid="op-tenant-create-federal-state"
            aria-invalid={problemFor("federal-state") ? "true" : undefined}
            aria-describedby={describedBy("federal-state", "op-tenant-create-federal-state-hint")}
            bind:value={values.federalState}
            onblur={() => touch("federal-state")}
          >
            <option value="">Bundesland wählen</option>
            {#each FEDERAL_STATE_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          {@render problemText("federal-state")}
          <p class="form-hint" id="op-tenant-create-federal-state-hint">
            Gilt für den Standardsalon und bestimmt dessen Feiertage. Nach dem Anlegen nicht mehr
            änderbar.
          </p>
        </div>

        <div class="form-group">
          <label class="form-label" for="op-tenant-create-timezone">Zeitzone (optional)</label>
          <input
            id="op-tenant-create-timezone"
            class="form-input"
            type="text"
            list="op-tenant-create-timezones"
            autocomplete="off"
            spellcheck="false"
            placeholder="Standard des Systems"
            data-field="timezone"
            data-testid="op-tenant-create-timezone"
            aria-invalid={problemFor("timezone") ? "true" : undefined}
            aria-describedby={describedBy("timezone")}
            bind:value={values.timezone}
            oninput={() => clearServerProblem("timezone")}
            onblur={() => touch("timezone")}
          />
          <datalist id="op-tenant-create-timezones">
            {#each TIMEZONES as zone (zone)}
              <option value={zone}></option>
            {/each}
          </datalist>
          {@render problemText("timezone")}
        </div>

        <fieldset class="group">
          <legend class="group-label">Erste Administration</legend>
          <p class="form-hint">
            Die erste Administration erhält eine Einladung per E-Mail und wird dem Standardsalon
            zugeordnet.
          </p>

          <div class="form-group">
            <label class="form-label" for="op-tenant-create-admin-email">E-Mail-Adresse *</label>
            <input
              id="op-tenant-create-admin-email"
              class="form-input"
              type="email"
              maxlength={EMAIL_MAX}
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              data-field="admin-email"
              data-testid="op-tenant-create-admin-email"
              aria-invalid={problemFor("admin-email") ? "true" : undefined}
              aria-describedby={describedBy("admin-email")}
              bind:value={values.adminEmail}
              oninput={() => clearServerProblem("admin-email")}
              onblur={() => touch("admin-email")}
            />
            {@render problemText("admin-email")}
          </div>

          <div class="form-group">
            <label class="form-label" for="op-tenant-create-admin-first-name">Vorname *</label>
            <input
              id="op-tenant-create-admin-first-name"
              class="form-input"
              type="text"
              maxlength="100"
              autocomplete="off"
              data-field="admin-first-name"
              data-testid="op-tenant-create-admin-first-name"
              aria-invalid={problemFor("admin-first-name") ? "true" : undefined}
              aria-describedby={describedBy("admin-first-name")}
              bind:value={values.adminFirstName}
              onblur={() => touch("admin-first-name")}
            />
            {@render problemText("admin-first-name")}
          </div>

          <div class="form-group">
            <label class="form-label" for="op-tenant-create-admin-last-name">Nachname *</label>
            <input
              id="op-tenant-create-admin-last-name"
              class="form-input"
              type="text"
              maxlength="100"
              autocomplete="off"
              data-field="admin-last-name"
              data-testid="op-tenant-create-admin-last-name"
              aria-invalid={problemFor("admin-last-name") ? "true" : undefined}
              aria-describedby={describedBy("admin-last-name")}
              bind:value={values.adminLastName}
              onblur={() => touch("admin-last-name")}
            />
            {@render problemText("admin-last-name")}
          </div>

          <div class="form-group">
            <label class="form-label" for="op-tenant-create-admin-employee-number"
              >Personalnummer (optional)</label
            >
            <input
              id="op-tenant-create-admin-employee-number"
              class="form-input"
              type="text"
              maxlength="50"
              autocomplete="off"
              data-field="admin-employee-number"
              data-testid="op-tenant-create-admin-employee-number"
              aria-describedby={describedBy("admin-employee-number")}
              bind:value={values.adminEmployeeNumber}
            />
          </div>
        </fieldset>
      </form>
    {/if}
  </div>

  {#snippet footer()}
    {#if result}
      <span class="spacer"></span>
      <button
        type="button"
        class="btn btn-ghost"
        data-testid="op-tenant-create-result-close"
        onclick={close}>Schließen</button
      >
      <button
        type="button"
        class="btn btn-primary"
        data-testid="op-tenant-create-result-open"
        bind:this={resultOpenEl}
        onclick={openCreated}>Zum Mandanten</button
      >
    {:else}
      <span class="spacer"></span>
      <button
        type="button"
        class="btn btn-ghost"
        data-testid="op-tenant-create-cancel"
        disabled={pending}
        onclick={close}>Abbrechen</button
      >
      <button
        type="submit"
        form={FORM_ID}
        class="btn btn-primary"
        data-testid="op-tenant-create-submit"
        disabled={!valid || pending}
      >
        {#if pending}<Spinner size={14} label="Wird angelegt" /> Wird angelegt …{:else}Mandant
          anlegen{/if}
      </button>
    {/if}
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

  .form-group {
    min-width: 0;
  }

  .form-input {
    min-width: 0;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .problem {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .form-hint {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
    margin: 0;
    padding: 16px 0 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  .group-label {
    padding: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .result {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .lead {
    margin: 0;
    font-size: 16px;
    overflow-wrap: anywhere;
  }

  .alert {
    overflow-wrap: anywhere;
  }
</style>
