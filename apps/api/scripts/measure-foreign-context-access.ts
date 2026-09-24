#!/usr/bin/env -S pnpm exec tsx
/**
 * Phase 100b Plan 01 (AC-1/AC-2/D-03/D-04/D-06) — the instrument this phase's whole milestone is
 * measured with. GitHub issue #100 (T5, "Explizite öffentliche API je Kontext").
 *
 * ── WHAT THIS MEASURES ────────────────────────────────────────────────────────────────────────
 * Every Prisma call under `apps/api/src/{contexts,composition,services}/**\/*.ts` (production
 * code only — `__tests__/` and `*.test.ts` are skipped) whose delegate is one of the 44 models in
 * `packages/db/prisma/schema.prisma`. Each call's AREA (which physical location it sits in) is
 * compared against its MODEL's OWNER (which context that model belongs to, per ADR 0001 §3). A
 * FOREIGN access is one where the owner is not `platform` and the owner differs from the area —
 * i.e. a context reading or writing another context's model directly, the exact thing ADR 0001
 * rule 3 ("kein direkter Tabellenzugriff auf fremde Schemas") forbids. WORKLOAD is FOREIGN minus
 * whatever `foreign-context-access-exceptions.json` names as an exception (D-03) — today only
 * `test-bootstrap.ts`'s 21 calls.
 *
 * ── WHY THE MATCH PATTERN IS RECEIVER-AGNOSTIC ───────────────────────────────────────────────
 * CONTEXT.md's first measurement pinned the receiver to the literal string `prisma.<model>.<op>(`
 * and was blind to every `tx.<model>.<op>(` call inside a `$transaction` — 121 of them exist in
 * this tree, including the overtime-account bookings `leave.ts` performs when a manager approves
 * or corrects an approved request. This script's regex captures the WHOLE dotted receiver chain
 * immediately before `.<model>.<op>(` (`app.prisma`, `tx`, a bare `prisma`, or anything else) and
 * never requires it to equal a fixed string. See the module-level `CALL_RE` construction.
 *
 * ── WHY `services/clock` and `services/phorest` are NOT their own area (D-04, ADR entry F) ──────
 * `docs/adr/0001-abweichungen.md` entry F states explicitly that Zeiterfassung is
 * `contexts/time-tracking/` **AND** `services/clock/`, and Schichtplanung is
 * `contexts/scheduling/` **AND** `services/phorest/` — two physical trees, one context each. This
 * script's `areaForRelPath` encodes exactly that: files under `services/clock/` are area
 * `time-tracking`, files under `services/phorest/` are area `scheduling`. Getting this wrong (as
 * CONTEXT.md's first draft did, treating `services/` as a fourth area) inflates the FOREIGN count
 * by counting a context's OWN model access as a crossing (`services/clock`'s 13 `timeEntry`
 * accesses are its own model, not foreign).
 *
 * ── HOUSE-FORM NOTES ─────────────────────────────────────────────────────────────────────────
 * Structured after `measure-context-coverage.ts` / `measure-saldo-path-parity.ts`: Part A is
 * exported pure functions (file-I/O confined to a handful of named `read*`/`scan*` functions,
 * everything else a pure transform over already-read data) so `__tests__/` can drive it against a
 * fixture directory without touching the real tree; Part B is a `main()` guarded by the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check — issue #203 records a suite
 * that dropped its own worker databases because a `main()` ran on bare import, and although this
 * script only reads, the guard is the house rule, not a database-specific precaution.
 *
 * The exception file's shape and its stale/reason/convertedModels validation deliberately mirror
 * `lint-tenant-scoping-exceptions.ts` (`validateExceptions`, `MIN_REASON_LENGTH`) — same class of
 * problem (a named, reasoned carve-out that must not silently rot into a blanket allow), same
 * fix.
 *
 * ── Flags ────────────────────────────────────────────────────────────────────────────────────
 *   (none)          Print the one-line summary and exit 0.
 *   --check <n>     Exit 0 if the current workload count equals <n>; otherwise print the delta
 *                   (which files/calls changed) and exit 1. This is how every later wave proves
 *                   "I converted N" by equality, not by reading a diff.
 *   --rows          Print `file:line | area | model.op | owner | receiver` for every WORKLOAD
 *                   access — the exact list a conversion plan works from.
 *   --by-model      Print the per-model workload table (models sorted by count, descending) —
 *                   the conversion unit waves 2-5 use.
 *
 * Exit codes:
 *   0 — summary/--rows/--by-model printed, or --check matched
 *   1 — the exceptions file is invalid (stale entry, missing/short reason, convertedModels
 *       violation) or --check did not match
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Part A: exported pure helpers (DB-free, unit-testable) ─────────────────────────────────

/** The five contexts a Prisma model can be OWNED by (ADR 0001 §3). Never a sixth value. */
export type OwnerArea =
  | "platform"
  | "time-tracking"
  | "absence"
  | "scheduling"
  | "working-time-account";

/** Where a FILE sits (D-04): the five contexts, or the cross-context `composition/` layer. */
export type FileArea = OwnerArea | "composition";

export const OWNER_AREAS: readonly OwnerArea[] = [
  "platform",
  "time-tracking",
  "absence",
  "scheduling",
  "working-time-account",
];

/**
 * Every Prisma delegate name (camelCase, as written in code) in `packages/db/prisma/schema.prisma`
 * today — 45 models, issue #99's table, extended by Phase 73b's `AccessRole` (#73), Phase 64b's `Salon` (#64), Phase 74b's `RoleAssignment` (#74) and Phase 65b's `SalonCoupling` (#65). `MODEL_OWNER`
 * below is a `Record` over exactly this union with no default branch: a model added to the schema
 * later and not added here fails the TypeScript build, rather than silently falling through to
 * `platform` the way an enumerated allowlist is supposed to (see `context-area-map.ts`'s own
 * "never a fallthrough" note on `rahmen`).
 */
export type PrismaModelName =
  | "tenant"
  | "salon"
  | "tenantConfig"
  | "user"
  | "refreshToken"
  | "otpToken"
  | "invitation"
  | "accessRole"
  | "roleAssignment"
  | "employee"
  | "workSchedule"
  | "timeEntry"
  | "break"
  | "saldoSnapshot"
  | "openingBalance"
  | "overtimeAccount"
  | "overtimeTransaction"
  | "overtimePlan"
  | "leaveType"
  | "leaveEntitlement"
  | "specialLeaveRule"
  | "leaveRequest"
  | "retroEntryRequest"
  | "section9Credit"
  | "absence"
  | "publicHoliday"
  | "schoolHolidayPeriod"
  | "auditLog"
  | "terminalApiKey"
  | "presenceSource"
  | "presenceDevice"
  | "apiKey"
  | "phorestStaffMapping"
  | "phorestSyncRun"
  | "phorestAppointment"
  | "salonCoupling"
  | "companyShutdown"
  | "companyShutdownException"
  | "notification"
  | "shiftTemplate"
  | "coverageRule"
  | "shift"
  | "employeeShiftPattern"
  | "employeeVocationalSchoolPattern"
  | "employeeAvailability";

/**
 * The 45-model ownership table (issue #99's "Modellzuordnung", ADR 0001 §3). This is the ONE
 * place a model's owning context may be stated for this measurement (measurement authority rule
 * 5) — no other reader of this script should rebuild it inline.
 */
export const MODEL_OWNER: Readonly<Record<PrismaModelName, OwnerArea>> = {
  // platform (Unterbau) — 16
  tenant: "platform",
  salon: "platform", // Phase 64b — Salon, issue #64
  tenantConfig: "platform",
  employee: "platform",
  user: "platform",
  auditLog: "platform",
  apiKey: "platform",
  invitation: "platform",
  otpToken: "platform",
  refreshToken: "platform",
  notification: "platform",
  publicHoliday: "platform",
  schoolHolidayPeriod: "platform",
  workSchedule: "platform",
  accessRole: "platform", // Phase 73b (#73) — named permission bundle, an Unterbau model
  roleAssignment: "platform", // Phase 74b (#74) — role assignment with scope, an Unterbau model
  // time-tracking — 6
  timeEntry: "time-tracking",
  break: "time-tracking",
  presenceDevice: "time-tracking",
  presenceSource: "time-tracking",
  terminalApiKey: "time-tracking",
  retroEntryRequest: "time-tracking",
  // absence — 9
  leaveRequest: "absence",
  leaveType: "absence",
  leaveEntitlement: "absence",
  absence: "absence",
  companyShutdown: "absence",
  companyShutdownException: "absence",
  specialLeaveRule: "absence",
  employeeVocationalSchoolPattern: "absence",
  section9Credit: "absence",
  // working-time-account — 5
  overtimeAccount: "working-time-account",
  overtimeTransaction: "working-time-account",
  overtimePlan: "working-time-account",
  saldoSnapshot: "working-time-account",
  openingBalance: "working-time-account",
  // scheduling — 9
  shift: "scheduling",
  shiftTemplate: "scheduling",
  employeeShiftPattern: "scheduling",
  employeeAvailability: "scheduling",
  coverageRule: "scheduling",
  phorestAppointment: "scheduling",
  phorestStaffMapping: "scheduling",
  phorestSyncRun: "scheduling",
  salonCoupling: "scheduling", // Phase 65b (#65) — Phorest coupling per salon
};

export const PRISMA_MODELS: readonly PrismaModelName[] = Object.keys(
  MODEL_OWNER,
) as PrismaModelName[];

/** The 14 Prisma delegate methods this measurement recognizes (measurement authority rule 2). */
export const OPS = [
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "groupBy",
  "aggregate",
] as const;
export type PrismaOp = (typeof OPS)[number];

const READ_OPS: ReadonlySet<string> = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "groupBy",
  "aggregate",
]);
const WRITE_OPS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

export function isReadOp(op: string): boolean {
  return READ_OPS.has(op);
}
export function isWriteOp(op: string): boolean {
  return WRITE_OPS.has(op);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MODEL_ALT = PRISMA_MODELS.map(escapeRegExp).join("|");
const OP_ALT = OPS.map(escapeRegExp).join("|");

/**
 * Matches `<dotted receiver>.<model>.<op>(` anywhere on a line. The receiver group
 * `(?:[A-Za-z_$][\w$]*\.)+` requires one or more dot-terminated identifier segments and is
 * DELIBERATELY not pinned to any particular name (measurement authority rule 2) — `app.prisma.`,
 * `tx.`, `prisma.`, `client.db.` all match. `<model>` and `<op>` are literal alternations over the
 * closed 44-model / 14-op vocabulary, so a receiver chain that merely CONTAINS one of those words
 * as a substring elsewhere never confuses the match (the two trailing literal dots anchor it).
 */
const CALL_RE = new RegExp(`((?:[A-Za-z_$][\\w$]*\\.)+)(${MODEL_ALT})\\.(${OP_ALT})\\(`, "g");

/** measurement authority rule 3: skip lines whose TRIMMED form starts with a comment marker. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

export interface RawCall {
  line: number;
  receiver: string;
  model: string;
  op: string;
}

/**
 * Extracts every matching call from raw file content, line by line, skipping comment-only lines.
 * Pure and file-I/O-free — this is what the non-vacuity fixture test drives directly.
 */
export function extractCallsFromContent(content: string): RawCall[] {
  const calls: RawCall[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(line)) !== null) {
      const receiver = m[1].replace(/\.$/, "");
      calls.push({ line: i + 1, receiver, model: m[2], op: m[3] });
    }
  }
  return calls;
}

export class UnmappedAreaError extends Error {
  constructor(relPath: string) {
    super(
      `measure-foreign-context-access: "${relPath}" sits under services/ but is neither ` +
        `services/clock/ nor services/phorest/ (ADR 0001 entry F names only these two). Add a ` +
        `case to areaForRelPath() in measure-foreign-context-access.ts before measuring it.`,
    );
    this.name = "UnmappedAreaError";
  }
}

const CONTEXT_DIR_TO_AREA: Readonly<Record<string, OwnerArea>> = {
  platform: "platform",
  "time-tracking": "time-tracking",
  absence: "absence",
  scheduling: "scheduling",
  "working-time-account": "working-time-account",
};

/**
 * AREA for a file, given a path relative to `apps/api/src` (POSIX, no leading `src/`). Encodes
 * measurement authority rule 4 (ADR 0001 entry F) exhaustively — `null` for anything outside the
 * three walked trees (`contexts/`, `composition/`, `services/`), `UnmappedAreaError` for a
 * `services/*` subtree that is neither `clock` nor `phorest`.
 */
export function areaForRelPath(relPath: string): FileArea | null {
  if (relPath.startsWith("services/clock/")) return "time-tracking";
  if (relPath.startsWith("services/phorest/")) return "scheduling";
  if (relPath.startsWith("services/")) throw new UnmappedAreaError(relPath);

  if (relPath.startsWith("composition/")) return "composition";

  const contextMatch = /^contexts\/([a-zA-Z-]+)\//.exec(relPath);
  if (contextMatch) {
    const area = CONTEXT_DIR_TO_AREA[contextMatch[1]];
    if (area) return area;
    throw new UnmappedAreaError(relPath);
  }

  return null;
}

export interface Access {
  /** Repo-relative path from the repo root, e.g. "apps/api/src/contexts/absence/api/leave.ts". */
  file: string;
  line: number;
  model: PrismaModelName;
  op: PrismaOp;
  receiver: string;
  owner: OwnerArea;
  area: FileArea;
  /** owner !== "platform" AND owner !== area (measurement authority rule 6). */
  foreign: boolean;
}

/** measurement authority rule 6. */
export function isForeign(owner: OwnerArea, area: FileArea): boolean {
  return owner !== "platform" && owner !== area;
}

/**
 * Extracts every recognized Access from one file's already-read content. `relPathFromSrc` is
 * relative to `apps/api/src` (POSIX, no leading `src/`); the returned `Access.file` is the full
 * repo-relative path (`apps/api/src/...`), matching `lint-tenant-scoping-exceptions.json`'s own
 * convention — this is the format the exceptions file's `file` field is written in.
 */
export function scanFileContent(relPathFromSrc: string, content: string): Access[] {
  const area = areaForRelPath(relPathFromSrc);
  if (area === null) return [];

  const raw = extractCallsFromContent(content);
  const out: Access[] = [];
  for (const c of raw) {
    const model = c.model as PrismaModelName;
    const owner = MODEL_OWNER[model];
    const op = c.op as PrismaOp;
    out.push({
      file: `apps/api/src/${relPathFromSrc}`,
      line: c.line,
      model,
      op,
      receiver: c.receiver,
      owner,
      area,
      foreign: isForeign(owner, area),
    });
  }
  return out;
}

const SCAN_ROOTS = ["contexts", "composition", "services"] as const;

function walkTsFiles(dir: string, apiSrcRoot: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTsFiles(full, apiSrcRoot, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    out.push(relative(apiSrcRoot, full).split("\\").join("/"));
  }
}

/**
 * The files `scanSrcTree` would walk, WITHOUT reading their content — reporting only, the
 * accesses computation (`scanSrcTree` below) is untouched by this addition (235-08, D-02's own
 * input/output-conflation pitfall 3: a workload of 0 must be distinguishable, from the tool's own
 * output, from a scan that found no FILES at all). Walks the same `SCAN_ROOTS` with the same
 * `walkTsFiles` primitive `scanSrcTree` uses, so the two counts can never structurally diverge.
 * Returns the FILE SET itself (not merely its count) so `run()`'s own `<x>.length === 0` check is
 * the classifier's recognised `"empty-abort"` shape (`lint-guard-vacuity-detect.ts`'s
 * `matchEmptyAbortProof` — the proof has to sit on the walk-derived binding's own `.length`,
 * never on a number computed one indirection away from it).
 */
export function discoverScannedFiles(apiSrcRoot: string): string[] {
  const out: string[] = [];
  for (const rootName of SCAN_ROOTS) {
    const rootDir = join(apiSrcRoot, rootName);
    try {
      if (!statSync(rootDir).isDirectory()) continue;
    } catch {
      continue;
    }
    walkTsFiles(rootDir, apiSrcRoot, out);
  }
  return out;
}

/**
 * The empty-abort message for a 0-scanned-file scan. Pure and exported so it is pinnable without
 * a real filesystem walk. Names every one of `SCAN_ROOTS` under `apiSrcRoot`, mirroring
 * `check-import-targets.ts`'s own empty-abort message shape (235-05/D-02).
 */
export function emptyScanAbortMessage(apiSrcRoot: string): string {
  const roots = SCAN_ROOTS.map((r) => join(apiSrcRoot, r)).join(", ");
  return (
    `measure-foreign-context-access: scanned 0 file(s) under ${roots} — a scan root moved or ` +
    `the extension filter matched nothing. This is a failure, not a clean result.`
  );
}

/**
 * Walks `apps/api/src/{contexts,composition,services}/**\/*.ts` (measurement authority rule 1),
 * skipping `__tests__/` and `*.test.ts`, and returns every Access found. `apiSrcRoot` is the
 * absolute path to `apps/api/src` (or, in a test, a fixture directory laid out the same way).
 */
export function scanSrcTree(apiSrcRoot: string): Access[] {
  const out: Access[] = [];
  for (const rootName of SCAN_ROOTS) {
    const rootDir = join(apiSrcRoot, rootName);
    try {
      if (!statSync(rootDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const relFiles: string[] = [];
    walkTsFiles(rootDir, apiSrcRoot, relFiles);
    for (const relPath of relFiles) {
      const content = readFileSync(join(apiSrcRoot, relPath), "utf8");
      out.push(...scanFileContent(relPath, content));
    }
  }
  return out;
}

// ── Exceptions file (D-03), validated like lint-tenant-scoping-exceptions.ts ────────────────

export const EXCEPTIONS_FILE = "apps/api/scripts/foreign-context-access-exceptions.json";

export const MIN_REASON_LENGTH = 30;

export interface ExceptionCall {
  /** "<model>.<op>", e.g. "overtimeAccount.deleteMany" */
  call: string;
  line: number;
}

export interface ExceptionEntry {
  file: string;
  calls: ExceptionCall[];
  reason: string;
}

export interface ExceptionsDocument {
  /**
   * Models fully converted to a facade — a model listed here MUST have zero WORKLOAD accesses
   * (post-exception). Empty today (D-01 baseline); each conversion wave in this phase appends to
   * it, after which any new direct access to that model is a hard error, not a silent regression.
   */
  convertedModels: string[];
  exceptions: ExceptionEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a raw (untyped) exceptions document against the CURRENT access set — structural
 * shape, reason length, staleness (does every named call still match a current FOREIGN access?),
 * and the `convertedModels` invariant (does a listed model really have zero workload left?).
 * Mirrors `lint-tenant-scoping-exceptions.ts`'s `validateExceptions` (T-100B-01).
 */
export function validateExceptionsDocument(
  raw: unknown,
  accesses: readonly Access[],
): { ok: true; doc: ExceptionsDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [`${EXCEPTIONS_FILE} must contain a JSON object`] };
  }

  const { convertedModels, exceptions } = raw as Record<string, unknown>;

  if (!Array.isArray(convertedModels) || convertedModels.some((m) => typeof m !== "string")) {
    errors.push(`'convertedModels' must be an array of strings`);
  }
  if (!Array.isArray(exceptions)) {
    errors.push(`'exceptions' must be an array`);
    return { ok: false, errors };
  }

  const foreignByKey = new Map<string, Access>();
  for (const a of accesses) {
    if (!a.foreign) continue;
    foreignByKey.set(`${a.file}::${a.model}.${a.op}::${a.line}`, a);
  }

  const validEntries: ExceptionEntry[] = [];
  (exceptions as unknown[]).forEach((entry, index) => {
    const label =
      isRecord(entry) && typeof entry.file === "string" ? entry.file : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }
    const { file, calls, reason } = entry;
    if (typeof file !== "string" || file.length === 0) {
      errors.push(`${label}: missing or invalid 'file'`);
      return;
    }
    if (!Array.isArray(calls) || calls.length === 0) {
      errors.push(
        `${label}: 'calls' must be a non-empty array — every excepted call must be named explicitly`,
      );
      return;
    }
    const parsedCalls: ExceptionCall[] = [];
    let callsInvalid = false;
    calls.forEach((c: unknown, ci: number) => {
      if (
        !isRecord(c) ||
        typeof c.call !== "string" ||
        c.call.length === 0 ||
        typeof c.line !== "number" ||
        !Number.isInteger(c.line) ||
        c.line < 1
      ) {
        errors.push(
          `${label}: calls[${ci}] must be { call: "<model>.<op>", line: <positive integer> }`,
        );
        callsInvalid = true;
        return;
      }
      parsedCalls.push({ call: c.call, line: c.line });
    });
    if (callsInvalid) return;

    if (typeof reason !== "string" || reason.trim().length === 0) {
      errors.push(
        `${label}: missing 'reason' — every exception MUST name WHY the calls it lists are excepted`,
      );
      return;
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' is only ${reason.trim().length} character(s) — must read as a sentence, not a label (minimum ${MIN_REASON_LENGTH})`,
      );
      return;
    }

    const staleCalls = parsedCalls.filter(
      (c) => !foreignByKey.has(`${file}::${c.call}::${c.line}`),
    );
    if (staleCalls.length > 0) {
      errors.push(
        `${label}: STALE — ${staleCalls.map((c) => `${c.call}:${c.line}`).join(", ")} no longer ` +
          `match(es) a current FOREIGN access; the call may have moved or been fixed — update or ` +
          `remove it, a stale entry is a blanket allow waiting to happen`,
      );
      return;
    }

    validEntries.push({ file, calls: parsedCalls, reason: reason.trim() });
  });

  if (errors.length > 0) return { ok: false, errors };

  // convertedModels invariant: any model listed must have zero FOREIGN access remaining that is
  // not itself excepted away — i.e. zero WORKLOAD for that model.
  const exceptedKeys = new Set<string>();
  for (const e of validEntries) {
    for (const c of e.calls) exceptedKeys.add(`${e.file}::${c.call}::${c.line}`);
  }
  for (const model of convertedModels as string[]) {
    const remaining = accesses.filter(
      (a) =>
        a.foreign &&
        a.model === model &&
        !exceptedKeys.has(`${a.file}::${a.model}.${a.op}::${a.line}`),
    );
    if (remaining.length > 0) {
      errors.push(
        `convertedModels lists "${model}" but ${remaining.length} workload access(es) to it ` +
          `remain (e.g. ${remaining[0].file}:${remaining[0].line}) — remove it from ` +
          `convertedModels until the conversion is actually complete`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    doc: { convertedModels: convertedModels as string[], exceptions: validEntries },
  };
}

export function loadExceptionsRaw(repoRoot: string): unknown {
  const abs = join(repoRoot, EXCEPTIONS_FILE);
  const text = readFileSync(abs, "utf8");
  return JSON.parse(text);
}

/** Is `access` named by any entry in `doc.exceptions`? */
export function isExcepted(access: Access, doc: ExceptionsDocument): boolean {
  const key = `${access.model}.${access.op}`;
  return doc.exceptions.some(
    (e) => e.file === access.file && e.calls.some((c) => c.call === key && c.line === access.line),
  );
}

export interface WorkloadResult {
  workload: Access[];
  excepted: Access[];
}

export function computeWorkload(
  accesses: readonly Access[],
  doc: ExceptionsDocument,
): WorkloadResult {
  const foreign = accesses.filter((a) => a.foreign);
  const excepted = foreign.filter((a) => isExcepted(a, doc));
  const workload = foreign.filter((a) => !isExcepted(a, doc));
  return { workload, excepted };
}

/**
 * `scannedFiles` is optional (235-08, D-02 pitfall 3): when given, it prefixes the line with the
 * size of the SCANNED set, kept visibly separate from `${files} file(s)` (the WORKLOAD set,
 * i.e. files WITH a foreign access) — two different sets, so a workload of 0 never looks like a
 * scan of 0. Omitted, the line is byte-identical to its pre-235-08 form (the format this tool's
 * own pinning test locks down).
 */
export function summaryLine(result: WorkloadResult, scannedFiles?: number): string {
  const files = new Set(result.workload.map((a) => a.file)).size;
  const read = result.workload.filter((a) => isReadOp(a.op)).length;
  const write = result.workload.filter((a) => isWriteOp(a.op)).length;
  const scannedPrefix = scannedFiles === undefined ? "" : `${scannedFiles} file(s) scanned; `;
  return (
    `[measure:context-access] ${scannedPrefix}${result.workload.length} foreign access(es) in ` +
    `${files} file(s) — ${read} read / ${write} write; ${result.excepted.length} excepted.`
  );
}

export function renderRows(result: WorkloadResult): string {
  return result.workload
    .slice()
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)))
    .map((a) => `${a.file}:${a.line} | ${a.area} | ${a.model}.${a.op} | ${a.owner} | ${a.receiver}`)
    .join("\n");
}

export function renderByModel(result: WorkloadResult): string {
  const counts = new Map<string, { total: number; read: number; write: number }>();
  for (const a of result.workload) {
    const c = counts.get(a.model) ?? { total: 0, read: 0, write: 0 };
    c.total++;
    if (isReadOp(a.op)) c.read++;
    if (isWriteOp(a.op)) c.write++;
    counts.set(a.model, c);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([model, c]) => `${model} ${c.total} (r${c.read}/w${c.write})`)
    .join("\n");
}

// ── Part B: CLI entry point ─────────────────────────────────────────────────────────────────

function run(repoRoot: string, argv: string[]): number {
  const apiSrcRoot = join(repoRoot, "apps/api/src");

  // Empty-abort (235-08, D-02 pitfall 3): the workload computation and its numbers are untouched
  // below — this proof goes on the SCANNED set, checked before scanSrcTree ever runs, never on the
  // workload/accesses count (which correctly wants to stay 0 on a healthy tree). `process.exitCode`
  // set explicitly alongside the `return 1` (same classifier-visibility shape as A2's
  // lint-saldo-lock-derivation.ts fix): the CLI entry already wraps this in
  // `process.exit(run(...))`, so the real exit code was never in question.
  const scannedFiles = discoverScannedFiles(apiSrcRoot);
  if (scannedFiles.length === 0) {
    console.error(emptyScanAbortMessage(apiSrcRoot));
    process.exitCode = 1;
    return 1;
  }

  const accesses = scanSrcTree(apiSrcRoot);

  const raw = loadExceptionsRaw(repoRoot);
  const validated = validateExceptionsDocument(raw, accesses);
  if (!validated.ok) {
    console.error(`measure-foreign-context-access: ${EXCEPTIONS_FILE} is invalid:`);
    for (const e of validated.errors) console.error(`  - ${e}`);
    return 1;
  }
  const result = computeWorkload(accesses, validated.doc);

  if (argv.includes("--rows")) {
    console.log(renderRows(result));
    return 0;
  }
  if (argv.includes("--by-model")) {
    console.log(renderByModel(result));
    return 0;
  }

  const checkIdx = argv.indexOf("--check");
  if (checkIdx !== -1) {
    const expected = Number(argv[checkIdx + 1]);
    if (!Number.isInteger(expected)) {
      console.error(`measure-foreign-context-access: --check requires an integer argument`);
      return 1;
    }
    console.log(summaryLine(result, scannedFiles.length));
    if (result.workload.length === expected) {
      return 0;
    }
    const delta = result.workload.length - expected;
    console.error(
      `measure-foreign-context-access: --check ${expected} FAILED — actual workload is ` +
        `${result.workload.length} (${delta > 0 ? "+" : ""}${delta}). Files in the current ` +
        `workload:\n` +
        [...new Set(result.workload.map((a) => a.file))].sort().join("\n"),
    );
    return 1;
  }

  console.log(summaryLine(result, scannedFiles.length));
  return 0;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
  process.exit(run(repoRoot, process.argv.slice(2)));
}
