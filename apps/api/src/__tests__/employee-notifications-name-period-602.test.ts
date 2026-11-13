/**
 * Issue #602: every notification that reaches the person it is about names the process and its period.
 * A notice is stored and read later than it is sent, so "heute" or "an deinen letzten Arbeitstagen"
 * says nothing once the day has passed.
 *
 * Static guard over every `notify({ … })` call site of apps/api/src (and the direct
 * `notification.create` writers, which bypass notify(), D-16 of #608):
 *   R1  every notification type found in the source is registered in AUDIENCE, so a new type is
 *       classified on purpose (a person's own notice, or a notice to managers / admins);
 *   R2  every site of a type the person receives builds its message from the registered date token
 *       inside an interpolation - a formatted day, a period label, a month or a year;
 *   R3  the direct writers are exactly the known files, and the person's own notice among them carries
 *       its dates too.
 * The rule is about the in-app message; lock-screen push texts are neutral on purpose and live in
 * notification-push-policy.ts (#608).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect } from "vitest";

type Audience = { audience: "PERSON"; dateBy: string } | { audience: "OTHERS"; reason: string };

/** Every notification type of the source, by whom it reaches. */
const AUDIENCE: Record<string, Audience> = {
  // ── to the person the notice is about (R2: the message names the period) ──
  SECTION9_CREDIT_CONFIRMED: { audience: "PERSON", dateBy: "rangeLabel" },
  SECTION9_CREDIT_REJECTED: { audience: "PERSON", dateBy: "rangeLabel" },
  SECTION9_AU_PENDING_EMPLOYEE: { audience: "PERSON", dateBy: "rangeLabel" },
  LEAVE_APPROVED: { audience: "PERSON", dateBy: "decisionPeriodDe(" },
  LEAVE_REJECTED: { audience: "PERSON", dateBy: "decisionPeriodDe(" },
  CARRYOVER_EXPIRING: { audience: "PERSON", dateBy: "deadlineDe" },
  RETRO_ENTRY_DECIDED: { audience: "PERSON", dateBy: "targetDateStr" },
  CLOCK_OUT_REMINDER: { audience: "PERSON", dateBy: "startStr" },
  MISSING_ENTRIES: { audience: "PERSON", dateBy: "sinceDe" },
  OPEN_ENTRY_INVALIDATED: { audience: "PERSON", dateBy: "startStr" },
  UPCOMING_ABSENCE: { audience: "PERSON", dateBy: "startStr" },
  VACATION_EXPIRY: { audience: "PERSON", dateBy: "carryOverDeadlineDay" },
  GAP_WARNING_EMPLOYEE: { audience: "PERSON", dateBy: "monthLabel" },
  BREAK_UNCONFIRMED: { audience: "PERSON", dateBy: "dateDe" },
  REMINDER_SHIFT_START: { audience: "PERSON", dateBy: "formatNoticeDay(" },
  REMINDER_SHIFT_END: { audience: "PERSON", dateBy: "formatNoticeDay(" },
  REMINDER_DAY_CLOSE: { audience: "PERSON", dateBy: "formatNoticeDay(" },
  WIFI_DEVICE_NOT_SEEN: { audience: "PERSON", dateBy: "formatNoticeDay(" },
  MONTH_CORRECTION_DECIDED: { audience: "PERSON", dateBy: "day(row.targetDate)" },
  LEAVE_DAYS_ADJUSTED: { audience: "PERSON", dateBy: "von" },
  LEAVE_PLAN_OPENED: { audience: "PERSON", dateBy: "plan.year" },
  // ── to managers, approvers, admins or planners ──
  SECTION9_AU_PENDING_MANAGER: { audience: "OTHERS", reason: "approvers of the § 9 case" },
  LEAVE_REQUEST: { audience: "OTHERS", reason: "approvers of a new request" },
  ACCOUNT_LOCKED: { audience: "OTHERS", reason: "security notice to administrators" },
  SUPPORT_ACCESS_STARTED: { audience: "OTHERS", reason: "tenant administrators (#93)" },
  SHIFT_LEAVE_CONFLICT: { audience: "OTHERS", reason: "roster planners" },
  SHIFT_WEEK_OVERBOOKED: { audience: "OTHERS", reason: "roster planners" },
  RETRO_ENTRY_WITHDRAWN: { audience: "OTHERS", reason: "approvers of the Zeitnachtrag" },
  RETRO_ENTRY_REQUESTED: { audience: "OTHERS", reason: "approvers of the Zeitnachtrag" },
  RETRO_ENTRY_UPDATED: { audience: "OTHERS", reason: "approvers of the Zeitnachtrag" },
  BREAK_COMPLIANCE_ALERT: { audience: "OTHERS", reason: "managers of the person" },
  PENDING_LEAVE_REMINDER: { audience: "OTHERS", reason: "approvers of an open request" },
  GAP_WARNING_MANAGER: { audience: "OTHERS", reason: "managers before the Monatsabschluss" },
  BREAK_CROSS_SALON_VIOLATION: { audience: "OTHERS", reason: "managers only (#80 D-09e)" },
  BREAK_PLACEMENT_VIOLATION: { audience: "OTHERS", reason: "managers only (#511 D-13)" },
  MONTH_CORRECTION_REQUESTED: { audience: "OTHERS", reason: "approvers of the correction (#599)" },
  MONTH_CLOSE_BLOCKED: { audience: "OTHERS", reason: "month-close holders" },
  MONTH_CLOSE_DEFERRED: { audience: "OTHERS", reason: "month-close holders" },
};

/** The writers that create Notification rows without notify() (#608 D-16), and the person's own one. */
const DIRECT_WRITERS = [
  "contexts/absence/bs-leave-correction.ts",
  "contexts/absence/vocational-school-generator.ts",
  "contexts/platform/plugins/notify.ts", // notify() itself
];
const DIRECT_PERSON_NOTICE = {
  file: "contexts/absence/bs-leave-correction.ts",
  messageStart: "const message =\n    `Der ${fmtDMY(bsDate)} ist ein Berufsschultag.",
};

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (abs.endsWith(".ts") && !abs.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

const FILES = walk(SRC).map((abs) => ({
  rel: relative(SRC, abs).split("\\").join("/"),
  text: readFileSync(abs, "utf8"),
}));

/** The balanced `{ … }` that starts at `open`. */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

interface Site {
  file: string;
  line: number;
  types: string[];
  message: string;
}

function notifySites(): Site[] {
  const sites: Site[] = [];
  for (const f of FILES) {
    if (f.rel === "contexts/platform/plugins/notify.ts") continue; // the definition
    const re = /\bnotify\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.text))) {
      const open = m.index + m[0].length - 1;
      const body = objectAt(f.text, open);
      const typeExpr = /\btype:\s*([^\n]+)/.exec(body)?.[1] ?? "";
      // the type literals, not the operand of a comparison inside a conditional type
      const types = [...typeExpr.matchAll(/(?<!===\s*)"([A-Z0-9_]+)"/g)].map((x) => x[1]);
      let message = "";
      const inline = /\bmessage:\s*([\s\S]*?)(?=,\s*\n\s*[a-zA-Z]+[:,]|\s*\n\s*\})/.exec(body);
      if (inline) message = inline[1];
      const named = /\bmessage(?::\s*([A-Za-z]+))?,/.exec(body);
      const varName = inline && /^[A-Za-z]+$/.test(inline[1].trim()) ? inline[1].trim() : null;
      const ref = varName ?? (named && !inline ? (named[1] ?? "message") : null);
      if (ref) {
        // the nearest preceding `const <ref> =` (or a destructuring that names it) of the same file
        const before = f.text.slice(0, open);
        const decl = new RegExp(`const (?:${ref}|\\{[^}]*\\b${ref}\\b[^}]*\\}) =`, "g");
        let at = -1;
        for (const d of before.matchAll(decl)) at = d.index ?? at;
        if (at >= 0) message = before.slice(at, before.indexOf(";", at) + 1);
      }
      sites.push({
        file: f.rel,
        line: f.text.slice(0, m.index).split("\n").length,
        types,
        message,
      });
    }
  }
  return sites;
}

const SITES = notifySites();

describe("employee notifications name their period (Issue #602)", () => {
  it("finds the notify() sites (non-vacuous) and every site has a type and a message", () => {
    expect(FILES.length).toBeGreaterThan(300); // the walked source tree is not empty
    expect(SITES.length).toBeGreaterThanOrEqual(35);
    const broken = SITES.filter((s) => s.types.length === 0 || s.message.trim() === "").map(
      (s) => `${s.file}:${s.line}`,
    );
    expect(broken).toEqual([]);
  });

  it("R1: every notification type of the source is registered with its audience", () => {
    const found = new Set(SITES.flatMap((s) => s.types));
    const unregistered = [...found].filter((t) => !(t in AUDIENCE));
    expect(unregistered).toEqual([]);
    // the register holds no type that no longer exists (it cannot rot silently)
    const stale = Object.keys(AUDIENCE).filter((t) => !found.has(t));
    expect(stale).toEqual([]);
  });

  it("R2: every site of a notice to the person builds its message from a date", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const s of SITES) {
      for (const t of s.types) {
        const a = AUDIENCE[t];
        if (!a || a.audience !== "PERSON") continue;
        checked++;
        const interpolations = [...s.message.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
        if (!interpolations.some((expr) => expr.includes(a.dateBy))) {
          offenders.push(`${s.file}:${s.line} ${t} (expects \${…${a.dateBy}…})`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("R2 sees a message without a date (control)", () => {
    const interpolations = [..."`Heute fehlt noch deine Zeit.`".matchAll(/\$\{([^}]*)\}/g)].map(
      (x) => x[1],
    );
    expect(interpolations.some((e) => e.includes("formatNoticeDay("))).toBe(false);
  });

  it("R3: the direct writers are the known ones, and the person's own notice names its dates", () => {
    const writers = FILES.filter((f) => /\bnotification\.create\(/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(writers).toEqual([...DIRECT_WRITERS].sort());
    const text = FILES.find((f) => f.rel === DIRECT_PERSON_NOTICE.file)?.text ?? "";
    expect(text).toContain(DIRECT_PERSON_NOTICE.messageStart);
  });
});
