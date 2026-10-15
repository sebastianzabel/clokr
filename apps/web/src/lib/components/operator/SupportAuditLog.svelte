<!--
  SupportAuditLog - the change log of one tenant under a support access (Issue #93, D-05(4), D-17).

  Filter row (window and optional person), the rows newest first, and the pager. Old and new values are
  shown as key/value lists; the server has already replaced every free-text string by the constant
  marker, the browser only draws it muted with a screen-reader hint and never decides what is visible.
  A window above 92 days is refused here before any request (the server enforces the same cap).
  The page owns the requests and the URL; this component only reports what was chosen.
-->
<script lang="ts">
  import Pagination from "$components/ui/Pagination.svelte";
  import { formatOperatorDateTime } from "$lib/operator/labels";
  import { auditActor, flattenAuditValue, windowError } from "$lib/operator/support-audit";
  import type { SupportAuditPage, SupportEmployee } from "$lib/operator/types";

  export interface AuditFilter {
    from: string;
    to: string;
    employeeId: string;
  }

  interface Props {
    employees: SupportEmployee[];
    /** The applied filter, as it stands in the URL. */
    from: string;
    to: string;
    employeeId: string;
    /** The current page; null while loading or after a failure. */
    audit: SupportAuditPage | null;
    loading?: boolean;
    errorText?: string;
    onApply: (filter: AuditFilter) => void;
    onPage: (page: number) => void;
    onRetry: () => void;
  }

  let {
    employees,
    from,
    to,
    employeeId,
    audit,
    loading = false,
    errorText = "",
    onApply,
    onPage,
    onRetry,
  }: Props = $props();

  // The inputs start from the applied filter and follow it when the URL changes (back button).
  let fromValue = $derived(from);
  let toValue = $derived(to);
  let personValue = $derived(employeeId);
  let refusal = $state("");

  function apply(event: SubmitEvent) {
    event.preventDefault();
    const problem = windowError(fromValue, toValue);
    if (problem !== null) {
      refusal = problem;
      return;
    }
    refusal = "";
    onApply({ from: fromValue, to: toValue, employeeId: personValue });
  }

  function personLabel(employee: SupportEmployee): string {
    return `${employee.lastName}, ${employee.firstName} (${employee.employeeNumber})`;
  }
</script>

<div class="log" data-testid="op-support-audit">
  <form class="filters" onsubmit={apply} novalidate>
    <div class="field">
      <label class="form-label" for="op-support-audit-from-input">Von</label>
      <input
        id="op-support-audit-from-input"
        class="form-input"
        type="date"
        bind:value={fromValue}
        aria-describedby="op-support-audit-hint"
        data-testid="op-support-audit-from"
      />
    </div>
    <div class="field">
      <label class="form-label" for="op-support-audit-to-input">Bis</label>
      <input
        id="op-support-audit-to-input"
        class="form-input"
        type="date"
        bind:value={toValue}
        aria-describedby="op-support-audit-hint"
        data-testid="op-support-audit-to"
      />
    </div>
    <div class="field person">
      <label class="form-label" for="op-support-audit-person-input">Person</label>
      <select
        id="op-support-audit-person-input"
        class="form-input"
        bind:value={personValue}
        data-testid="op-support-audit-person"
      >
        <option value="">Alle Personen</option>
        {#each employees as employee (employee.id)}
          <option value={employee.id}>{personLabel(employee)}</option>
        {/each}
      </select>
    </div>
    <button type="submit" class="btn btn-primary" data-testid="op-support-audit-apply"
      >Anzeigen</button
    >
  </form>
  <p class="form-hint hint" id="op-support-audit-hint">
    Der Zeitraum zählt in UTC-Kalendertagen und umfasst höchstens 92 Tage. Uhrzeiten erscheinen in
    der Zeitzone dieses Browsers.
  </p>
  {#if refusal !== ""}
    <p class="form-error problem" role="alert" data-testid="op-support-audit-window-error">
      {refusal}
    </p>
  {/if}

  {#if loading}
    <div aria-busy="true" data-testid="op-support-audit-loading">
      <span class="sr-only" role="status">Wird geladen …</span>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
      <div class="skeleton row"></div>
    </div>
  {:else if errorText !== ""}
    <div class="alert alert-error" role="alert" data-testid="op-support-audit-error">
      <p class="message">{errorText}</p>
      <button
        type="button"
        class="btn btn-outline"
        data-testid="op-support-audit-retry"
        onclick={onRetry}>Erneut laden</button
      >
    </div>
  {:else if audit}
    {#if audit.items.length === 0}
      <p class="empty">Keine Änderungen im gewählten Zeitraum.</p>
    {:else}
      <ul class="entries">
        {#each audit.items as item (item.id)}
          {@const actor = auditActor(item)}
          {@const oldRows = flattenAuditValue(item.oldValue)}
          {@const newRows = flattenAuditValue(item.newValue)}
          <li class="entry" data-testid={`op-support-audit-row-${item.id}`}>
            <div class="entry-head">
              <span class="when">{formatOperatorDateTime(item.createdAt)}</span>
              <span class="badge badge-gray action">{item.action}</span>
              <span class="what text">
                {item.entity}
                {#if item.entityId}<span class="mono">{item.entityId}</span>{/if}
              </span>
              <span class="who" data-actor={actor.kind}>{actor.text}</span>
            </div>
            <details class="values">
              <summary>Werte anzeigen</summary>
              <div class="value-columns">
                {#each [{ title: "Vorher", rows: oldRows }, { title: "Nachher", rows: newRows }] as column (column.title)}
                  <div class="value-column">
                    <h4 class="value-title">{column.title}</h4>
                    {#if column.rows.length === 0}
                      <p class="none">Kein Wert</p>
                    {:else}
                      <dl class="pairs">
                        {#each column.rows as row, index (index)}
                          <div class="pair">
                            <dt class="mono">{row.path === "" ? "Wert" : row.path}</dt>
                            <dd>
                              {#if row.redacted}
                                <span class="redacted" data-testid="op-support-audit-redacted"
                                  ><span aria-hidden="true">{row.text}</span><span class="sr-only"
                                    >ausgeblendet</span
                                  ></span
                                >
                              {:else}
                                <span class="text">{row.text}</span>
                              {/if}
                            </dd>
                          </div>
                        {/each}
                      </dl>
                    {/if}
                  </div>
                {/each}
              </div>
            </details>
          </li>
        {/each}
      </ul>
      {#if audit.total > audit.pageSize}
        <div data-testid="op-support-audit-pagination">
          <Pagination
            total={audit.total}
            page={audit.page}
            pageSize={audit.pageSize}
            pageSizeOptions={[audit.pageSize]}
            labelSingular="Änderung"
            labelPlural="Änderungen"
            onChange={({ page }) => onPage(page)}
          />
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .log {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .field.person {
    flex: 1 1 220px;
  }

  .filters :global(.btn) {
    min-height: 44px;
  }

  .hint,
  .problem {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .problem {
    color: var(--bad-text);
  }

  .message {
    margin: 0 0 16px;
    font-size: 16px;
  }

  .row {
    height: 48px;
    margin-bottom: 8px;
  }

  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }

  .entries {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
  }

  .entry {
    padding: 12px 16px;
    min-width: 0;
    border-bottom: 1px solid var(--border);
  }

  .entry:last-child {
    border-bottom: 0;
  }

  .entry-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 16px;
    min-width: 0;
  }

  .when {
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    font-size: 13px;
  }

  .action {
    overflow-wrap: anywhere;
  }

  .what {
    font-weight: 600;
  }

  .who {
    font-size: 13px;
    color: var(--text-muted);
  }

  .text {
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 400;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .values {
    margin-top: 8px;
  }

  .values summary {
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
    font-size: 13px;
    color: var(--text);
  }

  .value-columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
    gap: 16px;
    padding-top: 8px;
  }

  .value-column {
    min-width: 0;
  }

  .value-title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
  }

  .none {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  .pairs {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
  }

  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: 0 12px;
    min-width: 0;
  }

  .pair dt {
    color: var(--text-muted);
  }

  .pair dd {
    margin: 0;
    font-size: 13px;
    min-width: 0;
  }

  /* The server's redaction marker: present, readable, and visibly not a stored value. */
  .redacted {
    color: var(--text-muted);
    font-style: italic;
  }
</style>
