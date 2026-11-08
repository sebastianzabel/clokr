// Issue #840 G-3, G-8 - source pins of the inbox chrome: the header follows the leave pages'
// PageHead pattern and the type chip of a leave row is the one LeaveTypeChip (colour from the
// mapping, never the brand colour). The #558 constraints of this exempt page are re-asserted.
//
// Source-read for the same reason as `inbox-section9-840.test.ts`: the page imports `$app/*`,
// mounts several dialogs and fires its requests on mount. The chip itself is proven mounted in
// `lib/components/leave/__tests__/LeaveTypeChip.test.ts`, the colours in the browser by
// `apps/e2e/tests/leave-area-840.spec.ts` (test 7).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const INBOX = readRouteFile(
  "../routes/(app)/inbox/+page.svelte",
  "src/routes/(app)/inbox/+page.svelte",
);

describe("Issue #840 G-8 / G-3 - the inbox chrome", () => {
  it("[vacuity gate] the page source is loaded and is the inbox", () => {
    expect(INBOX.length).toBeGreaterThan(20_000);
    expect(INBOX).toContain("<ApprovalRow");
  });

  it("[G-8] the header is the leave pages' PageHead: eyebrow „Team“, plain title „Inbox“", () => {
    expect(INBOX).toContain('<PageHead eyebrow="Team" title="Inbox" />');
    expect(INBOX).not.toContain('eyebrow="Manager"');
    expect(INBOX).not.toMatch(/<PageHead[^>]*accent=/);
  });

  it("[G-3] the type chip of a leave row is LeaveTypeChip, dashed for a PENDING request", () => {
    expect(INBOX).toContain(
      'import LeaveTypeChip from "$lib/components/leave/LeaveTypeChip.svelte"',
    );
    expect(INBOX).toContain("<LeaveTypeChip");
    expect(INBOX).toContain("code={req.typeCode}");
    expect(INBOX).toContain("label={typeName(req.typeCode)}");
    expect(INBOX).toContain('requested={req.status === "PENDING"}');
    // No type is drawn in the brand colour any more.
    expect(INBOX).not.toMatch(/chip-brand">\{typeName\(/);
  });

  it("[#558] the inbox stays an unfiltered work queue: no salon filter identifier, not even in a comment", () => {
    expect(INBOX).not.toContain("salonPageFilter");
    expect(INBOX).not.toContain("withSalonId(");
    expect(INBOX).not.toContain("SalonScopeLabel");
  });
});
