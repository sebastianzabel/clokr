// Issue #878 — every save of PUT /settings/work sends only the fields its own section edits.
//
// Before the fix, the twelve sections of /admin/system spread a copy of the settings read at page
// load (`_gOtherFields`: the default hours, overtime, vacation and carry-over fields of
// /admin/vacation) plus the company fields `federalState`/`timezone` into every save, and the
// DATEV save of /admin/export wrote the whole configuration back. A change saved in the meantime
// (another tab, another person) was overwritten with the old value, without a hint.
//
// Source pin (route pages cannot be mounted here, see admin-system-save-wiring.test.ts): every
// `api.put("/settings/work", …)` call of the four admin pages that write the tenant settings is
// found, and its payload object must carry exactly the keys listed below and no spread. A new
// call fails until it is listed. The server half — a partial PUT keeps every field it does not
// name, and the audit lists only the changed ones — is proven in
// apps/api/src/__tests__/settings-own-fields-878.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRoute(page: string): string {
  const rel = `routes/(app)/admin/${page}/+page.svelte`;
  try {
    return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), `src/${rel}`), "utf8");
  }
}

interface Put {
  fn: string;
  keys: string[];
  spread: boolean;
}

/** Every PUT /settings/work of a page: the enclosing function and the payload's top-level keys. */
function settingsWorkPuts(source: string): Put[] {
  const puts: Put[] = [];
  const re = /api\.put(?:<[\s\S]*?>)?\(\s*"\/settings\/work",\s*\{/g;
  for (const m of source.matchAll(re)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    const body = source.slice(open + 1, close);
    // top-level keys only: strip nested braces/brackets/parens first
    let flat = body;
    for (let prev = ""; prev !== flat;) {
      prev = flat;
      flat = flat.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g, "");
    }
    flat = flat.replace(/\/\/.*$/gm, "");
    const keys = [...flat.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)].map((k) => k[1]);
    const before = source.slice(0, m.index);
    const fns = [...before.matchAll(/async function (\w+)/g)];
    puts.push({
      fn: fns.at(-1)?.[1] ?? "?",
      keys: [...new Set(keys)].sort(),
      spread: /\.\.\./.test(flat),
    });
  }
  return puts;
}

const EXPECTED: Record<string, Record<string, string[]>> = {
  system: {
    saveShiftHoursMode: ["shiftStoreHoursMode"],
    saveFederalState: ["federalState", "tenantName", "timezone"],
    toggleAutoBreak: ["autoBreakEnabled", "defaultBreakStart"],
    saveDefaultBreakStart: ["autoBreakEnabled", "defaultBreakStart"],
    saveBreakDefaults: ["defaultBreakOver6h", "defaultBreakOver9h"],
    toggleEnforceBreakConfirmation: ["enforceBreakConfirmation"],
    toggleBlockMonthCloseOnUnconfirmedBreak: ["blockMonthCloseOnUnconfirmedBreak"],
    saveAvailabilityEnabled: ["availabilityEnabled"],
    saveVocationalSchoolAutoCleanupShifts: ["vocationalSchoolAutoCleanupShifts"],
    saveCloseMonthWithGaps: ["closeMonthWithGapsAllowed"],
    saveRetroEntryWindowDays: ["retroEntryWindowDays"],
    saveBsSlots: [
      "bsSlotBlockWeekMinutes",
      "bsSlotFirstLongDayMinutes",
      "bsSlotSecondLongDayMinutes",
      "bsSlotShortDayMinutes",
    ],
    saveDefaultWorkDays: ["defaultWorkDays"],
    saveCoreDefaults: ["defaultCoreDays", "defaultCoreEnd", "defaultCoreStart"],
  },
  export: {
    saveDatev: [
      "datevBeraterNr",
      "datevKrankNr",
      "datevMandantenNr",
      "datevNormalstundenNr",
      "datevSonderurlaubNr",
      "datevUrlaubNr",
    ],
  },
  audit: {
    saveRetention: ["dataRetentionYears"],
  },
};

describe("Issue #878 — each section sends only its own fields", () => {
  for (const [page, expected] of Object.entries(EXPECTED)) {
    describe(`/admin/${page}`, () => {
      const puts = settingsWorkPuts(readRoute(page));

      it("every PUT /settings/work of the page is listed here (no unlisted save)", () => {
        expect(puts.length).toBeGreaterThan(0);
        expect(puts.map((p) => p.fn).sort()).toEqual(Object.keys(expected).sort());
      });

      for (const [fn, keys] of Object.entries(expected)) {
        it(`${fn} sends exactly ${keys.join(", ")} and no spread`, () => {
          const put = puts.find((p) => p.fn === fn);
          expect(put, `no PUT /settings/work in ${fn}`).toBeDefined();
          expect(put!.spread).toBe(false);
          expect(put!.keys).toEqual(keys);
        });
      }
    });
  }

  it("no page keeps a load-time copy of the settings", () => {
    for (const page of ["system", "export", "audit", "vacation"]) {
      expect(readRoute(page)).not.toContain("_gOtherFields");
    }
  });

  it("the system page sends no field of /admin/vacation and the company fields only from its own section", () => {
    const vacationOwned = [
      "defaultWeeklyHours",
      "defaultMondayHours",
      "overtimeThreshold",
      "allowOvertimePayout",
      "defaultVacationDays",
      "carryOverDeadlineDay",
      "carryOverDeadlineMonth",
    ];
    for (const put of settingsWorkPuts(readRoute("system"))) {
      expect(
        put.keys.filter((k) => vacationOwned.includes(k)),
        put.fn,
      ).toEqual([]);
      if (put.fn !== "saveFederalState") {
        expect(
          put.keys.filter((k) => ["federalState", "timezone", "tenantName"].includes(k)),
          put.fn,
        ).toEqual([]);
      }
    }
  });

  it("/admin/vacation sends one page-wide payload without a spread (its own fields, one save button)", () => {
    const puts = settingsWorkPuts(readRoute("vacation"));
    expect(puts.map((p) => p.fn)).toEqual(["saveGlobal"]);
    expect(puts[0].spread).toBe(false);
    for (const k of [
      "autoBreakEnabled",
      "defaultBreakStart",
      "federalState",
      "timezone",
      "datevUrlaubNr",
    ]) {
      expect(puts[0].keys).not.toContain(k);
    }
  });
});
