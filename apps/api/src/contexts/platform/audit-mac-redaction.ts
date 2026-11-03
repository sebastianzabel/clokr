/**
 * Issue #820 - the ONE place a device MAC address inside the AuditLog old/new values of an
 * anonymized person is redacted (DSGVO Art. 17; a MAC bound to a person's device is personal data,
 * Art. 4 Nr. 1 DSGVO). Sibling of `audit-freetext-redaction.ts` (#512): rows are never deleted, who
 * (ids, actor stamp), when (createdAt), what (action, entity, entityId) and every figure stay; only
 * the address is replaced by "[ausgeblendet]".
 *
 * Decided by KEY and SHAPE, never by an action list, so the next writer that audits a MAC is covered
 * without a code change:
 *   - KEY: every string leaf under a key whose camel/snake tokens contain `mac`, `macs`,
 *     `macAddress` or `macAddresses` (`mac`, `oldMac`, `wifi_mac`, `macs: [...]`);
 *   - SHAPE: any MAC-shaped substring of any other string (aa:bb:cc:dd:ee:ff, aa-bb-..., aabb.ccdd.eeff),
 *     e.g. inside a note like "MAC aa:bb:... beobachtet".
 * A bare 12-hex value under a non-mac key is NOT recognised (indistinguishable from an id). The guard
 * `audit-mac-writers-820.test.ts` therefore fails on an audit writer that puts a MAC under a key the
 * rule does not cover.
 *
 * Which rows are "the person's" (the subject): (a) authored by the person's user, (b) naming the
 * employee at the top level (`employeeId`), (c) PresenceEvent rows whose entityId is the employee,
 * (d) PresenceDevice rows of the person's devices - live devices plus every device id that an audit
 * row with the employee's `employeeId` names (so a device removed long ago is still found), (e) TimeEntry
 * rows of the person's time entries (the presence confirmation is audited with entityId = entry), and
 * (f) any row whose `mac` equals a MAC of the person (the "unknown MAC" event of a device that was
 * enrolled later). PresenceDevice rows are additionally redacted by type (the device label is free
 * text). Known residue: a MAC row of a device removed before anonymization whose audit neither names
 * the employee nor was written by the person's user (a system row) stays; the unknown-MAC events are
 * purgeable and expire on their own.
 *
 * Counts only, never values.
 */
import type { Prisma } from "@clokr/db";
import { redactSupportAuditValue, SUPPORT_AUDIT_REDACTED } from "./support-audit-redaction";

const PAGE = 500;
const ID_CHUNK = 1000;

export interface MacAuditSubject {
  employeeId: string;
  userId: string | null;
  /** Ids of the person's live PresenceDevice rows (read BEFORE they are deleted). */
  deviceIds: string[];
  /** MACs of the person (live devices, legacy Employee.wifiMacs). */
  macs: string[];
  /** Ids of every TimeEntry of the person (soft-deleted included). */
  timeEntryIds: string[];
}

export interface MacAuditResult {
  rowsScanned: number;
  /** Rows whose old/new value held a MAC (and, in write mode, were rewritten). */
  rowsWithMac: number;
  /** rowsWithMac per entity name, for the read-only audit script. */
  byEntity: Record<string, number>;
}

/** colon/dash separated, or Cisco dotted. Lookarounds keep UUID segments out. */
const MAC_SHAPE =
  /(?<![0-9a-f:-])(?:[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})(?![0-9a-f:-])/gi;

const MAC_TOKENS = new Set(["mac", "macs", "macaddress", "macaddresses"]);

/** True when a key (camelCase, snake_case, kebab) names a MAC. Exported for the guard test. */
export function isMacKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  return tokens.some((t) => MAC_TOKENS.has(t));
}

function redactAll(node: unknown): unknown {
  if (typeof node === "string") return SUPPORT_AUDIT_REDACTED;
  if (Array.isArray(node)) return node.map(redactAll);
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, redactAll(v)]));
  }
  return node;
}

function redactNode(node: unknown): unknown {
  if (typeof node === "string") return node.replace(MAC_SHAPE, SUPPORT_AUDIT_REDACTED);
  if (Array.isArray(node)) return node.map(redactNode);
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isMacKey(key) ? redactAll(child) : redactNode(child);
    }
    return out;
  }
  return node;
}

/** Replaces every MAC (by key or shape) of one stored value; returns a new value. */
export function redactMacsInAuditValue(value: unknown): unknown {
  return value === undefined ? undefined : redactNode(value);
}

/** Whether a stored value still holds a MAC (by key or shape). */
export function auditValueHoldsMac(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return JSON.stringify(redactNode(value)) !== JSON.stringify(value);
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type Db = Prisma.TransactionClient;

/**
 * Finds the person's audit rows that hold a MAC. With `write: true` (the anonymization) each is
 * rewritten in place; without it (the read-only audit script) nothing is written.
 */
export async function redactMacAuditOfPerson(
  db: Db,
  subject: MacAuditSubject,
  options: { write: boolean },
): Promise<MacAuditResult> {
  const result: MacAuditResult = { rowsScanned: 0, rowsWithMac: 0, byEntity: {} };
  const { employeeId, userId } = subject;

  // Device ids named by audit rows that carry this employee (a device unassigned long ago).
  const deviceIds = new Set(subject.deviceIds);
  const macs = new Set(subject.macs);
  const named = await db.auditLog.findMany({
    where: {
      entity: "PresenceDevice",
      OR: [
        { newValue: { path: ["employeeId"], equals: employeeId } },
        { oldValue: { path: ["employeeId"], equals: employeeId } },
      ],
    },
    select: { entityId: true, oldValue: true, newValue: true },
  });
  for (const row of named) {
    if (row.entityId) deviceIds.add(row.entityId);
    for (const stored of [row.oldValue, row.newValue]) {
      const mac = (stored as { mac?: unknown } | null)?.mac;
      if (typeof mac === "string") macs.add(mac);
    }
  }

  const selectors: Prisma.AuditLogWhereInput[] = [
    { newValue: { path: ["employeeId"], equals: employeeId } },
    { oldValue: { path: ["employeeId"], equals: employeeId } },
    { entity: "PresenceEvent", entityId: employeeId },
  ];
  if (userId) selectors.push({ userId });
  if (deviceIds.size > 0) {
    selectors.push({ entity: "PresenceDevice", entityId: { in: [...deviceIds] } });
  }
  for (const mac of macs) {
    selectors.push({ newValue: { path: ["mac"], equals: mac } });
    selectors.push({ oldValue: { path: ["mac"], equals: mac } });
  }

  const wheres: Prisma.AuditLogWhereInput[] = [
    { OR: selectors, entity: { notIn: ["Employee", "User"] } },
    ...chunks(subject.timeEntryIds, ID_CHUNK).map((ids): Prisma.AuditLogWhereInput => ({
      entity: "TimeEntry",
      entityId: { in: ids },
    })),
  ];

  for (const where of wheres) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.auditLog.findMany({
        where,
        select: { id: true, entity: true, oldValue: true, newValue: true },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        result.rowsScanned += 1;
        const data: Prisma.AuditLogUpdateInput = {};
        for (const field of ["oldValue", "newValue"] as const) {
          const stored = row[field];
          if (stored === null || !auditValueHoldsMac(stored)) continue;
          // A device label is free text of a personal device: PresenceDevice rows get the type rule too.
          const typed =
            row.entity === "PresenceDevice"
              ? redactSupportAuditValue(stored, { keepTimeOfDay: true })
              : stored;
          data[field] = redactMacsInAuditValue(typed) as Prisma.InputJsonValue;
        }
        if (Object.keys(data).length === 0) continue;
        result.rowsWithMac += 1;
        result.byEntity[row.entity] = (result.byEntity[row.entity] ?? 0) + 1;
        if (options.write) await db.auditLog.update({ where: { id: row.id }, data });
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
  }
  return result;
}
