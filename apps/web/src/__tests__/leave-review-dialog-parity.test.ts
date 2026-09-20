// Issue #255 — "Attest-Feld fehlt im Inbox-Prüfdialog; BUrlG-§-7-Hinweis erscheint auf jeder
// Antragsart". Today, `/team/leave` and `/inbox` each carry a FULL, independent copy of the
// absence review dialog (own markup, own `submitReview()`), and the two copies have drifted:
//
//   Finding 1 — `/inbox`'s copy never gained the attest ("Attest liegt vor") capture that #201
//   added to `/team/leave`'s copy. `apps/web/src/routes/(app)/inbox/+page.svelte` has zero
//   case-insensitive occurrences of "attest" (measured 2026-09-20).
//
//   Finding 2 — `/inbox`'s copy renders the BUrlG §7 carry-over/forfeiture notice UNCONDITIONALLY,
//   so it also appears on sick leave, parental leave, and every other request type, where the text
//   is simply wrong.
//
// The owner's decision on the issue (2026-09-18) is explicit: the fix is ONE shared dialog
// (`apps/web/src/lib/components/leave/LeaveReviewDialog.svelte`), not two dialogs kept in lockstep
// by convention or by a parity-checking gate. This file is that decision's acceptance test,
// written BEFORE the shared component exists (255-CONTEXT.md D-13): every assertion below is
// either observed RED against today's two-copy tree, or — where a direction cannot be red against
// today's tree by construction — proven by a recorded mutation instead of an unobserved green
// (Task 2 of this plan).
//
// WHY TREE-WIDE, NOT PER-PAGE (255-CONTEXT.md D-12 — the load-bearing reason for this file's
// shape): a naive assertion written against `/inbox`'s OWN markup ("inbox contains no 'attest'")
// would go silently, vacuously true the moment Plan 03/04 move that markup into the shared
// component — not because the ticket got fixed, but because there is nothing left on the page to
// find. That is the exact failure class this project has already hit twice: the Phase 96
// discriminator-swap incident and the #203/#235/#240/#245 vacuous-guard incidents. Every assertion
// here is therefore phrased against the TREE (a corpus of sources, or a full apps/web/src walk),
// so the SAME line keeps measuring the same thing across the refactor: before it, the property
// holds because one page's own markup satisfies it; after it, because the shared component both
// pages now delegate to satisfies it.
//
// Scope (255-01-PLAN.md <scope_boundary>): this file is the ENTIRE deliverable of Plan 01. No
// production file is touched. Do not run this file to green — that is Task 2's job, and a green
// run here would mean either the refactor already happened (it has not) or an assertion does not
// assert what it claims to.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ── Corpus loading ──────────────────────────────────────────────────────────
//
// Same dual-cwd resilience idiom as apps/web/src/__tests__/leave-overlap-fallback.test.ts:21-26 —
// it covers both "vitest resolves relative to this file" and "vitest's cwd is apps/web" (the shape
// `pnpm --filter @clokr/web exec vitest run ...` actually runs in).
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

// Same idiom, but tolerant of the file not existing at all — LeaveReviewDialog.svelte is only
// created in Plan 02. Returns null rather than throwing so this file is loadable both before and
// after that plan lands.
function readOptionalFile(relativeFromHere: string, relativeFromCwd: string): string | null {
  try {
    const fromHere = fileURLToPath(new URL(relativeFromHere, import.meta.url));
    if (existsSync(fromHere)) return readFileSync(fromHere, "utf8");
  } catch {
    // import.meta.url resolution itself failed — fall through to the cwd-based path below.
  }
  const fromCwd = resolve(process.cwd(), relativeFromCwd);
  return existsSync(fromCwd) ? readFileSync(fromCwd, "utf8") : null;
}

const INBOX_PAGE = readRouteFile(
  "../routes/(app)/inbox/+page.svelte",
  "src/routes/(app)/inbox/+page.svelte",
);
const TEAM_LEAVE_PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);
// Optional: does not exist until Plan 02. `COMPONENT` stays null until then, and every test below
// is written so it means the same thing in both states (see D-12 note above).
const COMPONENT: string | null = readOptionalFile(
  "../lib/components/leave/LeaveReviewDialog.svelte",
  "src/lib/components/leave/LeaveReviewDialog.svelte",
);

// The corpus this whole file measures: both review-dialog route files, plus the shared component
// once it exists. "Tree-wide" for Test 1, Test 2 and Test 6 means "summed/checked across this
// array", not "summed across the entire repo" — Test 3, Test 4 and Test 5 additionally walk the
// full apps/web/src tree and are noted as such where they do.
const REVIEW_SOURCES: Array<[label: string, src: string]> = [
  ["inbox/+page.svelte", INBOX_PAGE],
  ["team/leave/+page.svelte", TEAM_LEAVE_PAGE],
];
if (COMPONENT !== null) {
  REVIEW_SOURCES.push(["LeaveReviewDialog.svelte", COMPONENT]);
}

/** Literal substring count — not RegExp. `submitReview(` contains a metacharacter. */
function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

// Constants shared by more than one test group below — declared once, at module scope, so every
// test measures the identical literal string.
const REVIEW_DIALOG_MARKER = "Kolleg:innen im gleichen Zeitraum";
const SELF_APPROVAL_SENTENCE = "Eigene Anträge können nicht selbst genehmigt werden.";

// ── Full apps/web/src tree walk (Test 3, Test 4, Test 5) ───────────────────
//
// Pattern mirrored from apps/api/src/__tests__/absence-vocabulary-guard.test.ts:280-310 (G6): walk
// once, prove the walked set is non-empty BEFORE drawing any conclusion from it, so a moved or
// emptied directory turns the gate red instead of reporting success having found nothing
// (CLAUDE.md § Anti-vacuity gate).
//
// `__tests__` is excluded deliberately, not incidentally: this file's own module-scope constants
// above (REVIEW_DIALOG_MARKER, SELF_APPROVAL_SENTENCE) are the literal strings Test 3/4/5 search
// for, and apps/web/src/__tests__/leave-overlap-fallback.test.ts already carries
// REVIEW_DIALOG_MARKER as a fixture string of its own (its Test 0 blocks). Without the exclusion,
// this walk would find test files that merely QUOTE the target strings and miscount them as a
// second production carrier.
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "__tests__",
  ".svelte-kit",
  "dist",
  "build",
  "generated",
]);
const SCAN_EXTS = new Set([".ts", ".svelte"]);

interface WalkedFile {
  /** Relative to apps/web/src, forward-slash separated, e.g. "routes/(app)/inbox/+page.svelte". */
  relPath: string;
  content: string;
}

function resolveWebSrcRoot(): string {
  try {
    // Directory containing this file's parent, i.e. apps/web/src — mirrors the two-argument
    // readRouteFile idiom above, adapted for a directory instead of a single file.
    const candidate = fileURLToPath(new URL("..", import.meta.url));
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall through
  }
  // `pnpm --filter @clokr/web exec vitest run ...` sets cwd to apps/web.
  return resolve(process.cwd(), "src");
}

function collectSrcFiles(rootDir: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  function walk(absDir: string) {
    for (const entry of readdirSync(absDir)) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const abs = join(absDir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (SCAN_EXTS.has(extname(entry))) {
        out.push({
          relPath: relative(rootDir, abs).split("\\").join("/"),
          content: readFileSync(abs, "utf8"),
        });
      }
    }
  }
  walk(rootDir);
  return out;
}

const WEB_SRC_ROOT = resolveWebSrcRoot();
// Computed once at module load — Test 3 and Test 4 explicitly share this SAME walk result
// ("denselben Baumlauf", 255-01-PLAN.md Task 1), and Test 5 reuses it too.
const SRC_FILES = collectSrcFiles(WEB_SRC_ROOT);

// ── Test 0 — anti-vacuity gate ──────────────────────────────────────────────
//
// Runs before every content claim below. Without these four checks, every test in this file could
// be green because nothing was ever actually read — a moved file, a typo'd path, or an emptied
// source would look identical from the outside to "the ticket's findings are already fixed".
describe("Test 0 — the corpus was actually read (anti-vacuity gate)", () => {
  it("INBOX_PAGE and TEAM_LEAVE_PAGE are not empty stand-ins for a failed read", () => {
    // Thresholds are deliberately far below today's measured sizes (38_252 / 97_323 bytes as of
    // 2026-09-20, see 255-01-PLAN.md <interfaces>) because BOTH files shrink by design over this
    // phase as their dialog markup moves into the shared component. A threshold close to today's
    // size would turn this anti-vacuity check into a time bomb that fails the moment Plan 03/04
    // land, for a reason that has nothing to do with a broken read.
    expect(INBOX_PAGE.length).toBeGreaterThan(20_000);
    expect(TEAM_LEAVE_PAGE.length).toBeGreaterThan(60_000);
  });

  it("the review-dialog corpus has at least the two mandatory route sources", () => {
    expect(REVIEW_SOURCES.length).toBeGreaterThanOrEqual(2);
  });

  it("at least one corpus source carries the review-dialog marker, and at least one carries the self-approval sentence", () => {
    expect(REVIEW_SOURCES.some(([, src]) => src.includes(REVIEW_DIALOG_MARKER))).toBe(true);
    expect(REVIEW_SOURCES.some(([, src]) => src.includes(SELF_APPROVAL_SENTENCE))).toBe(true);
  });
});

// ── Test 1 — AC-2: whoever shows the review dialog also offers attest capture ──
describe("Test 1 — AC-2: rendering the review dialog implies offering attest capture", () => {
  function rendersAbsenceReviewDialog(src: string): boolean {
    return src.includes("<LeaveReviewDialog") || src.includes(REVIEW_DIALOG_MARKER);
  }
  function offersAttestCapture(src: string): boolean {
    return src.includes("<LeaveReviewDialog") || src.includes("AttestFields");
  }

  // Deliberately per-page (it.each), never summed across the pair: a single OR across both pages
  // would stay true even if only ONE of the two ever offered attest capture, hiding exactly the
  // asymmetry Finding 1 reports.
  const PAGES: Array<[label: string, src: string]> = [
    ["inbox/+page.svelte", INBOX_PAGE],
    ["team/leave/+page.svelte", TEAM_LEAVE_PAGE],
  ];

  it.each(PAGES)(
    "%s: rendering the review dialog implies offering attest capture",
    (_name, src) => {
      // Both helper functions check "<LeaveReviewDialog" FIRST. That is what lets this single line
      // measure both worlds: before the refactor, each page satisfies the implication (or not) via
      // its own markup; after it, both helpers collapse onto the same "delegates to the shared
      // component" signal for both pages at once — by design, not by accident (see D-12 note above).
      if (rendersAbsenceReviewDialog(src)) {
        expect(offersAttestCapture(src)).toBe(true);
      }
    },
  );
});

// ── Test 2 — AC-3: the §7 notice is unique tree-wide and gated on a named condition ──
describe("Test 2 — AC-3: the §7 notice is unique in the corpus and bound to a named condition", () => {
  const SECTION7_SENTENCE = "Urlaubsantrag muss zeitnah entschieden werden";
  const SECTION7_GATE = "{#if showsBurlgSection7Notice(";

  it("the sentence occurs exactly once across the review-dialog corpus", () => {
    // Pinned to this exact, longer substring — never to the shorter paragraph reference alone,
    // which is ambiguous tree-wide: admin/vacation/+page.svelte:183 and
    // reports/+page.svelte:223,1256,1774 also carry it (Phase-44 Verfall-Warnungen, an unrelated
    // feature). Pinning the shorter, ambiguous spelling would make this test measure pages outside
    // this phase — see 255-01-PLAN.md <interfaces> and this file's own acceptance criteria, which
    // forbid that shorter spelling from appearing in this file at all.
    const total = REVIEW_SOURCES.reduce(
      (sum, [, src]) => sum + countOccurrences(src, SECTION7_SENTENCE),
      0,
    );
    expect(total).toBe(1);
  });

  it("the sentence is bound to a named showsBurlgSection7Notice(...) condition close by", () => {
    const carrier = REVIEW_SOURCES.find(([, src]) => src.includes(SECTION7_SENTENCE));
    expect(
      carrier,
      "no source in the review-dialog corpus carries the §7 sentence at all",
    ).toBeDefined();
    const [, src] = carrier!;
    const idx = src.indexOf(SECTION7_SENTENCE);
    const gate = src.lastIndexOf(SECTION7_GATE, idx);
    // RED today, and for the right reason: the notice renders unconditionally (Finding 2), so no
    // `{#if showsBurlgSection7Notice(...}` precedes it at all.
    expect(gate).toBeGreaterThan(-1);
    expect(idx - gate).toBeLessThan(800);
  });

  it("the gate never keys on a display string or label (D-08, CLAUDE.md § Context Boundaries)", () => {
    // If `gate` is -1 (true today, before Plan 02 exists), `.slice(-1, idx)` resolves to at most
    // the single character immediately before idx and is empty for all practical purposes here —
    // harmless, and NOT where today's red comes from (that is the `gate > -1` assertion above).
    // Once the gate exists, this becomes the real guard against a second, string-keyed condition
    // creeping in next to the named one ("Never use a new display string as a control value").
    const carrier = REVIEW_SOURCES.find(([, src]) => src.includes(SECTION7_SENTENCE));
    const [, src] = carrier!;
    const idx = src.indexOf(SECTION7_SENTENCE);
    const gate = src.lastIndexOf(SECTION7_GATE, idx);
    const between = src.slice(gate, idx);
    expect(between).not.toContain(".name");
    expect(between).not.toContain("Label");
  });
});

// ── Test 3 — AC-4 / D-18: the self-approval sentence exists in exactly two files, tree-wide ──
describe("Test 3 — AC-4 / D-18: the self-approval sentence exists in exactly two files, tree-wide", () => {
  it("[anti-vacuity] the apps/web/src tree walk actually found files", () => {
    expect(
      SRC_FILES.length,
      "walked zero .ts/.svelte files under apps/web/src — the tree walk itself is broken; every " +
        "assertion below would vacuously pass against an empty set",
    ).toBeGreaterThan(0);
  });

  it("today: 3 occurrences across 2 files — not yet the target 2 across the target 2 files", () => {
    const carriers = SRC_FILES.filter((f) => f.content.includes(SELF_APPROVAL_SENTENCE));
    const totalOccurrences = carriers.reduce(
      (sum, f) => sum + countOccurrences(f.content, SELF_APPROVAL_SENTENCE),
      0,
    );
    // Today: 3 occurrences in 2 files — inbox/+page.svelte carries it TWICE (the retro dialog,
    // which this phase does not touch, plus the absence review dialog, which moves into the
    // shared component in Plan 03), team/leave/+page.svelte carries it once (moves into the
    // shared component in Plan 02). Target after Plan 04: 2 occurrences in 2 files — the retro
    // dialog's copy (kept, unchanged) plus the shared component's one copy.
    expect(totalOccurrences).toBe(2);
    expect(carriers.map((f) => f.relPath).sort()).toEqual(
      ["lib/components/leave/LeaveReviewDialog.svelte", "routes/(app)/inbox/+page.svelte"].sort(),
    );
  });
});

// ── Test 4 — AC-1 / D-19: submitReview lives only under lib/, never under routes/ ──
describe("Test 4 — AC-1 / D-19: submitReview lives only under lib/, never under routes/", () => {
  const SUBMIT_REVIEW_FN = "async function submitReview(";
  const routesCarriers = SRC_FILES.filter(
    (f) => f.relPath.startsWith("routes/") && f.content.includes(SUBMIT_REVIEW_FN),
  );
  const libCarriers = SRC_FILES.filter(
    (f) => f.relPath.startsWith("lib/") && f.content.includes(SUBMIT_REVIEW_FN),
  );

  it("today: 0 occurrences under routes/ — there are 2", () => {
    expect(routesCarriers.length).toBe(0);
  });

  it("today: exactly 1 occurrence under lib/ — there are 0 (positive counter-proof to the zero above)", () => {
    // Without this second, positive direction, "0 under routes/" would ALSO hold if submitReview
    // vanished entirely instead of moving into the shared component — it would be indistinguishable
    // from a silently deleted feature.
    expect(libCarriers.length).toBe(1);
  });
});

// ── Test 5 — AC-5 / D-20: no third copy of the review dialog exists ────────
describe("Test 5 — AC-5 / D-20: no third copy of the review dialog exists", () => {
  it("exactly three route files carry the review-dialog marker, and no more", () => {
    const carriers = SRC_FILES.filter(
      (f) => f.relPath.startsWith("routes/") && f.content.includes(REVIEW_DIALOG_MARKER),
    )
      .map((f) => f.relPath.slice("routes/".length))
      .sort();
    // "(app)/leave/+page.svelte" carries the phrase in the EMPLOYEE's own request form's overlap
    // panel (Phase 262) — not a review dialog at all, and outside this phase. It is deliberately
    // kept in this expected list so a later reader SEES the distinction instead of re-deriving it.
    // This is the mechanical proof behind "there is no third copy" (D-20) — the structural claim
    // AC-5 rests on: a shared dialog makes divergence impossible instead of merely checkable, so
    // no ongoing parity gate is needed once this is true.
    //
    // This assertion CANNOT be red against today's unmodified tree: the corpus genuinely has
    // exactly these three carriers today, and the coming refactor does not add or remove a
    // carrier — it only changes WHERE the markup lives inside two of the three. Its guarantee is
    // therefore proven by a RECORDED MUTATION instead of an unobserved green: 255-01-PLAN.md
    // Task 2 Part B temporarily adds a fourth marker-carrying file under routes/, observes this
    // test go red, records the failure verbatim, and removes the file again. An unobserved-green
    // assertion here would be the same failure class as the Phase 96 discriminator-swap incident
    // and the #203/#235/#240/#245 vacuous-guard incidents this project has already hit.
    expect(carriers).toEqual(
      [
        "(app)/inbox/+page.svelte",
        "(app)/leave/+page.svelte",
        "(app)/team/leave/+page.svelte",
      ].sort(),
    );
  });
});

// ── Test 6 — D-06: the nine /team/leave data-testid anchors survive intact ──
describe("Test 6 — D-06: the nine /team/leave data-testid anchors survive intact", () => {
  // apps/e2e/tests/leave-flow.spec.ts drives on these names today. The
  // leave-cancel-approval-modal-{reject,approve} pair has no OTHER e2e coverage at all — for those
  // two, this table is the only net that would notice a rename.
  const TESTID_NAMES = [
    "leave-approval-modal",
    "leave-approval-modal-summary",
    "leave-approval-modal-reason",
    "leave-approval-modal-close",
    "leave-approval-modal-reject",
    "leave-approval-modal-approve",
    "leave-approval-modal-self-block",
    "leave-cancel-approval-modal-reject",
    "leave-cancel-approval-modal-approve",
  ];

  it("[anti-vacuity] the table actually has nine entries — it.each on an empty array would pass without checking anything", () => {
    expect(TESTID_NAMES.length).toBe(9);
  });

  it.each(TESTID_NAMES)('"%s" occurs exactly once across the review-dialog corpus', (name) => {
    // Quoted match (`"${name}"`), not a bare substring match: "leave-approval-modal" is itself a
    // substring of "leave-approval-modal-summary", but the quote-delimited literal
    // `"leave-approval-modal"` is not a substring of `"leave-approval-modal-summary"` (the
    // character after "modal" differs — a closing quote vs. a hyphen) — so this stays precise
    // without needing a RegExp word boundary.
    //
    // CANNOT be red against today's unmodified tree — all nine already occur exactly once, since
    // /team/leave still owns them all. Proven instead by a recorded mutation: 255-01-PLAN.md
    // Task 2 Part C renames exactly one of these nine in team/leave/+page.svelte, observes this
    // test go red for that one name, records the failure verbatim, and reverts the rename.
    const total = REVIEW_SOURCES.reduce(
      (sum, [, src]) => sum + countOccurrences(src, `"${name}"`),
      0,
    );
    expect(total).toBe(1);
  });
});
