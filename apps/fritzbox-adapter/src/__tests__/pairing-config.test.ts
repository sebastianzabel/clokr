import { describe, expect, it } from "vitest";
import { parsePairingConfig } from "../pairing-config.js";

const VALID = {
  PAIRING_ENABLED: "true",
  CLOKR_APP_URL: "https://clokr.example.invalid",
};

function errorsOf(env: Record<string, string | undefined>): string[] {
  const result = parsePairingConfig(env);
  if (result.ok) throw new Error("expected a configuration error");
  return result.errors;
}

describe("parsePairingConfig", () => {
  it.each([undefined, "false", "TRUE", "1", "yes", ""])(
    "is disabled for PAIRING_ENABLED=%j and never inspects CLOKR_APP_URL",
    (flag) => {
      expect(parsePairingConfig({ PAIRING_ENABLED: flag, CLOKR_APP_URL: "garbage ??" })).toEqual({
        ok: true,
        value: { enabled: false },
      });
    },
  );

  it("enables with the defaults and the origin of the app URL", () => {
    expect(parsePairingConfig(VALID)).toEqual({
      ok: true,
      value: {
        enabled: true,
        port: 8766,
        bind: "0.0.0.0",
        appOrigin: "https://clokr.example.invalid",
      },
    });
  });

  it("accepts a trailing slash, a non-default https port and an IPv6 bind", () => {
    const result = parsePairingConfig({
      ...VALID,
      CLOKR_APP_URL: "https://Clokr.Example.invalid:8443/",
      PAIRING_PORT: "9000",
      PAIRING_BIND: "::",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        port: 9000,
        bind: "::",
        appOrigin: "https://clokr.example.invalid:8443",
      },
    });
  });

  it("accepts plain http for localhost and 127.0.0.1 only", () => {
    for (const url of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      expect(parsePairingConfig({ ...VALID, CLOKR_APP_URL: url }).ok).toBe(true);
    }
    expect(errorsOf({ ...VALID, CLOKR_APP_URL: "http://clokr.example.invalid" })).toHaveLength(1);
  });

  it.each([
    ["a path", "https://clokr.example.invalid/app"],
    ["a query", "https://clokr.example.invalid/?a=1"],
    ["an empty query", "https://clokr.example.invalid?"],
    ["a fragment", "https://clokr.example.invalid/#x"],
    ["an empty fragment", "https://clokr.example.invalid#"],
    ["userinfo", "https://user:secret@clokr.example.invalid"],
    ["a username only", "https://user@clokr.example.invalid"],
    ["a backslash host trick", "https://clokr.example.invalid\\@evil.invalid"],
    ["leading whitespace", " https://clokr.example.invalid"],
    ["another scheme", "ftp://clokr.example.invalid"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a relative value", "clokr.example.invalid"],
    ["not a URL", "not a url"],
    ["no value", undefined],
    ["an empty value", ""],
  ])("refuses an enabled listener with %s in CLOKR_APP_URL", (_name, value) => {
    const errors = errorsOf({ ...VALID, CLOKR_APP_URL: value });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("CLOKR_APP_URL");
  });

  it.each(["0", "70000", "65536", "abc", "-1", "80.5", "8766abc", "0x10"])(
    "refuses PAIRING_PORT=%j",
    (port) => {
      const errors = errorsOf({ ...VALID, PAIRING_PORT: port });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("PAIRING_PORT");
    },
  );

  it.each(["not-an-ip", "192.168.178", "localhost", "192.168.178.1:80"])(
    "refuses PAIRING_BIND=%j",
    (bind) => {
      const errors = errorsOf({ ...VALID, PAIRING_BIND: bind });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("PAIRING_BIND");
    },
  );

  it("reports every problem at once and never repeats a value", () => {
    const errors = errorsOf({
      PAIRING_ENABLED: "true",
      PAIRING_PORT: "secret-port",
      PAIRING_BIND: "secret-bind",
      CLOKR_APP_URL: "https://user:secret-pass@clokr.example.invalid/secret-path",
    });
    expect(errors).toHaveLength(3);
    const text = errors.join("\n");
    for (const leak of ["secret-port", "secret-bind", "secret-pass", "secret-path"]) {
      expect(text).not.toContain(leak);
    }
  });
});
