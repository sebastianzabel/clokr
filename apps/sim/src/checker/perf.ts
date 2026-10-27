/**
 * Response-time measurement and trend (Issue #715). The thresholds come from the issues that made
 * them necessary; a number without an issue behind it is marked as proposed.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays } from "../tz";
import type { CheckContext, Finding } from "./types";

export const THRESHOLDS = {
  /** #688 / #696 acceptance criterion: 300 persons x 12 months in under 15 s. */
  periodFullMs: { value: 15_000, source: "#688, #696 (300 persons x 12 months)" },
  /** #696: the web proxy gives up at 30 s; beyond this the page is broken for users. */
  periodHardMs: { value: 30_000, source: "#696 (web proxy limit)" },
  /** Proposed by #715, not from an earlier issue: the dashboard is the landing page. */
  dashboardMs: { value: 3_000, source: "proposed in #715" },
  /** Proposed by #715. Applies to the status read and to one close request. */
  monthCloseMs: { value: 10_000, source: "proposed in #715" },
  /** A metric above 2x the median of its last runs (and above 1 s) is a trend finding. */
  trendFactor: { value: 2, source: "proposed in #715" },
  trendFloorMs: { value: 1_000, source: "proposed in #715" },
} as const;

export interface PerfMetrics {
  [metric: string]: number;
}

/** The period limit scales with the work: person-months against the 300 x 12 reference. */
export function periodLimitMs(persons: number, months: number): number {
  const reference = 300 * 12;
  const scaled = (THRESHOLDS.periodFullMs.value * persons * months) / reference;
  return Math.min(THRESHOLDS.periodFullMs.value, Math.max(2_000, Math.round(scaled)));
}

export function monthsBack(today: string, count: number): { from: string; to: string } {
  const to = today.slice(0, 7);
  let [y, m] = to.split("-").map(Number);
  m -= count - 1;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  return { from: `${y}-${String(m).padStart(2, "0")}`, to };
}

export async function measure(
  ctx: CheckContext,
): Promise<{ metrics: PerfMetrics; persons: number }> {
  const chain = ctx.state.tenants.chain;
  const persons = Object.values(chain?.persons ?? {}).filter((p) => p.created).length;
  const metrics: PerfMetrics = {};
  for (const months of [1, 3, 12]) {
    const { from, to } = monthsBack(ctx.today, months);
    const res = await ctx.api.get(`/api/v1/reports/period?from=${from}&to=${to}`, ctx.adminToken);
    metrics[`period_${months}m_ms`] = res.status === 200 ? res.ms : -res.status;
  }
  const dash = await ctx.api.get("/api/v1/dashboard", ctx.adminToken);
  metrics.dashboard_ms = dash.status === 200 ? dash.ms : -dash.status;
  const prev = addDays(`${ctx.today.slice(0, 7)}-01`, -1);
  const status = await ctx.api.get(
    `/api/v1/overtime/close-month/status?year=${prev.slice(0, 4)}&month=${Number(prev.slice(5, 7))}`,
    ctx.adminToken,
  );
  metrics.month_close_status_ms = status.status === 200 ? status.ms : -status.status;
  const lastLog = ctx.dayLogs[ctx.dayLogs.length - 1];
  const closeMax = lastLog?.actions["month.close"]?.maxMs;
  if (closeMax !== undefined) metrics.month_close_action_max_ms = closeMax;
  return { metrics, persons };
}

export interface TrendLine {
  date: string;
  takenAt: string;
  persons: number;
  metrics: PerfMetrics;
}

export function readTrend(stateDir: string): TrendLine[] {
  const path = join(stateDir, "trend.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TrendLine);
}

export function appendTrend(stateDir: string, line: TrendLine): void {
  appendFileSync(join(stateDir, "trend.jsonl"), `${JSON.stringify(line)}\n`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Threshold and trend findings for one measurement against the earlier ones. */
export function judgePerf(now: TrendLine, history: readonly TrendLine[]): Finding[] {
  const findings: Finding[] = [];
  const add = (metric: string, message: string) =>
    findings.push({ invariant: "perf.response-times", key: `perf:${metric}`, message });

  for (const [metric, value] of Object.entries(now.metrics)) {
    if (value < 0) {
      add(`${metric}:status`, `${metric} answered with status ${-value} instead of 200.`);
      continue;
    }
    let limit: number | null = null;
    let source = "";
    const period = /^period_(\d+)m_ms$/.exec(metric);
    if (period) {
      limit = periodLimitMs(now.persons, Number(period[1]));
      source = `${THRESHOLDS.periodFullMs.source}, scaled to ${now.persons} persons`;
      if (value > THRESHOLDS.periodHardMs.value) {
        add(
          `${metric}:hard`,
          `${metric} took ${value} ms, above the hard limit ${THRESHOLDS.periodHardMs.value} ms (${THRESHOLDS.periodHardMs.source}).`,
        );
      }
    } else if (metric === "dashboard_ms") {
      limit = THRESHOLDS.dashboardMs.value;
      source = THRESHOLDS.dashboardMs.source;
    } else if (metric.startsWith("month_close")) {
      limit = THRESHOLDS.monthCloseMs.value;
      source = THRESHOLDS.monthCloseMs.source;
    }
    if (limit !== null && value > limit) {
      add(
        `${metric}:limit`,
        `${metric} took ${value} ms, above the limit ${limit} ms (${source}).`,
      );
    }
    const prior = history
      .slice(-7)
      .map((h) => h.metrics[metric])
      .filter((v): v is number => typeof v === "number" && v >= 0);
    if (prior.length >= 3) {
      const base = median(prior);
      if (value > THRESHOLDS.trendFloorMs.value && value > base * THRESHOLDS.trendFactor.value) {
        add(
          `${metric}:trend`,
          `${metric} took ${value} ms, more than ${THRESHOLDS.trendFactor.value}x the median ${Math.round(base)} ms of the last ${prior.length} runs.`,
        );
      }
    }
  }
  return findings;
}
