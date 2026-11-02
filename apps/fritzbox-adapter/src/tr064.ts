import { createHash, randomBytes } from "crypto";
import { isIP } from "node:net";

// ── Types ──────────────────────────────────────────────────────────────────────
export interface FritzDevice {
  mac: string;
  hostname: string;
  active: boolean;
  ip: string;
}

/** One device answered by the by-IP host lookup (Issue #610). */
export interface HostEntry {
  mac: string;
  hostname: string;
  active: boolean;
  /** "802.11" for a Wi-Fi client, null when the box did not say. */
  interfaceType: string | null;
}

/**
 * A TR-064 request the box answered with an unusable HTTP status. `message` is built exactly as
 * before (status and the first 200 characters), `body` keeps the full text so a caller can read
 * a SOAP fault code instead of parsing the truncated message.
 */
export class Tr064HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "Tr064HttpError";
    this.status = status;
    this.body = body;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize any MAC address format to lowercase colon-separated octets.
 * Accepts: "AA-BB-CC-DD-EE-FF", "AABBCCDDEEFF", "aa:bb:cc:dd:ee:ff"
 * Returns: "aa:bb:cc:dd:ee:ff", or "" for invalid input.
 *
 * WR-04: Returns empty string (rather than silently lowercasing raw input)
 * when the stripped hex is not exactly 12 characters. Callers must filter
 * out empty strings. This is consistent with the API's normalizeMac which
 * throws on invalid input — a bad MAC from the FritzBox is skipped here
 * rather than forwarded to the API where it would cause a 400 response.
 */
export function normalizeMac(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 12) {
    console.warn(`[fritzbox-adapter] Skipping device with invalid MAC: ${JSON.stringify(raw)}`);
    return ""; // callers must check and skip empty MACs
  }
  return hex.match(/.{2}/g)!.join(":").toLowerCase();
}

function md5(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/** Parse a single field value from a WWW-Authenticate: Digest header. */
function parseDigestField(header: string, field: string): string | undefined {
  const match = new RegExp(`${field}="([^"]*)"`, "i").exec(header);
  return match?.[1];
}

function parseDigestFieldUnquoted(header: string, field: string): string | undefined {
  const match = new RegExp(`${field}=([^,\\s]*)`, "i").exec(header);
  return match?.[1];
}

// ── TR-064 SOAP client ────────────────────────────────────────────────────────

/**
 * Minimal TR-064 SOAP client with manual HTTP Digest authentication.
 *
 * Uses Node's built-in fetch + crypto — no external HTTP libraries needed.
 * Digest auth uses MD5 challenge-response as defined in RFC 2617.
 */
export class Tr064Client {
  private readonly url: string;
  private readonly user: string;
  private readonly pass: string;

  constructor(url: string, user: string, pass: string) {
    this.url = url.replace(/\/$/, ""); // strip trailing slash
    this.user = user;
    this.pass = pass;
  }

  /**
   * POST a SOAP request, handling HTTP Digest auth via MD5 challenge-response.
   *
   * 1. First attempt: POST without auth header.
   * 2. If 401 + WWW-Authenticate: Digest → compute MD5 response and retry.
   * 3. If still non-200 → throw Error.
   */
  private async digestFetch(
    path: string,
    body: string,
    soapAction: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const endpoint = this.url + path;
    const headers: Record<string, string> = {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: soapAction,
    };

    // ── First attempt (unauthenticated) ──────────────────────────────────────
    let res = await fetch(endpoint, { method: "POST", headers, body, signal });

    if (res.status === 200) {
      return res.text();
    }

    if (res.status !== 401) {
      const text = await res.text();
      const snippet = text.slice(0, 200);
      throw new Tr064HttpError(
        `TR-064 request failed (${res.status}): ${snippet}`,
        res.status,
        text,
      );
    }

    // ── Digest challenge ──────────────────────────────────────────────────────
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    if (!wwwAuth.toLowerCase().startsWith("digest")) {
      throw new Error("TR-064 server requires unsupported auth scheme");
    }

    const realm = parseDigestField(wwwAuth, "realm") ?? "";
    const nonce = parseDigestField(wwwAuth, "nonce") ?? "";
    const qop = parseDigestFieldUnquoted(wwwAuth, "qop");

    const ha1 = md5(`${this.user}:${realm}:${this.pass}`);
    const ha2 = md5(`POST:${path}`);
    const nc = "00000001";
    const cnonce = randomBytes(4).toString("hex");

    let digestResponse: string;
    if (qop) {
      digestResponse = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    } else {
      digestResponse = md5(`${ha1}:${nonce}:${ha2}`);
    }

    const authHeader = [
      `Digest username="${this.user}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${path}"`,
      ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
      `response="${digestResponse}"`,
    ].join(", ");

    // ── Retry with credentials ────────────────────────────────────────────────
    res = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, Authorization: authHeader },
      body,
      signal,
    });

    if (res.status === 200) {
      return res.text();
    }

    const text = await res.text();
    const snippet = text.slice(0, 200);
    throw new Tr064HttpError(`TR-064 auth failed (${res.status}): ${snippet}`, res.status, text);
  }

  /**
   * Ask the box which device currently holds an IP address (Issue #610, pairing).
   *
   * Uses X_AVM-DE_GetSpecificHostEntryByIP on the same control path the poll uses. The call is
   * bounded by a timeout (a stuck box must not hang a phone's page); SOAP fault 714 (no such
   * entry) answers null, every other failure throws a Tr064HttpError or the fetch error.
   * `onRawResponse` receives the raw XML of a 200 answer (the real-box probe prints its element
   * names).
   */
  async getHostByIp(
    ip: string,
    options: { timeoutMs?: number; onRawResponse?: (xml: string) => void } = {},
  ): Promise<HostEntry | null> {
    // The IP enters an XML envelope: only a real address literal may get there.
    if (isIP(ip) === 0) {
      throw new Error("getHostByIp: invalid IP address");
    }

    const serviceUrn = "urn:dslforum-org:service:Hosts:1";
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:X_AVM-DE_GetSpecificHostEntryByIP xmlns:u="${serviceUrn}">
      <NewIPAddress>${ip}</NewIPAddress>
    </u:X_AVM-DE_GetSpecificHostEntryByIP>
  </s:Body>
</s:Envelope>`;

    let xml: string;
    try {
      xml = await this.digestFetch(
        "/upnp/control/Hosts",
        envelope,
        `${serviceUrn}#X_AVM-DE_GetSpecificHostEntryByIP`,
        AbortSignal.timeout(options.timeoutMs ?? 5_000),
      );
    } catch (err) {
      if (
        err instanceof Tr064HttpError &&
        err.status === 500 &&
        /<errorCode>\s*714\s*<\/errorCode>/i.test(err.body)
      ) {
        return null;
      }
      throw err;
    }

    options.onRawResponse?.(xml);

    const macRaw = /<NewMACAddress>(.*?)<\/NewMACAddress>/i.exec(xml)?.[1];
    const mac = macRaw ? normalizeMac(macRaw) : "";
    if (!mac) {
      return null;
    }
    return {
      mac,
      hostname: /<NewHostName>(.*?)<\/NewHostName>/i.exec(xml)?.[1] ?? "",
      active: (/<NewActive>(.*?)<\/NewActive>/i.exec(xml)?.[1] ?? "0") === "1",
      interfaceType: /<NewInterfaceType>(.*?)<\/NewInterfaceType>/i.exec(xml)?.[1] || null,
    };
  }

  /**
   * Retrieve the list of currently known hosts from the FritzBox.
   *
   * Uses GetHostListPath (returns a secondary XML URL) and fetches that URL.
   * Falls back to enumerating GetGenericHostEntry if the list path is not
   * available. Each returned device has its MAC normalized to lowercase colons.
   */
  async getHostList(): Promise<FritzDevice[]> {
    const serviceUrn = "urn:dslforum-org:service:Hosts:1";
    const hostsPath = "/upnp/control/Hosts";

    // ── GetHostListPath (FritzOS 6.0+) ────────────────────────────────────────
    const listPathEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetHostListPath xmlns:u="${serviceUrn}"/>
  </s:Body>
</s:Envelope>`;

    let hostListXml: string;

    try {
      const listPathXml = await this.digestFetch(
        hostsPath,
        listPathEnvelope,
        `${serviceUrn}#GetHostListPath`,
      );

      // Extract the host list path URL from the response
      const pathMatch = /<NewHostListPath>(.*?)<\/NewHostListPath>/i.exec(listPathXml);
      if (!pathMatch) {
        throw new Error("GetHostListPath: NewHostListPath element not found");
      }

      const hostListUrl = pathMatch[1];

      // Fetch the secondary XML document (same Digest auth)
      const listRes = await fetch(hostListUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.user}:${this.pass}`).toString("base64")}`,
        },
      });

      if (!listRes.ok) {
        throw new Error(`Host list fetch failed (${listRes.status})`);
      }

      hostListXml = await listRes.text();
    } catch {
      // GetHostListPath failed or not supported — fall back to enumeration
      return this.getHostListByEnumeration();
    }

    return this.parseHostListXml(hostListXml);
  }

  /** Parse an XML host list document into FritzDevice[]. */
  private parseHostListXml(xml: string): FritzDevice[] {
    const devices: FritzDevice[] = [];
    // Match individual <Item> or <host> elements
    const itemRegex = /<(?:Item|host)\b[^>]*>([\s\S]*?)<\/(?:Item|host)>/gi;
    let itemMatch: RegExpExecArray | null;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const item = itemMatch[1];

      const macRaw = /<(?:MACAddress|MAC)>(.*?)<\/(?:MACAddress|MAC)>/i.exec(item)?.[1];
      const hostname =
        /<(?:HostName|hostname)>(.*?)<\/(?:HostName|hostname)>/i.exec(item)?.[1] ?? "";
      const activeRaw = /<(?:Active|active)>(.*?)<\/(?:Active|active)>/i.exec(item)?.[1] ?? "0";
      const ip = /<(?:IPAddress|ip)>(.*?)<\/(?:IPAddress|ip)>/i.exec(item)?.[1] ?? "";

      if (macRaw) {
        const normalizedMac = normalizeMac(macRaw);
        if (normalizedMac) {
          devices.push({
            mac: normalizedMac,
            hostname,
            active: activeRaw === "1",
            ip,
          });
        }
      }
    }

    return devices;
  }

  /** Fallback: enumerate hosts via GetHostNumberOfEntries + GetGenericHostEntry. */
  private async getHostListByEnumeration(): Promise<FritzDevice[]> {
    const serviceUrn = "urn:dslforum-org:service:Hosts:1";
    const hostsPath = "/upnp/control/Hosts";

    // GetHostNumberOfEntries
    const countEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetHostNumberOfEntries xmlns:u="${serviceUrn}"/>
  </s:Body>
</s:Envelope>`;

    const countXml = await this.digestFetch(
      hostsPath,
      countEnvelope,
      `${serviceUrn}#GetHostNumberOfEntries`,
    );

    const countMatch = /<NewHostNumberOfEntries>(\d+)<\/NewHostNumberOfEntries>/i.exec(countXml);
    const count = countMatch ? parseInt(countMatch[1], 10) : 0;

    const devices: FritzDevice[] = [];

    for (let i = 0; i < count; i++) {
      const entryEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetGenericHostEntry xmlns:u="${serviceUrn}">
      <NewIndex>${i}</NewIndex>
    </u:GetGenericHostEntry>
  </s:Body>
</s:Envelope>`;

      try {
        const entryXml = await this.digestFetch(
          hostsPath,
          entryEnvelope,
          `${serviceUrn}#GetGenericHostEntry`,
        );

        const macRaw = /<NewMACAddress>(.*?)<\/NewMACAddress>/i.exec(entryXml)?.[1];
        const hostname = /<NewHostName>(.*?)<\/NewHostName>/i.exec(entryXml)?.[1] ?? "";
        const activeRaw = /<NewActive>(.*?)<\/NewActive>/i.exec(entryXml)?.[1] ?? "0";
        const ip = /<NewIPAddress>(.*?)<\/NewIPAddress>/i.exec(entryXml)?.[1] ?? "";

        if (macRaw) {
          const normalizedMac = normalizeMac(macRaw);
          if (normalizedMac) {
            devices.push({
              mac: normalizedMac,
              hostname,
              active: activeRaw === "1",
              ip,
            });
          }
        }
      } catch {
        // Skip individual entry on error — partial list is better than none
        console.warn(`[fritzbox-adapter] Failed to fetch host entry ${i}, skipping`);
      }
    }

    return devices;
  }
}
