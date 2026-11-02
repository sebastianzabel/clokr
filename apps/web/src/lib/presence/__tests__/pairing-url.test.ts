// Issue #610 (Phase 610-06): the salon pairing URL is built from a private IPv4 literal and a port.
import { describe, it, expect } from "vitest";

import { pairingUrlFor, pairingUrlMessage } from "../pairing-url";

describe("pairingUrlFor", () => {
  it("builds the URL for the three private ranges", () => {
    expect(pairingUrlFor("192.168.178.20", "8766")).toEqual({
      ok: true,
      url: "http://192.168.178.20:8766/koppeln",
    });
    expect(pairingUrlFor("10.0.0.5", "8080")).toEqual({
      ok: true,
      url: "http://10.0.0.5:8080/koppeln",
    });
    expect(pairingUrlFor("172.20.1.9", "8080")).toEqual({
      ok: true,
      url: "http://172.20.1.9:8080/koppeln",
    });
    expect(pairingUrlFor("172.16.0.1", "1")).toMatchObject({ ok: true });
    expect(pairingUrlFor("172.31.255.255", "65535")).toMatchObject({ ok: true });
  });

  it("trims surrounding whitespace", () => {
    expect(pairingUrlFor("  192.168.178.20 ", " 8766 ")).toEqual({
      ok: true,
      url: "http://192.168.178.20:8766/koppeln",
    });
  });

  it("refuses public addresses", () => {
    expect(pairingUrlFor("8.8.8.8", "8766")).toEqual({ ok: false, reason: "NOT_PRIVATE" });
    expect(pairingUrlFor("172.32.0.1", "8766")).toEqual({ ok: false, reason: "NOT_PRIVATE" });
    expect(pairingUrlFor("172.15.0.1", "8766")).toEqual({ ok: false, reason: "NOT_PRIVATE" });
    expect(pairingUrlFor("127.0.0.1", "8766")).toEqual({ ok: false, reason: "NOT_PRIVATE" });
  });

  it.each([
    "192.168.178",
    "192.168.178.256",
    "192.168.01.2",
    "adapter.local",
    "::1",
    "http://192.168.178.20",
    "192.168.178.20/koppeln",
    "192.168.178.20:8766",
    "",
    "1e2.168.1.1",
    "192.168.1.+1",
  ])("refuses the malformed address %j", (address) => {
    expect(pairingUrlFor(address, "8766")).toEqual({ ok: false, reason: "INVALID_ADDRESS" });
  });

  it.each(["0", "65536", "80a", "", "-1", "8 0", "08766", "8766.0"])(
    "refuses the port %j",
    (port) => {
      expect(pairingUrlFor("192.168.178.20", port)).toEqual({ ok: false, reason: "INVALID_PORT" });
    },
  );

  it("judges the address before the port", () => {
    expect(pairingUrlFor("nope", "0")).toEqual({ ok: false, reason: "INVALID_ADDRESS" });
  });
});

describe("pairingUrlMessage", () => {
  it("gives a German field text per reason", () => {
    expect(pairingUrlMessage("NOT_PRIVATE")).toBe(
      "Bitte gib die Adresse des Adapters im Salon-WLAN ein (z. B. 192.168.178.20).",
    );
    expect(pairingUrlMessage("INVALID_ADDRESS")).toMatch(/IP-Adresse/);
    expect(pairingUrlMessage("INVALID_PORT")).toMatch(/Port/);
  });
});
