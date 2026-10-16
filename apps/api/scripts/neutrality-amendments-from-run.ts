/**
 * Issue #539 (D-15) — neutrality amendments from a measured run.
 *
 * The ONLY sanctioned way to change a neutrality expectation for #539. A VERIFY run of the three
 * neutrality tests with `NEUTRALITY_ACTUAL_OUT_DIR=<dir>` writes what it measured to
 * `<dir>/<matrix|recipients|activity-auth>.actual.json`. This tool compares such a dump with the
 * EFFECTIVE expectation of the register (the recording, overridden by the last link of a key's
 * amendment chain, `src/__tests__/neutrality/amendment-chain.ts`) and turns every difference into
 * one appended chain link `{ date, from: <effective value>, to: <measured value>, issue, key,
 * reason }`.
 *
 * It REFUSES (exit 1, nothing written) when
 *   - a differing key does not match `--only` (a change nobody named is a finding, never a link),
 *   - the recipients register changes in any way but the removal of the labels matching
 *     `--expect-removed`, or any other site field differs from the recording,
 *   - the dump misses a recorded key (an incomplete run) or holds a key the recording lacks,
 *   - an existing chain is broken, or the appended links would break one.
 * A refusal is a finding. Never widen `--only` to make it go away.
 *
 * Recordings are NEVER written: the only file this tool can write is the register
 * (`recorded/<name>-amendments.json`), and only with `--write`; existing links stay byte-identical,
 * new links are appended in code-point key order. Dry run by default.
 *
 * Output (fixed tokens, later plans grep them): first line `differing=<n>`, then one line per
 * differing key, with `--write` a final line `appended=<n>`.
 *
 * Usage:
 *   pnpm --filter @clokr/api exec tsx scripts/neutrality-amendments-from-run.ts \
 *     --register matrix|recipients|activity-auth --actual <file> --only <regex> \
 *     --issue <n> --date <YYYY-MM-DD> --reason <text, >= 20 chars> \
 *     [--expect-removed <regex>] [--write]
 *
 * Exit codes: 0 ok (also: 0 differences) · 1 refusal, bad CLI or unreadable input.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import {
  resolveAmendmentChains,
  type AmendmentLink,
} from "../src/__tests__/neutrality/amendment-chain";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export const MIN_REASON_LENGTH = 20;

export type RegisterName = "matrix" | "recipients" | "activity-auth";
export const REGISTER_NAMES: readonly RegisterName[] = ["matrix", "recipients", "activity-auth"];

export interface RegisterPaths {
  recording: string;
  amendments: string;
}

interface RegisterShape {
  /** Property of the recording / dump file that holds the key -> value map. */
  readonly mapKey: "cells" | "sites" | "entries";
  /** Layout of one appended link: the matrix register is pretty-printed, the others one line each. */
  readonly style: "pretty" | "compact";
}

const SHAPES: Readonly<Record<RegisterName, RegisterShape>> = {
  matrix: { mapKey: "cells", style: "pretty" },
  recipients: { mapKey: "sites", style: "compact" },
  "activity-auth": { mapKey: "entries", style: "compact" },
};

const RECORDED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "__tests__",
  "neutrality",
  "recorded",
);

export function defaultPaths(name: RegisterName): RegisterPaths {
  return {
    recording: join(RECORDED_DIR, `${name}.json`),
    amendments: join(RECORDED_DIR, `${name}-amendments.json`),
  };
}

type Json = unknown;
type Link = AmendmentLink<Json>;

interface SiteLike {
  recipients: string[];
  [field: string]: unknown;
}

export interface Diff {
  /** Every key whose measured value differs from its effective expectation. */
  differing: string[];
  /** Why the run cannot be turned into links; empty when it can. */
  refusals: string[];
  /** The links to append, in code-point key order. */
  newLinks: Link[];
}

function codePointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The part of a map value a register amends: the whole value, or a site's `recipients` list. */
function projection(name: RegisterName, value: unknown): unknown {
  return name === "recipients" ? (value as SiteLike).recipients : value;
}

function withoutRecipients(value: unknown): unknown {
  const { recipients: _recipients, ...rest } = value as SiteLike;
  void _recipients;
  return rest;
}

export function diffRun(options: {
  register: RegisterName;
  recording: Record<string, unknown>;
  links: readonly Link[];
  actual: Record<string, unknown>;
  only: RegExp;
  expectRemoved?: RegExp;
  issue: number;
  date: string;
  reason: string;
}): Diff {
  const { register, recording, links, actual, only, expectRemoved, issue, date, reason } = options;
  const refusals: string[] = [];
  const differing: string[] = [];
  const newLinks: Link[] = [];

  const chain = resolveAmendmentChains<Json>({
    links,
    recordedValueOf: (key) => (key in recording ? projection(register, recording[key]) : undefined),
    minReasonLength: MIN_REASON_LENGTH,
  });
  for (const problem of chain.problems) refusals.push(`existing chain: ${problem}`);

  for (const key of Object.keys(actual).sort(codePointOrder)) {
    if (!(key in recording)) {
      refusals.push(
        `${key}: the dump holds a key the recording does not — a new route/site is not an amendment`,
      );
    }
  }

  for (const key of Object.keys(recording).sort(codePointOrder)) {
    if (!(key in actual)) {
      refusals.push(`${key}: the dump misses this recorded key — the run was incomplete`);
      continue;
    }
    const recorded = recording[key];
    const effectiveLink = chain.effective.get(key);
    const expected = effectiveLink ? effectiveLink.to : projection(register, recorded);
    const measured = projection(register, actual[key]);

    let restDiffers = false;
    if (register === "recipients") {
      restDiffers = !isDeepStrictEqual(withoutRecipients(actual[key]), withoutRecipients(recorded));
    }
    const valueDiffers = !isDeepStrictEqual(expected, measured);
    if (!valueDiffers && !restDiffers) continue;

    differing.push(key);
    if (!only.test(key)) {
      refusals.push(`${key}: differs but is outside --only ${only.source}`);
      continue;
    }
    if (restDiffers) {
      refusals.push(`${key}: a site field other than 'recipients' differs from the recording`);
      continue;
    }
    if (register === "recipients") {
      if (expectRemoved === undefined) {
        refusals.push(`${key}: recipients changed but no --expect-removed was given`);
        continue;
      }
      const wanted = (expected as string[]).filter((label) => !expectRemoved.test(label));
      if (!isDeepStrictEqual(wanted, measured)) {
        refusals.push(
          `${key}: recipients changed other than by removing --expect-removed ${expectRemoved.source}: ` +
            `expected ${JSON.stringify(wanted)}, measured ${JSON.stringify(measured)}`,
        );
        continue;
      }
    }
    newLinks.push({ key, from: expected, to: measured, issue, reason, date });
  }

  if (refusals.length === 0 && newLinks.length > 0) {
    const after = resolveAmendmentChains<Json>({
      links: [...links, ...newLinks],
      recordedValueOf: (key) =>
        key in recording ? projection(register, recording[key]) : undefined,
      minReasonLength: MIN_REASON_LENGTH,
    });
    for (const problem of after.problems) refusals.push(`appended links: ${problem}`);
  }

  return { differing, refusals, newLinks };
}

/** One appended link as text, in the layout of its register. */
export function renderLink(register: RegisterName, link: Link): string {
  if (SHAPES[register].style === "pretty") {
    const body = JSON.stringify(
      {
        date: link.date,
        from: link.from,
        issue: link.issue,
        key: link.key,
        reason: link.reason,
        to: link.to,
      },
      null,
      2,
    );
    return body
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
  }
  const value = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v);
  return (
    `    {"date": ${JSON.stringify(link.date)}, "from": ${value(link.from)}, "issue": ${link.issue}, ` +
    `"key": ${JSON.stringify(link.key)}, "reason": ${JSON.stringify(link.reason)}, "to": ${value(link.to)}}`
  );
}

const ARRAY_END = "\n  ]\n}\n";

/**
 * The register text with `newLinks` appended after the existing links. The existing text is kept
 * byte-for-byte; a file that does not end in the expected array closing is refused rather than
 * reformatted.
 */
export function appendLinks(
  register: RegisterName,
  text: string,
  newLinks: readonly Link[],
): string {
  if (newLinks.length === 0) return text;
  const rendered = [...newLinks]
    .sort((a, b) => codePointOrder(a.key, b.key))
    .map((link) => renderLink(register, link))
    .join(",\n");
  if (text.endsWith(ARRAY_END)) {
    return `${text.slice(0, text.length - ARRAY_END.length)},\n${rendered}${ARRAY_END}`;
  }
  const empty = /("amendments":\s*)\[\s*\]/;
  if (empty.test(text) && text.endsWith("\n}\n")) {
    return text.replace(empty, `$1[\n${rendered}\n  ]`);
  }
  throw new Error(
    "the register file does not end in the expected layout — refusing to reformat it",
  );
}

export const USAGE = `
Usage:
  pnpm --filter @clokr/api exec tsx scripts/neutrality-amendments-from-run.ts \\
    --register matrix|recipients|activity-auth --actual <dump.json> --only <regex> \\
    --issue <n> --date <YYYY-MM-DD> --reason <text, at least ${MIN_REASON_LENGTH} chars> \\
    [--expect-removed <regex>] [--write] [--help]

Turns a measured neutrality run (NEUTRALITY_ACTUAL_OUT_DIR dump) into appended amendment links.
Dry run unless --write. Refuses (exit 1) any difference outside --only, any recipients change but
the removal of --expect-removed labels, an incomplete dump and a broken chain. Never writes a recording.
`;

interface Cli {
  help: boolean;
  register?: RegisterName;
  actual?: string;
  only?: RegExp;
  issue?: number;
  date?: string;
  reason?: string;
  expectRemoved?: RegExp;
  write: boolean;
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      register: { type: "string" },
      actual: { type: "string" },
      only: { type: "string" },
      issue: { type: "string" },
      date: { type: "string" },
      reason: { type: "string" },
      "expect-removed": { type: "string" },
      write: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return { help: true, write: false };
  const register = values.register as RegisterName | undefined;
  if (register === undefined || !REGISTER_NAMES.includes(register)) {
    throw new Error(`--register must be one of ${REGISTER_NAMES.join(", ")}`);
  }
  if (!values.actual) throw new Error("--actual <file> is required");
  if (values.only === undefined) throw new Error("--only <regex> is required");
  const issue = Number(values.issue);
  if (!values.issue || !Number.isInteger(issue) || issue <= 0) {
    throw new Error("--issue must be a positive integer");
  }
  const date = values.date;
  if (
    !date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  ) {
    throw new Error("--date must be a valid YYYY-MM-DD date");
  }
  const reason = values.reason;
  if (!reason || reason.trim().length < MIN_REASON_LENGTH) {
    throw new Error(`--reason must be at least ${MIN_REASON_LENGTH} characters`);
  }
  if (values["expect-removed"] !== undefined && register !== "recipients") {
    throw new Error("--expect-removed applies to the recipients register only");
  }
  return {
    help: false,
    register,
    actual: values.actual,
    only: new RegExp(values.only),
    issue,
    date,
    reason,
    expectRemoved:
      values["expect-removed"] === undefined ? undefined : new RegExp(values["expect-removed"]),
    write: Boolean(values.write),
  };
}

function readMap(file: string, mapKey: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const map = parsed[mapKey];
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`${file}: no "${mapKey}" object`);
  }
  return map as Record<string, unknown>;
}

/** Exported for unit tests; `paths` injects the recording/register locations per register. */
export function main(argv: string[], paths?: Partial<Record<RegisterName, RegisterPaths>>): number {
  let cli: Cli;
  try {
    cli = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
  if (cli.help) {
    console.info(USAGE);
    return EXIT_OK;
  }
  const register = cli.register as RegisterName;
  const files = paths?.[register] ?? defaultPaths(register);
  const shape = SHAPES[register];

  let diff: Diff;
  let amendmentsText: string;
  try {
    const recording = readMap(files.recording, shape.mapKey);
    const actual = readMap(cli.actual as string, shape.mapKey);
    amendmentsText = readFileSync(files.amendments, "utf8");
    const links = (JSON.parse(amendmentsText) as { amendments: Link[] }).amendments;
    diff = diffRun({
      register,
      recording,
      links,
      actual,
      only: cli.only as RegExp,
      expectRemoved: cli.expectRemoved,
      issue: cli.issue as number,
      date: cli.date as string,
      reason: cli.reason as string,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }

  console.info(`differing=${diff.differing.length}`);
  for (const key of diff.differing) console.info(`  ${key}`);

  if (diff.refusals.length > 0) {
    for (const refusal of diff.refusals) console.error(`REFUSED: ${refusal}`);
    console.error("nothing was written");
    return EXIT_ERROR;
  }

  if (cli.write && diff.newLinks.length > 0) {
    try {
      // The ONLY write of this tool: the amendments register. Recordings are never opened for writing.
      writeFileSync(files.amendments, appendLinks(register, amendmentsText, diff.newLinks));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return EXIT_ERROR;
    }
  }
  if (cli.write) console.info(`appended=${diff.newLinks.length}`);
  return EXIT_OK;
}

// Run-guard: importing the module for unit tests has no side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
