import "dotenv/config";
import { createServer } from "http";
import { Tr064Client } from "./tr064.js";
import { PresenceStateManager } from "./state.js";
import type { FritzDevice } from "./tr064.js";
import type { PresenceEvent } from "./state.js";

// ── Environment validation ─────────────────────────────────────────────────────

const REQUIRED_VARS = [
  "FRITZBOX_URL",
  "FRITZBOX_USER",
  "FRITZBOX_PASS",
  "CLOKR_API_URL",
  "CLOKR_PRESENCE_KEY",
] as const;

for (const varName of REQUIRED_VARS) {
  if (!process.env[varName]) {
    console.error(`[fritzbox-adapter] ERROR: ${varName} is required`);
    process.exit(1);
  }
}

const FRITZBOX_URL = process.env.FRITZBOX_URL!;
const FRITZBOX_USER = process.env.FRITZBOX_USER!;
const FRITZBOX_PASS = process.env.FRITZBOX_PASS!;
const CLOKR_API_URL = process.env.CLOKR_API_URL!;
// T-25-09-02: CLOKR_PRESENCE_KEY must never be logged — not printed in startup banner
const CLOKR_PRESENCE_KEY = process.env.CLOKR_PRESENCE_KEY!;

// Clamp poll interval to minimum 10 s to prevent hammering the FritzBox
const pollIntervalSeconds = Math.max(10, parseInt(process.env.POLL_INTERVAL_SECONDS ?? "60", 10));
const pollIntervalMs = pollIntervalSeconds * 1_000;

const devicesPort = parseInt(process.env.DEVICES_PORT ?? "8765", 10);
// T-25-09-03: default to loopback only — never expose to public internet
const devicesBind = process.env.DEVICES_BIND ?? "127.0.0.1";

// ── Initialization ─────────────────────────────────────────────────────────────

const client = new Tr064Client(FRITZBOX_URL, FRITZBOX_USER, FRITZBOX_PASS);
const stateMgr = new PresenceStateManager();
let lastHosts: FritzDevice[] = [];

// ── Webhook poster ─────────────────────────────────────────────────────────────

/**
 * POST a single presence event to the clokr-api webhook.
 *
 * IMPORTANT: internal PresenceEvent uses { macAddress, state } for code clarity,
 * but the clokr-api Zod schema expects { mac, eventType, timestamp, adapter }.
 * We remap here. Sending { macAddress, state } would result in a 400 error.
 */
async function postEvent(event: PresenceEvent): Promise<void> {
  const body = JSON.stringify({
    mac: event.macAddress,
    eventType: event.state,
    timestamp: event.timestamp.toISOString(),
    adapter: "fritzbox",
  });

  try {
    const res = await fetch(`${CLOKR_API_URL}/api/v1/presence/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // T-25-09-02: key sent in Authorization header — never logged below
        Authorization: `Bearer ${CLOKR_PRESENCE_KEY}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[fritzbox-adapter] Webhook POST failed (${res.status}): ${text.slice(0, 200)}`,
      );
    } else {
      console.warn(`[fritzbox-adapter] Event posted: mac=${event.macAddress} state=${event.state}`);
    }
  } catch (err) {
    console.error(`[fritzbox-adapter] Webhook POST error:`, err);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

/**
 * Single poll cycle: fetch host list from FritzBox, diff state, post events.
 * Non-throwing — errors are logged and the next poll retries (T-25-09-04).
 */
async function pollOnce(): Promise<void> {
  try {
    const hosts = await client.getHostList();
    lastHosts = hosts;

    const now = new Date();
    const events = stateMgr.processHostList(hosts, now);

    for (const event of events) {
      await postEvent(event);
    }
  } catch (err) {
    console.error(`[fritzbox-adapter] Poll error (will retry next interval):`, err);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.warn(
  `[fritzbox-adapter] Starting. Poll interval: ${pollIntervalSeconds}s, devices on ${devicesBind}:${devicesPort}`,
);

// Initial poll immediately — don't wait for first interval tick
void pollOnce();
const pollTimer = setInterval(() => void pollOnce(), pollIntervalMs);

// ── GET /devices HTTP server ──────────────────────────────────────────────────
// CR-02: require the same CLOKR_PRESENCE_KEY as a Bearer token so that only
// the Clokr API proxy (which forwards the key) can read the host table.

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/devices") {
    // Authenticate: require Bearer token matching CLOKR_PRESENCE_KEY
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${CLOKR_PRESENCE_KEY}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const payload = JSON.stringify(lastHosts);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(devicesPort, devicesBind, () => {
  console.warn(`[fritzbox-adapter] Devices endpoint listening on ${devicesBind}:${devicesPort}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
  console.warn("[fritzbox-adapter] Shutting down...");
  clearInterval(pollTimer);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
