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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATION_EMAIL_POLICY, resolveEmailPolicy } from "../utils/notification-email-policy";

const SRC_DIR = join(__dirname, "../");

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract UPPER_SNAKE notification-type literals from the expression that follows
 * `type:` in a `notify({ ... })` call.
 *
 * The naive "every /"([A-Z][A-Z0-9_]*)"/g literal on the line" rule is WRONG: the
 * ternary at `leave.ts:1400` reads
 *   type: body.status === "APPROVED" ? "LEAVE_APPROVED" : "LEAVE_REJECTED",
 * and the naive rule also captures "APPROVED" — the comparison operand, a
 * `LeaveRequest.status` value, never a notification type. `resolveEmailPolicy("APPROVED")`
 * is undefined BY CONSTRUCTION and can never be fixed by adding a registry entry.
 *
 * Correct rule: if the expression contains a `?`, discard everything up to and
 * including the FIRST `?` and collect literals only from the branches after it.
 * Otherwise collect literals from the whole expression.
 */
function extractTypeLiterals(typeExpression: string): string[] {
  const qIndex = typeExpression.indexOf("?");
  const relevant = qIndex === -1 ? typeExpression : typeExpression.slice(qIndex + 1);
  const matches = relevant.match(/"([A-Z][A-Z0-9_]*)"/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

function scanNotifyEmitSites(): Set<string> {
  const found = new Set<string>();
  const files = collectTsFiles(SRC_DIR);

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const callRegex = /\bnotify\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(content)) !== null) {
      const windowStart = match.index;
      const window = content.slice(windowStart, windowStart + 1500);
      const typeLineMatch = window.match(/^\s*type:\s*(.+)$/m);
      if (!typeLineMatch) continue;
      for (const t of extractTypeLiterals(typeLineMatch[1])) {
        found.add(t);
      }
    }
  }

  return found;
}

describe("NOTIFICATION_EMAIL_POLICY exhaustiveness (quick-260825-k3g)", () => {
  const found = scanNotifyEmitSites();

  it("scans at least 24 distinct notify() types (floor guard)", () => {
    // Without this floor, a scanner broken by a future refactor would find nothing and
    // the exhaustiveness assertions below would pass vacuously — strictly worse than no
    // test at all.
    expect(found.size).toBeGreaterThanOrEqual(24);
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
