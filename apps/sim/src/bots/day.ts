/** One simulated day: admin, roster, people, manager, isolation. Entry point of `sim day`. */
import type { SimConfig } from "../config";
import { mapLimit } from "../http";
import type { SimTenantKey } from "../plan";
import { loadState, saveState } from "../state";
import { dayInTz } from "../tz";
import { adminDay } from "./admin";
import { BotContext, loadProgress, saveProgress, writeDayLog, type DayLog } from "./context";
import { employeeDay } from "./employee";
import { isolationDay } from "./isolation";
import { closeMonths, correctEntries, planShifts, reviewLeave } from "./manager";

export interface DayOptions {
  date?: string;
  concurrency?: number;
  /** Run a day again even though it was simulated before (its entries then collide). */
  force?: boolean;
  log?: (line: string) => void;
}

export async function runDay(config: SimConfig, options: DayOptions = {}): Promise<DayLog> {
  const log = options.log ?? (() => {});
  const day = options.date ?? dayInTz(new Date(), config.tz);
  const state = loadState(config.stateDir);
  const progress = loadProgress(config.stateDir);
  if (progress.daysSimulated.includes(day) && !options.force) {
    throw new Error(`Day ${day} was already simulated (use --force to run it again)`);
  }
  const ctx = new BotContext(config, state, progress, day);
  const tenants: SimTenantKey[] = ["chain", "small"];

  for (const key of tenants) {
    await adminDay(ctx, key);
    await planShifts(ctx, key);
  }
  saveState(config.stateDir, state);

  for (const key of tenants) {
    const { plan } = ctx.tenant(key);
    await mapLimit(plan.persons, options.concurrency ?? 6, (person) =>
      employeeDay(ctx, key, person),
    );
    log(`${key}: employees done`);
    await correctEntries(ctx, key);
    await reviewLeave(ctx, key);
    await closeMonths(ctx, key);
  }
  await isolationDay(ctx);

  if (!progress.daysSimulated.includes(day)) progress.daysSimulated.push(day);
  ctx.log.finishedAt = new Date().toISOString();
  saveProgress(config.stateDir, progress);
  writeDayLog(config.stateDir, ctx.log);
  return ctx.log;
}
