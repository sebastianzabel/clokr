<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { onMount } from "svelte";

  let apiUrl = $state("http://localhost:4000");
  let terminalSecret = $state("");
  let autoStart = $state(false);
  let soundEnabled = $state(true);
  let readerConnected = $state(false);
  let queueSize = $state(0);
  let saving = $state(false);
  let saved = $state(false);

  onMount(async () => {
    try {
      const config: any = await invoke("get_config");
      apiUrl = config.api_url ?? "http://localhost:4000";
      terminalSecret = config.terminal_secret ?? "";
      autoStart = config.auto_start ?? false;
      soundEnabled = config.sound_enabled ?? true;
    } catch (e) {
      console.error("Failed to load config:", e);
    }

    try {
      readerConnected = await invoke("get_reader_status");
      queueSize = await invoke("get_queue_size");
    } catch (e) {
      console.error("Failed to get status:", e);
    }

    listen<boolean>("nfc:reader-status", (event) => {
      readerConnected = event.payload;
    });

    listen<number>("nfc:queue-size", (event) => {
      queueSize = event.payload;
    });
  });

  async function save() {
    saving = true;
    saved = false;
    try {
      await invoke("save_config", {
        config: {
          api_url: apiUrl,
          terminal_secret: terminalSecret || null,
          auto_start: autoStart,
          sound_enabled: soundEnabled,
        },
      });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    } catch (e) {
      console.error("Failed to save config:", e);
      alert("Fehler beim Speichern: " + e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="settings">
  <div class="header">
    <h1>Clokr NFC Terminal</h1>
    <p class="subtitle">Einstellungen</p>
  </div>

  <div class="status-bar">
    <div class="status-item">
      <span
        class="status-dot"
        class:connected={readerConnected}
        class:disconnected={!readerConnected}
      ></span>
      {readerConnected ? "Leser verbunden" : "Leser getrennt"}
    </div>
    {#if queueSize > 0}
      <div class="status-item queue-badge">
        {queueSize} in Warteschlange
      </div>
    {/if}
  </div>

  <form
    onsubmit={(e) => {
      e.preventDefault();
      save();
    }}
  >
    <div class="form-group">
      <label for="api-url">API URL</label>
      <input id="api-url" type="url" bind:value={apiUrl} placeholder="http://localhost:4000" />
    </div>

    <div class="form-group">
      <label for="secret">Terminal-Secret</label>
      <input id="secret" type="password" bind:value={terminalSecret} placeholder="Optional" />
    </div>

    <div class="form-group toggle-group">
      <label for="auto-start">Automatisch starten</label>
      <label class="switch">
        <input id="auto-start" type="checkbox" bind:checked={autoStart} />
        <span class="slider"></span>
      </label>
    </div>

    <div class="form-group toggle-group">
      <label for="sound">Ton bei Stempelung</label>
      <label class="switch">
        <input id="sound" type="checkbox" bind:checked={soundEnabled} />
        <span class="slider"></span>
      </label>
    </div>

    <div class="actions">
      <button type="submit" class="btn-primary" disabled={saving}>
        {saving ? "Speichert..." : "Speichern"}
      </button>
      {#if saved}
        <span class="saved-badge">Gespeichert</span>
      {/if}
    </div>
  </form>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .header h1 {
    margin: 0;
    font-size: 1.375rem;
    font-weight: 700;
    color: #fff;
  }

  .subtitle {
    margin: 0.25rem 0 0;
    font-size: 0.8125rem;
    color: #888;
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    font-size: 0.8125rem;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .status-dot.connected {
    background: #22c55e;
    box-shadow: 0 0 6px #22c55e80;
  }
  .status-dot.disconnected {
    background: #ef4444;
    box-shadow: 0 0 6px #ef444480;
  }

  .queue-badge {
    background: #f59e0b30;
    color: #f59e0b;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: #aaa;
  }

  .form-group input[type="url"],
  .form-group input[type="password"] {
    padding: 0.5rem 0.75rem;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    color: #fff;
    font-size: 0.875rem;
    outline: none;
    transition: border-color 0.15s;
  }

  .form-group input:focus {
    border-color: #7c3aed;
  }

  .toggle-group {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
  }

  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .slider {
    position: absolute;
    cursor: pointer;
    inset: 0;
    background: #444;
    border-radius: 24px;
    transition: 0.2s;
  }

  .slider::before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: 0.2s;
  }

  .switch input:checked + .slider {
    background: #7c3aed;
  }
  .switch input:checked + .slider::before {
    transform: translateX(20px);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .btn-primary {
    padding: 0.5rem 1.5rem;
    background: #7c3aed;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-primary:hover {
    background: #6d28d9;
  }
  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .saved-badge {
    font-size: 0.8125rem;
    color: #22c55e;
    font-weight: 500;
  }
</style>
