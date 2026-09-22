// Phase 307 Plan 02 (D-04) — a DEBOUNCE_NOOP must never again reach the surface as success.
//
// describe A: pure behaviour of interpretClockOut(), no DOM.
// describe B: parity between this module's ClockResolutionKind mirror and the server's
//   ClockResolution union in apps/api/src/services/clock/types.ts — the mirror can not silently
//   go stale the way the pre-Phase-307 ClockOutResponse type did (it never learned DEBOUNCE_NOOP
//   existed at all).
// describe C: source-level proof that the dashboard page actually calls interpretClockOut() and
//   shows toasts.error(...) on a non-closed result — apps/web/vitest.config.ts registers no
//   `$app/*` alias and the page imports `$app/*` directly, so mounting it is not possible here
//   (same wall dashboard-clock-card.test.ts and dashboard-today-shift-source.test.ts document).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import {
  interpretClockOut,
  type ClockOutResponse,
  type ClockResolutionKind,
} from "../clock-out-result";

describe("interpretClockOut — D-04: a DEBOUNCE_NOOP (or any non-close) is never 'closed'", () => {
  it("A1: CLOCKED_OUT with entry -> closed, entry passed through", () => {
    const response: ClockOutResponse = {
      resolution: { kind: "CLOCKED_OUT", entry: { id: "e1", endTime: "2026-09-22T10:00:00Z" } },
    };
    const result = interpretClockOut(response);
    expect(result.kind).toBe("closed");
    if (result.kind === "closed") {
      expect(result.entry).toEqual({ id: "e1", endTime: "2026-09-22T10:00:00Z" });
    }
  });

  it("A2: CONSOLIDATED with entry -> closed, entry passed through", () => {
    const response: ClockOutResponse = {
      resolution: { kind: "CONSOLIDATED", entry: { id: "e2", endTime: "2026-09-22T11:00:00Z" } },
    };
    const result = interpretClockOut(response);
    expect(result.kind).toBe("closed");
    if (result.kind === "closed") {
      expect(result.entry).toEqual({ id: "e2", endTime: "2026-09-22T11:00:00Z" });
    }
  });

  it("A3: DEBOUNCE_NOOP (actual wire shape: action 'NOOP', NO entry) -> not-closed with a non-empty German message — the actual subject of this phase", () => {
    const response: ClockOutResponse = {
      action: "NOOP",
      resolution: { kind: "DEBOUNCE_NOOP" },
    };
    const result = interpretClockOut(response);
    expect(result.kind).toBe("not-closed");
    if (result.kind === "not-closed") {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toMatch(/[äöüßÄÖÜ]|Ausstempeln/);
    }
  });

  it("A4: CLOCKED_OUT WITHOUT entry (form deviation) -> not-closed with a message, no crash — a reader who trusted the old required `resolution.entry` type would TypeError here", () => {
    const response: ClockOutResponse = {
      resolution: { kind: "CLOCKED_OUT" },
    };
    expect(() => interpretClockOut(response)).not.toThrow();
    const result = interpretClockOut(response);
    expect(result.kind).toBe("not-closed");
    if (result.kind === "not-closed") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it.each<ClockResolutionKind>(["CONFLICT", "CLOCKED_IN", "CONFIRMED"])(
    "A5: %s -> not-closed with a message",
    (kind) => {
      const response: ClockOutResponse = { resolution: { kind } };
      const result = interpretClockOut(response);
      expect(result.kind).toBe("not-closed");
      if (result.kind === "not-closed") {
        expect(result.message.length).toBeGreaterThan(0);
      }
    },
  );
});

// ── describe B — parity against the server's ClockResolution union ──────────────────────────
const SERVER_TYPES_URL = new URL("../../../../../api/src/services/clock/types.ts", import.meta.url);
let SERVER_TYPES_SOURCE: string | null = null;
try {
  SERVER_TYPES_SOURCE = readFileSync(fileURLToPath(SERVER_TYPES_URL), "utf8");
} catch {
  try {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    SERVER_TYPES_SOURCE = readFileSync(
      resolve(process.cwd(), "../api/src/services/clock/types.ts"),
      "utf8",
    );
  } catch {
    SERVER_TYPES_SOURCE = null;
  }
}

const WEB_MODULE_URL = new URL("../clock-out-result.ts", import.meta.url);
let WEB_MODULE_SOURCE: string | null = null;
try {
  WEB_MODULE_SOURCE = readFileSync(fileURLToPath(WEB_MODULE_URL), "utf8");
} catch {
  try {
    WEB_MODULE_SOURCE = readFileSync(
      resolve(process.cwd(), "src/lib/dashboard/clock-out-result.ts"),
      "utf8",
    );
  } catch {
    WEB_MODULE_SOURCE = null;
  }
}

/**
 * Extract the body of `export type <name> = ...;` by tracking brace depth, stopping at the
 * first top-level `;` (depth 0) — NOT the first `;` in the source. The union members inside
 * `ClockResolution` contain their OWN internal semicolons (e.g.
 * `{ kind: "CLOCKED_IN"; entry: TimeEntry; audit: { id: string } }`), so a naive
 * non-greedy `/=([\s\S]*?);/` stops after the first member's first field and silently
 * truncates the extraction — exactly the kind of check that "looks without seeing".
 */
function extractBalancedTypeBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start + marker.length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ";" && depth === 0) {
      return source.slice(start + marker.length, i);
    }
  }
  return "";
}

function extractServerKindNames(source: string): string[] {
  const body = extractBalancedTypeBody(source, "export type ClockResolution =");
  return [...body.matchAll(/kind:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
}

function extractWebMirrorKindNames(source: string): string[] {
  const body = extractBalancedTypeBody(source, "export type ClockResolutionKind =");
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

describe("clock-out-result parity — the web mirror can not silently go stale (D-04)", () => {
  // Anti-vacuity gate FIRST — if the server source can't be found, this MUST fail loudly, never
  // skip: a parity test that goes quietly green on a moved file is the fourth shape of a check
  // that sees nothing (project memory "checks that look without seeing").
  it("G0 (anti-vacuity gate): both source files are loaded, and the server union has exactly six kind names including DEBOUNCE_NOOP", () => {
    expect(
      SERVER_TYPES_SOURCE,
      "apps/api/src/services/clock/types.ts could not be found",
    ).not.toBeNull();
    expect(WEB_MODULE_SOURCE, "clock-out-result.ts could not be found").not.toBeNull();
    const serverNames = extractServerKindNames(SERVER_TYPES_SOURCE!);
    expect(serverNames).toHaveLength(6);
    expect(serverNames).toContain("DEBOUNCE_NOOP");
  });

  it("the web mirror's ClockResolutionKind names EXACTLY the server's ClockResolution['kind'] set — no hardcoded expectation on either side", () => {
    const serverNames = extractServerKindNames(SERVER_TYPES_SOURCE!);
    const webNames = extractWebMirrorKindNames(WEB_MODULE_SOURCE!);
    expect(new Set(webNames)).toEqual(new Set(serverNames));
    // Sanity: the extraction itself isn't vacuous on the web side either.
    expect(webNames.length).toBeGreaterThan(0);
  });
});

// ── describe C — source-level proof the dashboard page actually consumes the result ─────────
const PAGE_URL = new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url);
let PAGE_SOURCE: string | null = null;
try {
  PAGE_SOURCE = readFileSync(fileURLToPath(PAGE_URL), "utf8");
} catch {
  try {
    PAGE_SOURCE = readFileSync(
      resolve(process.cwd(), "src/routes/(app)/dashboard/+page.svelte"),
      "utf8",
    );
  } catch {
    PAGE_SOURCE = null;
  }
}

describe("dashboard +page.svelte — quelltext proof it reads the clock-out response (D-04, AK-1/AK-4)", () => {
  it("G0 (anti-vacuity gate): the page was loaded, is non-trivial, and contains handleClock", () => {
    expect(PAGE_SOURCE, "dashboard +page.svelte could not be found").not.toBeNull();
    expect(PAGE_SOURCE!.length).toBeGreaterThan(50_000);
    expect(PAGE_SOURCE).toContain("handleClock");
  });

  it("calls interpretClockOut()", () => {
    expect(PAGE_SOURCE).toContain("interpretClockOut(");
  });

  it("shows toasts.error(...) for a not-closed result inside handleClock", () => {
    const handleClockStart = PAGE_SOURCE!.indexOf("async function handleClock()");
    expect(handleClockStart).toBeGreaterThan(-1);
    const nextFunctionStart = PAGE_SOURCE!.indexOf("\n  async function ", handleClockStart + 1);
    const handleClockBody = PAGE_SOURCE!.slice(
      handleClockStart,
      nextFunctionStart === -1 ? handleClockStart + 4000 : nextFunctionStart,
    );
    expect(handleClockBody).toContain('"not-closed"');
    expect(handleClockBody).toContain("toasts.error(");
  });

  it("the old admission that the response is unread is gone", () => {
    expect(PAGE_SOURCE).not.toContain("We don't currently consume the");
  });

  it("no second, hand-written ClockOutResponse type remains on the page — imported from the module instead", () => {
    expect(PAGE_SOURCE).not.toMatch(/type ClockOutResponse = \{/);
    expect(PAGE_SOURCE).toMatch(/import\s+\{[^}]*interpretClockOut/);
  });
});
