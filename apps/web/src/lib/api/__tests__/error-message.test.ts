// The API error shape is `{ error, message?, details? }` (apps/api/src/app.ts): `error` is the
// CATEGORY, `message` the specific reason. ApiError used to carry only the category, so every
// validation failure in the app read as the bare word "Validierungsfehler" — no field, no clue.
//
// These tests pin that the specific reason reaches ApiError.message, and that a response which
// carries only a category still degrades to it rather than to the generic fallback.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorMessage } from "../error-message";

function clientSource(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../client.ts", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/lib/api/client.ts"), "utf8");
  }
}

describe("ApiError message — the specific reason reaches the user", () => {
  it("control: the extracted function is the real one and is callable", () => {
    // Without this the assertions below could all be passing against a helper that no caller
    // uses — the point is that BOTH ApiError construction sites actually route through it.
    expect(typeof errorMessage).toBe("function");
    const src = clientSource();
    // Four, not two: client.ts has two request functions (JSON and blob), each with a 401 path
    // and a general non-ok path. Pinning the exact count is what makes a NEW, unrouted
    // ApiError site fail here instead of silently keeping the old bare-category behaviour.
    expect(
      src.match(/errorMessage\(data,/g) ?? [],
      "not every ApiError construction site routes through errorMessage()",
    ).toHaveLength(4);
    expect(src, "an ApiError still takes data.error directly").not.toMatch(
      /new ApiError\([^)]*\)\?\.error/,
    );
  });

  it("a ZodError response names the failing field, not just the category", () => {
    const msg = errorMessage(
      {
        error: "Validierungsfehler",
        message: "holidayRulesValidFromYear: Expected number, received null",
        details: [],
      },
      "Fehler",
    );
    expect(msg).toContain("holidayRulesValidFromYear");
    expect(msg, "the bare category alone is what made this class of failure undebuggable").not.toBe(
      "Validierungsfehler",
    );
  });

  it("keeps the category alongside the detail", () => {
    const msg = errorMessage({ error: "Validierungsfehler", message: "feld: kaputt" }, "Fehler");
    expect(msg).toBe("Validierungsfehler: feld: kaputt");
  });

  it("a response with only a category still shows it", () => {
    expect(errorMessage({ error: "Nicht gefunden" }, "Fehler")).toBe("Nicht gefunden");
  });

  it("does not duplicate when category and detail are identical", () => {
    expect(errorMessage({ error: "Konflikt", message: "Konflikt" }, "Fehler")).toBe("Konflikt");
  });

  it("falls back when the body carries neither, and ignores blank strings", () => {
    expect(errorMessage({}, "Fehler")).toBe("Fehler");
    expect(errorMessage(null, "Fehler")).toBe("Fehler");
    expect(errorMessage({ error: "   ", message: "   " }, "Fehler")).toBe("Fehler");
  });
});
