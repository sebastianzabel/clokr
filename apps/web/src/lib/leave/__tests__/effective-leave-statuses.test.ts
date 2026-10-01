// Issue #446 (D-01) — the web's display mirror of EFFECTIVE_LEAVE_STATUSES must never silently
// drift from the API's own definition. This test reads the API source file as TEXT (the web
// tree cannot import API code — `apps/web/Dockerfile`'s `test ! -e /app/packages/db` gate) and
// regex-extracts the quoted tuple members, so a change to the API constant that is not mirrored
// here fails the build instead of silently de-syncing calendar display from saldo truth.
//
// Source-read pattern copied from dashboard-leave-type-code.test.ts (Phase 205): try the
// import.meta.url-relative path first, fall back to a process.cwd()-relative path so this also
// works when vitest's cwd differs from the file's own directory.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { EFFECTIVE_LEAVE_STATUSES, isEffectiveLeaveStatus } from "../effective-leave-statuses";

function readApiFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const API_SOURCE = readApiFile(
  "../../../../../api/src/contexts/absence/effective-leave-statuses.ts",
  "../api/src/contexts/absence/effective-leave-statuses.ts",
);

describe("EFFECTIVE_LEAVE_STATUSES mirrors the API constant (Issue #446 D-01)", () => {
  it("[vacuity gate] the API source is actually loaded and declares the tuple", () => {
    // A wrong or moved path, or an empty read, must fail this test loudly rather than let the
    // comparison below pass vacuously against an empty/garbage string.
    expect(API_SOURCE.length).toBeGreaterThan(0);
    expect(API_SOURCE).toContain("EFFECTIVE_LEAVE_STATUSES");
  });

  it("the regex finds a non-empty tuple in the API source", () => {
    const match = API_SOURCE.match(/EFFECTIVE_LEAVE_STATUSES\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    const members = match![1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    expect(members.length).toBeGreaterThan(0);
  });

  it("the web tuple equals the API tuple, in the same order", () => {
    const match = API_SOURCE.match(/EFFECTIVE_LEAVE_STATUSES\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    const apiMembers = match![1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    expect(apiMembers.length).toBeGreaterThan(0);
    expect([...EFFECTIVE_LEAVE_STATUSES]).toEqual(apiMembers);
  });
});

describe("isEffectiveLeaveStatus", () => {
  it("is true for APPROVED and CANCELLATION_REQUESTED", () => {
    expect(isEffectiveLeaveStatus("APPROVED")).toBe(true);
    expect(isEffectiveLeaveStatus("CANCELLATION_REQUESTED")).toBe(true);
  });

  it("is false for PENDING, REJECTED, CANCELLED and an unknown string", () => {
    expect(isEffectiveLeaveStatus("PENDING")).toBe(false);
    expect(isEffectiveLeaveStatus("REJECTED")).toBe(false);
    expect(isEffectiveLeaveStatus("CANCELLED")).toBe(false);
    expect(isEffectiveLeaveStatus("NOT_A_STATUS")).toBe(false);
  });
});
