import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Tr064Client, Tr064HttpError } from "../tr064.js";
import {
  CONTROL_PATH,
  DIGEST_CHALLENGE,
  FAULT_402,
  FAULT_714,
  HOST_BAD_MAC,
  HOST_ESCAPED_NAME,
  HOST_ETHERNET,
  HOST_FOUND_WIFI,
  HOST_INACTIVE,
  HOST_MAC_AFTER_NAME,
  HOST_NO_INTERFACE_TYPE,
  HOST_RAW_INJECTION_AFTER_MAC,
  HOST_RAW_INJECTION_BEFORE_MAC,
  SOAP_ACTION,
} from "./fixtures/tr064-host-by-ip.js";

const BASE = "http://fritz.invalid:49000";
const IP = "192.168.178.42";

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

let fetchMock: Mock<(url: string, init: FetchInit) => Promise<Response>>;

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<Response>>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Tr064Client.getHostByIp", () => {
  const client = new Tr064Client(BASE, "user", "pass");

  it("parses a 200 answer into a normalized entry", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, HOST_FOUND_WIFI));
    await expect(client.getHostByIp(IP)).resolves.toEqual({
      mac: "aa:bb:cc:00:11:22",
      hostname: "iPhone",
      active: true,
      interfaceType: "802.11",
    });
  });

  it("reports an inactive entry, a missing interface type and an unparseable MAC", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, HOST_INACTIVE));
    expect((await client.getHostByIp(IP))?.active).toBe(false);

    fetchMock.mockResolvedValueOnce(respond(200, HOST_NO_INTERFACE_TYPE));
    expect((await client.getHostByIp(IP))?.interfaceType).toBeNull();

    fetchMock.mockResolvedValueOnce(respond(200, HOST_ETHERNET));
    expect((await client.getHostByIp(IP))?.interfaceType).toBe("Ethernet");

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(respond(200, HOST_BAD_MAC));
    await expect(client.getHostByIp(IP)).resolves.toBeNull();
  });

  it("IN-02: reads each element on its own - entities decoded, element order irrelevant", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, HOST_ESCAPED_NAME));
    const entry = await client.getHostByIp(IP);
    expect(entry?.mac).toBe("aa:bb:cc:00:11:22");
    expect(entry?.hostname).toBe(
      "A&B </NewHostName><NewMACAddress>02:00:00:00:00:66</NewMACAddress> AB",
    );
    expect(entry?.active).toBe(true);
    expect(entry?.interfaceType).toBe("802.11");

    fetchMock.mockResolvedValueOnce(respond(200, HOST_MAC_AFTER_NAME));
    expect((await client.getHostByIp(IP))?.mac).toBe("aa:bb:cc:00:11:22");
  });

  it("IN-02: rejects an answer whose hostname injects a second MAC element, in either order", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const xml of [HOST_RAW_INJECTION_AFTER_MAC, HOST_RAW_INJECTION_BEFORE_MAC]) {
      fetchMock.mockResolvedValueOnce(respond(200, xml));
      await expect(client.getHostByIp(IP)).resolves.toBeNull();
    }
  });

  it("treats a 500 fault with errorCode 714 as not found", async () => {
    fetchMock.mockResolvedValueOnce(respond(500, FAULT_714));
    await expect(client.getHostByIp(IP)).resolves.toBeNull();
  });

  it("throws a typed error for any other fault, with the full body and today's message", async () => {
    fetchMock.mockResolvedValueOnce(respond(500, FAULT_402));
    const error = await client.getHostByIp(IP).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Tr064HttpError);
    const typed = error as Tr064HttpError;
    expect(typed.status).toBe(500);
    expect(typed.body).toBe(FAULT_402);
    expect(typed.body.length).toBeGreaterThan(200);
    expect(typed.message.startsWith("TR-064 request failed (500): ")).toBe(true);
    expect(typed.message.length).toBe("TR-064 request failed (500): ".length + 200);
  });

  it("answers a Digest challenge and parses the second response", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(401, "", { "WWW-Authenticate": DIGEST_CHALLENGE }))
      .mockResolvedValueOnce(respond(200, HOST_FOUND_WIFI));
    const entry = await client.getHostByIp(IP);
    expect(entry?.mac).toBe("aa:bb:cc:00:11:22");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1][1] as FetchInit;
    expect(second.headers?.Authorization).toMatch(/^Digest username="user"/);
    expect(second.headers?.Authorization).toContain(`uri="${CONTROL_PATH}"`);
  });

  it("types a failed authentication as well, with the existing message", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(401, "", { "WWW-Authenticate": DIGEST_CHALLENGE }))
      .mockResolvedValueOnce(respond(401, "denied"));
    const error = (await client.getHostByIp(IP).catch((e: unknown) => e)) as Tr064HttpError;
    expect(error).toBeInstanceOf(Tr064HttpError);
    expect(error.status).toBe(401);
    expect(error.body).toBe("denied");
    expect(error.message).toBe("TR-064 auth failed (401): denied");
  });

  it("sends a SOAP envelope for the given IP to the poll's control path", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, HOST_FOUND_WIFI));
    await client.getHostByIp(IP);
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${BASE}${CONTROL_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.headers?.SOAPAction).toBe(SOAP_ACTION);
    expect(init.body).toContain(`<NewIPAddress>${IP}</NewIPAddress>`);
    expect(init.body).toContain("<u:X_AVM-DE_GetSpecificHostEntryByIP");
  });

  it.each([
    "192.168.178.1<x>",
    "",
    " 192.168.178.1",
    "192.168.178.1</NewIPAddress><x/>",
    "garbage",
  ])("rejects the invalid IP %j before any request", async (bad) => {
    await expect(client.getHostByIp(bad)).rejects.toThrow(/invalid IP/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a request that never answers after the timeout", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: FetchInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(client.getHostByIp(IP, { timeoutMs: 20 })).rejects.toBeDefined();
    const init = fetchMock.mock.calls[0][1] as FetchInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the signal to the retry after a Digest challenge too", async () => {
    fetchMock
      .mockResolvedValueOnce(respond(401, "", { "WWW-Authenticate": DIGEST_CHALLENGE }))
      .mockResolvedValueOnce(respond(200, HOST_FOUND_WIFI));
    await client.getHostByIp(IP);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as FetchInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("hands the raw XML to onRawResponse", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, HOST_FOUND_WIFI));
    const seen: string[] = [];
    await client.getHostByIp(IP, { onRawResponse: (xml) => seen.push(xml) });
    expect(seen).toEqual([HOST_FOUND_WIFI]);
  });
});
