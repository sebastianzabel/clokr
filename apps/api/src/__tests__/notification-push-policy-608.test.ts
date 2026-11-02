/**
 * Issue #608 (D-08, D-09, D-16, AC-4) - the push policy registry.
 *
 * Pure static test, no DB and no app boot: it scans every `app.notify()` call site under
 * apps/api/src through the same scanner the e-mail registry test uses, and pins the content rules
 * of every lock-screen text. A new notification type without a push entry, a text that names a
 * figure or a health word, and a `send` entry for a type that is never e-mailed all turn this red.
 */
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_EMAIL_POLICY,
  resolveEmailPolicy,
} from "../contexts/platform/notification-email-policy";
import {
  NOTIFICATION_PUSH_POLICY,
  PUSH_FALLBACK_URL,
  PUSH_TITLE,
  PUSH_TTL_CLASSES,
  resolvePushPolicy,
  safePushUrl,
} from "../contexts/platform/notification-push-policy";
import { scanNotifyEmitSites } from "./notify-emit-sites";

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Word starts (stems) whose presence on a lock screen would disclose health, saldo or figures.
// Matched at a word start so that "Aufmerksamkeit" does not trip "AU"; "AU" itself is a whole word.
const DENIED_STEMS = [
  "krank",
  "attest",
  "arzt",
  "gesund",
  "saldo",
  "stunde",
  "minute",
  "überstunde",
  "mutterschutz",
  "schwanger",
];
const WORD_START = "(?<![\\p{L}\\p{N}])";
const DENIED_STEM_RE = new RegExp(`${WORD_START}(?:${DENIED_STEMS.join("|")})`, "iu");
const DENIED_WHOLE_WORD_RE = new RegExp(`${WORD_START}AU(?![\\p{L}\\p{N}])`, "iu");
const POLITE_FORM_RE = /\b(Sie|Ihr|Ihre|Ihnen)\b/;

const NEVER_PUSH_TYPES = [
  "SECTION9_AU_PENDING_EMPLOYEE",
  "SECTION9_AU_PENDING_MANAGER",
  "SECTION9_CREDIT_CONFIRMED",
  "SECTION9_CREDIT_REJECTED",
  "SUPPORT_ACCESS_STARTED",
];

// Issue #610 (D-10): the ONE named exception to the parity rule below - a type that is pushed although
// its e-mail policy is `never`. A new entry needs a written reason; the stale-list case proves every
// entry really is e-mail `never` AND push `send`, so the list cannot go stale or hide a `never` type.
const PUSH_WITHOUT_EMAIL: Record<string, string> = {
  WIFI_DEVICE_NOT_SEEN:
    "no personal data, re-coupling hint only; e-mail deliberately not used (Issue #610, D-10)",
};

describe("NOTIFICATION_PUSH_POLICY exhaustiveness (Issue #608, D-08)", () => {
  const scan = scanNotifyEmitSites();
  const found = scan.types;

  it("walked source files and scans at least 24 distinct notify() types (floor guard)", () => {
    expect(scan.filesScanned).toBeGreaterThan(0);
    expect(
      found.size,
      "no notify() call site scanned under apps/api/src - the source tree moved or emptied",
    ).toBeGreaterThanOrEqual(24);
  });

  it("splits the leave.ts ternary into both branches, not the status operand", () => {
    expect(found.has("LEAVE_APPROVED")).toBe(true);
    expect(found.has("LEAVE_REJECTED")).toBe(true);
    expect(found.has("APPROVED")).toBe(false);
  });

  it("every discovered emit-site type has an explicit push policy (fail-closed)", () => {
    for (const type of found) {
      expect(
        resolvePushPolicy(type),
        `Notification type "${type}" is emitted via app.notify() but has no entry in ` +
          `NOTIFICATION_PUSH_POLICY. Add one in apps/api/src/contexts/platform/notification-push-policy.ts ` +
          `with a neutral text or "never" (Issue #608, AC-4).`,
      ).toBeDefined();
    }
  });

  it("the only registry key with no emit site is LEAVE_CANCELLED (reverse hygiene)", () => {
    const registeredButUnemitted = Object.keys(NOTIFICATION_PUSH_POLICY).filter(
      (key) => !found.has(key),
    );
    expect(registeredButUnemitted).toEqual(["LEAVE_CANCELLED"]);
  });

  it("the push registry keys equal the e-mail registry keys (D-08)", () => {
    expect(Object.keys(NOTIFICATION_PUSH_POLICY).sort(byName)).toEqual(
      Object.keys(NOTIFICATION_EMAIL_POLICY).sort(byName),
    );
  });
});

describe("NOTIFICATION_PUSH_POLICY never entries (AC-4, D-16)", () => {
  it("every never entry carries a non-empty written reason", () => {
    const nevers = Object.entries(NOTIFICATION_PUSH_POLICY).filter(([, p]) => p.push === "never");
    expect(nevers.length).toBeGreaterThanOrEqual(5);
    for (const [type, policy] of nevers) {
      if (policy.push !== "never") continue;
      expect(policy.reason.length, `${type} has an empty reason`).toBeGreaterThan(0);
    }
  });

  it("every type whose e-mail policy is never is never pushed (parity), bar PUSH_WITHOUT_EMAIL", () => {
    for (const [type, email] of Object.entries(NOTIFICATION_EMAIL_POLICY)) {
      if (email.email !== "never") continue;
      if (Object.prototype.hasOwnProperty.call(PUSH_WITHOUT_EMAIL, type)) continue;
      expect(resolvePushPolicy(type)?.push, `${type} is e-mail never but not push never`).toBe(
        "never",
      );
    }
  });

  it("every PUSH_WITHOUT_EMAIL entry is e-mail never AND push send, with a written reason", () => {
    const entries = Object.entries(PUSH_WITHOUT_EMAIL);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const [type, reason] of entries) {
      expect(reason.length, `${type} has an empty reason`).toBeGreaterThan(0);
      expect(resolveEmailPolicy(type)?.email, `${type} is not e-mail never`).toBe("never");
      expect(resolvePushPolicy(type)?.push, `${type} is not pushed`).toBe("send");
    }
  });

  it.each(NEVER_PUSH_TYPES)("%s is never pushed", (type) => {
    expect(resolvePushPolicy(type)?.push).toBe("never");
    expect(resolveEmailPolicy(type)?.email).toBe("never");
  });

  it("exactly the five named types are never pushed", () => {
    const nevers = Object.entries(NOTIFICATION_PUSH_POLICY)
      .filter(([, p]) => p.push === "never")
      .map(([type]) => type)
      .sort(byName);
    expect(nevers).toEqual([...NEVER_PUSH_TYPES].sort(byName));
  });
});

describe("NOTIFICATION_PUSH_POLICY text rules (AC-4)", () => {
  const sends = Object.entries(NOTIFICATION_PUSH_POLICY).flatMap(([type, policy]) =>
    policy.push === "send" ? [{ type, policy }] : [],
  );

  it("28 types are sent", () => {
    expect(sends.length).toBe(28);
  });

  it.each(sends.map((s) => [s.type, s.policy.body, s.policy.ttlSeconds] as const))(
    "%s: neutral du-form text, within the length and TTL rules",
    (type, body, ttlSeconds) => {
      expect(body.length, `${type} body is empty`).toBeGreaterThan(0);
      expect(body.length, `${type} body is longer than 80 characters`).toBeLessThanOrEqual(80);
      expect(body, `${type} body contains a digit`).not.toMatch(/\d/);
      expect(body, `${type} body contains an @`).not.toContain("@");
      expect(body, `${type} body contains a section sign`).not.toContain("§");
      expect(body, `${type} body contains a denied health/saldo/figure word`).not.toMatch(
        DENIED_STEM_RE,
      );
      expect(body, `${type} body contains the word AU`).not.toMatch(DENIED_WHOLE_WORD_RE);
      expect(body, `${type} body uses the polite form`).not.toMatch(POLITE_FORM_RE);
      expect(PUSH_TTL_CLASSES, `${type} uses an unknown TTL class`).toContain(ttlSeconds);
    },
  );

  it("the title constant is the product name", () => {
    expect(PUSH_TITLE).toBe("Clokr");
  });

  it("the deny-list itself bites (the content rule is not vacuous)", () => {
    expect("Dein Saldo ist 5 Stunden im Minus").toMatch(DENIED_STEM_RE);
    expect("Krankmeldung eingegangen").toMatch(DENIED_STEM_RE);
    expect("Neue AU liegt vor").toMatch(DENIED_WHOLE_WORD_RE);
    expect("Der Monatsabschluss braucht deine Aufmerksamkeit.").not.toMatch(DENIED_WHOLE_WORD_RE);
    expect("Bitte senden Sie Ihre Unterlagen").toMatch(POLITE_FORM_RE);
  });
});

describe("resolvePushPolicy", () => {
  it("is undefined for a made-up type (fail-closed)", () => {
    expect(resolvePushPolicy("__DOES_NOT_EXIST__")).toBeUndefined();
  });

  it("is not fooled by Object.prototype members", () => {
    expect(resolvePushPolicy("constructor")).toBeUndefined();
    expect(resolvePushPolicy("toString")).toBeUndefined();
    expect(resolvePushPolicy("hasOwnProperty")).toBeUndefined();
  });
});

describe("safePushUrl (D-09, T-608-19)", () => {
  it.each(["/team/leave?request=abc", "/time-entries?highlight=x#y", "/dashboard", "/inbox"])(
    "passes %s unchanged",
    (link) => {
      expect(safePushUrl(link)).toBe(link);
    },
  );

  const unsafe: Array<[string, string | null | undefined]> = [
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["protocol-relative", "//evil.example"],
    ["slash-backslash", "/\\evil.example"],
    ["absolute https", "https://evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["trailing newline", "/ok\n"],
    ["space", "/with space"],
    ["513 characters", "/" + "a".repeat(512)],
    ["encoded double slash", "/%2F%2Fevil.example"],
    ["encoded dot segments", "/a/%2e%2e/b"],
    ["encoded backslash", "/%5cevil.example"],
    ["tab", "/a\tb"],
    ["relative without slash", "dashboard"],
    // Review 2, WR-03: normalisation of a `.` segment would leave a protocol-relative path.
    ["dot segment before a host", "/.//evil.example"],
    ["dot segments before a host", "/.///evil.example/x"],
    ["parent segment before a host", "/..//evil.example"],
    ["dot segment before a backslash", "/./\\evil.example"],
  ];
  it.each(unsafe)("falls back to /dashboard for %s", (_label, link) => {
    expect(safePushUrl(link)).toBe(PUSH_FALLBACK_URL);
    expect(PUSH_FALLBACK_URL).toBe("/dashboard");
  });

  it("sends the dot-segment-normalised path, never the raw input", () => {
    expect(safePushUrl("/./team/leave?request=abc#x")).toBe("/team/leave?request=abc#x");
    expect(safePushUrl("/a/./b")).toBe("/a/b");
    expect(safePushUrl("/a/../b")).toBe("/b");
    expect(safePushUrl("/.")).toBe("/");
  });

  it("accepts a path of exactly 512 characters", () => {
    const link = "/" + "a".repeat(511);
    expect(link.length).toBe(512);
    expect(safePushUrl(link)).toBe(link);
  });
});
