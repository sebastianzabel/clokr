/**
 * Phase 259 Plan 02 (Issue #259, D-03/D-03a/D-05/D-06/D-06a/D-07) — the pure, zero-I/O half of the
 * `lint-t100-09-routes` gate. Mirrors the `lint-e2e-spec-registry.ts` / `-validate.ts` split: every
 * export here is a pure function of its arguments (no `readFileSync`, no `readdirSync`, no
 * `process.exit`, no `Date.now()`), so `apps/api/scripts/__tests__/lint-t100-09-routes-validate.test.ts`
 * can drive it entirely from in-memory fixtures. All disk I/O lives in the CLI wrapper,
 * `./lint-t100-09-routes.ts`.
 *
 * ── What this checker classifies ─────────────────────────────────────────────────────────────────
 * Every route in `apps/api/src/contexts/*\/api/**\/*.ts` that carries a path parameter (a URL
 * segment starting with `:`) must have exactly one checked-in entry in
 * `apps/api/scripts/lint-t100-09-routes.json`, classified `probe` / `nicht anwendbar` /
 * `bekannt-abweichend`, each with a measured `reason` (D-05). The DERIVED set — not the register —
 * is authoritative: an entry for a route that no longer exists is STALE (caught here), and a
 * derived route with no entry is MISSING (caught by `diffRegisterAgainstRoutes`, the other
 * direction). This is what lets deleting a handler's `CROSS_TENANT_ACCESS_DENIED` audit call NOT
 * remove that route from the checked set (D-03, corrected) — membership comes from parsing source
 * text, never from the presence of the audit call.
 *
 * ── Route derivation, three pieces (D-03 corrected: source text, not Fastify's route tree) ────────
 * `extractRouteDeclarations` finds every `app.<method>("<path>"` call — newline-tolerant between
 * the open-paren and the opening quote, the shape `company-shutdowns.ts:183` uses — and attributes
 * each to the nearest PRECEDING `export async function <name>(` declaration in the same file. This
 * is a start-offset bucketing, not a brace-matching parse: it is immune to `{`/`}` characters
 * inside regex literals or string bodies (several route files declare zod schemas with
 * `/^\d{4}-\d{2}-\d{2}$/`-shaped regexes ahead of their route function), because it never counts
 * braces at all. It is correct exactly because every route file in this codebase places its
 * `app.<method>` calls strictly inside a top-level exported route function and never nests one
 * exported function inside another — both measured facts, not assumptions.
 *
 * `extractPrefixMap` resolves each exported function name to the URL prefix it is registered under
 * in `apps/api/src/app.ts`, by reading BOTH the `app.register(<fn>, { prefix: "…" })` calls AND the
 * named-import statements that bring `<fn>` into scope — including a MULTI-LINE named import (the
 * shape `app.ts` actually uses for `shiftPatternRoutes` / `shiftPatternTenantRoutes`). Resolving
 * through the import binding, not just the local identifier used at the call site, means a renamed
 * import (`import { fooRoutes as barRoutes }`) still resolves back to the route file's OWN export
 * name — the name `extractRouteDeclarations` attributes routes to — so the join key matches
 * regardless of which local alias `app.ts` happens to use. No file in this codebase renames a route
 * import today; the resolution is built to not silently break the day one does.
 *
 * `joinRoutes` combines the two: a declaration whose `exportedFn` has no prefix-map entry is an
 * ERROR (`unresolved`), never a silently dropped route — this is precisely how the two
 * `shift-patterns.ts` route functions, registered under two DIFFERENT prefixes from the same file,
 * would vanish under a naive file→prefix map instead of this function→prefix one.
 *
 * ── The register's two-direction check (D-03a) ─────────────────────────────────────────────────
 * `validateRegisterDocument` answers "is this JSON well-formed, and does every entry point at a
 * route that still exists in the derived set" (shape, category enum, reason length, duplicate
 * `route`, the `params`/`minimalBody`/`ticket`/`validatedAt` field rules, STALE-entry detection).
 * `diffRegisterAgainstRoutes` answers the other direction — "does every DERIVED path-parameter
 * route have an entry" (missing-entry detection).
 *
 * ── D-06a, corrected: an offline expiry date, never a network call ────────────────────────────────
 * `findExpiredDeviations` takes `nowIso` as a PARAMETER, injected by the caller
 * (`./lint-t100-09-routes.ts` passes `new Date().toISOString()`; the unit test pins an arbitrary
 * value to test the 89/90/91-day boundary without waiting for a calendar). No GitHub API call, no
 * network dependency — a `bekannt-abweichend` entry rots by DATE, not by an external service's
 * uptime (D-06a, corrected: the original "verify the ticket is OPEN" design had no in-repo
 * precedent and would silently pass offline or without a token — another check that looks without
 * seeing).
 *
 * ── House-form notes ──────────────────────────────────────────────────────────────────────────
 * The three German category values (`CATEGORIES`) are kept verbatim as string literals — they are
 * the owner's decided DATA values (D-06/D-07's own vocabulary), not code identifiers — the same
 * call `lint-e2e-spec-registry-validate.ts` already made and documented for its own three.
 */

export const CATEGORIES = ["probe", "nicht anwendbar", "bekannt-abweichend"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Matches the family convention (`lint-guard-vacuity.ts` / `lint-e2e-spec-registry-validate.ts`'s
 * own `MIN_REASON_LENGTH`) — "a measured sentence, never a label". */
export const MIN_REASON_LENGTH = 30;

/** D-06a, corrected: a `bekannt-abweichend` entry older than this many days is expired. */
export const DEFAULT_MAX_DEVIATION_AGE_DAYS = 90;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface RouteDeclaration {
  exportedFn: string;
  method: string;
  path: string;
  line: number;
}

export interface RegisterEntry {
  route: string;
  file: string;
  category: Category;
  params: Record<string, string> | null;
  minimalBody: Record<string, unknown> | null;
  reason: string;
  ticket: number | null;
  validatedAt: string | null;
}

export interface RegisterDocument {
  registerSource: string;
  entries: RegisterEntry[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

/**
 * Finds every `export async function <name>(` declaration's start offset (source order), and every
 * `app.<method>("<path>"` call — newline-tolerant between `app.<method>(` and the opening quote,
 * required for `company-shutdowns.ts:183`'s `app.delete(\n  "/:id/exceptions/:employeeId",` shape —
 * then attributes each call to the nearest preceding exported function. A call before any exported
 * function declaration is attributed to `null` (never silently dropped — the caller decides what a
 * `null` owner means; `joinRoutes` treats it as unresolved).
 */
export function extractRouteDeclarations(
  sourceText: string,
  _fileRelPath: string,
): RouteDeclaration[] {
  const fnStarts: { name: string; offset: number }[] = [];
  const fnRe = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(sourceText))) {
    fnStarts.push({ name: fm[1], offset: fm.index });
  }
  fnStarts.sort((a, b) => a.offset - b.offset);

  function ownerFor(offset: number): string | null {
    let owner: string | null = null;
    for (const fn of fnStarts) {
      if (fn.offset <= offset) owner = fn.name;
      else break;
    }
    return owner;
  }

  const methodAlt = HTTP_METHODS.join("|");
  const routeRe = new RegExp(`app\\.(${methodAlt})\\(\\s*\\n?\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const declarations: RouteDeclaration[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = routeRe.exec(sourceText))) {
    const owner = ownerFor(rm.index);
    const line = sourceText.slice(0, rm.index).split("\n").length;
    declarations.push({
      exportedFn: owner ?? "<module-level, no enclosing exported function>",
      method: rm[1].toUpperCase(),
      path: rm[2],
      line,
    });
  }
  return declarations;
}

/**
 * Resolves every exported route-function name to its registration prefix in `app.ts`, by reading
 * BOTH the named-import statements (multi-line-tolerant, alias-aware) and the
 * `app.register(<fn>, { prefix: "…" })` calls, and joining through the import binding so a renamed
 * local identifier still resolves back to the route file's own export name.
 */
export function extractPrefixMap(appTsText: string): Map<string, string> {
  const localToOriginal = new Map<string, string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(appTsText))) {
    const body = im[1];
    for (const rawItem of body.split(",")) {
      const item = rawItem.trim();
      if (!item) continue;
      const asMatch = item.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch) {
        localToOriginal.set(asMatch[2], asMatch[1]);
      } else if (/^\w+$/.test(item)) {
        localToOriginal.set(item, item);
      }
    }
  }

  const prefixMap = new Map<string, string>();
  const registerRe = /app\.register\(\s*(\w+)\s*,\s*\{([^}]*)\}\s*\)/g;
  let rm: RegExpExecArray | null;
  while ((rm = registerRe.exec(appTsText))) {
    const localIdent = rm[1];
    const optionsBody = rm[2];
    const prefixMatch = optionsBody.match(/prefix:\s*["']([^"']+)["']/);
    if (!prefixMatch) continue; // plugin registration without a prefix — not a route module
    const originalName = localToOriginal.get(localIdent) ?? localIdent;
    prefixMap.set(originalName, prefixMatch[1]);
  }
  return prefixMap;
}

/**
 * Joins route declarations against the prefix map into the full `"<METHOD> <url>"` set. An
 * exported function with no prefix-map entry is an ERROR (`unresolved`), never a silent drop.
 */
export function joinRoutes(
  declarations: readonly RouteDeclaration[],
  prefixMap: ReadonlyMap<string, string>,
): { routes: string[]; unresolved: string[] } {
  const routes = new Set<string>();
  const unresolvedSet = new Set<string>();
  for (const d of declarations) {
    const prefix = prefixMap.get(d.exportedFn);
    if (prefix === undefined) {
      unresolvedSet.add(d.exportedFn);
      continue;
    }
    const url = d.path === "/" ? prefix : `${prefix}${d.path}`;
    routes.add(`${d.method} ${url}`);
  }
  return { routes: [...routes].sort(), unresolved: [...unresolvedSet].sort() };
}

/** A URL segment beginning with `:` — the derivation rule that decides register membership (D-05). */
export function hasPathParameter(url: string): boolean {
  return url.split("/").some((seg) => seg.startsWith(":"));
}

/** The `:name` segments of a `"<METHOD> <url>"` route string's URL half, in order, without the colon. */
export function pathParamNames(route: string): string[] {
  const url = route.split(" ")[1] ?? "";
  return url
    .split("/")
    .filter((seg) => seg.startsWith(":"))
    .map((seg) => seg.slice(1));
}

/**
 * Validates a raw (untyped) register document's SHAPE — object/array structure, non-empty
 * `registerSource`, per-entry `route`/`file`/`category`/`reason`/`params`/`minimalBody`/`ticket`/
 * `validatedAt`, duplicate `route` detection — and, given `derivedRoutes`, flags any entry whose
 * `route` is not among them as STALE. Fails CLOSED: any error means `{ ok: false }`. Does NOT check
 * for a derived route with no entry at all — that is `diffRegisterAgainstRoutes`'s job.
 */
export function validateRegisterDocument(
  raw: unknown,
  derivedRoutes: readonly string[],
): { ok: true; doc: RegisterDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["register document must be a JSON object"] };
  }

  const { registerSource, entries } = raw;
  if (typeof registerSource !== "string" || registerSource.trim().length === 0) {
    errors.push("'registerSource' must be a non-empty string");
  }
  if (!Array.isArray(entries)) {
    errors.push("'entries' must be an array");
    return { ok: false, errors };
  }

  const derivedSet = new Set(derivedRoutes);
  const seenRoutes = new Set<string>();
  const validEntries: RegisterEntry[] = [];

  (entries as unknown[]).forEach((entry, index) => {
    const label =
      isRecord(entry) && typeof entry.route === "string" ? entry.route : `entry #${index}`;

    if (!isRecord(entry)) {
      errors.push(`${label}: entry is not an object`);
      return;
    }

    const { route, file, category, params, minimalBody, reason, ticket, validatedAt } = entry;

    if (typeof route !== "string" || route.trim().length === 0) {
      errors.push(`${label}: 'route' must be a non-empty string`);
      return;
    }
    if (seenRoutes.has(route)) {
      errors.push(`${label}: duplicate entry for '${route}'`);
    } else {
      seenRoutes.add(route);
    }

    if (typeof file !== "string" || file.trim().length === 0) {
      errors.push(`${label}: 'file' must be a non-empty string`);
    }

    if (!isCategory(category)) {
      errors.push(
        `${label}: 'category' must be one of ${CATEGORIES.join(", ")} — got ${JSON.stringify(category)}`,
      );
    }

    if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(
        `${label}: 'reason' must be a string of at least ${MIN_REASON_LENGTH} characters — a ` +
          `measured sentence naming file:line, never a label`,
      );
    }

    if (minimalBody !== null && !isRecord(minimalBody)) {
      errors.push(`${label}: 'minimalBody' must be null or an object`);
    }

    if (isCategory(category)) {
      if (category === "probe") {
        if (!isRecord(params) || Object.keys(params).length === 0) {
          errors.push(
            `${label}: 'params' is required for category 'probe' — one key per path parameter`,
          );
        } else {
          const expected = new Set(pathParamNames(route));
          const actual = new Set(Object.keys(params));
          const missing = [...expected].filter((p) => !actual.has(p));
          const extra = [...actual].filter((p) => !expected.has(p));
          if (missing.length > 0) {
            errors.push(
              `${label}: 'params' is missing key(s) for path parameter(s): ${missing.join(", ")}`,
            );
          }
          if (extra.length > 0) {
            errors.push(
              `${label}: 'params' has key(s) not present as a path parameter: ${extra.join(", ")}`,
            );
          }
          for (const [k, v] of Object.entries(params)) {
            if (typeof v !== "string" || v.trim().length === 0) {
              errors.push(`${label}: 'params.${k}' must be a non-empty string`);
            }
          }
        }
        if (ticket !== null || validatedAt !== null) {
          errors.push(`${label}: 'ticket'/'validatedAt' must be null for category 'probe'`);
        }
      } else {
        if (params !== null) {
          errors.push(`${label}: 'params' must be null for category '${category}'`);
        }
        if (category === "bekannt-abweichend") {
          if (typeof ticket !== "number" || !Number.isInteger(ticket) || ticket <= 0) {
            errors.push(
              `${label}: 'ticket' must be a positive integer for category 'bekannt-abweichend'`,
            );
          }
          if (typeof validatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(validatedAt)) {
            errors.push(
              `${label}: 'validatedAt' must be an ISO date (YYYY-MM-DD) for category 'bekannt-abweichend'`,
            );
          }
        } else if (ticket !== null || validatedAt !== null) {
          errors.push(`${label}: 'ticket'/'validatedAt' must be null for category '${category}'`);
        }
      }
    }

    if (!derivedSet.has(route)) {
      errors.push(`${label}: STALE — '${route}' is not among the derived path-parameter routes`);
      return;
    }

    if (
      typeof file === "string" &&
      file.trim().length > 0 &&
      isCategory(category) &&
      typeof reason === "string" &&
      reason.trim().length >= MIN_REASON_LENGTH
    ) {
      validEntries.push({
        route,
        file,
        category,
        params: (params as Record<string, string> | null | undefined) ?? null,
        minimalBody: (minimalBody as Record<string, unknown> | null | undefined) ?? null,
        reason,
        ticket: (ticket as number | null | undefined) ?? null,
        validatedAt: (validatedAt as string | null | undefined) ?? null,
      });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { registerSource: registerSource as string, entries: validEntries } };
}

/**
 * The other direction of D-03a: every DERIVED path-parameter route must have exactly one register
 * entry. A route with no entry is named individually — never an aggregate count.
 */
export function diffRegisterAgainstRoutes(
  entries: readonly RegisterEntry[],
  derivedRoutes: readonly string[],
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const entryRoutes = new Set(entries.map((e) => e.route));
  for (const route of derivedRoutes) {
    if (!entryRoutes.has(route)) {
      errors.push(
        `'${route}' has no register entry — every path-parameter route must appear exactly once`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/**
 * D-06a, corrected: a `bekannt-abweichend` entry whose `validatedAt` is older than `maxAgeDays`
 * (default 90) is expired. `nowIso` is a PARAMETER — see module docblock for why.
 */
export function findExpiredDeviations(
  entries: readonly RegisterEntry[],
  nowIso: string,
  maxAgeDays: number = DEFAULT_MAX_DEVIATION_AGE_DAYS,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const nowMs = Date.parse(nowIso);
  for (const entry of entries) {
    if (entry.category !== "bekannt-abweichend") continue;
    if (!entry.validatedAt) continue; // already flagged by validateRegisterDocument
    const validatedMs = Date.parse(entry.validatedAt);
    const ageDays = Math.floor((nowMs - validatedMs) / (24 * 60 * 60 * 1000));
    if (ageDays > maxAgeDays) {
      errors.push(
        `'${entry.route}' is 'bekannt-abweichend' with validatedAt ${entry.validatedAt}, ${ageDays} ` +
          `days ago — older than the ${maxAgeDays}-day expiry (ticket #${entry.ticket}); re-validate or fix`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}
