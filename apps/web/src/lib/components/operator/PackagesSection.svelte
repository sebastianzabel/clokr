<!--
  PackagesSection - the "Pakete" section of the operator's tenant page (Phase 566, D-08).

  The operator books and cancels the add-on modules of a tenant and sets the salon quota. The
  component only drafts: it keeps the checkboxes and the quota as local state, shows whether the
  draft differs from the stored packages and hands the exact body `{ bookedModules, salonQuota }`
  to the page, which owns the API call. One "Speichern" button in the section footer saves the
  whole group (docs/ADMIN_STRUCTURE.md 3.2.1: a group with a number field never saves on input).
  The server validates and records every change; a refusal is worded by its code.

  Lowering the effective limit below the number of active salons is allowed: nothing becomes
  inactive, only further salons cannot be activated (D-06), which the non-blocking warning says.
-->
<script lang="ts">
  import Section from "$lib/components/admin/Section.svelte";
  import { TENANT_MODULE_DESCRIPTIONS } from "$lib/operator/labels";
  import { REASON_TEXTS, failureText } from "$lib/operator/reasons";
  import type { OperatorTenant, SetTenantPackagesBody } from "$lib/operator/types";
  import {
    TENANT_MODULES,
    TENANT_MODULE_LABELS,
    type TenantModule,
  } from "$lib/packages/tenant-modules";
  import { toasts } from "$stores/toast";

  interface Props {
    tenant: OperatorTenant;
    /** Receives the exact body of the PUT; resolves with the stored tenant, rejects with the client's error. */
    onSave: (body: SetTenantPackagesBody) => Promise<OperatorTenant>;
    /** Called with the tenant the server returned after a successful save. */
    onSaved: (tenant: OperatorTenant) => void;
    /** The tenant is deactivated: every control is disabled. */
    tenantDeactivated?: boolean;
  }

  let { tenant, onSave, onSaved, tenantDeactivated = false }: Props = $props();

  const QUOTA_MIN = 1;
  const QUOTA_MAX = 500;
  const FROZEN_HINT_ID = "op-packages-tenant-frozen-hint";
  const QUOTA_ERROR_ID = "op-packages-quota-error";
  const QUOTA_HINT_ID = "op-packages-quota-hint";
  const QUOTA_MESSAGE = `Das Salon-Kontingent muss eine ganze Zahl von ${QUOTA_MIN} bis ${QUOTA_MAX} sein.`;

  /** The draft in canonical (declaration) order, so two drafts with the same set compare equal. */
  function canonical(modules: readonly TenantModule[]): TenantModule[] {
    return TENANT_MODULES.filter((m) => modules.includes(m));
  }

  // The draft restarts from the stored packages only when THEY change (after a save or a reload
  // with different values). Both sources are primitives, so a silent reload that merely refreshes
  // the active salon count does not invalidate them and keeps the operator's unsaved draft.
  const storedModulesKey = $derived(canonical(tenant.packages.bookedModules).join(","));
  const storedQuota = $derived(tenant.packages.salonQuota);

  let booked = $derived<TenantModule[]>(
    storedModulesKey === "" ? [] : (storedModulesKey.split(",") as TenantModule[]),
  );
  let quotaText = $derived(String(storedQuota));
  let saving = $state(false);
  let failure = $state<string | null>(null);

  /** A whole number inside the API range, else `null`. */
  const quota = $derived.by(() => {
    const text = quotaText.trim();
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    return value >= QUOTA_MIN && value <= QUOTA_MAX ? value : null;
  });
  const quotaInvalid = $derived(quota === null);

  const chainBooked = $derived(booked.includes("CHAIN"));
  const activeSalonCount = $derived(tenant.packages.activeSalonCount);
  // Mirrors the API rule: the quota counts only with the Ketten-Paket, else one salon.
  const effectiveLimit = $derived(quota === null ? null : chainBooked ? quota : 1);
  const limitBelowActive = $derived(effectiveLimit !== null && effectiveLimit < activeSalonCount);

  const dirty = $derived(canonical(booked).join(",") !== storedModulesKey || quota !== storedQuota);
  const canSave = $derived(dirty && !quotaInvalid && !saving && !tenantDeactivated);

  function toggle(module: TenantModule, checked: boolean) {
    failure = null;
    booked = canonical(checked ? [...booked, module] : booked.filter((m) => m !== module));
  }

  async function save() {
    if (!canSave || quota === null) return;
    saving = true;
    failure = null;
    try {
      const updated = await onSave({ bookedModules: canonical(booked), salonQuota: quota });
      toasts.success("Pakete gespeichert.");
      onSaved(updated);
    } catch (error) {
      failure = failureText(error);
    } finally {
      saving = false;
    }
  }
</script>

<Section title="Pakete" sub="Gebuchte Module und Salon-Kontingent" {dirty} animate>
  <div data-testid="op-packages-section">
    {#if tenantDeactivated}
      <div class="callout brand block" id={FROZEN_HINT_ID} data-testid={FROZEN_HINT_ID}>
        <p>{REASON_TEXTS.TENANT_DEACTIVATED}</p>
      </div>
    {/if}

    <p class="base" data-testid="package-base">
      Grundversion – immer enthalten (gesetzliche Funktionen, 1 aktiver Salon)
    </p>

    <fieldset class="modules" disabled={tenantDeactivated} data-testid="package-modules">
      <legend class="legend">Gebuchte Pakete</legend>
      {#each TENANT_MODULES as module (module)}
        <div class="module">
          <label class="module-label">
            <input
              type="checkbox"
              checked={booked.includes(module)}
              aria-describedby={`op-package-${module}-desc`}
              data-testid={`package-${module}`}
              onchange={(event) => toggle(module, event.currentTarget.checked)}
            />
            <span class="module-name">{TENANT_MODULE_LABELS[module]}</span>
          </label>
          <p class="form-hint module-desc" id={`op-package-${module}-desc`}>
            {TENANT_MODULE_DESCRIPTIONS[module]}
          </p>
        </div>
      {/each}
    </fieldset>

    <div class="form-group quota">
      <label class="form-label" for="op-packages-quota">Salon-Kontingent</label>
      <input
        id="op-packages-quota"
        class="form-input quota-input"
        type="number"
        inputmode="numeric"
        min={QUOTA_MIN}
        max={QUOTA_MAX}
        step="1"
        disabled={tenantDeactivated}
        aria-invalid={quotaInvalid ? "true" : undefined}
        aria-describedby={quotaInvalid ? `${QUOTA_ERROR_ID} ${QUOTA_HINT_ID}` : QUOTA_HINT_ID}
        data-testid="package-quota"
        value={quotaText}
        oninput={(event) => {
          failure = null;
          quotaText = event.currentTarget.value;
        }}
      />
      <p class="form-hint" id={QUOTA_HINT_ID}>
        Gilt nur mit dem Ketten-Paket. Ohne Ketten-Paket ist 1 aktiver Salon möglich.
      </p>
      {#if quotaInvalid}
        <p class="form-error" id={QUOTA_ERROR_ID} data-testid="package-quota-error">
          {QUOTA_MESSAGE}
        </p>
      {/if}
    </div>

    <dl class="facts">
      <dt>Aktive Salons</dt>
      <dd data-testid="package-active-salons">{activeSalonCount}</dd>
      <dt>Wirksames Limit</dt>
      <dd data-testid="package-effective-limit">{effectiveLimit ?? "–"}</dd>
    </dl>

    {#if limitBelowActive}
      <div class="callout block" role="status" data-testid="package-quota-warning">
        <p>
          Das Limit liegt unter der Zahl aktiver Salons. Bestehende Salons bleiben aktiv; nur
          weitere können nicht aktiviert werden.
        </p>
      </div>
    {/if}

    {#if failure}
      <div class="alert alert-error block" role="alert" data-testid="packages-error">
        {failure}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-primary"
      disabled={!canSave}
      aria-describedby={tenantDeactivated ? FROZEN_HINT_ID : undefined}
      data-testid="packages-save"
      onclick={save}>{saving ? "Wird gespeichert …" : "Speichern"}</button
    >
  {/snippet}
</Section>

<style>
  .block {
    margin-top: 16px;
    overflow-wrap: anywhere;
  }

  .base {
    margin: 0 0 16px;
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  .modules {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .legend {
    padding: 0;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .module {
    min-width: 0;
  }

  .module-label {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    font-size: 16px;
    cursor: pointer;
  }

  .module-label input {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .module-desc {
    margin: 0 0 0 30px;
    overflow-wrap: anywhere;
  }

  .quota {
    margin-top: 16px;
    min-width: 0;
  }

  .quota-input {
    max-width: 160px;
  }

  .form-hint,
  .form-error {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .facts {
    display: grid;
    grid-template-columns: minmax(96px, 160px) 1fr;
    gap: 8px 16px;
    margin: 16px 0 0;
    font-size: 16px;
  }

  .facts dt {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .facts dd {
    margin: 0;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
