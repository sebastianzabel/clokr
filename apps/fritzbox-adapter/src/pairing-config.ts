import { isIP } from "node:net";

/**
 * Startup contract of the opt-in pairing listener (Issue #610, D-01).
 *
 * Pure: it reads the environment object it is handed and returns either a configuration or the
 * list of problems. A problem names the variable, never its value (an operator may have pasted
 * something that is not meant for a log). `index.ts` prints the errors and exits.
 */
export type PairingConfig =
  { enabled: false } | { enabled: true; port: number; bind: string; appOrigin: string };

export type PairingConfigResult =
  { ok: true; value: PairingConfig } | { ok: false; errors: string[] };

const DEFAULT_PORT = 8766;
const DEFAULT_BIND = "0.0.0.0";
// http is accepted for a developer machine only; a real deployment redirects to https.
const LOCAL_HTTP_HOSTS = ["localhost", "127.0.0.1"];

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * CLOKR_APP_URL becomes the origin of the redirect, so it is parsed with the WHATWG URL parser
 * only (a second, hand-written parser is how the #608 review found a redirect bypass, CR-01)
 * and must be a bare origin: no userinfo, no path, no query, no fragment.
 */
function parseAppOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  // The WHATWG parser trims and rewrites these silently; for an origin we want them refused.
  if (/[\\?#@]/.test(raw)) return null;
  if ([...raw].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:";
  const localHttp = url.protocol === "http:" && LOCAL_HTTP_HOSTS.includes(url.hostname);
  if (!secure && !localHttp) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

export function parsePairingConfig(env: Record<string, string | undefined>): PairingConfigResult {
  if (env.PAIRING_ENABLED !== "true") {
    return { ok: true, value: { enabled: false } };
  }

  const errors: string[] = [];

  const port = parsePort(env.PAIRING_PORT);
  if (port === null) {
    errors.push("PAIRING_PORT must be an integer between 1 and 65535");
  }

  const bindRaw =
    env.PAIRING_BIND === undefined || env.PAIRING_BIND === "" ? DEFAULT_BIND : env.PAIRING_BIND;
  if (isIP(bindRaw) === 0) {
    errors.push("PAIRING_BIND must be an IP address");
  }

  const appOrigin = parseAppOrigin(env.CLOKR_APP_URL);
  if (appOrigin === null) {
    errors.push(
      "CLOKR_APP_URL is required when PAIRING_ENABLED=true and must be an https origin without path, query, fragment or credentials",
    );
  }

  if (errors.length > 0 || port === null || appOrigin === null) {
    return { ok: false, errors };
  }
  return { ok: true, value: { enabled: true, port, bind: bindRaw, appOrigin } };
}
