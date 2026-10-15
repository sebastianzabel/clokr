<!--
  SupportSection - the "Support-Zugriff" section of the operator's tenant page (Issue #93, D-09).

  Without a running access it offers the request form (reason and duration); with one it shows the
  end time in the browser's zone, the remaining time derived from `expiresAt - now`, the reason,
  the links into the read views and "Zugriff beenden" behind a danger confirmation. Below that the
  operator's own history lists every earlier access with its status.

  The component only asks: the page owns the API calls and the reload, like PackagesSection. The
  limits (10 to 500 characters, four durations) mirror the server, which stays the authority; a
  refusal is worded by its machine code, never by the server's text. A deactivated tenant freezes
  every control and says why. A `notice` code handed back from a read view is shown as a callout.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import { formatGrantRemaining, remainingMs } from "$lib/operator/countdown";
  import {
    SUPPORT_DURATION_OPTIONS,
    SUPPORT_ENDED_BY_LABELS,
    SUPPORT_STATUS_LABELS,
    formatOperatorDateTime,
  } from "$lib/operator/labels";
  import {
    REASON_TEXTS,
    SUPPORT_ACCESS_NOT_FOUND,
    SUPPORT_NOTICE_CODES,
    failureText,
  } from "$lib/operator/reasons";
  import type {
    OperatorSupportAccess,
    OperatorSupportAccessState,
    RequestSupportAccessBody,
    SupportAccessStatus,
    SupportDurationHours,
  } from "$lib/operator/types";

  interface Props {
    tenantId: string;
    state: OperatorSupportAccessState;
    /** The tenant is deactivated: every control is disabled and the reason is shown. */
    tenantDeactivated?: boolean;
    /** Code a read view handed back (`SUPPORT_ACCESS_REQUIRED` / `SUPPORT_ACCESS_EXPIRED`); anything else is ignored. */
    notice?: string | null;
    /** Receives the trimmed reason and the duration; rejects with the client's error on failure. */
    onRequest: (body: RequestSupportAccessBody) => Promise<void>;
    /** Receives the id of the running access; rejects with the client's error on failure. */
    onEnd: (accessId: string) => Promise<void>;
    /** Reloads the page state when a refusal shows that it is stale. */
    onReload?: () => Promise<void>;
  }

  let {
    tenantId,
    state: supportState,
    tenantDeactivated = false,
    notice = null,
    onRequest,
    onEnd,
    onReload,
  }: Props = $props();

  const REASON_MIN = 10;
  const REASON_MAX = 500;
  const REASON_ID = "op-support-reason-input";
  const REASON_HINT_ID = "op-support-reason-hint";
  const REASON_ERROR_ID = "op-support-reason-error";
  const FROZEN_HINT_ID = "op-support-frozen-hint";
  const REASON_LENGTH_MESSAGE = `Der Grund muss ${REASON_MIN} bis ${REASON_MAX} Zeichen lang sein.`;
  /** Refusals that show the page state is stale: a reload brings the real state on screen. */
  const STALE_CODES: readonly string[] = [
    "SUPPORT_ACCESS_ALREADY_ACTIVE",
    "SUPPORT_ACCESS_NOT_ACTIVE",
  ];

  interface Failure {
    code: string | undefined;
    text: string;
  }

  let reason = $state("");
  let reasonTouched = $state(false);
  let duration = $state<SupportDurationHours>(1);
  let submitting = $state(false);
  let requestError = $state<Failure | null>(null);
  let endOpen = $state(false);
  let endError = $state<Failure | null>(null);
  // The remaining time is always derived from the absolute expiry against this clock, never from a
  // counter that is decremented: a throttled background tab must not drift behind the real expiry.
  let now = $state(Date.now());

  onMount(() => {
    const ticker = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(ticker);
  });

  const durationOptions = SUPPORT_DURATION_OPTIONS.map((option) => ({
    value: String(option.value),
    label: option.label,
  }));

  const trimmedLength = $derived(reason.trim().length);
  const reasonTooShort = $derived(trimmedLength < REASON_MIN);
  const reasonTooLong = $derived(trimmedLength > REASON_MAX);
  const reasonValid = $derived(!reasonTooShort && !reasonTooLong);
  const showReasonError = $derived(
    reasonTooLong || (reasonTouched && trimmedLength > 0 && reasonTooShort),
  );
  const canRequest = $derived(reasonValid && !submitting && !tenantDeactivated);

  // The running access, until its expiry passes on the clock: then the form state returns without a request.
  const active = $derived(
    supportState.active && Date.parse(supportState.active.expiresAt) > now
      ? supportState.active
      : null,
  );
  const remaining = $derived(active ? remainingMs(Date.parse(active.expiresAt), now) : 0);
  const shownNotice = $derived(
    notice !== null && SUPPORT_NOTICE_CODES.includes(notice) ? notice : null,
  );

  /** The stored status, except that a grant whose expiry passed on the clock reads as expired. */
  function statusOf(access: OperatorSupportAccess): SupportAccessStatus {
    return access.status === "ACTIVE" && Date.parse(access.expiresAt) <= now
      ? "EXPIRED"
      : access.status;
  }

  function endedLine(access: OperatorSupportAccess): string | null {
    return access.status === "ENDED" && access.endedBy
      ? `beendet ${SUPPORT_ENDED_BY_LABELS[access.endedBy]}`
      : null;
  }

  function failureOf(error: unknown): Failure {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return {
      code: typeof code === "string" ? code : undefined,
      text: failureText(error, { notFoundCode: SUPPORT_ACCESS_NOT_FOUND }),
    };
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canRequest) return;
    submitting = true;
    requestError = null;
    try {
      await onRequest({ reason: reason.trim(), durationHours: duration });
      reason = "";
      reasonTouched = false;
      duration = 1;
    } catch (error) {
      requestError = failureOf(error);
      if (requestError.code !== undefined && STALE_CODES.includes(requestError.code)) {
        void onReload?.();
      }
    } finally {
      submitting = false;
    }
  }

  function openEnd() {
    endError = null;
    endOpen = true;
  }

  async function confirmEnd() {
    const access = supportState.active;
    if (!access) return;
    try {
      await onEnd(access.id);
    } catch (error) {
      endError = failureOf(error);
      if (endError.code !== undefined && STALE_CODES.includes(endError.code)) {
        void onReload?.();
      }
      throw error;
    }
    endError = null;
  }

  const supportBase = $derived(`/betreiber/mandanten/${encodeURIComponent(tenantId)}/support`);
</script>

<Section
  title="Support-Zugriff"
  sub="Befristete, protokollierte Einsicht in Mandantendaten"
  animate
>
  <div data-testid="op-support-section">
    {#if shownNotice}
      <div
        class="callout brand block first"
        role="status"
        data-code={shownNotice}
        data-testid="op-support-notice"
      >
        <p>{REASON_TEXTS[shownNotice]}</p>
      </div>
    {/if}

    {#if tenantDeactivated}
      <div class="callout brand block" id={FROZEN_HINT_ID} data-testid="op-support-frozen-hint">
        <p>{REASON_TEXTS.TENANT_DEACTIVATED}</p>
      </div>
    {/if}

    {#if active}
      <div data-testid="op-support-active">
        <dl class="facts">
          <dt>Aktiv bis</dt>
          <dd data-testid="op-support-expires">{formatOperatorDateTime(active.expiresAt)}</dd>
          <dt>Verbleibend</dt>
          <dd data-testid="op-support-remaining">{formatGrantRemaining(remaining)}</dd>
          <dt>Grund</dt>
          <dd class="reason-text" data-testid="op-support-active-reason">{active.reason}</dd>
        </dl>

        <div class="actions">
          {#if tenantDeactivated}
            <span
              class="btn btn-outline frozen-link"
              role="link"
              aria-disabled="true"
              aria-describedby={FROZEN_HINT_ID}
              data-testid="op-support-link-employees">Mitarbeitende ansehen</span
            >
            <span
              class="btn btn-outline frozen-link"
              role="link"
              aria-disabled="true"
              aria-describedby={FROZEN_HINT_ID}
              data-testid="op-support-link-protocol">Protokoll ansehen</span
            >
          {:else}
            <a class="btn btn-outline" href={supportBase} data-testid="op-support-link-employees"
              >Mitarbeitende ansehen</a
            >
            <a
              class="btn btn-outline"
              href={`${supportBase}/protokoll`}
              data-testid="op-support-link-protocol">Protokoll ansehen</a
            >
          {/if}
          <button
            type="button"
            class="btn btn-ghost danger"
            aria-haspopup="dialog"
            aria-describedby={tenantDeactivated ? FROZEN_HINT_ID : undefined}
            disabled={tenantDeactivated}
            data-testid="op-support-end"
            onclick={openEnd}>Zugriff beenden</button
          >
        </div>
      </div>
    {:else}
      <form class="request" onsubmit={submit} novalidate>
        <div class="form-group">
          <label class="form-label" for={REASON_ID}>Grund</label>
          <textarea
            id={REASON_ID}
            class="form-input"
            rows="3"
            disabled={tenantDeactivated}
            aria-invalid={showReasonError ? "true" : undefined}
            aria-describedby={showReasonError
              ? `${REASON_ERROR_ID} ${REASON_HINT_ID}`
              : REASON_HINT_ID}
            data-testid="op-support-reason"
            bind:value={reason}
            onblur={() => (reasonTouched = true)}
            oninput={() => (requestError = null)}
          ></textarea>
          <p class="counter" aria-hidden="true" data-testid="op-support-reason-count">
            {trimmedLength} / {REASON_MAX}
          </p>
          {#if showReasonError}
            <p class="form-error" id={REASON_ERROR_ID} data-testid="op-support-reason-error">
              {REASON_LENGTH_MESSAGE}
            </p>
          {/if}
        </div>

        <div class="form-group">
          <span class="form-label">Dauer</span>
          <div class="duration" data-testid="op-support-duration" data-value={String(duration)}>
            <SegmentedControl
              options={durationOptions}
              value={String(duration)}
              ariaLabel="Dauer"
              name="op-support-duration"
              disabled={tenantDeactivated}
              onchange={(next) => {
                requestError = null;
                duration = Number(next) as SupportDurationHours;
              }}
            />
          </div>
        </div>

        <p class="form-hint" id={REASON_HINT_ID}>
          Jeder Abruf wird im Betreiber- und im Mandantenprotokoll gespeichert. Der Mandant sieht
          Grund und Zeitraum und kann den Zugriff jederzeit beenden.
        </p>

        {#if requestError}
          <div
            class="alert alert-error block"
            role="alert"
            data-code={requestError.code}
            data-testid="op-support-error"
          >
            {requestError.text}
          </div>
        {/if}

        <div class="actions">
          <button
            type="submit"
            class="btn btn-primary"
            disabled={!canRequest}
            aria-describedby={tenantDeactivated ? FROZEN_HINT_ID : undefined}
            data-testid="op-support-request"
            >{submitting ? "Wird angefordert …" : "Zugriff anfordern"}</button
          >
        </div>
      </form>
    {/if}

    <div class="history" data-testid="op-support-history">
      <h3 class="history-title">Bisherige Zugriffe</h3>
      {#if supportState.history.length === 0}
        <p class="empty" data-testid="op-support-history-empty">Noch keine Support-Zugriffe.</p>
      {:else}
        <div class="table-wrap">
          <table class="data-table history-table">
            <caption class="sr-only">Bisherige Support-Zugriffe</caption>
            <thead>
              <tr>
                <th scope="col">Beginn</th>
                <th scope="col">Ende</th>
                <th scope="col">Status</th>
                <th scope="col">Grund</th>
              </tr>
            </thead>
            <tbody>
              {#each supportState.history as access (access.id)}
                {@const status = statusOf(access)}
                {@const ended = endedLine(access)}
                <tr data-testid={`op-support-history-row-${access.id}`}>
                  <td data-label="Beginn">{formatOperatorDateTime(access.startedAt)}</td>
                  <td data-label="Ende">
                    {formatOperatorDateTime(access.endedAt ?? access.expiresAt)}
                    {#if ended}<span class="ended">{ended}</span>{/if}
                  </td>
                  <td data-label="Status">
                    <span
                      class="badge"
                      class:badge-green={status === "ACTIVE"}
                      class:badge-gray={status !== "ACTIVE"}
                      data-testid={`op-support-status-${access.id}`}
                      data-state={status.toLowerCase()}>{SUPPORT_STATUS_LABELS[status]}</span
                    >
                  </td>
                  <td class="cell-reason" data-label="Grund">
                    <span class="clamp" title={access.reason}>{access.reason}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  </div>
</Section>

<ConfirmDialog
  bind:open={endOpen}
  danger
  title="Support-Zugriff beenden?"
  description="Der Zugriff endet sofort. Für eine weitere Einsicht ist ein neuer Antrag mit Grund nötig."
  confirmLabel="Zugriff beenden"
  onConfirm={confirmEnd}
>
  {#snippet body()}
    {#if endError}
      <div
        class="callout brand"
        role="alert"
        data-code={endError.code}
        data-testid="op-support-end-error"
      >
        <p>{endError.text}</p>
      </div>
    {/if}
  {/snippet}
</ConfirmDialog>

<style>
  .block {
    margin-top: 16px;
    overflow-wrap: anywhere;
  }

  .block.first {
    margin-top: 0;
  }

  .request {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 16px;
    min-width: 0;
  }

  .form-group {
    min-width: 0;
  }

  .counter {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .form-hint,
  .form-error {
    margin: 0;
    overflow-wrap: anywhere;
  }

  /* Four options at the segmented control's padding exceed a 360 px Section: scroll inside the
     row instead of widening the page. */
  .duration {
    max-width: 100%;
    overflow-x: auto;
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
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }

  .reason-text {
    white-space: pre-wrap;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }

  /* The v1.5 .btn recipe resets min-height to 0; the actions keep the 44 px touch target. */
  .actions :global(.btn) {
    min-height: 44px;
  }

  .danger {
    color: var(--bad-text);
  }

  .frozen-link {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .history {
    margin-top: 24px;
    min-width: 0;
  }

  .history-title {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .empty {
    margin: 0;
    font-size: 16px;
    color: var(--text-muted);
  }

  .ended {
    display: block;
    font-size: 13px;
    color: var(--text-muted);
  }

  .clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .cell-reason {
    min-width: 0;
  }

  @media (max-width: 559px) {
    .facts {
      grid-template-columns: 1fr;
      gap: 4px;
    }

    .facts dd {
      margin-bottom: 8px;
    }
  }

  @media (max-width: 639px) {
    .history-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .history-table,
    .history-table tbody {
      display: block;
    }

    .history-table tr {
      display: block;
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }

    .history-table tbody tr:last-child {
      border-bottom: 0;
    }

    .history-table td {
      display: block;
      padding: 0;
      border: 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .history-table td + td {
      margin-top: 4px;
    }

    .history-table td::before {
      content: attr(data-label) ": ";
      font-weight: 600;
      color: var(--text-muted);
    }
  }
</style>
