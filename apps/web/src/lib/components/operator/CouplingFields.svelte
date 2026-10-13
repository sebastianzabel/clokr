<!--
  CouplingFields - the external coupling of the operator salon form (Issue #89, AC-89-04, D-11, D-12b).

  Exactly two choices: "Keine" and "Phorest" (no other provider is offered, not even disabled). A
  Phorest coupling needs the Filialkennung. The tenant maintains the Phorest credentials itself, so
  this component only states that and never reads or shows one. Switching an existing coupling to
  "Keine" shows the removal hint before the parent saves; a deactivated salon cannot be coupled.
  The machine codes of a rejected save arrive as `fieldError` and are worded by the reasons module.
-->
<script lang="ts">
  import { REASON_TEXTS, reasonText } from "$lib/operator/reasons";
  import type { CouplingProvider } from "$lib/operator/types";

  interface FieldError {
    code: string;
    serverError?: string;
  }

  interface Props {
    provider: CouplingProvider;
    externalBranchId: string;
    /** The provider the salon has been loaded with; drives the removal hint. */
    initialProvider?: CouplingProvider;
    salonActive?: boolean;
    /** A rejected save: SALON_INACTIVE belongs to the select, BRANCH_ALREADY_COUPLED to the id. */
    fieldError?: FieldError | null;
    /** The parent's submit was attempted: show the missing-Filialkennung problem. */
    showRequired?: boolean;
  }

  let {
    provider = $bindable(),
    externalBranchId = $bindable(),
    initialProvider = "NONE",
    salonActive = true,
    fieldError = null,
    showRequired = false,
  }: Props = $props();

  const SELECT_ERROR_CODES = ["SALON_INACTIVE"];
  const BRANCH_ERROR_CODES = ["BRANCH_ALREADY_COUPLED"];

  let branchTouched = $state(false);

  const selectError = $derived(
    fieldError && SELECT_ERROR_CODES.includes(fieldError.code) ? fieldError : null,
  );
  const branchError = $derived(
    fieldError && BRANCH_ERROR_CODES.includes(fieldError.code) ? fieldError : null,
  );
  const showRemoveHint = $derived(initialProvider === "PHOREST" && provider === "NONE");
  const branchMissing = $derived(
    provider === "PHOREST" && externalBranchId.trim() === "" && (branchTouched || showRequired),
  );
  const branchProblem = $derived(branchError !== null || branchMissing);
  const inactiveHint = $derived(!salonActive && selectError === null);
</script>

<fieldset class="group" data-testid="op-salon-coupling">
  <legend class="group-label">Externe Kopplung</legend>

  <div class="form-group">
    <label class="form-label" for="op-salon-coupling-provider">System</label>
    <select
      id="op-salon-coupling-provider"
      class="form-input"
      disabled={!salonActive}
      data-testid="op-salon-coupling-provider"
      aria-invalid={selectError ? "true" : undefined}
      aria-describedby={selectError || inactiveHint ? "op-salon-coupling-provider-msg" : undefined}
      bind:value={provider}
    >
      <option value="NONE">Keine</option>
      <option value="PHOREST">Phorest</option>
    </select>
    {#if selectError}
      <p
        class="form-error problem"
        id="op-salon-coupling-provider-msg"
        data-code={selectError.code}
        data-testid="op-salon-coupling-provider-error"
      >
        {reasonText(selectError.code, selectError.serverError)}
      </p>
    {:else if inactiveHint}
      <p
        class="form-hint"
        id="op-salon-coupling-provider-msg"
        data-testid="op-salon-coupling-inactive-hint"
      >
        {REASON_TEXTS["SALON_INACTIVE"]}
      </p>
    {/if}
  </div>

  {#if provider === "PHOREST"}
    <div class="form-group">
      <label class="form-label" for="op-salon-coupling-branch">Filialkennung *</label>
      <input
        id="op-salon-coupling-branch"
        class="form-input mono"
        type="text"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        maxlength="200"
        data-testid="op-salon-coupling-branch"
        aria-invalid={branchProblem ? "true" : undefined}
        aria-describedby={branchProblem
          ? "op-salon-coupling-branch-msg op-salon-coupling-phorest-hint"
          : "op-salon-coupling-phorest-hint"}
        bind:value={externalBranchId}
        onblur={() => (branchTouched = true)}
      />
      {#if branchError}
        <p
          class="form-error problem"
          id="op-salon-coupling-branch-msg"
          data-code={branchError.code}
          data-testid="op-salon-coupling-branch-error"
        >
          {reasonText(branchError.code, branchError.serverError)}
        </p>
      {:else if branchMissing}
        <p
          class="form-error problem"
          id="op-salon-coupling-branch-msg"
          data-code="BRANCH_REQUIRED"
          data-testid="op-salon-coupling-branch-error"
        >
          Filialkennung angeben.
        </p>
      {/if}
      <p
        class="form-hint"
        id="op-salon-coupling-phorest-hint"
        data-testid="op-salon-coupling-phorest-hint"
      >
        Die Zugangsdaten zu Phorest pflegt der Mandant selbst. Ohne sie findet kein Abgleich statt.
      </p>
    </div>
  {/if}

  {#if showRemoveHint}
    <div class="callout brand" data-testid="op-salon-coupling-remove-hint">
      <p>
        Beim Speichern des Salons wird die Kopplung entfernt. Der Abgleich mit Phorest endet für
        diesen Salon.
      </p>
    </div>
  {/if}
</fieldset>

<style>
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

  .form-group,
  .form-input {
    min-width: 0;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .problem,
  .form-hint {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
