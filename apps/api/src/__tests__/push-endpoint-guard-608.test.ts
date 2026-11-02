/**
 * Issue #608 (D-17, P-608-04) - the push endpoint allow-list, table-proven. Pure: no app, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalPushEndpoint,
  isAllowedPushEndpoint,
  pushEndpointHost,
} from "../contexts/platform/push-endpoint-guard";

describe("isAllowedPushEndpoint (D-17)", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-am3p.notify.windows.com/w/?token=x",
    "https://web.push.apple.com/x",
    "https://FCM.GoogleAPIs.com:443/fcm/send/x",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://localhost/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://fcm.googleapis.com./x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evilfcm.googleapis.com.example/x",
    "https://notpush.apple.com.example/x",
    "https://evil.googleapis.com/x",
    "https://notify.windows.com.evil.example/x",
    "ftp://fcm.googleapis.com/x",
    "not a url",
    "",
    // Review CR-01: WHATWG repairs a missing authority, the legacy parser of `web-push` does not
    // (host null -> localhost:443). The differential check refuses every such input.
    "https:/fcm.googleapis.com/../x",
    "https:fcm.googleapis.com/x",
    "https:/fcm.googleapis.com/x",
    "https:///fcm.googleapis.com/x",
    "https://fcm.googleapis.com\t.evil/x",
    "https://fcm.googleapis.com%2f.evil/x",
    "https://evil.example\\@fcm.googleapis.com/x",
    "https://fcm.googleapis.com@evil.example/x",
    " ftp://fcm.googleapis.com/x",
    "//fcm.googleapis.com/x",
    "fcm.googleapis.com/x",
  ])("refuses %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe("canonicalPushEndpoint (CR-01, WR-01)", () => {
  it.each([
    ["https://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com/fcm/send/x"],
    ["HTTPS://FCM.GoogleAPIs.com:443/fcm/send/x", "https://fcm.googleapis.com/fcm/send/x"],
    ["https://fcm.googleapis.com/a/../x", "https://fcm.googleapis.com/x"],
    // A backslash is a path separator for WHATWG and the legacy parser alike: the canonical
    // string is clean and both parsers resolve the allow-listed host.
    ["https:\\\\fcm.googleapis.com/x", "https://fcm.googleapis.com/x"],
    // The backslash ends the authority, so "@evil.example" is path text and the host stays allow-listed.
    ["https://fcm.googleapis.com\\@evil.example/x", "https://fcm.googleapis.com/@evil.example/x"],
    ["https://fcm.googleapis.com/x\t", "https://fcm.googleapis.com/x"],
    ["https://fcm.googleapis.com/x\n", "https://fcm.googleapis.com/x"],
  ])("canonicalises %j to %s", (raw, expected) => {
    expect(canonicalPushEndpoint(raw)).toBe(expected);
  });

  it("returns null for every refused input", () => {
    expect(canonicalPushEndpoint("https:/fcm.googleapis.com/x")).toBeNull();
    expect(canonicalPushEndpoint("https://127.0.0.1/x")).toBeNull();
  });

  it("is idempotent: the canonical form canonicalises to itself", () => {
    const once = canonicalPushEndpoint("HTTPS://FCM.GoogleAPIs.com:443/a/../fcm/send/x");
    expect(once).not.toBeNull();
    expect(canonicalPushEndpoint(once as string)).toBe(once);
  });
});

describe("pushEndpointHost", () => {
  it("returns the lower-cased host, never the path", () => {
    expect(pushEndpointHost("https://FCM.googleapis.com/fcm/send/secret")).toBe(
      "fcm.googleapis.com",
    );
  });

  it("returns null for a string that is not a URL", () => {
    expect(pushEndpointHost("not a url")).toBeNull();
  });
});
