/**
 * Issue #608 (D-02) - the VAPID key generator prints three variables the API's boot check accepts.
 * Real key generation is local crypto: no network, no database.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createECDH } from "node:crypto";
import { envSchema } from "../../src/config";
import { EXIT_ERROR, EXIT_OK, main, vapidEnvLines } from "../generate-vapid-keys";

function valueOf(lines: string[], key: string): string {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`missing ${key}`);
  return line.slice(key.length + 1);
}

function derivePublicKey(privateKeyBase64Url: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKeyBase64Url, "base64url"));
  return ecdh.getPublicKey().toString("base64url");
}

describe("generate-vapid-keys (608-06)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns exactly the three lines with the documented key shapes", () => {
    const lines = vapidEnvLines({ subject: "mailto:ops@example.com" });
    expect(lines.map((l) => l.split("=")[0])).toEqual([
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "VAPID_SUBJECT",
    ]);
    expect(valueOf(lines, "VAPID_PUBLIC_KEY")).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(valueOf(lines, "VAPID_PRIVATE_KEY")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(valueOf(lines, "VAPID_SUBJECT")).toBe("mailto:ops@example.com");
  });

  it("prints a public key that is the one derived from the private key", () => {
    const lines = vapidEnvLines({ subject: "mailto:ops@example.com" });
    expect(derivePublicKey(valueOf(lines, "VAPID_PRIVATE_KEY"))).toBe(
      valueOf(lines, "VAPID_PUBLIC_KEY"),
    );
  });

  it("prints a set the API's boot schema accepts", () => {
    const lines = vapidEnvLines({ subject: "mailto:ops@example.com" });
    const env = Object.fromEntries(
      lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const result = envSchema.safeParse({
      DATABASE_URL: "postgresql://clokr:password@localhost:5432/clokr_test",
      JWT_SECRET: "generator-test-jwt-secret-min-32-characters",
      JWT_REFRESH_SECRET: "generator-test-refresh-secret-min-32-chars",
      ENCRYPTION_KEY: "generator-test-encryption-key-min-32-characters",
      ...env,
    });
    expect(result.success).toBe(true);
  });

  it("gives a different pair on every call", () => {
    const a = vapidEnvLines({ subject: "mailto:ops@example.com" });
    const b = vapidEnvLines({ subject: "mailto:ops@example.com" });
    expect(valueOf(a, "VAPID_PRIVATE_KEY")).not.toBe(valueOf(b, "VAPID_PRIVATE_KEY"));
    expect(valueOf(a, "VAPID_PUBLIC_KEY")).not.toBe(valueOf(b, "VAPID_PUBLIC_KEY"));
  });

  it("prints an empty subject line and a stderr hint when no subject is given", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main([])).toBe(EXIT_OK);
    expect(out.mock.calls.map((c) => String(c[0]))).toHaveLength(3);
    expect(String(out.mock.calls[2][0])).toBe("VAPID_SUBJECT=");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("--subject");
  });

  it("prints the three lines to stdout for a valid subject", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--subject", "https://clokr.example.com/kontakt"])).toBe(EXIT_OK);
    expect(out).toHaveBeenCalledTimes(3);
    expect(String(out.mock.calls[2][0])).toBe("VAPID_SUBJECT=https://clokr.example.com/kontakt");
    expect(err).not.toHaveBeenCalled();
  });

  it.each([
    "ops@example.com",
    "mailto:no-at-sign",
    "http://clokr.example.com",
    "https://localhost/contact",
    "https://127.0.0.1/contact",
    "https://app.localhost/contact",
    "not a url",
  ])("refuses the subject %j with exit 1 and prints no key", (subject) => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--subject", subject])).toBe(EXIT_ERROR);
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown argument without printing a key", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--private-key", "x"])).toBe(EXIT_ERROR);
    expect(out).not.toHaveBeenCalled();
  });
});
