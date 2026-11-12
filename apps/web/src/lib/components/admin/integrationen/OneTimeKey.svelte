<!--
  OneTimeKey - the one-time display of a freshly created key (NFC terminal key, API key, presence source key;
  Issue #854, T-854-34). The secret exists only in the parent's state until the person closes this block: it is
  never stored, never logged and never rendered again afterwards. The block stays until it is closed on
  purpose, so the person cannot lose the key by a click elsewhere.

  Props:
    title   - heading, e.g. „Neuer Schlüssel erstellt“
    rawKey  - the secret as the API returned it once
    onclose - the parent forgets the secret
-->
<script lang="ts">
  import { toasts } from "$stores/toast";

  interface Props {
    title: string;
    rawKey: string;
    onclose: () => void;
  }

  let { title, rawKey, onclose }: Props = $props();

  async function copy() {
    try {
      await navigator.clipboard.writeText(rawKey);
      toasts.success("Schlüssel kopiert.");
    } catch {
      toasts.error(
        "Der Schlüssel konnte nicht kopiert werden. Markier ihn und kopier ihn von Hand.",
      );
    }
  }
</script>

<div class="otk" role="status" aria-live="polite" data-testid="one-time-key">
  <p class="otk-title">{title}</p>
  <p class="otk-hint">Kopier den Schlüssel jetzt. Er wird nicht erneut angezeigt.</p>
  <div class="otk-row">
    <code class="otk-value">{rawKey}</code>
    <button type="button" class="btn btn-secondary btn-sm" onclick={copy}>Kopieren</button>
  </div>
  <div>
    <button type="button" class="btn btn-secondary btn-sm" onclick={onclose}>Schließen</button>
  </div>
</div>

<style>
  .otk {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: var(--s-4);
    margin-bottom: var(--s-4);
    border: 1px solid var(--ok);
    border-radius: var(--r-control);
    background: var(--sunk);
  }

  .otk-title {
    margin: 0;
    font-weight: 600;
    color: var(--text);
  }

  .otk-hint {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .otk-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }

  .otk-value {
    flex: 1 1 16rem;
    min-width: 0;
    padding: var(--s-2);
    border-radius: var(--r-control);
    background: var(--card);
    border: 1px solid var(--line);
    font-family: var(--font-code);
    font-size: var(--fs-sm);
    word-break: break-all;
    color: var(--text);
  }
</style>
