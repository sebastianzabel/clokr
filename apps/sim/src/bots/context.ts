/**
 * Shared context of one simulated day (Issue #715). Holds the API client, the session cache, the
 * persisted progress between days and the recorder that turns every call into a counted outcome.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config";
import { ApiClient, login, type ApiResult, type Session } from "../http";
import type { PersonSpec, SimTenantKey, TenantPlan } from "../plan";
import { tenantState, type SimState, type TenantState } from "../state";
import { rngFor, type Rng } from "../rng";
import { dayInTz } from "../tz";
import type { PendingNachtrag } from "./decisions";

/** A deliberate rule violation a bot introduced; the checker expects exactly these findings. */
export interface Intent {
  date: string;
  tenant: SimTenantKey;
  person: string;
  kind: "LONG_DAY" | "NO_BREAK" | "OPEN_ENTRY";
}

export interface LeaveRecord {
  id: string;
  start: string;
  end: string;
  type: "VACATION" | "SICK" | "SICK_CHILD";
  /** User id of the manager who approved it (a cancellation needs somebody else). */
  approvedBy?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLATION_REQUESTED" | "CANCELLED";
}

export interface ShiftRecord {
  start: string;
  end: string;
  salonIndex: number;
}

export interface Progress {
  shiftsPlannedThrough: Partial<Record<SimTenantKey, string>>;
  /** person key -> day -> shift (both tenants share the key space, keys are prefixed). */
  shifts: Record<string, Record<string, ShiftRecord>>;
  leave: Record<string, LeaveRecord[]>;
  closedMonths: Record<string, true>;
  intents: Intent[];
  /** Weekly hours after a contract change by the admin bot (person key -> hours). */
  weeklyHours: Record<string, number>;
  holidayMonths: string[];
  /** A bounded sample of foreign ids the isolation bot probes with. */
  sampleEntryIds: string[];
  daysSimulated: string[];
  /** Bookings left out on purpose that are filed as a Zeitnachtrag once the retro window is over. */
  nachtraege: PendingNachtrag[];
  /** Months the admin bot deliberately unlocked (and the manager bot closed again). */
  unlocks: { tenant: SimTenantKey; employeeId: string; month: string; date: string }[];
}

export function emptyProgress(): Progress {
  return {
    shiftsPlannedThrough: {},
    shifts: {},
    leave: {},
    closedMonths: {},
    weeklyHours: {},
    holidayMonths: [],
    intents: [],
    sampleEntryIds: [],
    daysSimulated: [],
    nachtraege: [],
    unlocks: [],
  };
}

export function loadProgress(stateDir: string): Progress {
  const path = join(stateDir, "progress.json");
  if (!existsSync(path)) return emptyProgress();
  return { ...emptyProgress(), ...(JSON.parse(readFileSync(path, "utf8")) as Progress) };
}

export function saveProgress(stateDir: string, progress: Progress): void {
  const path = join(stateDir, "progress.json");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(progress, null, 1));
  renameSync(tmp, path);
}

export interface ActionCount {
  ok: number;
  refused: number;
  error: number;
  /** Sum and maximum of the response times in milliseconds (the checker's trend input). */
  totalMs: number;
  maxMs: number;
}

export interface IsolationProbe {
  probe: string;
  foreignStatus: number;
  unknownStatus: number;
  identical: boolean;
}

export interface DayLog {
  date: string;
  startedAt: string;
  finishedAt: string | null;
  actions: Record<string, ActionCount>;
  /** Server errors (5xx) and transport failures seen while using the real interfaces. */
  anomalies: { action: string; status: number }[];
  isolation: IsolationProbe[];
  intents: Intent[];
}

export class BotContext {
  readonly api: ApiClient;
  readonly log: DayLog;
  /** Entries the bots booked during this run, for the manager's correction pass. */
  readonly createdEntries: { id: string; endTime: string; tenant: SimTenantKey }[] = [];
  /** The real calendar day of the run (the simulated day may lie in the past during a replay). */
  readonly realToday: string;
  private readonly sessions = new Map<string, { session: Session; at: number }>();

  constructor(
    readonly config: SimConfig,
    readonly state: SimState,
    readonly progress: Progress,
    readonly day: string,
    api?: ApiClient,
  ) {
    this.api = api ?? new ApiClient(config.apiUrl);
    this.realToday = dayInTz(new Date(), config.tz);
    this.log = {
      date: day,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      actions: {},
      anomalies: [],
      isolation: [],
      intents: [],
    };
  }

  rng(...keys: string[]): Rng {
    return rngFor(this.config.seed, "day", this.day, ...keys);
  }

  tenant(key: SimTenantKey): { plan: TenantPlan; state: TenantState } {
    const plan = this.state.plan.tenants.find((t) => t.key === key);
    if (!plan) throw new Error(`No plan for tenant ${key}`);
    return { plan, state: tenantState(this.state, key) };
  }

  /** Logs in as the person (cached for ten minutes: access tokens live fifteen). */
  async sessionFor(email: string, password: string): Promise<Session> {
    const cached = this.sessions.get(email);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.session;
    const session = await login(this.api, email, password);
    this.sessions.set(email, { session, at: Date.now() });
    return session;
  }

  async personSession(person: PersonSpec): Promise<Session> {
    return this.sessionFor(person.email, person.password);
  }

  /**
   * Runs one API call and counts the outcome: a status in `ok` is a success, any other 4xx is a
   * business refusal the system is allowed to give, a 5xx or a transport failure is an anomaly the
   * checker reports.
   */
  async call<T>(
    action: string,
    fn: () => Promise<ApiResult<T>>,
    ok: readonly number[] = [200, 201, 204],
  ): Promise<ApiResult<T> | null> {
    const count = (this.log.actions[action] ??= {
      ok: 0,
      refused: 0,
      error: 0,
      totalMs: 0,
      maxMs: 0,
    });
    try {
      const res = await fn();
      count.totalMs += res.ms;
      count.maxMs = Math.max(count.maxMs, res.ms);
      if (ok.includes(res.status)) count.ok += 1;
      else if (res.status >= 500) {
        count.error += 1;
        this.log.anomalies.push({ action, status: res.status });
      } else count.refused += 1;
      return res;
    } catch {
      count.error += 1;
      this.log.anomalies.push({ action, status: 0 });
      return null;
    }
  }

  intend(intent: Omit<Intent, "date">): void {
    const full = { ...intent, date: this.day };
    this.progress.intents.push(full);
    this.log.intents.push(full);
  }
}

export function writeDayLog(stateDir: string, log: DayLog): void {
  const dir = join(stateDir, "logs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${log.date}.json`), JSON.stringify(log, null, 1));
}
