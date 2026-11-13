/**
 * The second tenant's bot (Issue #715): systematically asks for the first tenant's ids and must get
 * exactly the answer an id that exists nowhere gets (T-100-09). It records the pair of answers; the
 * checker judges them.
 */
import { randomUUID } from "node:crypto";
import { BotContext, type IsolationProbe } from "./context";

interface Probe {
  name: string;
  method: "GET" | "PUT" | "DELETE" | "PATCH";
  path: (id: string) => string;
  body?: unknown;
  kind: "employee" | "salon" | "entry" | "leave";
}

const PROBES: Probe[] = [
  {
    name: "GET /employees/:id",
    method: "GET",
    path: (id) => `/api/v1/employees/${id}`,
    kind: "employee",
  },
  {
    name: "GET /overtime/:employeeId",
    method: "GET",
    path: (id) => `/api/v1/overtime/${id}`,
    kind: "employee",
  },
  { name: "GET /salons/:id", method: "GET", path: (id) => `/api/v1/salons/${id}`, kind: "salon" },
  {
    name: "GET /time-entries/summary",
    method: "GET",
    path: (id) => `/api/v1/time-entries/summary?employeeId=${id}&from=2026-01-01&to=2026-01-31`,
    kind: "employee",
  },
  {
    name: "DELETE /time-entries/:id",
    method: "DELETE",
    path: (id) => `/api/v1/time-entries/${id}`,
    kind: "entry",
  },
  {
    name: "PATCH /leave/requests/:id/review",
    method: "PATCH",
    path: (id) => `/api/v1/leave/requests/${id}/review`,
    body: { status: "REJECTED" },
    kind: "leave",
  },
];

export async function isolationDay(ctx: BotContext): Promise<void> {
  const chain = ctx.tenant("chain").state;
  const small = ctx.tenant("small").state;
  const rng = ctx.rng("isolation");
  const admin = await ctx.sessionFor(small.adminEmail, small.adminPassword);

  // Only the first tenant's ids are "foreign" for the second tenant's admin. Taking an id of the
  // admin's own tenant here would make the probe meaningless and, for a DELETE, destructive.
  const chainPlan = ctx.tenant("chain").plan;
  const ids = {
    employee: Object.values(chain.persons)
      .filter((p) => p.created)
      .map((p) => p.employeeId),
    salon: chain.salonIds,
    entry: ctx.progress.sampleEntryIds,
    leave: chainPlan.persons.flatMap((p) => ctx.progress.leave[p.key] ?? []).map((l) => l.id),
  };

  for (const probe of PROBES) {
    const pool = ids[probe.kind];
    if (pool.length === 0) continue;
    for (const foreignId of rng.shuffle(pool).slice(0, 2)) {
      const run = (id: string) =>
        ctx.api.request(probe.method, probe.path(id), { token: admin.token, body: probe.body });
      const foreign = await ctx.call("isolation.probe", () => run(foreignId), [404]);
      const unknown = await ctx.call("isolation.probe", () => run(randomUUID()), [404]);
      if (!foreign || !unknown) continue;
      const result: IsolationProbe = {
        probe: probe.name,
        foreignStatus: foreign.status,
        unknownStatus: unknown.status,
        identical:
          foreign.status === unknown.status &&
          JSON.stringify(foreign.body) === JSON.stringify(unknown.body),
      };
      ctx.log.isolation.push(result);
    }
  }
}
