/**
 * Phase 75b (Issue #75, D-20, Pitfall 1, Pitfall 5) — runs one cell of the permission neutrality
 * matrix and reduces the response to a comparable record.
 *
 * A cell is (actor, route, variant). Its record holds
 *   - `status`;
 *   - `error`: the `error` string of a non-2xx JSON body (German, deterministic) — it separates
 *     two 403s with different reasons, which a status comparison cannot;
 *   - `ids`: the sorted multiset of every uuid found ANYWHERE in the body — in keys and values, in
 *     JSON and in text bodies (iCal, CSV) — mapped to fixture labels. A uuid glued to a short
 *     prefix (`rev-<uuid>`, `apikey:<uuid>`) keeps the prefix. A uuid of ANOTHER actor's tenant
 *     becomes `@<ACTOR>:<label>` (a cross-tenant leak shows by name); an unknown uuid becomes
 *     `<new>` (rows the request itself or the migration created);
 *   - `contentType` for non-JSON bodies;
 *   - route-specific `projections` where access decides masking rather than rows.
 *
 * Every request carries a UNIQUE `remoteAddress` and no X-Forwarded-For header: the global
 * `@fastify/rate-limit` store is keyed by `req.ip` (`trustProxy: true` resolves it to the inject
 * address when no XFF is sent), so no cell can be rate-limited by the cells before it.
 */
import type { FastifyInstance } from "fastify";
import type { ActorFixture, LabelRegistry } from "./fixture";
import {
  API_KEY_ACTORS,
  TENANT_LEVEL_KINDS,
  type ProjectionName,
  type RouteSpec,
  type VariantSpec,
} from "./matrix-config";
import { pathParams } from "./route-derivation";

export interface CellResult {
  status: number;
  error?: string;
  ids?: string[];
  contentType?: string;
  projections?: Record<string, unknown>;
}

type InjectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

let requestCounter = 0;

/** A fresh inject address per request: 10.<actor slot>.<n / 250>.<n % 250 + 1>. */
function nextRemoteAddress(actorSlot: number): string {
  const n = requestCounter++;
  return `10.${actorSlot}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}

/** Global labels valid in every tenant (system roles etc.). */
export type GlobalLabels = ReadonlyMap<string, string>;

export interface LabelContext {
  self: ActorFixture;
  others: readonly ActorFixture[];
  global: GlobalLabels;
}

function labelFor(ctx: LabelContext, id: string): string {
  const own = ctx.self.registry.labelOf(id);
  if (own !== undefined) return own;
  const global = ctx.global.get(id);
  if (global !== undefined) return global;
  for (const other of ctx.others) {
    const label = other.registry.labelOf(id);
    if (label !== undefined) return `@${other.actor}:${label}`;
  }
  return "<new>";
}

/** Replaces every uuid inside `text` by its label. */
export function relabel(ctx: LabelContext, text: string): string {
  return text.replace(new RegExp(UUID_SOURCE, "gi"), (m) => labelFor(ctx, m.toLowerCase()));
}

/** Every uuid in `text`, with an attached short prefix, as labels. */
function idsInText(ctx: LabelContext, text: string, out: string[]): void {
  const pattern = new RegExp(`([A-Za-z]{1,12}[-:])?(${UUID_SOURCE})`, "gi");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    out.push(`${m[1] ?? ""}${labelFor(ctx, m[2].toLowerCase())}`);
  }
}

function idsInJson(ctx: LabelContext, value: unknown, out: string[]): void {
  if (typeof value === "string") {
    idsInText(ctx, value, out);
  } else if (Array.isArray(value)) {
    for (const item of value) idsInJson(ctx, item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      idsInText(ctx, key, out);
      idsInJson(ctx, item, out);
    }
  }
}

/** Resolves `$<label>` placeholders (whole string values only) against the actor's registry. */
function resolvePlaceholders(registry: LabelRegistry, value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("$") ? registry.idOf(value.slice(1)) : value;
  }
  if (Array.isArray(value)) return value.map((item) => resolvePlaceholders(registry, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(registry, v)]),
    );
  }
  return value;
}

/** The label a path parameter of kind `kind` resolves to for `variant`. */
export function paramLabel(kind: string, variant: VariantSpec): string {
  if (TENANT_LEVEL_KINDS.has(kind)) return `tenant.${kind}`;
  if (variant.target !== "own" && variant.target !== "foreign") {
    throw new Error(
      `cell-runner: person-bound kind "${kind}" needs an own/foreign variant, got "${variant.target}"`,
    );
  }
  return `${variant.target}.${kind}`;
}

/** The variants of a route: the explicit list, or the default derived from its parameters. */
export function variantsOf(route: string, spec: RouteSpec): VariantSpec[] {
  if (spec.variants) return spec.variants;
  const kinds = pathParams(route).map((p) => {
    const kind = spec.params?.[p];
    if (kind === undefined) throw new Error(`cell-runner: ${route} has no kind for ":${p}"`);
    return kind;
  });
  if (kinds.length === 0) return [{ name: "none", target: "none" }];
  if (kinds.every((k) => TENANT_LEVEL_KINDS.has(k))) return [{ name: "tenant", target: "tenant" }];
  return [
    { name: "own", target: "own" },
    { name: "foreign", target: "foreign" },
  ];
}

/** Whether an actor runs a variant: API-key actors have no own person (a key has no employee). */
export function actorRunsVariant(actor: ActorFixture, variant: VariantSpec): boolean {
  return !(API_KEY_ACTORS.has(actor.actor) && variant.target === "own");
}

/** A top-level field of a 2xx JSON body. Throws when it is absent: a projection that reads a key
 * the response does not have would record `undefined` for every actor and prove nothing. */
function field(route: string, name: ProjectionName, body: unknown, key: string): unknown {
  if (body === null || typeof body !== "object" || !(key in body)) {
    throw new Error(`cell-runner: projection "${name}" of ${route} found no "${key}" in the body`);
  }
  return (body as Record<string, unknown>)[key];
}

function project(route: string, name: ProjectionName, body: unknown, ctx: LabelContext): unknown {
  if (name === "pendingApprovalsCount") {
    // `composition/dashboard.ts` answers the team-wide count as `pendingApprovals`.
    return field(route, name, body, "pendingApprovals");
  }
  if (name === "collisionTotal") {
    return field(route, name, body, "total");
  }
  if (name === "body") {
    return JSON.parse(relabel(ctx, JSON.stringify(body ?? null)));
  }
  if (!Array.isArray(body)) {
    throw new Error(`cell-runner: projection "${name}" of ${route} expects an array body`);
  }
  // leaveTypeMask: per leave item "<label of the request>:<typeCode or null>:<typeName present?>",
  // plus the § 9 marker where the item carries one (the calendar masks it together with the type).
  return body
    .map((raw) => {
      const item = raw as {
        id?: string;
        typeCode?: unknown;
        typeName?: unknown;
        section9?: unknown;
      };
      const label = typeof item.id === "string" ? relabel(ctx, item.id) : "<no id>";
      const code = typeof item.typeCode === "string" ? item.typeCode : "null";
      const named = item.typeName !== undefined && item.typeName !== null ? "named" : "unnamed";
      const section9 = "section9" in item ? `:s9=${String(item.section9)}` : "";
      return `${label}:${code}:${named}${section9}`;
    })
    .sort();
}

export interface RunCellArgs {
  app: FastifyInstance;
  ctx: LabelContext;
  actorSlot: number;
  route: string;
  spec: RouteSpec;
  variant: VariantSpec;
}

export async function runCell(args: RunCellArgs): Promise<CellResult> {
  const { app, ctx, route, spec, variant } = args;
  const registry = ctx.self.registry;
  const [method, template] = route.split(" ") as [InjectMethod, string];

  let url = template;
  for (const param of pathParams(route)) {
    const kind = spec.params?.[param];
    if (kind === undefined) throw new Error(`cell-runner: ${route} has no kind for ":${param}"`);
    url = url.replace(`:${param}`, registry.idOf(paramLabel(kind, variant)));
  }
  if (variant.query) {
    const query = resolvePlaceholders(registry, variant.query) as Record<string, string>;
    url += `?${new URLSearchParams(query).toString()}`;
  }

  const headers: Record<string, string> = { authorization: ctx.self.authorization };
  let payload: string | undefined;
  if (variant.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(resolvePlaceholders(registry, variant.body));
  }

  const res = await app.inject({
    method,
    url,
    headers,
    payload,
    remoteAddress: nextRemoteAddress(args.actorSlot),
  });

  const result: CellResult = { status: res.statusCode };
  const contentType = String(res.headers["content-type"] ?? "");
  const isJson = contentType.includes("application/json");
  const ids: string[] = [];
  let body: unknown = undefined;
  if (isJson && res.body.length > 0) {
    body = JSON.parse(res.body);
    idsInJson(ctx, body, ids);
    if (res.statusCode >= 300) {
      const error = (body as { error?: unknown } | null)?.error;
      if (typeof error === "string") result.error = relabel(ctx, error);
    }
  } else {
    result.contentType = contentType.split(";")[0].trim() || "<none>";
    if (contentType.startsWith("text/")) idsInText(ctx, res.body, ids);
  }
  result.ids = ids.sort();
  if (spec.projections && res.statusCode < 300) {
    result.projections = Object.fromEntries(
      spec.projections.map((name) => [name, project(route, name, body, ctx)]),
    );
  }
  return result;
}
