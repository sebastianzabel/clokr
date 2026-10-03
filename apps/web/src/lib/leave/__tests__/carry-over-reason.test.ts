// Issue #451 / #445 addendum (D-09) — pure-function coverage for the admin Urlaub tab's
// carry-over reason field. Same convention as
// apps/web/src/lib/leave/__tests__/storno.test.ts: plain function tests, no component mount,
// because carry-over-reason.ts is a pure, dependency-free module by design (no svelte/store/
// $api import — see the module header).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import {
  CARRY_OVER_REASON_OPTIONS,
  carryOverReasonLabel,
  carryOverReasonPatch,
  carryOverReasonHint,
} from "../carry-over-reason";

describe("CARRY_OVER_REASON_OPTIONS", () => {
  it("lists the labels in order Krankheit, Mutterschutz, Elternzeit, Sonstiges", () => {
    expect(CARRY_OVER_REASON_OPTIONS.map((o) => o.label)).toEqual([
      "Krankheit",
      "Mutterschutz",
      "Elternzeit",
      "Sonstiges",
    ]);
  });

  it("lists the matching values in the same order", () => {
    expect(CARRY_OVER_REASON_OPTIONS.map((o) => o.value)).toEqual([
      "ILLNESS",
      "MATERNITY",
      "PARENTAL_LEAVE",
      "OTHER",
    ]);
  });
});

describe("carryOverReasonPatch — change-only patch builder (#445 D-16 semantics)", () => {
  it("sends nothing when neither reason nor note changed", () => {
    expect(carryOverReasonPatch({ reason: null, note: null }, { reason: null, note: "" })).toEqual(
      {},
    );
  });

  it("sends only carryOverReason when the reason changed from null", () => {
    expect(
      carryOverReasonPatch({ reason: null, note: null }, { reason: "ILLNESS", note: "" }),
    ).toEqual({ carryOverReason: "ILLNESS" });
  });

  it("sends only the trimmed carryOverNote when only the note changed", () => {
    expect(
      carryOverReasonPatch({ reason: "OTHER", note: "x" }, { reason: "OTHER", note: " y " }),
    ).toEqual({ carryOverNote: "y" });
  });

  it("sends an explicit null carryOverReason when the reason was cleared", () => {
    expect(
      carryOverReasonPatch({ reason: "ILLNESS", note: null }, { reason: null, note: "" }),
    ).toEqual({ carryOverReason: null });
  });
});

describe("carryOverReasonHint — German hints (Issue #451 D-09)", () => {
  it('requires a note for "Sonstiges"', () => {
    expect(carryOverReasonHint("OTHER", "", "2027-03-31")).toBe(
      "Bei „Sonstiges“ ist eine Notiz zum Übertrag erforderlich.",
    );
  });

  it("requires a Verfallsdatum for every non-ILLNESS reason", () => {
    expect(carryOverReasonHint("MATERNITY", "x", "")).toBe(
      "Für diesen Übertragsgrund ist ein Verfallsdatum erforderlich.",
    );
  });

  it("explains the ILLNESS default when no date is given", () => {
    expect(carryOverReasonHint("ILLNESS", "", "")).toBe(
      "Ohne Datum gilt der 31.03. des Folgejahres (15 Monate, EuGH C-214/10).",
    );
  });

  it("returns null when no reason is selected", () => {
    expect(carryOverReasonHint(null, "", "")).toBeNull();
  });
});

describe("carryOverReasonLabel", () => {
  it("shows the legacy stored value as a read-only Altwert label", () => {
    expect(carryOverReasonLabel("OPERATIONAL")).toBe("Betriebliche Gründe (Altwert)");
  });

  it("returns null for null/undefined", () => {
    expect(carryOverReasonLabel(null)).toBeNull();
    expect(carryOverReasonLabel(undefined)).toBeNull();
  });

  it("labels every documented reason", () => {
    expect(carryOverReasonLabel("ILLNESS")).toBe("Krankheit");
    expect(carryOverReasonLabel("MATERNITY")).toBe("Mutterschutz");
    expect(carryOverReasonLabel("PARENTAL_LEAVE")).toBe("Elternzeit");
    expect(carryOverReasonLabel("OTHER")).toBe("Sonstiges");
  });
});

// Mirror pin (Task 2): the web options must list exactly the values the API enum accepts — a
// drift on either side is a silent data-entry gap (a reason the UI cannot send, or one it sends
// that the server never created). Read via readFileSync with the same cwd fallback the route
// pins use, so this does not depend on an import across the apps/api / apps/web boundary.
function readApiFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

describe("mirror pin — CARRY_OVER_REASON_OPTIONS values match the API's CARRY_OVER_REASONS enum", () => {
  it("parses apps/api/src/contexts/absence/illness-carryover-guard.ts and compares the literal", () => {
    const source = readApiFile(
      "../../../../../../api/src/contexts/absence/illness-carryover-guard.ts",
      "../api/src/contexts/absence/illness-carryover-guard.ts",
    );
    const match = source.match(/CARRY_OVER_REASONS\s*=\s*\[([^\]]+)\]/);
    expect(
      match,
      "CARRY_OVER_REASONS literal not found in illness-carryover-guard.ts",
    ).not.toBeNull();
    const apiValues = match![1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    expect(CARRY_OVER_REASON_OPTIONS.map((o) => o.value)).toEqual(apiValues);
  });
});
