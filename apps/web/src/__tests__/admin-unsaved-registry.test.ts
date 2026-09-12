// Phase 109 Plan 15 (Issue #35, D-15, gap closure) — cross-page ledger test for D-11/D-12.
//
// This is the D-11/D-12 counterpart to `lint:save-pattern` (plan 109-08). Phase 109 built an
// admin-wide-capable unsaved marker and navigation guard but wired it page by page, and nothing
// noticed that seven pages were missing — `109-VERIFICATION.md` found that by hand. This test
// walks the admin route DIRECTORY, not a file list, so the same omission cannot recur silently.
// It is a test rather than a lint script because the judgement it encodes ("does this page hold
// unsaved state?") is a ledger of decisions, not a syntactic rule.

import { readdirSync, readFileSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { describe, it, expect } from "vitest";

const ADMIN_ROOT = resolve(process.cwd(), "src/routes/(app)/admin");

function adminPages(dir = ADMIN_ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) adminPages(p, out);
    else if (e.name === "+page.svelte") out.push(p);
  }
  return out;
}

/** Path relative to ADMIN_ROOT, using forward slashes — matches the ledger's keys below. */
function relKey(absPath: string): string {
  return relative(ADMIN_ROOT, absPath).split(sep).join("/");
}

// ── The ledger ──────────────────────────────────────────────────────────────────────────────
// Pages that hold form state a user can lose. Each registers exactly one id.
const REGISTERED: Record<string, string> = {
  "system/+page.svelte": "admin-system",
  "employees/[id]/+page.svelte": "admin-employee-detail",
  "vacation/+page.svelte": "admin-vacation",
  "phorest/+page.svelte": "admin-phorest",
  "shifts/+page.svelte": "admin-shifts",
  "shutdowns/[id]/+page.svelte": "admin-shutdown-detail",
  "export/+page.svelte": "admin-export",
  "audit/+page.svelte": "admin-audit",
  "availability/[employeeId]/+page.svelte": "admin-availability-detail",
};

// Pages that CANNOT hold unsaved state, with the reason. A marker that can never appear is
// noise, and a guard on an action page teaches the operator to click through the dialog.
const EXCLUDED: Record<string, string> = {
  "employees/+page.svelte":
    "the only editable form is the invite <Modal> with its own Abbrechen; a modal draft is a modal-dismissal concern that beforeNavigate never sees",
  "shutdowns/+page.svelte": "same — the only form is the create <Modal>",
  "month-close/+page.svelte":
    "selectedYear/statusFilter are filters; unlockReason/gapAcknowledged are one-shot confirmations inside modals; the writes are operations, not form state",
  "import/+page.svelte":
    "an operation (paste CSV -> POST /imports/:mode), nothing is held as a setting",
  "integrations/+page.svelte":
    "no update endpoint exists; the single write creates a NEW API key and the two inputs clear afterwards",
  "themes/+page.svelte": "no write path and no bound form state",
  "availability/+page.svelte": "list view — no write path",
  "audit/[id]/+page.svelte": "detail view — no write path",
  "special-leave/+page.svelte": "redirect stub — no UI, no form state",
  "special-leave/[id]/+page.svelte": "redirect stub — no UI, no form state",
  "+page.svelte": "redirect stub — no UI, no form state",
};

function readAdminFile(relPath: string): string {
  return readFileSync(join(ADMIN_ROOT, relPath), "utf8");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Two allowed forms ship in this codebase for gating a `markUnsaved` registration on the
 * WR-01 readiness flag (109-REVIEW-FIX.md): either the `markUnsaved` call itself literally
 * ANDs `snapshotsReady &&` into the dirty argument (eight of nine pages), or the argument
 * passed to `markUnsaved` is a `$derived` binding whose OWN definition already ANDs in
 * `snapshotsReady` (`admin/availability/[employeeId]`, 109-14) — reading that derived value
 * directly is equivalent, and repeating `snapshotsReady &&` there would be redundant, not
 * safer. Either form closes the same hole: a load that never reaches its baseline can never
 * arm the guard.
 */
function registrationIsGated(src: string, id: string): boolean {
  const callMatch = src.match(new RegExp(`markUnsaved\\("${escapeRegExp(id)}",\\s*([^)]+)\\)`));
  if (!callMatch) return false;
  const arg = callMatch[1].trim();
  if (arg.includes("snapshotsReady")) return true;

  // The argument might instead be a plain identifier (e.g. `dirty`) whose OWN `$derived`
  // definition carries the gate.
  const identMatch = arg.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (!identMatch) return false;
  const derivedRe = new RegExp(
    `(?:const|let)\\s+${escapeRegExp(arg)}\\s*=\\s*\\$derived\\(([\\s\\S]*?)\\);`,
  );
  const derivedMatch = src.match(derivedRe);
  return !!derivedMatch && derivedMatch[1].includes("snapshotsReady");
}

/** Every distinct id a page's source registers via `markUnsaved("<id>", ...)`. */
function registeredIdsIn(src: string): string[] {
  const ids = new Set<string>();
  for (const m of src.matchAll(/markUnsaved\("([^"]+)"/g)) ids.add(m[1]);
  return [...ids];
}

const ALL_PAGES = adminPages();
const ALL_PAGE_KEYS = ALL_PAGES.map(relKey);

describe("every admin page is accounted for", () => {
  it("no admin page is missing from the ledger", () => {
    const missing = ALL_PAGE_KEYS.filter((k) => !(k in REGISTERED) && !(k in EXCLUDED));
    expect(
      missing,
      `The following admin pages are in neither REGISTERED nor EXCLUDED: ${missing.join(", ")}. ` +
        `add it to REGISTERED (and wire D-11/D-12) or to EXCLUDED with a reason`,
    ).toEqual([]);
  });

  it("no ledger entry points at a file that no longer exists", () => {
    const ledgerKeys = [...Object.keys(REGISTERED), ...Object.keys(EXCLUDED)];
    const stale = ledgerKeys.filter((k) => !ALL_PAGE_KEYS.includes(k));
    expect(stale, `Ledger entries with no matching +page.svelte: ${stale.join(", ")}`).toEqual([]);
  });

  it("no page is in both lists", () => {
    const overlap = Object.keys(REGISTERED).filter((k) => k in EXCLUDED);
    expect(overlap).toEqual([]);
  });
});

describe("registered pages carry the full idiom", () => {
  const entries = Object.entries(REGISTERED);

  it.each(entries)("%s registers markUnsaved(%s, ...)", (relPath, id) => {
    const src = readAdminFile(relPath);
    expect(src).toContain(`markUnsaved("${id}"`);
  });

  it.each(entries)("%s de-registers %s on cleanup", (relPath, id) => {
    const src = readAdminFile(relPath);
    expect(src).toContain(`return () => markUnsaved("${id}", false)`);
  });

  it.each(entries)("%s gates its registration of %s on snapshotsReady", (relPath, id) => {
    const src = readAdminFile(relPath);
    expect(registrationIsGated(src, id)).toBe(true);
  });
});

describe("registry ids are unique", () => {
  it("no id is registered by two pages", () => {
    // markUnsaved keeps a flat list of ids — a duplicate id means one page's `$effect`
    // cleanup removes the OTHER page's entry, and the guard then stays silent on a page
    // with unsaved changes (T-109-64). Scan EVERY admin page, not just REGISTERED, so a
    // newly-added collision is caught even before someone updates the ledger.
    const idToFiles = new Map<string, string[]>();
    for (const abs of ALL_PAGES) {
      const key = relKey(abs);
      const src = readFileSync(abs, "utf8");
      for (const id of registeredIdsIn(src)) {
        idToFiles.set(id, [...(idToFiles.get(id) ?? []), key]);
      }
    }
    const collisions = [...idToFiles.entries()].filter(([, files]) => files.length > 1);
    expect(
      collisions,
      `Ids registered by more than one page: ${collisions
        .map(([id, files]) => `"${id}" in [${files.join(", ")}]`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("the ledger ids match the ids actually used", () => {
    for (const [relPath, ledgerId] of Object.entries(REGISTERED)) {
      const src = readAdminFile(relPath);
      const ids = registeredIdsIn(src);
      expect(ids, `${relPath} should register exactly one id`).toEqual([ledgerId]);
    }
  });
});

describe("excluded pages register nothing", () => {
  it.each(Object.entries(EXCLUDED))("%s contains no markUnsaved(", (relPath) => {
    const src = readAdminFile(relPath);
    expect(src).not.toContain("markUnsaved(");
  });

  it("every exclusion carries a non-empty reason", () => {
    for (const [relPath, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${relPath}'s exclusion reason is too short`).toBeGreaterThanOrEqual(
        20,
      );
    }
  });
});

describe("the documented rule names this gate", () => {
  it("docs/ADMIN_STRUCTURE.md names admin-unsaved-registry", () => {
    const docs = readFileSync(resolve(process.cwd(), "..", "..", "docs/ADMIN_STRUCTURE.md"), {
      encoding: "utf8",
    });
    expect(docs).toContain("admin-unsaved-registry");
  });
});
