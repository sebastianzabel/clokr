/**
 * Invariants decided through the same API the web uses (Issue #715): the figures a person or a
 * manager sees must agree wherever the product shows the same number twice. Read-only GETs.
 */
import { rngFor } from "../rng";
import { result } from "./invariants-db";
import type { CheckContext, Finding, Invariant } from "./types";

interface Live {
  balanceHours: number;
  confirmedMinutes: number;
  openMonthMinutes: number;
}

const TOLERANCE_MINUTES = 1;
const minutes = (hours: number) => Math.round(hours * 60);

/** Pure comparison, separately testable: returns one message per disagreement. */
export function compareLiveFigures(input: {
  ledger: Live;
  leaveSurface: Live | null;
  overview: Live | null;
  periodClosingMinutes: number | null;
}): string[] {
  const out: string[] = [];
  const { ledger } = input;
  const chain = ledger.confirmedMinutes + ledger.openMonthMinutes;
  if (Math.abs(chain - minutes(ledger.balanceHours)) > TOLERANCE_MINUTES) {
    out.push(
      `Live saldo ${minutes(ledger.balanceHours)} min differs from carry plus open months ${chain} min.`,
    );
  }
  for (const [name, other] of [
    ["leave surface", input.leaveSurface],
    ["overview", input.overview],
  ] as const) {
    if (!other) continue;
    if (
      Math.abs(minutes(other.balanceHours) - minutes(ledger.balanceHours)) > TOLERANCE_MINUTES ||
      other.confirmedMinutes !== ledger.confirmedMinutes ||
      other.openMonthMinutes !== ledger.openMonthMinutes
    ) {
      out.push(`The ${name} shows other saldo figures than the overtime account.`);
    }
  }
  if (
    input.periodClosingMinutes !== null &&
    Math.abs(input.periodClosingMinutes - minutes(ledger.balanceHours)) > TOLERANCE_MINUTES
  ) {
    out.push(
      `The period report closing ${input.periodClosingMinutes} min differs from the live saldo ${minutes(ledger.balanceHours)} min.`,
    );
  }
  return out;
}

const pickLive = (b: Record<string, unknown>): Live => ({
  balanceHours: Number(b.balanceHours ?? 0),
  confirmedMinutes: Number(b.confirmedMinutes ?? 0),
  openMonthMinutes: Number(b.openMonthMinutes ?? 0),
});

export const SAMPLE_SIZE = 25;

export const saldoConsistency: Invariant = {
  id: "saldo.consistent",
  title: "Live saldo, overview and period report show one number",
  async run(ctx: CheckContext) {
    const chain = ctx.state.tenants.chain;
    const plan = ctx.state.plan.tenants.find((t) => t.key === "chain");
    if (!chain || !plan) return result(saldoConsistency, 0, []);
    const rng = rngFor(ctx.seed, "saldo-sample", ctx.today);
    const eligible = plan.persons.filter(
      (p) => chain.persons[p.key]?.created && !chain.persons[p.key].anonymized,
    );
    const sample = rng.shuffle(eligible).slice(0, SAMPLE_SIZE);

    const overview = await ctx.api.get<{ employees?: (Live & { id: string })[] }>(
      "/api/v1/dashboard/overtime-overview",
      ctx.adminToken,
    );
    const overviewById = new Map((overview.body.employees ?? []).map((e) => [e.id, e]));
    const month = ctx.today.slice(0, 7);
    const period = await ctx.api.get<{
      rows?: { employeeId: string; closingBalanceMinutes: number | null }[];
    }>(`/api/v1/reports/period?from=${month}&to=${month}`, ctx.adminToken);
    const periodById = new Map((period.body.rows ?? []).map((r) => [r.employeeId, r]));

    const findings: Finding[] = [];
    let examined = 0;
    for (const person of sample) {
      const id = chain.persons[person.key].employeeId;
      const ledgerRes = await ctx.api.get<Record<string, unknown>>(
        `/api/v1/overtime/${id}`,
        ctx.adminToken,
      );
      if (ledgerRes.status !== 200) continue;
      const leaveRes = await ctx.api.get<Record<string, unknown>>(
        `/api/v1/leave/overtime-balance?employeeId=${id}`,
        ctx.adminToken,
      );
      examined += 1;
      const ov = overviewById.get(id);
      for (const message of compareLiveFigures({
        ledger: pickLive(ledgerRes.body),
        leaveSurface:
          leaveRes.status === 200 && leaveRes.body.balanceVisible !== false
            ? pickLive(leaveRes.body)
            : null,
        overview: ov ? pickLive(ov as unknown as Record<string, unknown>) : null,
        periodClosingMinutes: periodById.get(id)?.closingBalanceMinutes ?? null,
      })) {
        findings.push({
          invariant: "saldo.consistent",
          key: `saldo:${id}:${ctx.today}`,
          group: "saldo",
          message: `Employee ${id}: ${message}`,
        });
      }
    }
    return result(saldoConsistency, examined, findings);
  },
};

export const API_INVARIANTS: Invariant[] = [saldoConsistency];
