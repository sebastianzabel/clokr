/**
 * Issue #835 (WR-10) — the demo reset (`packages/db/src/reset-demo.ts`) hard-deletes leave requests
 * and employees; `LeavePlanWish` references both with `onDelete: Restrict` and `LeavePlan` references
 * the tenant. Pinned from the source (the script runs against the demo database, never in a test):
 * every `leaveRequest.deleteMany` is preceded, inside its block, by a `leavePlanWish.deleteMany` over
 * the SAME person set, and the tenant's plans are deleted after the last wish delete.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const SOURCE = readFileSync(
  resolve(__dirname, "../../../../packages/db/src/reset-demo.ts"),
  "utf8",
);

/** Every call of `prisma.<delegate>.deleteMany(<args>)` with its offset and its argument text. */
function deletes(delegate: string): Array<{ at: number; args: string }> {
  const pattern = new RegExp(`prisma\\.${delegate}\\.deleteMany\\((\\{[^;]*?\\})\\);`, "g");
  return [...SOURCE.matchAll(pattern)].map((m) => ({ at: m.index ?? 0, args: m[1]! }));
}

describe("Issue #835 - reset-demo deletes plan wishes before what they reference", () => {
  const requestDeletes = deletes("leaveRequest");
  const wishDeletes = deletes("leavePlanWish");

  it("[vacuity gate] the script is read and has its three request-delete blocks", () => {
    expect(SOURCE.length).toBeGreaterThan(5_000);
    expect(requestDeletes.length).toBeGreaterThanOrEqual(3);
  });

  it("every leaveRequest.deleteMany follows a leavePlanWish.deleteMany over the same persons", () => {
    let blockStart = 0;
    for (const request of requestDeletes) {
      const wish = wishDeletes.find((w) => w.at >= blockStart && w.at < request.at);
      expect(
        wish,
        `no wish delete before the request delete at offset ${request.at}`,
      ).toBeDefined();
      expect(wish!.args).toBe(request.args);
      blockStart = request.at;
    }
  });

  it("the tenant's plans go after the last wish delete", () => {
    const plans = deletes("leavePlan");
    expect(plans.map((p) => p.args)).toEqual(["{ where: { tenantId: tenant.id } }"]);
    expect(plans[0]!.at).toBeGreaterThan(Math.max(...wishDeletes.map((w) => w.at)));
  });
});
