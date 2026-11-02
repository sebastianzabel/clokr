import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  CodeIssueError,
  classifyPeer,
  createCodeIssuer,
  createPairingHandler,
  createRateLimiter,
  maskMac,
  ownInterfaceAddresses,
  renderPage,
  startPairingServer,
  type PairingDeps,
} from "../pairing.js";
import type { FritzDevice, HostEntry } from "../tr064.js";

const APP = "https://clokr.example.invalid";
const MAC = "02:00:00:00:00:99";
const PEER = "192.168.178.42";
const CODE = "ab".repeat(32);
const KEY = "presence-key-do-not-log";

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeReq(options: {
  method?: string;
  url?: string;
  peer?: string | undefined;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    method: options.method ?? "GET",
    url: options.url ?? "/koppeln",
    headers: options.headers ?? {},
    socket: { remoteAddress: "peer" in options ? options.peer : `::ffff:${PEER}` },
  } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; sent: () => Sent } {
  const sent: Sent = { status: 0, headers: {}, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return res;
    },
    end(body?: string) {
      sent.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { res, sent: () => sent };
}

const ENTRY: HostEntry = {
  mac: MAC,
  hostname: "Annas-iPhone",
  active: true,
  interfaceType: "802.11",
};

function makeDeps(overrides: Partial<PairingDeps> = {}) {
  const logs: string[] = [];
  const resolveHost = vi.fn<PairingDeps["resolveHost"]>().mockResolvedValue(ENTRY);
  const issueCode = vi.fn<PairingDeps["issueCode"]>().mockResolvedValue(CODE);
  const deps: PairingDeps = {
    appOrigin: APP,
    resolveHost,
    issueCode,
    rateLimiter: createRateLimiter({ now: () => 1_000 }),
    ownAddresses: new Set(["192.168.178.2"]),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, logs, resolveHost, issueCode };
}

async function run(deps: PairingDeps, req: IncomingMessage): Promise<Sent> {
  const { res, sent } = fakeRes();
  await createPairingHandler(deps)(req, res);
  return sent();
}

const FIXTURE_IDENTIFIERS = [
  MAC,
  MAC.toUpperCase(),
  MAC.replaceAll(":", "-"),
  "020000000099",
  PEER,
  "Annas-iPhone",
];

function expectNoIdentifiers(page: string): void {
  for (const secret of FIXTURE_IDENTIFIERS) expect(page).not.toContain(secret);
  expect(page).not.toMatch(/error|stack/i);
}

// ── classifyPeer ──────────────────────────────────────────────────────────────

describe("classifyPeer", () => {
  it("unwraps an IPv4-mapped address and accepts a LAN or global address", () => {
    expect(classifyPeer("::ffff:192.168.178.42")).toEqual({ ok: true, ip: "192.168.178.42" });
    expect(classifyPeer("192.168.178.42")).toEqual({ ok: true, ip: "192.168.178.42" });
    expect(classifyPeer("2001:db8::5")).toEqual({ ok: true, ip: "2001:db8::5" });
  });

  it.each([
    "fe80::1",
    "FE80::ABCD%eth0",
    "febf::1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "127.0.0.1",
    "127.4.5.6",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "169.254.1.1",
    "::ffff:169.254.1.1",
    "0.0.0.0",
    "::",
    "garbage",
    "192.168.178.42<script>",
    "",
    undefined,
  ])("refuses %j", (raw) => {
    expect(classifyPeer(raw, new Set())).toEqual({ ok: false });
  });

  it("refuses one of the adapter's own interface addresses, also when mapped", () => {
    const own = new Set(["192.168.178.2", "fd00::2"]);
    expect(classifyPeer("192.168.178.2", own)).toEqual({ ok: false });
    expect(classifyPeer("::ffff:192.168.178.2", own)).toEqual({ ok: false });
    expect(classifyPeer("FD00::2", own)).toEqual({ ok: false });
    expect(classifyPeer("192.168.178.3", own)).toEqual({ ok: true, ip: "192.168.178.3" });
  });
});

describe("ownInterfaceAddresses", () => {
  it("collects every interface address, lower case and without a zone", () => {
    const own = ownInterfaceAddresses({
      eth0: [
        { address: "172.18.0.5", family: "IPv4", internal: false },
        { address: "FE80::1%eth0", family: "IPv6", internal: false },
      ],
      lo: undefined,
    } as unknown as ReturnType<typeof import("node:os").networkInterfaces>);
    expect([...own].sort()).toEqual(["172.18.0.5", "fe80::1"]);
  });
});

// ── rate limiter ──────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("refuses the sixth request of a peer in the window and lets another peer pass", () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(limiter.check("10.0.0.1")).toBe("ok");
    expect(limiter.check("10.0.0.1")).toBe("peer");
    expect(limiter.check("10.0.0.2")).toBe("ok");
    now = 60_001;
    expect(limiter.check("10.0.0.1")).toBe("ok");
  });

  it("refuses the 61st request over all peers in the window", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    let admitted = 0;
    for (let peer = 0; peer < 13; peer++) {
      for (let i = 0; i < 5; i++) if (limiter.check(`10.0.1.${peer}`) === "ok") admitted++;
    }
    expect(admitted).toBe(60);
    expect(limiter.check("10.0.9.9")).toBe("global");
  });

  it("does not count a refused request toward the window", () => {
    let now = 0;
    const limiter = createRateLimiter({ now: () => now, perPeerMax: 1, windowMs: 1_000 });
    expect(limiter.check("a")).toBe("ok");
    now = 900;
    expect(limiter.check("a")).toBe("peer");
    now = 1_001;
    expect(limiter.check("a")).toBe("ok");
  });
});

// ── pages ─────────────────────────────────────────────────────────────────────

describe("renderPage / maskMac", () => {
  it("renders the four fixed German pages", () => {
    const titles = {
      NOT_IN_LAN: "Bitte im Salon-WLAN öffnen",
      DEVICE_NOT_FOUND: "Gerät nicht gefunden",
      RATE_LIMITED: "Zu viele Versuche",
      UNAVAILABLE: "Kopplung gerade nicht möglich",
    } as const;
    for (const [kind, title] of Object.entries(titles)) {
      const page = renderPage(kind as keyof typeof titles);
      expect(page).toContain('<html lang="de">');
      expect(page).toContain(title);
    }
  });

  it("masks a MAC to its last two octets", () => {
    expect(maskMac("aa:bb:cc:00:11:22")).toBe("…:11:22");
    expect(maskMac(MAC)).toBe("…:00:99");
    expect(maskMac("garbage")).toBe("…");
  });
});

// ── handler ───────────────────────────────────────────────────────────────────

describe("createPairingHandler", () => {
  it("AC-3: resolves the socket peer only - query, body and proxy headers are ignored", async () => {
    const { deps, resolveHost, issueCode } = makeDeps();
    const sent = await run(
      deps,
      fakeReq({
        url: "/koppeln?mac=02:00:00:00:00:99&ip=10.0.0.9",
        headers: {
          "x-forwarded-for": "10.0.0.9",
          "x-real-ip": "10.0.0.8",
          forwarded: "for=10.0.0.7",
        },
      }),
    );
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledWith(PEER);
    expect(issueCode).toHaveBeenCalledWith(MAC, "Annas-iPhone");
    expect(sent.status).toBe(302);
    expect(sent.headers.Location).toBe(`${APP}/settings/geraet-koppeln?code=${CODE}`);
    expect(sent.headers["Cache-Control"]).toBe("no-store");
    expect(sent.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(sent.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(sent.headers["Content-Security-Policy"]).toContain("default-src 'none'");
  });

  it("refuses a loopback, link-local or own-address peer before any lookup", async () => {
    for (const peer of [
      "127.0.0.1",
      "::1",
      "fe80::1",
      "169.254.7.7",
      "::ffff:192.168.178.2",
      undefined,
    ]) {
      const { deps, resolveHost, issueCode } = makeDeps();
      const sent = await run(deps, fakeReq({ peer }));
      expect(sent.status).toBe(403);
      expect(sent.body).toContain("Bitte im Salon-WLAN öffnen");
      expect(resolveHost).not.toHaveBeenCalled();
      expect(issueCode).not.toHaveBeenCalled();
      expect(sent.headers.Location).toBeUndefined();
      expectNoIdentifiers(sent.body);
    }
  });

  it("CR-01: a stale host list never produces a code - the live lookup alone decides", async () => {
    // Reviewer's reproducer: the poll once saw .42 = Anna's phone; now the lookup for .42 fails or
    // has no answer for the peer (Bea got the lease). The handler has no host list to consult.
    const annaMac = "02:00:00:00:00:01";
    const stale: FritzDevice[] = [{ mac: annaMac, hostname: "Anna", active: true, ip: PEER }];
    const cases: Array<[string, (setup: ReturnType<typeof makeDeps>) => void, number]> = [
      ["lookup throws", (d) => d.resolveHost.mockRejectedValue(new Error("box down")), 503],
      ["lookup answers fault 714 (null)", (d) => d.resolveHost.mockResolvedValue(null), 404],
      [
        "lookup answers an inactive entry",
        (d) => d.resolveHost.mockResolvedValue({ ...ENTRY, active: false }),
        404,
      ],
      [
        "lookup answers an entry without a MAC",
        (d) => d.resolveHost.mockResolvedValue({ ...ENTRY, mac: "" }),
        404,
      ],
    ];
    for (const [name, arrange, status] of cases) {
      const setup = makeDeps();
      // A stale list is offered through every channel the old code read, to prove none is used.
      (setup.deps as unknown as { listHosts: () => FritzDevice[] }).listHosts = () => stale;
      arrange(setup);
      const sent = await run(setup.deps, fakeReq({}));
      expect(sent.status, name).toBe(status);
      expect(setup.issueCode, name).not.toHaveBeenCalled();
      expect(sent.headers.Location, name).toBeUndefined();
      expect(sent.body, name).toMatch(/Gerät nicht gefunden|Kopplung gerade nicht möglich/);
      expectNoIdentifiers(sent.body);
      expect(sent.body, name).not.toContain("Anna");
    }
  });

  it("answers 404 for a miss and 503 for a failed lookup, each with the German page", async () => {
    const miss = makeDeps();
    miss.resolveHost.mockResolvedValue(null);
    const missSent = await run(miss.deps, fakeReq({}));
    expect(missSent.status).toBe(404);
    expect(missSent.body).toContain("Gerät nicht gefunden");

    const down = makeDeps();
    down.resolveHost.mockRejectedValue(new Error("box down"));
    const sent = await run(down.deps, fakeReq({}));
    expect(sent.status).toBe(503);
    expect(sent.body).toContain("Kopplung gerade nicht möglich");
    expect(sent.headers.Location).toBeUndefined();
    expectNoIdentifiers(sent.body);
  });

  it("answers 502 without a redirect when the issuer fails or returns something that is not a code", async () => {
    const failing = makeDeps();
    failing.issueCode.mockRejectedValue(new CodeIssueError("pairing code request answered 401"));
    const garbage = makeDeps();
    garbage.issueCode.mockResolvedValue("not-a-code");
    const upper = makeDeps();
    upper.issueCode.mockResolvedValue("AB".repeat(32));
    const injected = makeDeps();
    injected.issueCode.mockResolvedValue(`${"ab".repeat(32)}\r\nSet-Cookie: x=1`);
    for (const setup of [failing, garbage, upper, injected]) {
      const sent = await run(setup.deps, fakeReq({}));
      expect(sent.status).toBe(502);
      expect(sent.headers.Location).toBeUndefined();
      expectNoIdentifiers(sent.body);
    }
  });

  it("limits a peer to five requests a minute without calling the resolver for the sixth", async () => {
    const { deps, resolveHost } = makeDeps();
    for (let i = 0; i < 5; i++) expect((await run(deps, fakeReq({}))).status).toBe(302);
    const sixth = await run(deps, fakeReq({}));
    expect(sixth.status).toBe(429);
    expect(sixth.body).toContain("Zu viele Versuche");
    expect(resolveHost).toHaveBeenCalledTimes(5);
    expectNoIdentifiers(sixth.body);

    const other = await run(deps, fakeReq({ peer: "::ffff:192.168.178.50" }));
    expect(other.status).toBe(302);
  });

  it("refuses the 61st request over all peers in the window", async () => {
    const { deps } = makeDeps();
    let last = 0;
    for (let peer = 0; peer < 13; peer++) {
      for (let i = 0; i < 5; i++) {
        last = (await run(deps, fakeReq({ peer: `192.168.179.${peer + 10}` }))).status;
        if (peer * 5 + i === 59) expect(last).toBe(302);
      }
    }
    expect(last).toBe(429);
  });

  it("answers POST /koppeln with 405 and any other path with 404", async () => {
    const { deps, resolveHost } = makeDeps();
    expect((await run(deps, fakeReq({ method: "POST" }))).status).toBe(405);
    for (const url of ["/devices", "/", "/koppeln/", "/koppeln%2f", "//koppeln", "/KOPPELN"]) {
      expect((await run(deps, fakeReq({ url }))).status).toBe(404);
    }
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("logs the peer and the outcome, a masked MAC at most, never the code or the key", async () => {
    const { deps, logs } = makeDeps();
    await run(deps, fakeReq({}));
    const failing = makeDeps();
    failing.issueCode.mockRejectedValue(new CodeIssueError(`failed with ${KEY}`));
    await run(failing.deps, fakeReq({}));
    const text = [...logs, ...failing.logs].join("\n");
    expect(text).toContain(`peer=${PEER}`);
    expect(text).toContain("outcome=redirected");
    expect(text).toContain("…:00:99");
    expect(text).not.toContain(MAC);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(KEY);
  });

  it("warns about a non-Wi-Fi interface type but still pairs", async () => {
    const { deps, logs } = makeDeps();
    (deps.resolveHost as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...ENTRY,
      interfaceType: "Ethernet",
    });
    expect((await run(deps, fakeReq({}))).status).toBe(302);
    expect(logs.join("\n")).toContain("interface=Ethernet");
  });
});

// ── issuer ────────────────────────────────────────────────────────────────────

describe("createCodeIssuer", () => {
  function issuerWith(fetchImpl: typeof fetch) {
    return createCodeIssuer({ apiUrl: "http://api:4000/", presenceKey: KEY, fetchImpl });
  }

  it("posts mac and hostname with the presence key as Bearer and returns the code", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: CODE, expiresAt: "2026-11-03T10:05:00.000Z" }), {
        status: 201,
      }),
    );
    await expect(issuerWith(fetchImpl)(MAC, "Annas-iPhone")).resolves.toBe(CODE);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://api:4000/api/v1/presence/pairing-codes");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init?.body as string)).toEqual({ mac: MAC, hostname: "Annas-iPhone" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends an empty hostname as null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ code: CODE }), { status: 201 }));
    await issuerWith(fetchImpl)(MAC, "");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      mac: MAC,
      hostname: null,
    });
  });

  it.each([
    ["a non-201 answer", () => new Response("{}", { status: 200 })],
    ["a 401 answer", () => new Response("{}", { status: 401 })],
    [
      "a code in the wrong format",
      () => new Response(JSON.stringify({ code: "XYZ" }), { status: 201 }),
    ],
    ["no code", () => new Response("{}", { status: 201 })],
  ])("throws on %s without echoing the key", async (_name, makeResponse) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse());
    const error = await issuerWith(fetchImpl)(MAC, "x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeIssueError);
    expect((error as Error).message).not.toContain(KEY);
  });
});

// ── real socket ───────────────────────────────────────────────────────────────

describe("startPairingServer", () => {
  it("returns null when pairing is disabled", () => {
    const { deps } = makeDeps();
    expect(startPairingServer({ enabled: false }, deps)).toBeNull();
  });

  it("refuses a loopback client with the German page and never calls the resolver", async () => {
    const { deps, resolveHost } = makeDeps({ ownAddresses: new Set() });
    const server = startPairingServer(
      { enabled: true, port: 0, bind: "127.0.0.1", appOrigin: APP },
      deps,
    );
    expect(server).not.toBeNull();
    try {
      await once(server!, "listening");
      const { port } = server!.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/koppeln`);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toContain("Bitte im Salon-WLAN öffnen");
      expect(resolveHost).not.toHaveBeenCalled();
    } finally {
      server!.close();
      server!.closeAllConnections();
    }
  });
});
