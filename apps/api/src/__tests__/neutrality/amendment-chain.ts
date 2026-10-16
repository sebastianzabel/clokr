/**
 * Issue #539 (D-15) — amendment CHAINS for the three neutrality registers.
 *
 * `recorded/matrix-amendments.json`, `recorded/recipients-amendments.json` and
 * `recorded/activity-auth-amendments.json` let a NAMED cell, site or entry of a recording carry a
 * different expected value than the recording itself, for a reason that is not the role -> permission
 * switch the recording proves neutral. The recordings stay byte-identical; the register names the
 * key, the exact `from`, the exact `to`, the issue, a written reason and a date.
 *
 * Until #539 a key could be amended ONCE. That is not enough any more: #333/#355/#367/#551 already
 * amended many FALLBACK cells and 16 of the 17 recipient sites, and removing the legacy-role fallback
 * (#539) changes some of those very cells a second time, for a second and later reason. A chain lets
 * one key carry several dated links, applied in FILE order:
 *
 *   - the first link's `from` equals the recorded value (for the recipients register: the recorded
 *     `recipients` list),
 *   - every next link's `from` equals the previous link's `to`,
 *   - dates never go back,
 *   - the effective expectation of the key is the LAST link's `to`.
 *
 * A register with one link per key is a chain of length one, so every pre-#539 register stays valid
 * unchanged. Appending, never overwriting, is also what lets two branches that both amend the same
 * register merge: the second one adds its link after the first one's.
 *
 * ONE module on purpose: the three neutrality tests use it for their register describe and for the
 * expectation of the verify sweep, and `scripts/neutrality-amendments-from-run.ts` uses it to decide
 * what a measured run is compared with — a second copy of this rule could drift from the tests.
 *
 * No I/O and no vitest import: the chain rule is a pure function over parsed JSON.
 */
import { isDeepStrictEqual } from "node:util";

export interface AmendmentLink<V> {
  readonly key: string;
  readonly from: V;
  readonly to: V;
  readonly issue: number;
  readonly reason: string;
  readonly date: string;
}

export interface AmendmentChainResult<V> {
  /** The last link per key in file order — what the verify sweep expects for that key. */
  readonly effective: ReadonlyMap<string, AmendmentLink<V>>;
  /** One line per violation; empty when every chain is valid. */
  readonly problems: string[];
}

/** Group links by key, keeping file order inside a group. */
export function groupAmendmentChains<V>(
  links: readonly AmendmentLink<V>[],
): ReadonlyMap<string, AmendmentLink<V>[]> {
  const chains = new Map<string, AmendmentLink<V>[]>();
  for (const link of links) {
    const chain = chains.get(link.key);
    if (chain) chain.push(link);
    else chains.set(link.key, [link]);
  }
  return chains;
}

/**
 * The effective link per key (the last one in file order), without any validation. The neutrality
 * tests need this at module load, before the recording is read; the register describe validates
 * the same links afterwards with `resolveAmendmentChains`.
 */
export function effectiveAmendmentLinks<V>(
  links: readonly AmendmentLink<V>[],
): ReadonlyMap<string, AmendmentLink<V>> {
  const effective = new Map<string, AmendmentLink<V>>();
  for (const [key, chain] of groupAmendmentChains(links)) {
    effective.set(key, chain[chain.length - 1]);
  }
  return effective;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate every chain and return the effective link per key.
 *
 * `recordedValueOf(key)` supplies the projection the register amends: the whole recorded entry
 * (matrix, activity-auth) or the recorded `recipients` list (recipients). It returns `undefined`
 * when the recording holds no such key. Omit it (RECORD mode, no recording loaded) to skip only the
 * checks against the recording; the link-level and chain-internal checks still run.
 *
 * Comparisons of `from` values are structural (`isDeepStrictEqual` on the parsed JSON).
 */
export function resolveAmendmentChains<V>(options: {
  links: readonly AmendmentLink<V>[];
  recordedValueOf?: (key: string) => V | undefined;
  minReasonLength: number;
}): AmendmentChainResult<V> {
  const { links, recordedValueOf, minReasonLength } = options;
  const problems: string[] = [];
  const chains = groupAmendmentChains(links);

  for (const [key, chain] of chains) {
    chain.forEach((link, index) => {
      const where = chain.length > 1 ? `${key} (link ${index + 1} of ${chain.length})` : key;
      if (!Number.isInteger(link.issue) || link.issue <= 0) {
        problems.push(
          `${where}: issue must be a positive integer, got ${JSON.stringify(link.issue)}`,
        );
      }
      if (typeof link.reason !== "string" || link.reason.trim().length < minReasonLength) {
        problems.push(`${where}: reason must be at least ${minReasonLength} characters`);
      }
      if (typeof link.date !== "string" || !ISO_DATE.test(link.date)) {
        problems.push(
          `${where}: date must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(link.date)}`,
        );
      }
      if (index === 0) return;
      const previous = chain[index - 1];
      if (ISO_DATE.test(link.date) && ISO_DATE.test(previous.date) && link.date < previous.date) {
        problems.push(
          `${where}: date ${link.date} is earlier than the previous link's ${previous.date} — chain dates never go back`,
        );
      }
      if (!isDeepStrictEqual(link.from, previous.to)) {
        problems.push(
          `${where}: chain broken — 'from' ${JSON.stringify(link.from)} does not equal the previous link's 'to' ${JSON.stringify(previous.to)}`,
        );
      }
    });

    if (recordedValueOf === undefined) continue;
    const recorded = recordedValueOf(key);
    if (recorded === undefined) {
      problems.push(
        `${key}: the recording holds no such key — a link for a route/actor/variant the recording never held is stale or invalid`,
      );
      continue;
    }
    if (!isDeepStrictEqual(chain[0].from, recorded)) {
      problems.push(
        `${key}: stale against the recording — first link's 'from' ${JSON.stringify(chain[0].from)} does not match the recorded ${JSON.stringify(recorded)}; the recording moved on and the chain must be re-derived`,
      );
    }
  }

  return { effective: effectiveAmendmentLinks(links), problems };
}
