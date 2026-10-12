// Issue #83 (D-10/D-14) — the web's persona fixture equals the API's system-role permissions.
//
// apps/web/src/lib/nav/__tests__/fixtures/system-role-permissions.json feeds the persona matrix of
// the admin route map (who sees which admin page). It is generated from SYSTEM_ROLE_PERMISSIONS and
// must never drift. This pin lives at the repo root because `test:scripts` runs on every PR — an
// API-side test would be skipped on a web-only PR. DB-free.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_ROLE_PERMISSIONS } from "../../apps/api/src/contexts/platform/system-roles.ts";

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "apps",
  "web",
  "src",
  "lib",
  "nav",
  "__tests__",
  "fixtures",
  "system-role-permissions.json",
);
const byText = (a, b) => a.localeCompare(b);

describe("web persona fixture (Issue #83)", () => {
  it("has the API's system-role slots and, per slot, exactly the API's keys", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(Object.keys(fixture).sort(byText)).toEqual(
      Object.keys(SYSTEM_ROLE_PERMISSIONS).sort(byText),
    );
    for (const [slot, keys] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
      const api = [...keys].sort(byText);
      const web = [...fixture[slot]].sort(byText);
      const missing = api.filter((k) => !web.includes(k));
      const extra = web.filter((k) => !api.includes(k));
      expect({ slot, missing, extra }).toEqual({ slot, missing: [], extra: [] });
    }
  });
});
