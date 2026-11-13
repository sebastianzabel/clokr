import type { ApiClient } from "../http";
import type { DayLog, Progress } from "../bots/context";
import type { SimState } from "../state";

/** A violation. `key` is stable across runs (used to avoid duplicate issues); `message` has ids only. */
export interface Finding {
  invariant: string;
  key: string;
  /**
   * The cause class this finding belongs to. One open issue exists per group, however many rows
   * show the symptom (a systemic cause must not file one issue per employee and day). Absent means
   * the key is the group.
   */
  group?: string;
  message: string;
}

export interface InvariantResult {
  id: string;
  title: string;
  /** How many rows or entities the check looked at. Zero is suspicious (see runChecks). */
  examined: number;
  findings: Finding[];
}

/** The only database interface the checker has: a query function on a read-only connection. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface ChecksumState {
  entries: Record<string, string>;
  snapshots: Record<string, string>;
}

export interface CheckContext {
  db: Queryable;
  api: ApiClient;
  /** Token of the chain tenant's admin (read-only use). */
  adminToken: string;
  state: SimState;
  progress: Progress;
  dayLogs: DayLog[];
  seed: string;
  today: string;
  /** Start of the window the audit-coverage check looks at. */
  since: Date;
  checksums: ChecksumState;
  /** Filled by the closed-months check: the baseline the next run compares against. */
  nextChecksums?: ChecksumState;
}

export interface Invariant {
  id: string;
  title: string;
  /** True when "examined nothing" is legitimate (for example before the first closed month). */
  mayBeEmpty?: boolean;
  run(ctx: CheckContext): Promise<InvariantResult>;
}
