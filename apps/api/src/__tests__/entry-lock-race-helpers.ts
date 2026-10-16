/**
 * Issue #70 (Phase 70b-04) — test helper: provoke the race the Employee row lock exists for.
 *
 * `holdEmployeeLockThen` takes the shared writer lock (`lockEmployeeForEntryWrite`) in a
 * transaction of its own, starts the request under test, waits until the database reports that
 * request's backend as BLOCKED by the holder (synchronised on observed state, never on a fixed
 * sleep), lets the holder write its competing rows and commit, and only then lets the request
 * continue. A writer that locks first and re-checks inside its transaction therefore sees the
 * holder's committed rows; a writer without the lock (or with a check before it) does not.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { lockEmployeeForEntryWrite } from "../contexts/time-tracking/entry-write-lock";

export interface LockRaceResult<T> {
  result: T;
  /** PostgreSQL reported a backend waiting on the holder while it held the lock. */
  blocked: boolean;
}

export async function holdEmployeeLockThen<T>(
  app: FastifyInstance,
  params: {
    tenantId: string;
    employeeId: string;
    /** Starts the request under test; called while the holder owns the lock. */
    start: () => Promise<T>;
    /** The competing write, run inside the holder transaction after the waiter was observed. */
    holderWork: (tx: Prisma.TransactionClient) => Promise<void>;
  },
): Promise<LockRaceResult<T>> {
  let signalLocked: ((pid: number) => void) | undefined;
  const locked = new Promise<number>((resolve) => {
    signalLocked = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const holder = app.prisma.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await lockEmployeeForEntryWrite(tx, params.tenantId, params.employeeId);
      signalLocked?.(pid);
      await gate;
      await params.holderWork(tx);
    },
    { timeout: 30000, maxWait: 30000 },
  );
  const holderPid = await Promise.race([
    locked,
    holder.then(
      () => Promise.reject(new Error("holder transaction ended before it took the lock")),
      (err: unknown) => Promise.reject(err),
    ),
  ]);

  const pending = params.start();
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const deadline = Date.now() + 15000;
  let blocked = false;
  while (!settled && Date.now() < deadline) {
    const [{ n }] = await app.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (n > 0) {
      blocked = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  release?.();
  await holder;
  const result = await pending;
  return { result, blocked };
}
