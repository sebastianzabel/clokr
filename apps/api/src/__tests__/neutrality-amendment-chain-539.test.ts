/**
 * Issue #539 (D-15) — the chain rule of the three neutrality amendment registers, DB-free.
 *
 * `neutrality/amendment-chain.ts` is the only place a chain is validated; the three neutrality tests
 * and `scripts/neutrality-amendments-from-run.ts` call it. These cases pin the rule on synthetic
 * recordings so a loosened rule turns red here, not silently in a register nobody re-reads.
 */
import { describe, it, expect } from "vitest";
import {
  effectiveAmendmentLinks,
  resolveAmendmentChains,
  type AmendmentLink,
} from "./neutrality/amendment-chain";

type Cell = { status: number; ids: string[] };

const REASON = "a written reason of well over twenty characters";
const MIN = 20;

const recording: Record<string, Cell> = {
  "A | GET /x | own": { status: 403, ids: [] },
  "B | GET /y | own": { status: 200, ids: ["one"] },
};

function link(
  partial: Partial<AmendmentLink<Cell>> & Pick<AmendmentLink<Cell>, "key" | "from" | "to">,
): AmendmentLink<Cell> {
  return { issue: 100, reason: REASON, date: "2026-09-25", ...partial };
}

function resolve(links: AmendmentLink<Cell>[]) {
  return resolveAmendmentChains<Cell>({
    links,
    recordedValueOf: (key) => recording[key],
    minReasonLength: MIN,
  });
}

describe("amendment chains (Issue #539, D-15)", () => {
  it("a single link whose 'from' equals the recording is valid and its 'to' is the effective value", () => {
    const only = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const result = resolve([only]);
    expect(result.problems).toEqual([]);
    expect(result.effective.get("A | GET /x | own")?.to).toEqual({ status: 200, ids: [] });
  });

  it("two links on one key chain: link 2 starts at link 1's 'to', the effective value is link 2's 'to'", () => {
    const first = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const second = link({
      key: "A | GET /x | own",
      from: { status: 200, ids: [] },
      to: { status: 404, ids: [] },
      issue: 539,
      date: "2026-10-15",
    });
    const result = resolve([first, second]);
    expect(result.problems).toEqual([]);
    expect(result.effective.get("A | GET /x | own")).toBe(second);
  });

  it("a second link on the same date is valid (dates may stay equal, never go back)", () => {
    const first = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const second = link({
      key: "A | GET /x | own",
      from: { status: 200, ids: [] },
      to: { status: 404, ids: [] },
    });
    expect(resolve([first, second]).problems).toEqual([]);
  });

  it("links of different keys may be interleaved in the file; each key is its own chain", () => {
    const a1 = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const b1 = link({
      key: "B | GET /y | own",
      from: { status: 200, ids: ["one"] },
      to: { status: 200, ids: [] },
    });
    const a2 = link({
      key: "A | GET /x | own",
      from: { status: 200, ids: [] },
      to: { status: 404, ids: [] },
    });
    const result = resolve([a1, b1, a2]);
    expect(result.problems).toEqual([]);
    expect(result.effective.size).toBe(2);
    expect(result.effective.get("A | GET /x | own")).toBe(a2);
    expect(result.effective.get("B | GET /y | own")).toBe(b1);
  });

  it("link 2 whose 'from' differs from link 1's 'to' is exactly one problem naming the key and 'chain broken'", () => {
    const first = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const second = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 404, ids: [] },
    });
    const { problems } = resolve([first, second]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A | GET /x | own");
    expect(problems[0]).toContain("chain broken");
  });

  it("a first link whose 'from' differs from the recorded value is one problem 'stale against the recording'", () => {
    const stale = link({
      key: "A | GET /x | own",
      from: { status: 500, ids: [] },
      to: { status: 200, ids: [] },
    });
    const { problems } = resolve([stale]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("A | GET /x | own");
    expect(problems[0]).toContain("stale against the recording");
  });

  it("a link on a key the recording does not hold is one problem", () => {
    const orphan = link({
      key: "Z | GET /nope | own",
      from: { status: 1, ids: [] },
      to: { status: 2, ids: [] },
    });
    const { problems } = resolve([orphan]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Z | GET /nope | own");
  });

  it("two links on a key the recording does not hold are still one problem for that key", () => {
    const first = link({
      key: "Z | GET /nope | own",
      from: { status: 1, ids: [] },
      to: { status: 2, ids: [] },
    });
    const second = link({
      key: "Z | GET /nope | own",
      from: { status: 2, ids: [] },
      to: { status: 3, ids: [] },
    });
    expect(resolve([first, second]).problems).toHaveLength(1);
  });

  it("a non-ISO date is one problem", () => {
    const bad = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
      date: "25.09.2026",
    });
    const { problems } = resolve([bad]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("date");
  });

  it("a non-positive or non-integer issue is one problem each", () => {
    const zero = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
      issue: 0,
    });
    const fractional = link({
      key: "B | GET /y | own",
      from: { status: 200, ids: ["one"] },
      to: { status: 200, ids: [] },
      issue: 1.5,
    });
    expect(resolve([zero]).problems).toHaveLength(1);
    expect(resolve([fractional]).problems).toHaveLength(1);
  });

  it("a reason shorter than the minimum is one problem", () => {
    const terse = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
      reason: "too short",
    });
    const { problems } = resolve([terse]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reason");
  });

  it("a date earlier than the previous link's is one problem", () => {
    const first = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
      date: "2026-10-01",
    });
    const second = link({
      key: "A | GET /x | own",
      from: { status: 200, ids: [] },
      to: { status: 404, ids: [] },
      date: "2026-09-30",
    });
    const { problems } = resolve([first, second]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("never go back");
  });

  it("'from' is compared structurally, not by property order or identity", () => {
    const reordered = link({
      key: "B | GET /y | own",
      from: { ids: ["one"], status: 200 } as Cell,
      to: { status: 200, ids: [] },
    });
    expect(resolve([reordered]).problems).toEqual([]);
  });

  it("without a recording only the recording-independent checks run (RECORD mode)", () => {
    const orphan = link({
      key: "Z | GET /nope | own",
      from: { status: 1, ids: [] },
      to: { status: 2, ids: [] },
    });
    const result = resolveAmendmentChains<Cell>({ links: [orphan], minReasonLength: MIN });
    expect(result.problems).toEqual([]);
    expect(result.effective.size).toBe(1);
  });

  it("effectiveAmendmentLinks needs no recording and picks the last link per key in file order", () => {
    const first = link({
      key: "A | GET /x | own",
      from: { status: 403, ids: [] },
      to: { status: 200, ids: [] },
    });
    const second = link({
      key: "A | GET /x | own",
      from: { status: 200, ids: [] },
      to: { status: 404, ids: [] },
    });
    expect(effectiveAmendmentLinks([first, second]).get("A | GET /x | own")).toBe(second);
  });

  it("an empty register is valid and has no effective link", () => {
    const result = resolve([]);
    expect(result.problems).toEqual([]);
    expect(result.effective.size).toBe(0);
  });

  it("a recipients-style register (string lists) chains the same way", () => {
    const recorded: Record<string, string[]> = { "#01 site": ["R.admin", "R.exited"] };
    const result = resolveAmendmentChains<string[]>({
      links: [
        {
          key: "#01 site",
          from: ["R.admin", "R.exited"],
          to: ["R.admin"],
          issue: 355,
          reason: REASON,
          date: "2026-09-25",
        },
        {
          key: "#01 site",
          from: ["R.admin"],
          to: [],
          issue: 539,
          reason: REASON,
          date: "2026-10-15",
        },
      ],
      recordedValueOf: (key) => recorded[key],
      minReasonLength: MIN,
    });
    expect(result.problems).toEqual([]);
    expect(result.effective.get("#01 site")?.to).toEqual([]);
  });
});
