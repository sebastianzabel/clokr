/**
 * Issue #608 (D-17, P-608-04) - the push endpoint allow-list, table-proven. Pure: no app, no DB.
 */
import { describe, it, expect } from "vitest";
import { isAllowedPushEndpoint, pushEndpointHost } from "../contexts/platform/push-endpoint-guard";

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
  ])("refuses %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
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
