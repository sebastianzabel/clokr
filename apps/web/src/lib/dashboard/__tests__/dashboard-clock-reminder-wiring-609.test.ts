// Issue #609 (AC-4, D-09, D-14): source-level wiring pin for the reminder arrival on the dashboard.
//
// Why it reads the page SOURCE: no route page is mounted in this workspace (see
// clock-salon-wiring-87.test.ts and dashboard-clock-card.test.ts for the precedent). What the
// pins protect: a `?clock=1` link only OPENS a confirmation, the stamp is the unchanged
// handleClock(), and the parameter is stripped through the router only once it is ready.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(url: URL, fallback: string): string {
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), fallback), "utf8");
  }
}

const PAGE = readSource(
  new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url),
  "src/routes/(app)/dashboard/+page.svelte",
);
const LIB = readSource(
  new URL("../clock-reminder.ts", import.meta.url),
  "src/lib/dashboard/clock-reminder.ts",
);

/** Source without whole-line comments, so prose about a call is not a call. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|<!--)/.test(line))
    .join("\n");
}

/** The reminder script block: from its section comment to the next section comment. */
function reminderBlock(): string {
  const start = PAGE.indexOf("// ── Shift reminder arrival (Issue #609");
  expect(start, "reminder block not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("// ── Deliberate re-clock-in on a finished day", start);
  expect(end, "reminder block end not found").toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** The body of one function of the reminder block, up to its closing brace at indent 2. */
function fnBody(block: string, marker: string): string {
  const start = block.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const end = block.indexOf("\n  }\n", start);
  expect(end, `unterminated: ${marker}`).toBeGreaterThan(start);
  return block.slice(start, end);
}

describe("dashboard shift reminder arrival (Issue #609)", () => {
  it("imports afterNavigate and replaceState from $app/navigation and the page store", () => {
    expect(PAGE).toMatch(/import \{[^}]*afterNavigate[^}]*\} from "\$app\/navigation"/);
    expect(PAGE).toMatch(/import \{[^}]*replaceState[^}]*\} from "\$app\/navigation"/);
    expect(PAGE).toContain('import { page } from "$app/stores"');
  });

  it("counts every arrival through afterNavigate (covers an already open dashboard)", () => {
    expect(reminderBlock()).toMatch(/afterNavigate\(\(\) => \{\s*clockArrival \+= 1;/);
  });

  it("decides through clockReminderAction with the live loading, exempt, day and salon state", () => {
    const effect = reminderBlock().slice(reminderBlock().indexOf("$effect(() => {"));
    expect(effect).toContain("clockReminderAction(");
    expect(effect).toContain("isExempt");
    expect(effect).toContain("dayKind: day.kind");
    expect(effect).toContain("clockInBlocked(clockSalonViewState, clockSalonId)");
    expect(effect).toContain("clockReminderWaiting");
  });

  it("waits for the router: loading, the salon choice and a first afterNavigate", () => {
    expect(reminderBlock()).toMatch(
      /clockReminderWaiting = \$derived\(loading \|\| !clockSalonLoaded \|\| clockArrival === 0\)/,
    );
  });

  it("acts once per arrival", () => {
    const effect = reminderBlock().slice(reminderBlock().indexOf("$effect(() => {"));
    expect(effect).toContain("arrival === clockHandledArrival");
    expect(effect).toContain("clockHandledArrival = arrival");
  });

  it("strips the parameter through replaceState, deferred past the update with tick()", () => {
    const body = fnBody(reminderBlock(), "async function settleClockReminder");
    expect(body).toContain("replaceState(stripClockParam(url)");
    const replaceAt = body.lastIndexOf("replaceState(");
    const tickAt = body.lastIndexOf("await tick()");
    expect(tickAt, "no await tick() before replaceState").toBeGreaterThan(-1);
    expect(tickAt).toBeLessThan(replaceAt);
  });

  it("the confirm handler re-derives the action and stamps only through handleClock()", () => {
    const body = fnBody(reminderBlock(), "async function confirmClockReminder");
    expect(body).toContain("clockReminderAction(");
    expect(body).toContain("live !== clockReminderPending");
    expect(body).toContain("Dein Stempelstatus hat sich inzwischen geändert.");
    expect(body).toMatch(/await handleClock\(\);/);
  });

  it("the reminder code sends no request of its own", () => {
    const block = code(reminderBlock());
    expect(block).not.toMatch(/api\.(post|put|patch|delete|get)\(/);
    expect(block).not.toContain("fetch(");
    expect(code(LIB)).not.toMatch(/api\.(post|put|patch|delete|get)\(|fetch\(/);
  });

  it("the confirmation dialog sits inside {#if !isExempt}, next to the reopen dialog", () => {
    const reopenAt = PAGE.indexOf("onConfirm={confirmReopen}");
    const reminderAt = PAGE.indexOf("onConfirm={confirmClockReminder}");
    expect(reopenAt).toBeGreaterThan(-1);
    expect(reminderAt).toBeGreaterThan(reopenAt);
    // Nothing closes the {#if !isExempt} block between the two dialogs.
    const between = PAGE.slice(reopenAt, reminderAt);
    expect(between).not.toContain("{/if}");
    expect(PAGE.slice(reminderAt, reminderAt + 80)).toContain("/>");
    expect(PAGE.slice(reminderAt).indexOf("{/if}")).toBeGreaterThan(-1);
  });

  it("handleClock stays the one stamp path: the reminder block never calls performClockIn", () => {
    expect(code(reminderBlock())).not.toContain("performClockIn(");
    expect(code(reminderBlock())).not.toContain("/clock-in");
  });
});
