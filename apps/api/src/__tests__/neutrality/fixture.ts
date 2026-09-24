/**
 * Phase 75b (Issue #75, D-20, D-21, D-25) — the fixture of the permission neutrality matrix.
 *
 * Every actor gets its OWN tenant (`buildActorTenant`): one actor's successful mutation can never
 * mask another actor's cell, and tenant-wide writes (close-month, settings, holidays) stay inside
 * the actor that made them. Each tenant holds
 *   - the actor itself (a legacy-role user with an Employee, or a `clk_` API key),
 *   - an "own" person (for user actors: the actor's own Employee; for API-key actors a plain
 *     employee that is NOT linked to the key — a key has no employee),
 *   - a "foreign" person of the same tenant,
 *   - an anchor admin (legacy ADMIN with an Employee) that no cell ever targets, so the 74b
 *     lockout guard never trips when an actor deactivates or anonymizes someone (Pitfall 4),
 *   - its own copies of every tenant-level entity.
 *
 * Every id the builder creates — including the rows `seedTestData` creates — is registered in a
 * label registry under an actor-relative label (`own.employee`, `foreign.user`,
 * `tenant.leaveType.VACATION`, …). The cell runner replaces every uuid in a response with its
 * label, so a recording is comparable across runs although every run creates new ids.
 *
 * No person names: fixture people carry role-descriptive names only.
 */
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Role } from "@clokr/db";
import { seedTestData } from "../setup";
import type { JwtPayload } from "../../middleware/auth";
import { API_KEY_ACTORS, type ActorKind } from "./matrix-config";

/** A bijective id ↔ label map for one actor's tenant. */
export class LabelRegistry {
  private readonly labelById = new Map<string, string>();
  private readonly idByLabel = new Map<string, string>();

  register(label: string, id: string): void {
    const existingLabel = this.labelById.get(id);
    if (existingLabel !== undefined) {
      throw new Error(`fixture: id of "${label}" is already registered as "${existingLabel}"`);
    }
    if (this.idByLabel.has(label)) {
      throw new Error(`fixture: label "${label}" is registered twice`);
    }
    this.labelById.set(id, label);
    this.idByLabel.set(label, id);
  }

  labelOf(id: string): string | undefined {
    return this.labelById.get(id);
  }

  idOf(label: string): string {
    const id = this.idByLabel.get(label);
    if (id === undefined) {
      throw new Error(`fixture: no entity is registered under the label "${label}"`);
    }
    return id;
  }

  has(label: string): boolean {
    return this.idByLabel.has(label);
  }

  get size(): number {
    return this.idByLabel.size;
  }
}

export interface ActorFixture {
  actor: ActorKind;
  tenantId: string;
  /** The `authorization` header value the actor's requests carry. */
  authorization: string;
  /** The user id of a user actor; undefined for an API-key actor. */
  actorUserId?: string;
  registry: LabelRegistry;
}

/** The legacy role of the actor's own person. API-key tenants get a plain employee. */
function ownPersonRole(actor: ActorKind): Role {
  if (actor === "MANAGER" || actor === "FALLBACK_MANAGER") return "MANAGER";
  if (actor === "ADMIN" || actor === "FALLBACK_ADMIN") return "ADMIN";
  return "EMPLOYEE";
}

/** A cheap, valid-shaped password hash: no cell logs in with it. */
const UNUSED_PASSWORD_HASH = "$2a$10$abcdefghijklmnopqrstuuMatrixFixtureHashNotUsedForLogin00";

interface PersonRows {
  userId: string;
  employeeId: string;
}

/** Creates a user + employee with a work schedule and an overtime account, and registers all four
 * ids under `<prefix>.user`, `<prefix>.employee`, `<prefix>.workSchedule`, `<prefix>.overtimeAccount`. */
async function createPerson(
  app: FastifyInstance,
  registry: LabelRegistry,
  opts: { tenantId: string; tenantSlug: string; prefix: string; role: Role; lastName: string },
): Promise<PersonRows> {
  const prisma = app.prisma;
  const user = await prisma.user.create({
    data: {
      email: `${opts.prefix}-${opts.tenantSlug}@matrix.test`,
      passwordHash: UNUSED_PASSWORD_HASH,
      role: opts.role,
      isActive: true,
    },
  });
  const employee = await prisma.employee.create({
    data: {
      tenantId: opts.tenantId,
      userId: user.id,
      employeeNumber: `${opts.prefix.toUpperCase()}-${opts.tenantSlug}`,
      firstName: "Matrix",
      lastName: opts.lastName,
      hireDate: new Date("2024-01-01"),
    },
  });
  const schedule = await prisma.workSchedule.create({
    data: {
      employeeId: employee.id,
      weeklyHours: 40,
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
      validFrom: new Date("2024-01-01"),
    },
  });
  const account = await prisma.overtimeAccount.create({
    data: { employeeId: employee.id, balanceHours: 0 },
  });
  registry.register(`${opts.prefix}.user`, user.id);
  registry.register(`${opts.prefix}.employee`, employee.id);
  registry.register(`${opts.prefix}.workSchedule`, schedule.id);
  registry.register(`${opts.prefix}.overtimeAccount`, account.id);
  return { userId: user.id, employeeId: employee.id };
}

/** Registers the rows `seedTestData` created for one of its two persons. */
async function registerSeedPerson(
  app: FastifyInstance,
  registry: LabelRegistry,
  prefix: string,
  person: { userId: string; employeeId: string },
): Promise<void> {
  registry.register(`${prefix}.user`, person.userId);
  registry.register(`${prefix}.employee`, person.employeeId);
  const schedule = await app.prisma.workSchedule.findFirstOrThrow({
    where: { employeeId: person.employeeId },
  });
  registry.register(`${prefix}.workSchedule`, schedule.id);
  const account = await app.prisma.overtimeAccount.findUniqueOrThrow({
    where: { employeeId: person.employeeId },
  });
  registry.register(`${prefix}.overtimeAccount`, account.id);
}

/** Creates an API key with a known raw value; returns the raw `clk_` key. */
async function createApiKey(
  app: FastifyInstance,
  registry: LabelRegistry,
  opts: { tenantId: string; label: string; name: string; scopes: string[]; createdBy: string },
): Promise<string> {
  const raw = `clk_${randomBytes(24).toString("hex")}`;
  const row = await app.prisma.apiKey.create({
    data: {
      tenantId: opts.tenantId,
      name: opts.name,
      keyHash: createHash("sha256").update(raw).digest("hex"),
      keyPrefix: raw.slice(0, 8),
      scopes: opts.scopes,
      createdBy: opts.createdBy,
    },
  });
  registry.register(opts.label, row.id);
  return raw;
}

/**
 * Builds one actor's tenant: `seedTestData` (its admin becomes the anchor admin, its employee the
 * foreign person), the own person with the actor's legacy role, the API keys, and — from Task 2 on
 * — every entity kind the route specs substitute.
 */
export async function buildActorTenant(
  app: FastifyInstance,
  actor: ActorKind,
): Promise<ActorFixture> {
  const registry = new LabelRegistry();
  const seed = await seedTestData(app, `75b-matrix-${actor.toLowerCase()}`);
  const tenantId = seed.tenant.id;
  const tenantSlug = seed.tenant.slug;
  registry.register("tenant", tenantId);
  const config = await app.prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  registry.register("tenant.config", config.id);
  registry.register("tenant.salon.default", seed.salonId);
  registry.register("tenant.leaveType.VACATION", seed.vacationType.id);

  await registerSeedPerson(app, registry, "anchor.admin", {
    userId: seed.adminUser.id,
    employeeId: seed.adminEmployee.id,
  });
  await registerSeedPerson(app, registry, "foreign", {
    userId: seed.empUser.id,
    employeeId: seed.employee.id,
  });
  const foreignEntitlement = await app.prisma.leaveEntitlement.findFirstOrThrow({
    where: { employeeId: seed.employee.id },
  });
  registry.register("foreign.entitlement.VACATION", foreignEntitlement.id);

  const ownRole = ownPersonRole(actor);
  const own = await createPerson(app, registry, {
    tenantId,
    tenantSlug,
    prefix: "own",
    role: ownRole,
    lastName: API_KEY_ACTORS.has(actor) ? "Ohne Schluessel" : "Akteur",
  });

  // The DELETE target of `/api-keys/:id` — never the actor's own key (75b-RESEARCH Q6).
  await createApiKey(app, registry, {
    tenantId,
    label: "tenant.apiKey.secondary",
    name: "Matrix Zweitschluessel",
    scopes: [],
    createdBy: seed.adminUser.id,
  });

  let authorization: string;
  let actorUserId: string | undefined;
  if (API_KEY_ACTORS.has(actor)) {
    const raw = await createApiKey(app, registry, {
      tenantId,
      label: "actor.apiKey",
      name: "Matrix Akteur-Schluessel",
      scopes: actor === "APIKEY_ADMIN" ? ["admin"] : [],
      createdBy: seed.adminUser.id,
    });
    authorization = `Bearer ${raw}`;
  } else {
    const payload: JwtPayload = {
      sub: own.userId,
      role: ownRole,
      tenantId,
      employeeId: own.employeeId,
    };
    authorization = `Bearer ${app.jwt.sign(payload)}`;
    actorUserId = own.userId;
  }

  return { actor, tenantId, authorization, actorUserId, registry };
}
