/**
 * Phase 275 Plan 04 (Issue #275, D-07) — the pure, zero-I/O half of the `lint-e2e-spec-registry`
 * gate. Mirrors the `lint-guard-vacuity.ts` / `lint-guard-vacuity-detect.ts` split: every export
 * here is a pure function of its arguments (no `readFileSync`, no `readdirSync`, no
 * `process.exit`), so `apps/api/scripts/__tests__/lint-e2e-spec-registry-validate.test.ts` can
 * drive it entirely from in-memory fixtures, DB-free. All disk I/O lives in the CLI wrapper,
 * `./lint-e2e-spec-registry.ts`.
 *
 * ── What D-07 requires, made mechanical ───────────────────────────────────────────────────────
 * Every file under `apps/e2e/tests/*.spec.ts` gets exactly ONE checked-in register entry
 * (`apps/api/scripts/lint-e2e-spec-registry.json`) naming a `category` — `CATEGORIES` below,
 * verbatim from D-07's own decision, kept in German because they are the owner's decided DATA
 * values, not code identifiers — and a `reason` of at least `MIN_REASON_LENGTH` characters
 * ("a sentence, not a label", the same phrase `lint-guard-vacuity.ts` uses for its own register).
 * Unlike that gate's exceptions register (where a file simply not being vacuous needs no entry at
 * all), a spec file here ALWAYS needs an entry — "missing" is itself an error condition, never a
 * quiet pass.
 *
 * ── Two functions, two directions of the same completeness question ──────────────────────────
 * `validateRegisterDocument` answers "is this JSON document well-formed, and does every entry
 * point at a file that still exists" (shape, category enum, reason length, duplicate `file`,
 * stale-entry detection). `diffRegisterAgainstFiles` answers the other direction — "does every
 * DISCOVERED file have an entry" (missing-entry detection) — plus re-confirms staleness, so a
 * caller that only runs the diff still gets a complete bidirectional answer on its own.
 *
 * ── `extractE2eCiTestMatch` and the T-275-14 sub-case (in-ci vs. what actually runs) ──────────
 * The concrete defect Issue #275 measured is not merely "the file was never touched" — it also
 * covers a file BELIEVED to run in CI that no Playwright project actually executes. This function
 * derives, from `apps/e2e/playwright.config.ts`'s own text, the set of `*.spec.ts` basenames some
 * CI-invoked Playwright project actually runs. Signals failure (never a quiet empty list) when a
 * named project block is absent, or its `testMatch` field matches nothing — the same anti-vacuity
 * discipline this whole phase is enforcing, applied to the config-parsing step itself.
 *
 * Deliberately unions THREE project blocks (`e2e-ci`, `axe-scan`, `visual`), not only the
 * literally-named `e2e-ci` project plan 275-03 created. `axe-scan.spec.ts` and `visual.spec.ts`
 * already ran in CI, via their OWN dedicated Playwright projects and CI jobs, before this phase
 * existed. D-07 requires EVERY one of the 24 files to carry exactly one of the three category
 * values, and neither `später-datum` nor `später-seed` is true of a file that already runs, today
 * — so both are categorised `in-ci` in the register too. Scoping this extraction to only the
 * `e2e-ci` project block would make the register's own honest "these two already run" claim FAIL
 * the very in-ci/testMatch consistency check this function exists to enforce — exactly backwards.
 * `diffInCiAgainstTestMatch` compares the register's `in-ci` entries against this UNIONED set, in
 * both directions — this is `T-275-14`'s general shape ("an in-ci entry for a file no project
 * runs"), not narrowly scoped to the newest project alone.
 *
 * ── House-form notes ──────────────────────────────────────────────────────────────────────────
 * `extractE2eCiTestMatch` uses a text-scan, not a TypeScript AST parse — `playwright.config.ts`'s
 * `testMatch` values are always regex literals of the shape `/<name>\.spec\.ts/`, either bare or
 * inside an array, immediately followed by a `use:` key in every project block this file defines
 * today (stated, not hidden, as a scope limit: a future project block that reorders its own keys
 * would need this scan updated, the same category of documented limitation
 * `lint-guard-vacuity-detect.ts`'s own header names for its flat, non-lexically-scoped binding
 * tracking).
 */

export const CATEGORIES = ["in-ci", "später-datum", "später-seed"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Matches the family convention (`lint-guard-vacuity.ts`'s own `MIN_REASON_LENGTH`) — "a
 * sentence, not a label". */
export const MIN_REASON_LENGTH = 30;

/** The three CI-invoked Playwright project blocks whose `testMatch` sets together answer "does
 * some project actually run this file" — see module docblock for why all three, not only
 * `e2e-ci`. */
const CI_PROJECT_NAMES = ["e2e-ci", "axe-scan", "visual"] as const;

export interface RegisterEntry {
  file: string;
  category: Category;
  reason: string;
}

export interface RegisterDocument {
  registerSource: string;
  entries: RegisterEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

/**
 * Validates a raw (untyped) register document's SHAPE — object/array structure, non-empty
 * `registerSource`, per-entry `file`/`category`/`reason`, duplicate `file` detection — and, given
 * `discoveredFiles`, flags any entry whose `file` is not among them as STALE. Fails CLOSED: any
 * error means `{ ok: false }` and the caller must not proceed to counting. Does NOT check for
 * discovered files with no entry at all — that is `diffRegisterAgainstFiles`'s job, so a caller
 * that wants the full bidirectional picture runs both.
 */
export function validateRegisterDocument(
  raw: unknown,
  discoveredFiles: readonly string[],
): { ok: true; doc: RegisterDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["register document must be a JSON object"] };
  }

  const { registerSource, entries } = raw;
  if (typeof registerSource !== "string" || registerSource.trim().length === 0) {
    errors.push("'registerSource' must be a non-empty string");
  }
  if (!Array.isArray(entries)) {
    errors.push("'entries' must be an array");
    return { ok: false, errors };
  }

  const discoveredSet = new Set(discoveredFiles);
  const seenFiles = new Set<string>();
  const validEntries: RegisterEntry[] = [];

  (entries as unknown[]).forEach((entry, index) => {
    const label =
      isRecord(entry) && typeof entry.file === "string" ? entry.file : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }

    const { file, category, reason } = entry;
    if (typeof file !== "string" || file.trim().length === 0) {
      errors.push(`${label}: 'file' must be a non-empty string`);
      return;
    }
    if (seenFiles.has(file)) {
      errors.push(`${label}: duplicate entry for '${file}'`);
    } else {
      seenFiles.add(file);
    }

    if (!isCategory(category)) {
      errors.push(
        `${label}: 'category' must be one of ${CATEGORIES.join(", ")} — got ${JSON.stringify(category)}`,
      );
    }
    if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' must be a string of at least ${MIN_REASON_LENGTH} characters — a ` +
          `sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
    }

    if (!discoveredSet.has(file)) {
      errors.push(`${label}: STALE — '${file}' does not exist among discovered spec files`);
      return;
    }

    if (
      isCategory(category) &&
      typeof reason === "string" &&
      reason.trim().length >= MIN_REASON_LENGTH
    ) {
      validEntries.push({ file, category, reason });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { registerSource: registerSource as string, entries: validEntries } };
}

/**
 * The bidirectional file-existence diff, independent of `validateRegisterDocument`'s shape
 * checks: every DISCOVERED file must have exactly one entry (a missing entry names the file), and
 * every entry's `file` must exist among the discovered set (a stale entry names the file too —
 * re-confirming the direction `validateRegisterDocument` already checks, so a caller invoking only
 * this function still gets the complete picture on its own).
 */
export function diffRegisterAgainstFiles(
  entries: readonly RegisterEntry[],
  discoveredFiles: readonly string[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const entryFiles = new Set(entries.map((e) => e.file));
  const discoveredSet = new Set(discoveredFiles);

  for (const file of discoveredFiles) {
    if (!entryFiles.has(file)) {
      errors.push(
        `'${file}' has no register entry — every apps/e2e/tests/*.spec.ts file must appear exactly once`,
      );
    }
  }
  for (const entry of entries) {
    if (!discoveredSet.has(entry.file)) {
      errors.push(
        `'${entry.file}' has a register entry but no longer exists among discovered spec files (STALE)`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * Derives the set of `*.spec.ts` basenames some CI-invoked Playwright project actually runs, by
 * scanning `configText` (the raw text of `apps/e2e/playwright.config.ts`) for each of
 * `CI_PROJECT_NAMES`'s project blocks and extracting the `/<name>\.spec\.ts/` regex literals in
 * its `testMatch` field. Returns `{ ok: false }` — never a quiet empty list — when a named block
 * is absent, or its `testMatch` matches nothing.
 */
export function extractE2eCiTestMatch(
  configText: string,
): { ok: true; files: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const files = new Set<string>();

  for (const projectName of CI_PROJECT_NAMES) {
    const nameNeedle = `name: "${projectName}"`;
    const nameIdx = configText.indexOf(nameNeedle);
    if (nameIdx === -1) {
      errors.push(
        `no project block named "${projectName}" found in apps/e2e/playwright.config.ts — check ` +
          `the project name, not the count`,
      );
      continue;
    }

    const nextNameIdx = configText.indexOf(`name: "`, nameIdx + nameNeedle.length);
    const blockEnd = nextNameIdx === -1 ? configText.length : nextNameIdx;
    const block = configText.slice(nameIdx, blockEnd);

    const testMatchIdx = block.indexOf("testMatch:");
    if (testMatchIdx === -1) {
      errors.push(
        `project "${projectName}" has no 'testMatch' field in its config block — check the ` +
          `block, not the count`,
      );
      continue;
    }

    const testMatchSegment = block.slice(testMatchIdx);
    const specLiteralRe = /\/([A-Za-z0-9_-]+)\\\.spec\\\.ts\//g;
    let match: RegExpExecArray | null;
    let foundAny = false;
    while ((match = specLiteralRe.exec(testMatchSegment)) !== null) {
      files.add(`${match[1]}.spec.ts`);
      foundAny = true;
    }
    if (!foundAny) {
      errors.push(
        `project "${projectName}"'s 'testMatch' field matched no /<name>\\.spec\\.ts/ pattern — ` +
          `check the pattern, not the count`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, files: [...files].sort() };
}

/**
 * The T-275-14 check itself: every register entry categorised `in-ci` must name a file some
 * CI-invoked project actually runs (`testMatchFiles`, from `extractE2eCiTestMatch`), and every
 * file some such project runs must be categorised `in-ci` in the register — the reverse direction,
 * which catches a file silently added to a project's `testMatch` without a matching register
 * update (the concrete drift class Issue #275 measured).
 */
export function diffInCiAgainstTestMatch(
  entries: readonly RegisterEntry[],
  testMatchFiles: readonly string[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const inCiBasenames = new Set(
    entries.filter((e) => e.category === "in-ci").map((e) => e.file.split("/").pop() ?? e.file),
  );
  const testMatchSet = new Set(testMatchFiles);

  for (const basename of inCiBasenames) {
    if (!testMatchSet.has(basename)) {
      errors.push(
        `'${basename}' is registered as 'in-ci' but no CI-invoked Playwright project ` +
          `(e2e-ci/axe-scan/visual) actually runs it`,
      );
    }
  }
  for (const basename of testMatchSet) {
    if (!inCiBasenames.has(basename)) {
      errors.push(
        `'${basename}' is run by a CI-invoked Playwright project (e2e-ci/axe-scan/visual) but ` +
          `its register entry is not categorised 'in-ci'`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
