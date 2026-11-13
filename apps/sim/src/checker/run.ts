/** Runs the invariants, the performance measurement and writes the JSON report (Issue #715). */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DayLog } from "../bots/context";
import { loadProgress } from "../bots/context";
import { loadState } from "../state";
import type { SimConfig } from "../config";
import { ApiClient, login } from "../http";
import { dayInTz } from "../tz";
import { connectReadOnly } from "./db";
import { API_INVARIANTS } from "./invariants-api";
import { DB_INVARIANTS } from "./invariants-db";
import { RULE_INVARIANTS } from "./invariants-rules";
import { appendTrend, judgePerf, measure, readTrend, type PerfMetrics } from "./perf";
import type {
  ChecksumState,
  CheckContext,
  Finding,
  Invariant,
  InvariantResult,
  Queryable,
} from "./types";

export const ALL_INVARIANTS: Invariant[] = [
  ...DB_INVARIANTS,
  ...API_INVARIANTS,
  ...RULE_INVARIANTS,
];

export interface InvariantReport {
  id: string;
  title: string;
  status: "pass" | "fail" | "error";
  examined: number;
  findings: Finding[];
  error?: string;
  ms: number;
}

export interface CheckReport {
  date: string;
  startedAt: string;
  seed: string;
  daysSimulated: number;
  ok: boolean;
  invariants: InvariantReport[];
  perf: { metrics: PerfMetrics; persons: number } | null;
  findings: Finding[];
}

/**
 * Runs every invariant against the context. An invariant that throws is reported as an error (the
 * report is red), never skipped; one that looked at nothing although days were simulated is a
 * finding of its own, so a check that silently stopped seeing anything cannot stay green.
 */
export async function runInvariants(
  invariants: readonly Invariant[],
  ctx: CheckContext,
): Promise<InvariantReport[]> {
  const reports: InvariantReport[] = [];
  for (const invariant of invariants) {
    const started = Date.now();
    let outcome: InvariantResult | null = null;
    let error: string | undefined;
    try {
      outcome = await invariant.run(ctx);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const findings = [...(outcome?.findings ?? [])];
    if (
      outcome &&
      outcome.examined === 0 &&
      !invariant.mayBeEmpty &&
      ctx.progress.daysSimulated.length >= 2
    ) {
      findings.push({
        invariant: invariant.id,
        key: `vacuous:${invariant.id}`,
        message: `The check examined nothing although ${ctx.progress.daysSimulated.length} days were simulated.`,
      });
    }
    reports.push({
      id: invariant.id,
      title: invariant.title,
      status: error ? "error" : findings.length > 0 ? "fail" : "pass",
      examined: outcome?.examined ?? 0,
      findings,
      error,
      ms: Date.now() - started,
    });
  }
  return reports;
}

interface CheckerState {
  lastCheckAt: string | null;
  checksums: ChecksumState;
}

function loadCheckerState(stateDir: string): CheckerState {
  const path = join(stateDir, "check-state.json");
  if (!existsSync(path)) return { lastCheckAt: null, checksums: { entries: {}, snapshots: {} } };
  return JSON.parse(readFileSync(path, "utf8")) as CheckerState;
}

export function loadDayLogs(stateDir: string, limit = 14): DayLog[] {
  const dir = join(stateDir, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as DayLog);
}

export interface CheckOptions {
  dbUrl: string;
  skipPerf?: boolean;
  rebaseline?: boolean;
}

export async function runCheck(config: SimConfig, options: CheckOptions): Promise<CheckReport> {
  const state = loadState(config.stateDir);
  const progress = loadProgress(config.stateDir);
  const checkerState = loadCheckerState(config.stateDir);
  const chain = state.tenants.chain;
  if (!chain) throw new Error("The chain tenant is not provisioned");

  const api = new ApiClient(config.apiUrl);
  const admin = await login(api, chain.adminEmail, chain.adminPassword);
  const db = await connectReadOnly(options.dbUrl);
  const now = new Date();
  const today = dayInTz(now, config.tz);
  const ctx: CheckContext = {
    db: db as Queryable,
    api,
    adminToken: admin.token,
    state,
    progress,
    dayLogs: loadDayLogs(config.stateDir),
    seed: config.seed,
    today,
    since: checkerState.lastCheckAt
      ? new Date(checkerState.lastCheckAt)
      : new Date(now.getTime() - 36 * 3600_000),
    checksums: options.rebaseline ? { entries: {}, snapshots: {} } : checkerState.checksums,
  };

  try {
    const invariants = await runInvariants(ALL_INVARIANTS, ctx);
    const findings = invariants.flatMap((i) => i.findings);
    let perf: CheckReport["perf"] = null;
    if (!options.skipPerf) {
      perf = await measure(ctx);
      const line = {
        date: today,
        takenAt: now.toISOString(),
        persons: perf.persons,
        metrics: perf.metrics,
      };
      findings.push(...judgePerf(line, readTrend(config.stateDir)));
      appendTrend(config.stateDir, line);
    }
    const report: CheckReport = {
      date: today,
      startedAt: now.toISOString(),
      seed: config.seed,
      daysSimulated: progress.daysSimulated.length,
      ok: findings.length === 0 && invariants.every((i) => i.status !== "error"),
      invariants,
      perf,
      findings,
    };
    const dir = join(config.stateDir, "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${today}.json`), JSON.stringify(report, null, 1));

    // The next baseline is only taken from a run whose closed-month check actually ran.
    const closed = invariants.find((i) => i.id === "months.closed-unchanged");
    if (closed && closed.status !== "error" && ctx.nextChecksums) {
      writeFileSync(
        join(config.stateDir, "check-state.json"),
        JSON.stringify(
          { lastCheckAt: now.toISOString(), checksums: ctx.nextChecksums } satisfies CheckerState,
          null,
          1,
        ),
      );
    }
    return report;
  } finally {
    await db.close();
  }
}
