<!--
  SupportBanner - the persistent notice above every support read view (Issue #93, D-09, D-21).

  It says until when the access runs, why it was requested and that every read is logged, and it
  shows the remaining time. The remaining time is always derived from the absolute expiry against a
  1 s clock, never from a decremented counter: a throttled background tab must not drift behind the
  real expiry. When it reaches zero the banner reports it exactly once through `onExpired`; the
  layout then leaves the view.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { formatGrantRemaining, remainingMs } from "$lib/operator/countdown";
  import { formatOperatorDateTime } from "$lib/operator/labels";

  interface Props {
    /** Absolute end of the access, ISO instant. */
    expiresAt: string;
    reason: string;
    /** Called once when the remaining time reaches zero (also when it is zero at mount). */
    onExpired: () => void;
  }

  let { expiresAt, reason, onExpired }: Props = $props();

  let now = $state(Date.now());
  let reported = false;

  onMount(() => {
    const ticker = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(ticker);
  });

  const remaining = $derived(remainingMs(Date.parse(expiresAt), now));
  const expired = $derived(remaining <= 0);

  $effect(() => {
    if (expired && !reported) {
      reported = true;
      onExpired();
    }
  });
</script>

<div class="callout brand banner" role="status" data-testid="op-support-banner">
  <div class="text">
    <p class="line">
      <b
        >Support-Zugriff aktiv bis <span data-testid="op-support-banner-until"
          >{formatOperatorDateTime(expiresAt)}</span
        ></b
      >
      <span class="remaining" data-testid="op-support-banner-remaining"
        >{formatGrantRemaining(remaining)}</span
      >
    </p>
    <p class="reason" data-testid="op-support-banner-reason">Grund: {reason}</p>
    <p>Jeder Abruf wird protokolliert.</p>
  </div>
</div>

<style>
  .banner {
    margin: 0 0 24px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    align-items: baseline;
  }

  .remaining {
    font-variant-numeric: tabular-nums;
  }

  .reason {
    overflow-wrap: anywhere;
  }
</style>
