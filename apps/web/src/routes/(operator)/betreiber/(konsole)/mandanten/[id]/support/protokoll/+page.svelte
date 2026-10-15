<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import PageHead from "$components/layout/PageHead.svelte";
  import Breadcrumb from "$components/ui/Breadcrumb.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import SupportAuditLog, {
    type AuditFilter,
  } from "$lib/components/operator/SupportAuditLog.svelte";
  import { OperatorApiError, operatorApi } from "$lib/operator/client";
  import {
    failureText,
    SUPPORT_ACCESS_REQUIRED,
    SUPPORT_READ_OVERRIDES,
  } from "$lib/operator/reasons";
  import {
    dayFromQuery,
    defaultAuditWindow,
    pageFromQuery,
    windowError,
  } from "$lib/operator/support-audit";
  import {
    supportBasePath,
    supportLeavePath,
    supportProtocolPath,
    tenantPagePath,
  } from "$lib/operator/support-nav";
  import type { SupportAuditPage, SupportEmployee } from "$lib/operator/types";

  let tenantName = $state("");
  let employees = $state<SupportEmployee[]>([]);
  let employeesLoaded = $state(false);
  let audit = $state<SupportAuditPage | null>(null);
  let loading = $state(true);
  let errorText = $state("");
  // Guards against a slow answer for an earlier filter overwriting the one now shown.
  let loadSeq = 0;

  const tenantId = $derived($page.params.id ?? "");
  // The filters live in the URL (`von`, `bis`, `person`, `seite`); a missing or invalid day falls
  // back to the default window of the last 30 days.
  const query = $derived.by(() => {
    const params = $page.url.searchParams;
    const fallback = defaultAuditWindow();
    return {
      from: dayFromQuery(params.get("von")) ?? fallback.from,
      to: dayFromQuery(params.get("bis")) ?? fallback.to,
      person: params.get("person") ?? "",
      page: pageFromQuery(params.get("seite")),
    };
  });
  // A person that is not in the list is ignored, so the select always shows a real choice.
  const person = $derived(employees.some((e) => e.id === query.person) ? query.person : "");

  function leave() {
    void goto(supportLeavePath(tenantId, SUPPORT_ACCESS_REQUIRED));
  }

  async function load() {
    const seq = ++loadSeq;
    audit = null;
    errorText = "";
    const refused = windowError(query.from, query.to);
    if (refused !== null) {
      // A hand-edited URL never reaches the server with a window it would refuse.
      errorText = refused;
      loading = false;
      return;
    }
    loading = true;
    try {
      const result = await operatorApi.getSupportAuditLog(tenantId, {
        from: query.from,
        to: query.to,
        page: query.page,
        ...(person === "" ? {} : { employeeId: person }),
      });
      if (seq !== loadSeq) return;
      audit = result;
      loading = false;
    } catch (err) {
      if (seq !== loadSeq) return;
      if (err instanceof OperatorApiError && err.code === SUPPORT_ACCESS_REQUIRED) {
        leave();
        return;
      }
      errorText = failureText(err, { overrides: SUPPORT_READ_OVERRIDES });
      loading = false;
    }
  }

  function show(filter: AuditFilter, pageNo = 1) {
    void goto(
      supportProtocolPath(tenantId, {
        from: filter.from,
        to: filter.to,
        employeeId: filter.employeeId,
        page: pageNo,
      }),
      { keepFocus: true },
    );
  }

  // The tenant name is only for the breadcrumb; the person list only for the filter. A failure of
  // either leaves the neutral word or "Alle Personen"; only a missing access leaves the view.
  onMount(() => {
    void operatorApi
      .getTenant(tenantId)
      .then((tenant) => (tenantName = tenant.name))
      .catch(() => undefined);
    void operatorApi
      .listSupportEmployees(tenantId)
      .then((list) => (employees = list.items))
      .catch((err: unknown) => {
        if (err instanceof OperatorApiError && err.code === SUPPORT_ACCESS_REQUIRED) leave();
      })
      .finally(() => (employeesLoaded = true));
  });

  $effect(() => {
    if (!employeesLoaded) return;
    // Read every input of the request here so a change of any of them reloads.
    void [query.from, query.to, query.page, person];
    untrack(() => void load());
  });
</script>

<svelte:head>
  <title>Protokoll – Support – Betreiber – Clokr</title>
</svelte:head>

<div class="page" data-testid="op-support-protocol-page">
  <div>
    <Breadcrumb
      crumbs={[
        { label: "Mandanten", href: "/betreiber" },
        { label: tenantName || "Mandant", href: tenantPagePath(tenantId) },
        { label: "Support", href: supportBasePath(tenantId) },
        { label: "Protokoll" },
      ]}
    />
    <PageHead eyebrow="Support-Zugriff" title="Protokoll" sub="Änderungsprotokoll des Mandanten" />
  </div>

  <Section title="Änderungen" sub="Neueste zuerst. Freitext in Werten ist ausgeblendet." animate>
    <SupportAuditLog
      {employees}
      from={query.from}
      to={query.to}
      employeeId={person}
      {audit}
      loading={loading || !employeesLoaded}
      {errorText}
      onApply={(filter) => show(filter)}
      onPage={(pageNo) => show({ from: query.from, to: query.to, employeeId: person }, pageNo)}
      onRetry={() => void load()}
    />
  </Section>
</div>
