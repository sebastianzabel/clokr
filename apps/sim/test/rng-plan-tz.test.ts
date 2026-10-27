import { describe, expect, it } from "vitest";
import { rngFor } from "../src/rng";
import { buildPopulation, countKinds, FULL_SIZE, SMALL_SIZE } from "../src/plan";
import { addDays, dayInTz, localIso, weekdayOf } from "../src/tz";

describe("rng", () => {
  it("gives the same numbers for the same keys, independent of other streams", () => {
    const a = rngFor("seed", "day", "2026-11-03", "p1");
    rngFor("seed", "day", "2026-11-03", "p2").next(); // another stream in between
    const b = rngFor("seed", "day", "2026-11-03", "p1");
    expect([a.next(), a.next(), a.int(1, 100)]).toEqual([b.next(), b.next(), b.int(1, 100)]);
  });

  it("differs for another seed or key", () => {
    expect(rngFor("a", "x").next()).not.toBe(rngFor("b", "x").next());
    expect(rngFor("a", "x").next()).not.toBe(rngFor("a", "y").next());
  });

  it("weighted() respects the weights roughly and never picks a zero weight", () => {
    const rng = rngFor("w");
    const picks = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 4000; i += 1) {
      picks[
        rng.weighted([
          { value: "a" as const, weight: 3 },
          { value: "b" as const, weight: 1 },
          { value: "c" as const, weight: 0 },
        ])
      ] += 1;
    }
    expect(picks.c).toBe(0);
    expect(picks.a / picks.b).toBeGreaterThan(2.3);
    expect(picks.a / picks.b).toBeLessThan(3.9);
  });
});

describe("population plan", () => {
  const full = buildPopulation("clokr-sim-1", "2026-11-02", FULL_SIZE);

  it("is deterministic from the seed and differs for another seed", () => {
    expect(buildPopulation("clokr-sim-1", "2026-11-02", FULL_SIZE)).toEqual(full);
    expect(buildPopulation("other", "2026-11-02", FULL_SIZE)).not.toEqual(full);
  });

  it("has the chain tenant of the issue: 30 salons, 300 people, a second small tenant", () => {
    const [chain, small] = full.tenants;
    expect(chain.salons).toHaveLength(30);
    expect(chain.persons).toHaveLength(300);
    expect(small.persons.length).toBeGreaterThan(0);
    expect(small.persons.length).toBeLessThan(20);
  });

  it("covers every contract model, minors, Springer, exits and later hires at full size", () => {
    const chain = full.tenants[0].persons;
    const kinds = countKinds(chain);
    for (const [kind, n] of Object.entries(kinds)) expect(n, kind).toBeGreaterThan(0);
    expect(chain.some((p) => p.plannedExitDay !== null)).toBe(true);
    expect(chain.some((p) => p.hireDate > "2026-11-02")).toBe(true);
    expect(
      chain.filter((p) => p.kind === "MONTHLY_NO_HOURS").every((p) => p.monthlyHours === null),
    ).toBe(true);
    expect(
      chain.filter((p) => p.kind === "MONTHLY_HOURS").every((p) => (p.monthlyHours ?? 0) > 0),
    ).toBe(true);
    expect(
      chain.filter((p) => p.kind === "SPRINGER").every((p) => p.extraSalonIndexes.length > 0),
    ).toBe(true);
    const minors = chain.filter((p) => p.kind === "MINOR");
    expect(minors.length).toBeGreaterThan(0);
    for (const m of minors) {
      const born = Number(m.birthDate?.slice(0, 4));
      expect(2026 - born).toBeLessThan(18);
    }
    for (const a of chain.filter((p) => p.kind === "AZUBI" || p.kind === "MINOR")) {
      expect(a.schoolDay).not.toBeNull();
    }
  });

  it("covers every kind and every clock channel even at the small size", () => {
    const small = buildPopulation("clokr-sim-1", "2026-11-02", SMALL_SIZE).tenants[0].persons;
    const kinds = countKinds(small);
    for (const [kind, n] of Object.entries(kinds)) expect(n, kind).toBeGreaterThan(0);
    expect(new Set(small.map((p) => p.channel))).toEqual(new Set(["WEB", "WIFI", "NFC"]));
  });

  it("is obviously synthetic: fake addresses, no real-looking names, unique keys", () => {
    const all = full.tenants.flatMap((t) => t.persons);
    expect(all.every((p) => p.email.endsWith("@sim.invalid"))).toBe(true);
    expect(all.every((p) => /^Bot-[A-Z]\d{4}$/.test(p.lastName))).toBe(true);
    expect(new Set(all.map((p) => p.key)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.employeeNumber)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.nfcCardId).filter(Boolean)).size).toBe(
      all.filter((p) => p.nfcCardId).length,
    );
  });
});

describe("calendar helpers", () => {
  it("resolves the tenant-local day and wall clock across the DST change", () => {
    expect(localIso("2026-10-24", "09:00")).toBe("2026-10-24T07:00:00.000Z"); // CEST
    expect(localIso("2026-10-26", "09:00")).toBe("2026-10-26T08:00:00.000Z"); // CET
    expect(dayInTz(new Date("2026-10-27T23:30:00Z"))).toBe("2026-10-28");
  });
  it("computes weekdays and day arithmetic", () => {
    expect(weekdayOf("2026-10-27")).toBe(2);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
