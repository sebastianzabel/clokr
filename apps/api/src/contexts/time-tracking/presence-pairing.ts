// Issue #610 (Phase 610-01, D-04..D-09, P-610-01/03/06/07) — the WLAN pairing service.
//
// Three operations around one `PresencePairingCode` row:
//   - `issuePairingCode`  the adapter (presence-source key) registers a one-time code for a MAC
//   - `previewPairing`    the signed-in person sees what the code would couple (read-only)
//   - `confirmPairing`    the signed-in person confirms with consent; ONE transaction claims the code,
//                         creates the device and records the consent
//
// The service takes plain values and never a request object; the routes stay thin. The raw code exists
// only in the return value of `issuePairingCode` — storage, logs and audits see its SHA-256 at most.
// Every Prisma call carries `tenantId` in its `where` (lint:tenant-scoping), raw SQL goes through
// `Prisma.sql` tagged templates (parameterised, never string-built).

import { Prisma } from "@clokr/db";
import type { PrismaClient } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import {
  PAIRING_CODE_PATTERN,
  PAIRING_CODE_TTL_MS,
  generatePairingCode,
  hashPairingCode,
  macTail,
} from "./pairing-code";

// ── issue ────────────────────────────────────────────────────────────────────────────────────

export interface IssuePairingCodeInput {
  tenantId: string;
  presenceSourceId: string;
  /** Already normalised (`normalizeMac`). */
  mac: string;
  /** Already sanitised (`sanitizeHostname`). */
  hostname: string | null;
  now: Date;
}

/**
 * Registers a fresh code for a MAC. Every UNCONSUMED code of the same tenant and MAC is deleted first
 * (supersede: at most one live code per device), in the same transaction as the insert; a consumed
 * code stays as the trace of its pairing. A transaction-scoped advisory lock keyed by tenant and MAC
 * serialises two concurrent issues for one device so "at most one live code" holds under a race too.
 */
export async function issuePairingCode(
  db: PrismaClient,
  input: IssuePairingCodeInput,
): Promise<{ code: string; expiresAt: Date }> {
  const { tenantId, presenceSourceId, mac, hostname, now } = input;
  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pairing-code:${tenantId}:${mac}`}, 0))`;
    await tx.presencePairingCode.deleteMany({ where: { tenantId, mac, consumedAt: null } });
    await tx.presencePairingCode.create({
      data: {
        tenantId,
        presenceSourceId,
        codeHash: hashPairingCode(code),
        mac,
        hostname,
        expiresAt,
        createdAt: now,
      },
    });
  });

  return { code, expiresAt };
}

// ── owner lock ───────────────────────────────────────────────────────────────────────────────

export interface PresenceOwner {
  userActive: boolean;
  wifiPresenceEnabled: boolean;
  wifiOptInAt: Date | null;
}

/**
 * The ONE lock on the person who owns presence devices: their Employee and User rows
 * (`FOR NO KEY UPDATE`, tenant clause included), taken FIRST in every transaction that adds or removes
 * presence devices or changes the consent (confirm here, the withdrawal in plan 02) so the two cannot
 * interleave. Returns `null` when the employee does not exist in the tenant.
 */
export async function lockPresenceOwner(
  tx: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
): Promise<PresenceOwner | null> {
  return readPresenceOwner(tx, employeeId, tenantId, true);
}

async function readPresenceOwner(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  lock: boolean,
): Promise<PresenceOwner | null> {
  const rows = await db.$queryRaw<
    { isActive: boolean; wifiPresenceEnabled: boolean; wifiOptInAt: Date | null }[]
  >(
    Prisma.sql`SELECT u."isActive" AS "isActive", e."wifiPresenceEnabled" AS "wifiPresenceEnabled", e."wifiOptInAt" AS "wifiOptInAt"
      FROM "Employee" e JOIN "User" u ON u.id = e."userId"
      WHERE e.id = ${employeeId} AND e."tenantId" = ${tenantId}
      ${lock ? Prisma.sql`FOR NO KEY UPDATE OF e, u` : Prisma.empty}`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userActive: row.isActive,
    wifiPresenceEnabled: row.wifiPresenceEnabled,
    wifiOptInAt: row.wifiOptInAt,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────────────────────

export interface PairingPreview {
  deviceLabel: string | null;
  macTail: string;
  replacesDevice: boolean;
  alreadyPaired: boolean;
  expiresAt: Date;
}

/**
 * Read-only: what would this code couple for the caller? `null` for every invalid state (the route
 * answers the one uniform 404). It never says whether the MAC belongs to someone else — the confirm
 * answers that with 409.
 */
export async function previewPairing(
  db: Prisma.TransactionClient,
  input: { tenantId: string; employeeId: string; code: string; now: Date },
): Promise<PairingPreview | null> {
  const { tenantId, employeeId, code, now } = input;
  if (!PAIRING_CODE_PATTERN.test(code)) return null;

  const owner = await readPresenceOwner(db, employeeId, tenantId, false);
  if (!owner || !owner.userActive) return null;

  const row = await db.presencePairingCode.findFirst({
    where: { tenantId, codeHash: hashPairingCode(code) },
    include: { presenceSource: { select: { isActive: true, revokedAt: true, deletedAt: true } } },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  if (
    !row.presenceSource.isActive ||
    row.presenceSource.revokedAt ||
    row.presenceSource.deletedAt
  ) {
    return null;
  }

  const devices = await db.presenceDevice.findMany({
    where: { tenantId, employeeId },
    select: { mac: true, pairedVia: true },
  });
  return {
    deviceLabel: row.hostname,
    macTail: macTail(row.mac),
    replacesDevice: devices.some((d) => d.pairedVia === "QR" && d.mac !== row.mac),
    alreadyPaired: devices.some((d) => d.mac === row.mac),
    expiresAt: row.expiresAt,
  };
}

// ── confirm ──────────────────────────────────────────────────────────────────────────────────

export interface ConfirmPairingInput {
  tenantId: string;
  employeeId: string;
  userId: string;
  code: string;
  /** The audit request context (ip and headers) as plain values — the service reads no request. */
  request: { ip: string; headers: Record<string, string | string[] | undefined> };
  now?: Date;
}

export interface ConfirmedDevice {
  id: string;
  mac: string;
  label: string | null;
  pairedVia: "MANUAL" | "QR";
  addedAt: Date;
  lastSeenAt: Date | null;
}

export type ConfirmPairingResult =
  | {
      kind: "OK";
      status: 201 | 200;
      body: {
        device: ConfirmedDevice;
        replacedDevices: number;
        wifiPresenceEnabled: true;
        wifiOptInAt: Date;
      };
      replacedDeviceIds: string[];
    }
  | { kind: "INVALID" }
  | { kind: "TAKEN" };

interface LockedCodeRow {
  id: string;
  presenceSourceId: string;
  mac: string;
  hostname: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Claims a code and couples the device with consent, in ONE transaction (P-610-07):
 * (1) lock the caller's Employee and User rows; (2) lock the code row and check it is unconsumed,
 * unexpired and from an active source; (3) refuse a MAC that is already mapped; (4) mark the code
 * consumed; (6) create the device; (7) record the consent. Refusals return before anything is
 * written, so a refused code stays unconsumed.
 */
export async function confirmPairing(
  app: FastifyInstance,
  input: ConfirmPairingInput,
): Promise<ConfirmPairingResult> {
  const { tenantId, employeeId, userId, code, request } = input;
  if (!PAIRING_CODE_PATTERN.test(code)) return { kind: "INVALID" };
  const codeHash = hashPairingCode(code);

  return app.prisma.$transaction(async (tx): Promise<ConfirmPairingResult> => {
    const now = input.now ?? new Date();

    // (1) the owner lock — Employee + User, always first
    const owner = await lockPresenceOwner(tx, employeeId, tenantId);
    if (!owner || !owner.userActive) return { kind: "INVALID" };

    // (2) the code row, locked for the claim
    const rows = await tx.$queryRaw<LockedCodeRow[]>(
      Prisma.sql`SELECT id, "presenceSourceId", mac, hostname, "expiresAt", "consumedAt"
        FROM "PresencePairingCode"
        WHERE "codeHash" = ${codeHash} AND "tenantId" = ${tenantId}
        FOR UPDATE`,
    );
    const row = rows[0];
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
      return { kind: "INVALID" };
    }
    const source = await tx.presenceSource.findFirst({
      where: {
        id: row.presenceSourceId,
        tenantId,
        isActive: true,
        revokedAt: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!source) return { kind: "INVALID" };

    // (3) the MAC must not be mapped to anyone yet (plan 02 turns "mapped to the caller" into a refresh)
    const existing = await tx.presenceDevice.findUnique({
      where: { tenantId_mac: { tenantId, mac: row.mac } },
      select: { id: true },
    });
    if (existing) return { kind: "TAKEN" };

    // (4) consume the code (guarded: the row lock already serialises, the predicate keeps it honest)
    const claimed = await tx.presencePairingCode.updateMany({
      where: { id: row.id, tenantId, consumedAt: null },
      data: { consumedAt: now, consumedByUserId: userId },
    });
    if (claimed.count !== 1) return { kind: "INVALID" };

    // (6) the device
    const device = await tx.presenceDevice.create({
      data: {
        tenantId,
        employeeId,
        mac: row.mac,
        label: row.hostname,
        addedByUserId: userId,
        pairedVia: "QR",
      },
      select: {
        id: true,
        mac: true,
        label: true,
        pairedVia: true,
        addedAt: true,
        lastSeenAt: true,
      },
    });

    // (7) consent — the explicit tap on the confirm button is the consent act
    await tx.employee.update({
      where: { id: employeeId, tenantId },
      data: { wifiPresenceEnabled: true, wifiOptInAt: now },
      select: { id: true },
    });

    // Consent changes are permanently retained: never `purgeable`.
    await app.audit({
      userId,
      action: "UPDATE",
      entity: "Employee",
      entityId: employeeId,
      oldValue: {
        wifiPresenceEnabled: owner.wifiPresenceEnabled,
        wifiOptInAt: owner.wifiOptInAt,
      },
      newValue: { wifiPresenceEnabled: true, wifiOptInAt: now, consentVia: "QR_PAIRING" },
      request,
      tx,
    });
    await app.audit({
      userId,
      action: "CREATE",
      entity: "PresenceDevice",
      entityId: device.id,
      newValue: {
        mac: device.mac,
        label: device.label,
        pairedVia: "QR",
        presenceSourceId: row.presenceSourceId,
      },
      request,
      tx,
    });

    return {
      kind: "OK",
      status: 201,
      body: { device, replacedDevices: 0, wifiPresenceEnabled: true, wifiOptInAt: now },
      replacedDeviceIds: [],
    };
  });
}
