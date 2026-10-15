<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import SupportMonthView from "$lib/components/operator/SupportMonthView.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import {
    EMPLOYEE_NOT_FOUND,
    failureText,
    REASON_TEXTS,
    SUPPORT_ACCESS_REQUIRED,
    SUPPORT_READ_OVERRIDES,
  } from "$lib/operator/reasons";
  import {
    supportBasePath,
    supportContractsPath,
    supportLeavePath,
    supportMonthPath,
    tenantPagePath,
  } from "$lib/operator/support-nav";
  import {
    MAX_MONTH,
    MIN_MONTH,
    currentMonth,
    monthFromQuery,
    monthLabel,
    shiftMonth,
  } from "$lib/operator/support-month";
  import type { SupportEmployeeMonth } from "$lib/operator/types";

  type LoadState = "loading" | "ready" | "not-found" | "error";

  let tenantName = $state("");
  let data = $state<SupportEmployeeMonth | null>(null);
  let loadState = $state<LoadState>("loading");
  let errorText = $state("");
  // Guards against a slow answer for an earlier month overwriting the one now shown.
  let loadSeq = 0;

  const tenantId = $derived($page.params.id ?? "");
  const employeeId = $derived($page.params.employeeId ?? "");
  const month = $derived(monthFromQuery($page.url.searchParams.get("monat")) ?? currentMonth());
  const personName = $derived(data ? `${data.employee.lastName}, ${data.employee.firstName}` : "");

  async function load(forMonth: string) {
    const seq = ++loadSeq;
    loadState = "loading";
    data = null;
    try {
      const result = await operatorApi.getSupportEmployeeMonth(tenantId, employeeId, forMonth);
      if (seq !== loadSeq) return;
      data = result;
      loadState = "ready";
    } catch (err) {
      if (seq !== loadSeq) return;
      if (err instanceof OperatorApiError && err.code === SUPPORT_ACCESS_REQUIRED) {
        void goto(supportLeavePath(tenantId, SUPPORT_ACCESS_REQUIRED));
        return;
      }
      if (err instanceof OperatorApiError && err.status === 404) {
        loadState = "not-found";
        return;
      }
      errorText = failureText(err, { overrides: SUPPORT_READ_OVERRIDES });
      loadState = "error";
    }
  }

  function showMonth(next: string) {
    if (next === month) return;
    void goto(supportMonthPath(tenantId, employeeId, next), {
      replaceState: true,
      keepFocus: true,
    });
  }

  function onPick(event: Event) {
    const picked = monthFromQuery((event.currentTarget as HTMLInputElement).value);
    if (picked !== null) showMonth(picked);
  }

  // The tenant name is only for the breadcrumb; a failure leaves the neutral word.
  onMount(() => {
    void operatorApi
      .getTenant(tenantId)
      .then((tenant) => (tenantName = tenant.name))
      .catch(() => undefined);
  });

  $effect(() => {
    const wanted = month;
    untrack(() => void load(wanted));
  });
</script>

<svelte:head>
  <title>Monatsansicht – Support – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-support-month-page">
  <div>
    <Breadcrumb
      crumbs={[
        { label: "Mandanten", href: "/betreiber" },
        { label: tenantName || "Mandant", href: tenantPagePath(tenantId) },
        { label: "Support", href: supportBasePath(tenantId) },
        { label: personName || "Mitarbeitende Person" },
      ]}
    />
    <PageHead eyebrow="Support-Zugriff" title="Monatsansicht" sub={monthLabel(month)}>
      {#snippet actions()}
        <a
          class="btn btn-outline"
          href={supportContractsPath(tenantId, employeeId)}
          data-testid="op-support-contracts-link">Verträge</a
        >
      {/snippet}
    </PageHead>
  </div>

  <div class="month-nav" data-testid="op-support-month-nav">
    <button
      type="button"
      class="btn btn-outline"
      disabled={month === MIN_MONTH}
      data-testid="op-support-month-prev"
      onclick={() => showMonth(shiftMonth(month, -1))}>Vorheriger Monat</button
    >
    <div class="month-pick">
      <label class="form-label" for="op-support-month-input">Monat</label>
      <input
        id="op-support-month-input"
        class="form-input"
        type="month"
        min={MIN_MONTH}
        max={MAX_MONTH}
        value={month}
        data-testid="op-support-month-input"
        onchange={onPick}
      />
    </div>
    <button
      type="button"
      class="btn btn-outline"
      disabled={month === MAX_MONTH}
      data-testid="op-support-month-next"
      onclick={() => showMonth(shiftMonth(month, 1))}>Nächster Monat</button
    >
  </div>

  {#if loadState === "loading"}
    <div aria-busy="true" data-testid="op-support-month-loading">
      <span class="sr-only" role="status">Wird geladen …</span>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
    </div>
  {:else if loadState === "not-found"}
    <div data-testid="op-support-month-not-found">
      <p class="message">{REASON_TEXTS[EMPLOYEE_NOT_FOUND]}</p>
      <a class="btn btn-outline" href={supportBasePath(tenantId)}>Zur Mitarbeitendenliste</a>
    </div>
  {:else if loadState === "error"}
    <div class="alert alert-error" role="alert" data-testid="op-support-month-error">
      <p class="message">{errorText}</p>
      <button type="button" class="btn btn-outline" onclick={() => void load(month)}
        >Erneut laden</button
      >
    </div>
  {:else if data}
    <SupportMonthView month={data} />
  {/if}
</div>

<style>
  .month-nav {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 16px;
  }

  .month-nav :global(.btn) {
    min-height: 44px;
  }

  .month-pick {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .message {
    margin: 0 0 16px;
    font-size: 16px;
  }

  .row {
    height: 48px;
    margin-bottom: 8px;
  }
</style>
