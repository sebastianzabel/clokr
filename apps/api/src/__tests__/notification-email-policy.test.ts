/**
 * Programmatic exhaustiveness test for the notification email registry
 * (apps/api/src/utils/notification-email-policy.ts).
 *
 * This is a pure static test — no DB, no app boot — that walks every `.ts` file under
 * `apps/api/src` (excluding `__tests__/`), finds every `notify({ ... })` call site, and
 * extracts the notification `type` literal(s) passed to it. It then asserts every
 * discovered type has an explicit entry in `NOTIFICATION_EMAIL_POLICY`.
 *
 * This is the enforcement mechanism for the fail-closed gate in `notify.ts`: adding a
 * 27th notification type without a corresponding registry entry fails this test with a
 * message naming the type — the trap this file exists to close (quick-260825-k3g).
 */
import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_EMAIL_POLICY,
  resolveEmailPolicy,
} from "../contexts/platform/notification-email-policy";
import { scanNotifyEmitSites } from "./notify-emit-sites";

describe("NOTIFICATION_EMAIL_POLICY exhaustiveness (quick-260825-k3g)", () => {
  const scan = scanNotifyEmitSites();
  const found = scan.types;

  it("walked at least one source file (the scanner's own non-empty proof)", () => {
    expect(scan.filesScanned).toBeGreaterThan(0);
  });

  it("scans at least 24 distinct notify() types (floor guard)", () => {
    // Without this floor, a scanner broken by a future refactor would find nothing and
    // the exhaustiveness assertions below would pass vacuously — strictly worse than no
    // test at all.
    expect(
      found.size,
      "no notify() call site scanned under apps/api/src — the source tree moved or emptied",
    ).toBeGreaterThanOrEqual(24);
  });

  it("correctly splits the leave.ts ternary into both branches, not the status operand", () => {
    expect(found.has("LEAVE_APPROVED")).toBe(true);
    expect(found.has("LEAVE_REJECTED")).toBe(true);
    expect(found.has("APPROVED")).toBe(false);
  });

  it("every discovered emit-site type has an explicit registry entry", () => {
    for (const type of found) {
      expect(
        resolveEmailPolicy(type),
        `Notification type "${type}" is emitted via app.notify() but has no entry in ` +
          `NOTIFICATION_EMAIL_POLICY. Add one in apps/api/src/utils/notification-email-policy.ts.`,
      ).toBeDefined();
    }
  });

  it("the only registry key with no emit site is LEAVE_CANCELLED (reverse hygiene)", () => {
    const registeredButUnemitted = Object.keys(NOTIFICATION_EMAIL_POLICY).filter(
      (key) => !found.has(key),
    );
    expect(registeredButUnemitted).toEqual(["LEAVE_CANCELLED"]);
  });

  it("every always/never entry carries a non-empty written reason", () => {
    for (const [type, policy] of Object.entries(NOTIFICATION_EMAIL_POLICY)) {
      if (policy.email === "always" || policy.email === "never") {
        expect(
          policy.reason.length,
          `${type} (${policy.email}) has an empty reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("resolveEmailPolicy is undefined for a made-up type (fail-closed)", () => {
    expect(resolveEmailPolicy("__DOES_NOT_EXIST__")).toBeUndefined();
  });

  it("resolveEmailPolicy is not fooled by Object.prototype members (T-K3G-06)", () => {
    expect(resolveEmailPolicy("constructor")).toBeUndefined();
    expect(resolveEmailPolicy("toString")).toBeUndefined();
    expect(resolveEmailPolicy("hasOwnProperty")).toBeUndefined();
  });
});
