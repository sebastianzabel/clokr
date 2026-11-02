import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { PairingConfig } from "./pairing-config.js";
import { Tr064HttpError, type HostEntry } from "./tr064.js";

/**
 * The opt-in pairing listener (Issue #610): a phone that scans the salon QR code opens
 * GET /koppeln, the adapter asks the FRITZ!Box which device holds the phone's own LAN address,
 * registers a one-time code for that MAC with the Clokr API and redirects the phone to Clokr.
 *
 * Trust model: the only input that decides the device is the TCP peer address of the socket.
 * The handler reads the request method, the pathname of the request URL and the socket peer -
 * nothing else. Anything a client can write into a request (query string, body, headers,
 * including proxy addressing headers) is ignored as a whole, so a request can only ever couple the
 * device that physically made it.
 */

// ── Peer address ──────────────────────────────────────────────────────────────

export type PeerClassification = { ok: true; ip: string } | { ok: false };

const MAPPED_V4_PREFIX = /^::ffff:/i;

/** Expand an IPv6 literal to eight 16-bit groups, or null when it does not parse. */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  // An embedded dotted IPv4 tail ("::ffff:1.2.3.4") counts as two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return values.length === 8 && values.every((v) => !Number.isNaN(v)) ? values : null;
}

function isRefusedIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  // 0.0.0.0/8 (unspecified), 127.0.0.0/8 (loopback), 169.254.0.0/16 (link-local)
  return a === 0 || a === 127 || (a === 169 && b === 254);
}

/**
 * Validate the raw socket peer address. A peer that cannot be a phone in the salon WLAN is
 * refused before any TR-064 call: missing or invalid, unspecified, loopback, link-local, or one of
 * this host's own interface addresses (what a container sees when the published port hides the
 * phone behind the Docker gateway). An IPv4-mapped IPv6 address is judged as its IPv4.
 */
export function classifyPeer(
  raw: string | undefined,
  ownAddresses: ReadonlySet<string> = new Set(),
): PeerClassification {
  if (!raw) return { ok: false };
  // Drop a zone id ("fe80::1%eth0"): it names an interface, not an address.
  let ip = raw.split("%")[0].toLowerCase();
  if (MAPPED_V4_PREFIX.test(ip)) {
    const rest = ip.replace(MAPPED_V4_PREFIX, "");
    if (isIP(rest) === 4) ip = rest;
  }

  const family = isIP(ip);
  if (family === 0) return { ok: false };

  if (family === 4) {
    if (isRefusedIpv4(ip)) return { ok: false };
  } else {
    const groups = expandIpv6(ip);
    if (!groups) return { ok: false };
    // IPv4-mapped in its hex spelling ("::ffff:7f00:1") is judged as the IPv4 it carries.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
      if (isRefusedIpv4(v4) || ownAddresses.has(v4)) return { ok: false };
      return { ok: true, ip: v4 };
    }
    const unspecified = groups.every((g) => g === 0);
    const loopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
    if (unspecified || loopback || linkLocal) return { ok: false };
  }

  if (ownAddresses.has(ip)) return { ok: false };
  return { ok: true, ip };
}

/** Every address of this host's own network interfaces (lower case, no zone id). */
export function ownInterfaceAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): Set<string> {
  const own = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      own.add(entry.address.split("%")[0].toLowerCase());
    }
  }
  return own;
}

// ── Rate limit ────────────────────────────────────────────────────────────────

export interface RateLimiter {
  check(peer: string): "ok" | "peer" | "global";
}

/**
 * Sliding-window limits: per peer and over all peers. Only admitted requests are counted, so a
 * refused flood does not push the window out and the limiter's memory stays bounded by the global
 * maximum.
 */
export function createRateLimiter(
  options: {
    perPeerMax?: number;
    globalMax?: number;
    windowMs?: number;
    now?: () => number;
  } = {},
): RateLimiter {
  const perPeerMax = options.perPeerMax ?? 5;
  const globalMax = options.globalMax ?? 60;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const peers = new Map<string, number[]>();
  let all: number[] = [];

  return {
    check(peer) {
      const t = now();
      const cutoff = t - windowMs;
      all = all.filter((stamp) => stamp > cutoff);
      const mine = (peers.get(peer) ?? []).filter((stamp) => stamp > cutoff);
      if (mine.length === 0) peers.delete(peer);
      if (mine.length >= perPeerMax) {
        peers.set(peer, mine);
        return "peer";
      }
      if (all.length >= globalMax) {
        if (mine.length > 0) peers.set(peer, mine);
        return "global";
      }
      mine.push(t);
      all.push(t);
      peers.set(peer, mine);
      return "ok";
    },
  };
}

// ── Pages ─────────────────────────────────────────────────────────────────────

export type PageKind = "NOT_IN_LAN" | "DEVICE_NOT_FOUND" | "RATE_LIMITED" | "UNAVAILABLE";

const PAGES: Record<PageKind, { title: string; text: string }> = {
  NOT_IN_LAN: {
    title: "Bitte im Salon-WLAN öffnen",
    text: "Diese Seite funktioniert nur, wenn dein Handy mit dem WLAN des Salons verbunden ist. Verbinde dich mit dem Salon-WLAN und scanne den QR-Code erneut.",
  },
  DEVICE_NOT_FOUND: {
    title: "Gerät nicht gefunden",
    text: "Dein Handy wurde im Salon-WLAN nicht gefunden. Prüfe, dass du mit dem Salon-WLAN und nicht mit einem Gast-WLAN verbunden bist, und scanne den QR-Code erneut.",
  },
  RATE_LIMITED: {
    title: "Zu viele Versuche",
    text: "Bitte warte eine Minute und scanne den QR-Code dann erneut.",
  },
  UNAVAILABLE: {
    title: "Kopplung gerade nicht möglich",
    text: "Bitte versuche es in ein paar Minuten erneut. Klappt es weiterhin nicht, wende dich an deine Leitung.",
  },
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A fixed German page. It carries no MAC, no IP, no hostname and no technical detail. */
export function renderPage(kind: PageKind): string {
  const page = PAGES[kind];
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#f6f5f8;color:#1f1d29}
main{max-width:30rem;margin:12vh auto 0;padding:0 1.25rem}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{font-size:1rem;line-height:1.5;margin:0}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.text)}</p>
</main>
</body>
</html>
`;
}

/** Last two octets of a MAC, for log lines: "…:11:22". */
export function maskMac(mac: string): string {
  const match = /([0-9a-f]{2}:[0-9a-f]{2})$/i.exec(mac);
  return match ? `…:${match[1].toLowerCase()}` : "…";
}

// ── Code issuer ───────────────────────────────────────────────────────────────

/** The one wire format of a pairing code: 64 lowercase hex characters. */
const CODE_PATTERN = /^[0-9a-f]{64}$/;

export type CodeIssuer = (mac: string, hostname: string) => Promise<string>;

export class CodeIssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeIssueError";
  }
}

/**
 * Register a one-time pairing code for a MAC with the Clokr API. The presence key goes out as a
 * Bearer token and appears in no message and no log. The answer must be 201 with a code in the
 * wire format, otherwise the issuer throws.
 */
export function createCodeIssuer(options: {
  apiUrl: string;
  presenceKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): CodeIssuer {
  const endpoint = `${options.apiUrl.replace(/\/$/, "")}/api/v1/presence/pairing-codes`;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return async (mac, hostname) => {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.presenceKey}`,
      },
      body: JSON.stringify({ mac, hostname: hostname === "" ? null : hostname.slice(0, 255) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 201) {
      throw new CodeIssueError(`pairing code request answered ${res.status}`);
    }
    const payload = (await res.json()) as { code?: unknown };
    if (typeof payload.code !== "string" || !CODE_PATTERN.test(payload.code)) {
      throw new CodeIssueError("pairing code request answered an unusable code");
    }
    return payload.code;
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export interface PairingDeps {
  /** Origin of the Clokr web app, already validated by parsePairingConfig. */
  appOrigin: string;
  /**
   * The live by-IP lookup. Its answer is the only thing that may produce a code: a throw, a miss,
   * an inactive entry or an entry without a MAC all end in a refusal page (no cached host list is
   * ever consulted, a stale lease must not be able to couple somebody else's device).
   */
  resolveHost: (ip: string) => Promise<HostEntry | null>;
  issueCode: CodeIssuer;
  rateLimiter: RateLimiter;
  ownAddresses: ReadonlySet<string>;
  log: (line: string) => void;
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const HTML_TYPE = "text/html; charset=utf-8";

function sendPage(res: ServerResponse, status: number, kind: PageKind): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": HTML_TYPE });
  res.end(renderPage(kind));
}

function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra });
  res.end();
}

function reasonOf(err: unknown): string {
  if (err instanceof Tr064HttpError) return `tr064-http-${err.status}`;
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Build the request handler. Nothing but the method, the pathname and the socket peer is read
 * from the request; the query string is thrown away unparsed.
 */
export function createPairingHandler(
  deps: PairingDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://pairing.invalid").pathname;
    } catch {
      pathname = "";
    }
    if (pathname !== "/koppeln") {
      sendEmpty(res, 404);
      return;
    }
    if (req.method !== "GET") {
      sendEmpty(res, 405, { Allow: "GET" });
      return;
    }

    const rawPeer = req.socket.remoteAddress;
    const peer = classifyPeer(rawPeer, deps.ownAddresses);
    if (!peer.ok) {
      deps.log(`[fritzbox-adapter] pairing peer=${rawPeer ?? "none"} outcome=not-in-lan`);
      sendPage(res, 403, "NOT_IN_LAN");
      return;
    }
    const ip = peer.ip;
    const note = (outcome: string, mac?: string): void => {
      deps.log(
        `[fritzbox-adapter] pairing peer=${ip} outcome=${outcome}${mac ? ` mac=${maskMac(mac)}` : ""}`,
      );
    };

    if (deps.rateLimiter.check(ip) !== "ok") {
      note("rate-limited");
      res.writeHead(429, { ...SECURITY_HEADERS, "Content-Type": HTML_TYPE, "Retry-After": "60" });
      res.end(renderPage("RATE_LIMITED"));
      return;
    }

    // ── Which device is the phone? The box answers for the peer address, nothing else decides.
    let entry: HostEntry | null = null;
    let lookupFailed = false;
    try {
      entry = await deps.resolveHost(ip);
    } catch (err) {
      lookupFailed = true;
      note(`lookup-failed reason=${reasonOf(err)}`);
    }
    if (entry && entry.interfaceType !== null && entry.interfaceType !== "802.11") {
      // Not a refusal: the field is an assumption of the by-IP action and unconfirmed on a real box.
      deps.log(
        `[fritzbox-adapter] pairing peer=${ip} warning=interface-type interface=${entry.interfaceType}`,
      );
    }
    const device: { mac: string; hostname: string } | null =
      entry && entry.active && entry.mac !== ""
        ? { mac: entry.mac, hostname: entry.hostname }
        : null;
    if (!device) {
      if (lookupFailed) {
        note("unavailable");
        sendPage(res, 503, "UNAVAILABLE");
      } else {
        note("device-not-found");
        sendPage(res, 404, "DEVICE_NOT_FOUND");
      }
      return;
    }

    // ── One-time code from the Clokr API, then the redirect.
    let code: string;
    try {
      code = await deps.issueCode(device.mac, device.hostname);
    } catch (err) {
      note(`issue-failed reason=${reasonOf(err)}`, device.mac);
      sendPage(res, 502, "UNAVAILABLE");
      return;
    }
    if (!CODE_PATTERN.test(code)) {
      note("issue-failed reason=bad-code", device.mac);
      sendPage(res, 502, "UNAVAILABLE");
      return;
    }
    note("redirected", device.mac);
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      Location: `${deps.appOrigin}/settings/geraet-koppeln?code=${code}`,
    });
    res.end();
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

/**
 * Start the pairing listener, or return null when pairing is not enabled. A handler rejection
 * becomes a 503 page and a log line; it never reaches the process.
 */
export function startPairingServer(
  config: PairingConfig,
  deps: Omit<PairingDeps, "appOrigin">,
): Server | null {
  if (!config.enabled) return null;

  const handler = createPairingHandler({ ...deps, appOrigin: config.appOrigin });
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      deps.log(`[fritzbox-adapter] pairing outcome=handler-failed reason=${reasonOf(err)}`);
      if (!res.headersSent) {
        sendPage(res, 503, "UNAVAILABLE");
      } else {
        res.end();
      }
    });
  });
  // A phone on the LAN gets a short fuse: slow or stalled requests must not pin sockets.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(config.port, config.bind, () => {
    deps.log(`[fritzbox-adapter] Pairing listener on ${config.bind}:${config.port}`);
  });
  return server;
}
