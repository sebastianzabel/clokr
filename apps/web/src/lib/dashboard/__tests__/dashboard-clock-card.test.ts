// Phase 115 (GitHub issue #118) — source-level regression shield for the dashboard hero card.
//
// Issue #118: at 20:50 on a Friday the hero card said „NOCH NICHT EINGESTEMPELT / Bereit für
// deinen Tag" with an active Einstempeln button, directly above a „HEUTIGER EINTRAG" card fed
// by the SAME HTTP response reading START 08:55 / ENDE 17:46 / NETTO 8:21 h. Tapping the button
// did not 409 — a closed same-day entry is CLOSED_SAME_DAY_ENTRY, which the state machine maps
// to REOPEN, reopening a retention-relevant TimeEntry and burying its recorded break under a
// ~3 h gap break. This file is what stops the mechanism from coming back.
//
// Why it reads the page SOURCE instead of mounting the component: no test in `apps/web` has ever
// mounted a route page (every other test file lives under `src/lib/`), and what is under test
// here is WHICH MARKUP BRANCHES EXIST — not behaviour, which `day-state.test.ts` already covers
// at the logic level.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
const PAGE_URL = new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url);
let PAGE: string;
try {
  PAGE = readFileSync(fileURLToPath(PAGE_URL), "utf8");
} catch {
  // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
  PAGE = readFileSync(resolve(process.cwd(), "src/routes/(app)/dashboard/+page.svelte"), "utf8");
}

// The resolver lives in a sibling workspace package. cwd is `apps/web` under the filter run.
const STATE_MACHINE_URL = new URL(
  "../../../../../api/src/services/clock/state-machine.ts",
  import.meta.url,
);
let STATE_MACHINE: string;
try {
  STATE_MACHINE = readFileSync(
    resolve(process.cwd(), "../api/src/services/clock/state-machine.ts"),
    "utf8",
  );
} catch {
  STATE_MACHINE = readFileSync(fileURLToPath(STATE_MACHINE_URL), "utf8");
}

describe("retired two-state ternaries — the mechanism of issue #118", () => {
  it("the button ternary is gone — a finished day fell into the `false` arm and was offered Einstempeln", () => {
    expect(PAGE).not.toContain('{clockedIn ? "Ausstempeln" : "Einstempeln"}');
  });

  it("the title ternary is gone — an 8:21 h day was labelled 'noch nicht eingestempelt'", () => {
    expect(PAGE).not.toContain('{clockedIn ? "Du arbeitest gerade" : "Noch nicht eingestempelt"}');
  });

  it("the two-state boolean can no longer be assigned", () => {
    expect(PAGE).not.toMatch(/let clockedIn = \$state/);
  });

  it("the timer no longer restarts at now — a REOPEN returns the ORIGINAL entry", () => {
    expect(PAGE).not.toContain("clockStart = new Date()");
  });

  it("the false ClockInResponse comment is retired", () => {
    expect(PAGE).not.toContain("always a fresh entry");
  });

  it("neither duplicated reading of the entries array survives", () => {
    expect(PAGE).not.toContain("find((e) => !e.endTime)");
  });
});

describe("the finished day has its own face", () => {
  it("the page branches on a finished day at all", () => {
    expect(PAGE).toContain('day.kind === "finished"');
  });

  it("it is called 'Tag abgeschlossen', not 'Noch nicht eingestempelt'", () => {
    expect(PAGE).toContain("Tag abgeschlossen");
  });

  it("the sub line names what the big readout shows", () => {
    expect(PAGE).toContain("Erfasste Arbeitszeit heute");
  });

  it("the state is exposed on the header for tests and debugging", () => {
    expect(PAGE).toContain("data-day-state={day.kind}");
  });

  it("a locked finished day is told why it has no action", () => {
    expect(PAGE).toContain("Monat abgeschlossen — der Eintrag kann nicht mehr geändert werden.");
  });
});

describe("no primary Einstempeln action on a finished day (acceptance criterion #2)", () => {
  it("the primary button is not rendered, not merely disabled", () => {
    expect(PAGE).toContain("{#if primaryLabel}");
  });

  it("its label comes from the module that returns null for a finished day", () => {
    expect(PAGE).toContain("primaryClockLabel(day)");
  });

  it("the reopen action is secondary — no btn-primary anywhere near it", () => {
    expect(PAGE).not.toMatch(/btn-primary[\s\S]{0,400}Erneut einstempeln/);
  });

  it("handleClock refuses a finished day even if a button were ever wired to it", () => {
    expect(PAGE).toContain('if (day.kind === "finished") return;');
  });
});

describe("the Rückfrage names its consequence (acceptance criterion #4)", () => {
  it("the sentence names the recorded clock-out time, interpolated — not hard-coded", () => {
    // Pins the copy AND the EN DASH (U+2013) AND that the time comes from the entry.
    expect(PAGE).toMatch(/Der Zeitraum \$\{[^}]+\}–jetzt wird als Pause erfasst/);
  });

  it("the dialog asks before it acts", () => {
    expect(PAGE).toContain('title="Erneut einstempeln?"');
  });

  it("the dialog is bound to the page's own open state", () => {
    expect(PAGE).toContain("bind:open={reopenDialogOpen}");
  });

  it("confirming routes through confirmReopen, not through handleClock", () => {
    expect(PAGE).toContain("onConfirm={confirmReopen}");
  });

  it("confirmReopen re-checks the day — the 5 s poll can change it under an open dialog", () => {
    expect(PAGE).toContain("if (!canReopenFinishedDay(day)) {");
  });
});

describe("the untouched states stay untouched", () => {
  // idle and running were not reworded; the Playwright visual baselines depend on it.
  const PRESERVED = [
    "Noch nicht eingestempelt",
    "Bereit zum Einstempeln",
    "Bereit für deinen Tag",
    "Du arbeitest gerade",
    "Zeiterfassung läuft",
    "Pause starten",
    "Pause beenden",
  ];

  for (const phrase of PRESERVED) {
    it(`still renders "${phrase}"`, () => {
      expect(PAGE).toContain(phrase);
    });
  }
});

describe("the Umfangsgrenze is mechanically enforced", () => {
  it("the resolver's REOPEN mapping is still there — this phase was forbidden to change it", () => {
    // REOPEN is a deliberate production fix for the 2026-06-04 NFC/WIFI double-tap incident
    // (services/clock/__tests__/consolidate.cross-source.test.ts). If this ever fails, someone
    // changed the one file issue #118 explicitly declared off limits.
    expect(STATE_MACHINE).toContain(
      'if (state.kind === "CLOSED_SAME_DAY_ENTRY") return { kind: "REOPEN", entryId: state.entryId };',
    );
  });

  it("an explicit IN on an already-open entry still conflicts rather than reopening", () => {
    expect(STATE_MACHINE).toContain('return { kind: "CONFLICT", reason: "ALREADY_CLOCKED_IN" };');
  });
});
