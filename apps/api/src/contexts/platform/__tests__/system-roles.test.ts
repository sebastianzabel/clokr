/**
 * Phase 75b (Issue #75), D-03 / D-32 — the system roles' permission sets are DERIVED from
 * `docs/permissions.md`, not chosen by intuition.
 *
 * The site tables of the doc ("Aufrufstellen der Permission-Guards", "Handler-Prüfungen" and, since
 * Phase 75b Plan 10, "Empfängersuchen") name, per call site, the permission it asks for and —
 * in the "heute" column — which legacy roles the site admits today (A = ADMIN, M = MANAGER,
 * E = EMPLOYEE). That column is the neutrality contract of #75. This test reads it and proves:
 *   (i)   every row naming the same `resource:action` agrees on the letters admitted through the
 *         ZUGEWIESEN reach — otherwise one permission cannot reproduce every site, and the catalog
 *         cut is not neutral (a finding, not something to loosen);
 *   (ii)  no ZUGEWIESEN letter set contains E (an employee reaches only its own data);
 *   (iii) every ZUGEWIESEN catalog permission has at least one row (a key without a call site
 *         would need an explicit decision — stop);
 *   (iv)  the sets derived from the doc equal `SYSTEM_ROLE_PERMISSIONS`, element by element and in
 *         catalog order: Admin = ZUGEWIESEN keys admitting A plus every EIGENE key, Manager =
 *         ZUGEWIESEN keys admitting M plus every EIGENE key, Mitarbeiter = every EIGENE key;
 *   (v)   the sizes are 87 / 63 / 22;
 *   (vi)  both sections yielded enough rows to mean something (input proof — an emptied or
 *         renamed section must turn this red, never let it pass having compared nothing).
 *
 * The two documented disagreements (75b-RESEARCH C-2) are modelled explicitly, never by skipping a
 * row or widening a letter set (D-32):
 *   (a) EIGENE reach letters — a row whose Reichweite names EIGENE and whose "heute" admits E
 *       attributes E to the EIGENE reach, so E is removed from that row's ZUGEWIESEN set
 *       (`GET /vocational-school/upcoming`: guard `A, M, E`, EIGENE via the handler check);
 *   (b) the precedence (Vorrang) marker — a row whose Reichweite names a winning permission V in
 *       the `VORRANG` pattern below is checked as holders(P) minus holders(V): the exclusive
 *       team-events branch of `GET /activity` admits only M, because `audit-log:read` wins for A.
 *       The marker is a machine-readable cell in the doc, not a special case keyed on a file name.
 *
 * The row reader mirrors `src/__tests__/permission-site-mapping.test.ts` (`readSectionRows`,
 * `splitCells`) as an independent copy, so a change to one parser cannot silently change what the
 * other one proves.
 *
 * DB-free: no Prisma, no app build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  permissionKey,
  PERMISSION_RESOURCES,
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  isSystemRoleId,
  type PermissionKey,
  type SystemRoleSlot,
} from "..";

// __dirname is apps/api/src/contexts/platform/__tests__ — six levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "permissions.md");
const DOC_NAME = "docs/permissions.md";

/** Renamed in Phase 75b Plan 12 (D-18) once the role guard was gone; the rules read it unchanged. */
const GUARD_HEADING = "## Aufrufstellen der Permission-Guards";
const HANDLER_HEADING = "## Handler-Prüfungen";
/**
 * Phase 75b Plan 10 (#75), D-16: the notification-recipient sites. Their "heute" cell has the
 * SAME shape as a guard row — plain letters, no "nur " prefix, no colon-suffixed description
 * (`docs/permissions.md` § Empfängersuchen) — so they are read with `kind: "guard"` below.
 */
const RECIPIENT_HEADING = "## Empfängersuchen";

/** Input proof (vi): the measured row counts are 136 and 39; the floors leave room to shrink. */
const MIN_GUARD_ROWS = 100;
const MIN_HANDLER_ROWS = 30;

const PERMISSION_CELL = /^`([a-z0-9-]+:[a-z0-9-]+)`$/;
const GUARD_HEUTE = /^[AME](?:, [AME])*$/;
const HANDLER_HEUTE_PREFIX = /^(?:nur )?[AME](?:, [AME])*$/;
const LETTER = /[AME]/g;
const REACH = /\b(EIGENE|ZUGEWIESEN)\b/g;
const VORRANG = /Vorrang hat `([a-z0-9-]+:[a-z0-9-]+)`/;

type Letter = "A" | "M" | "E";

interface DocRow {
  heading: string;
  raw: string;
  cells: string[];
}

interface SiteRow {
  where: string;
  resourceAction: string;
  /** Letters admitted through the ZUGEWIESEN reach, after exception (a). */
  zugewiesen: Set<Letter>;
  /** Exception (a) applied: E moved from ZUGEWIESEN to EIGENE. */
  eigeneLetterMoved: boolean;
  /** Exception (b): the `resource:action` that has Vorrang over this row, if marked. */
  vorrang: string | null;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

/** Data rows of the table(s) in one level-2 section; separator rows and their header rows dropped. */
function readSectionRows(doc: string, heading: string): DocRow[] {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start === -1) return [];
  const tableLines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (lines[i].trim().startsWith("|")) tableLines.push(lines[i]);
  }
  const drop = new Set<number>();
  tableLines.forEach((line, idx) => {
    if (isSeparatorRow(splitCells(line))) {
      drop.add(idx);
      if (idx > 0) drop.add(idx - 1);
    }
  });
  return tableLines
    .filter((_, idx) => !drop.has(idx))
    .map((raw) => ({ heading, raw, cells: splitCells(raw) }));
}

function lettersOf(text: string): Set<Letter> {
  return new Set((text.match(LETTER) ?? []) as Letter[]);
}

/**
 * One site row → its ZUGEWIESEN letter set. Guard rows: the letters of the "heute" cell. Handler
 * rows: the letters of the text before the first colon (the whole cell if there is none), where
 * the doc's "nur X" ("only X") means {X}. Anything else is an unknown shape — returned as an error, never guessed.
 */
function parseSiteRow(row: DocRow, kind: "guard" | "handler"): SiteRow | string {
  const where = `${DOC_NAME} § ${row.heading}: ${row.raw}`;
  if (row.cells.length !== 5) return `${where} — expected 5 cells, got ${row.cells.length}`;
  const [, , heute, permission, reichweite] = row.cells;
  const perm = PERMISSION_CELL.exec(permission);
  if (!perm) return `${where} — Permission is not a backticked resource:action`;

  const admittedText = kind === "guard" ? heute : heute.split(":")[0].trim();
  const shape = kind === "guard" ? GUARD_HEUTE : HANDLER_HEUTE_PREFIX;
  if (!shape.test(admittedText)) {
    return `${where} — "heute" (${JSON.stringify(admittedText)}) is not a known letter list`;
  }

  const reaches = new Set(reichweite.match(REACH) ?? []);
  if (!reaches.has("ZUGEWIESEN")) {
    return `${where} — Reichweite names no ZUGEWIESEN reach; a decision is needed for this row`;
  }

  const zugewiesen = lettersOf(admittedText);
  // Exception (a): E admitted by a row that names the EIGENE reach is the EIGENE reach's E.
  const eigeneLetterMoved = reaches.has("EIGENE") && zugewiesen.has("E");
  if (eigeneLetterMoved) zugewiesen.delete("E");

  const vorrang = VORRANG.exec(reichweite)?.[1] ?? null;
  return { where, resourceAction: perm[1], zugewiesen, eigeneLetterMoved, vorrang };
}

function formatLetters(letters: ReadonlySet<Letter>): string {
  return `{${[...letters].sort().join(", ")}}`;
}

function setsEqual(a: ReadonlySet<Letter>, b: ReadonlySet<Letter>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

interface Derivation {
  guardRows: number;
  handlerRows: number;
  recipientRows: number;
  rows: SiteRow[];
  errors: string[];
  /** resource:action → the letter set every non-Vorrang row agrees on. */
  holders: Map<string, Set<Letter>>;
}

function deriveFromDoc(): Derivation {
  const doc = readFileSync(DOC_PATH, "utf8");
  const guardDocRows = readSectionRows(doc, GUARD_HEADING);
  const handlerDocRows = readSectionRows(doc, HANDLER_HEADING);
  // Phase 75b Plan 10 (#75), D-16: the recipient section has the same 5-cell shape as a guard
  // row (plain "heute" letters, no "nur " prefix, no colon-suffixed description) — read as kind
  // "guard" so its letters feed the SAME agreement check (i) every other row goes through.
  const recipientDocRows = readSectionRows(doc, RECIPIENT_HEADING);
  const errors: string[] = [];
  const rows: SiteRow[] = [];
  for (const [docRows, kind] of [
    [guardDocRows, "guard"],
    [handlerDocRows, "handler"],
    [recipientDocRows, "guard"],
  ] as const) {
    for (const docRow of docRows) {
      const parsed = parseSiteRow(docRow, kind);
      if (typeof parsed === "string") errors.push(parsed);
      else rows.push(parsed);
    }
  }

  // (i) agreement among the rows WITHOUT a Vorrang marker; their common set is holders(P).
  const holders = new Map<string, Set<Letter>>();
  const firstRow = new Map<string, SiteRow>();
  for (const row of rows) {
    if (row.vorrang !== null) continue;
    const known = holders.get(row.resourceAction);
    if (!known) {
      holders.set(row.resourceAction, new Set(row.zugewiesen));
      firstRow.set(row.resourceAction, row);
      continue;
    }
    if (!setsEqual(known, row.zugewiesen)) {
      errors.push(
        `\`${row.resourceAction}\` rows disagree on the ZUGEWIESEN letters: ` +
          `${formatLetters(known)} in ${firstRow.get(row.resourceAction)?.where} vs. ` +
          `${formatLetters(row.zugewiesen)} in ${row.where}`,
      );
    }
  }

  // Exception (b): a Vorrang row admits holders(P) minus holders(V).
  for (const row of rows) {
    if (row.vorrang === null) continue;
    const own = holders.get(row.resourceAction);
    const winner = holders.get(row.vorrang);
    if (!own || !winner) {
      errors.push(
        `${row.where} — Vorrang row needs other rows for both \`${row.resourceAction}\` and ` +
          `\`${row.vorrang}\` to derive holders from`,
      );
      continue;
    }
    const expected = new Set([...own].filter((l) => !winner.has(l)));
    if (!setsEqual(expected, row.zugewiesen)) {
      errors.push(
        `${row.where} — Vorrang row admits ${formatLetters(row.zugewiesen)}, but holders(` +
          `${row.resourceAction}) minus holders(${row.vorrang}) is ${formatLetters(expected)}`,
      );
    }
  }

  return {
    guardRows: guardDocRows.length,
    handlerRows: handlerDocRows.length,
    recipientRows: recipientDocRows.length,
    rows,
    errors,
    holders,
  };
}

const derivation = deriveFromDoc();

function resourceActionOf(key: string): string {
  return key.split(":").slice(0, 2).join(":");
}

/** The doc-derived content of one system role, in catalog order (D-03). */
function docDerivedSet(letter: Letter | null): string[] {
  const out: string[] = [];
  for (const permission of PERMISSIONS) {
    const key = permissionKey(permission);
    if (permission.reach === "EIGENE") {
      out.push(key);
      continue;
    }
    if (letter === null) continue;
    if (derivation.holders.get(resourceActionOf(key))?.has(letter)) out.push(key);
  }
  return out;
}

describe("Phase 75b — system-role permission sets derived from docs/permissions.md (D-03, D-32)", () => {
  it("(vi) all site tables yield enough rows to prove something", () => {
    expect(
      derivation.guardRows,
      `${DOC_NAME} § "${GUARD_HEADING}" yielded too few rows — section renamed or emptied?`,
    ).toBeGreaterThan(MIN_GUARD_ROWS);
    expect(
      derivation.handlerRows,
      `${DOC_NAME} § "${HANDLER_HEADING}" yielded too few rows — section renamed or emptied?`,
    ).toBeGreaterThan(MIN_HANDLER_ROWS);
    expect(
      derivation.recipientRows,
      `${DOC_NAME} § "${RECIPIENT_HEADING}" yielded no rows — section renamed or emptied?`,
    ).toBeGreaterThan(0);
    expect(derivation.rows.length).toBe(
      derivation.guardRows + derivation.handlerRows + derivation.recipientRows,
    );
  });

  it("both documented exceptions are modelled and exercised, not dead code (D-32)", () => {
    const eigeneRows = derivation.rows.filter((r) => r.eigeneLetterMoved);
    const vorrangRows = derivation.rows.filter((r) => r.vorrang !== null);
    expect(eigeneRows.length, "exception (a) no longer applies to any row").toBeGreaterThan(0);
    expect(vorrangRows.length, "exception (b): no Vorrang marker found in the doc").toBeGreaterThan(
      0,
    );
  });

  it("(i) every row naming a permission agrees on the admitted ZUGEWIESEN letters", () => {
    expect(derivation.errors).toEqual([]);
  });

  it("(ii) no ZUGEWIESEN letter set admits E", () => {
    const offenders = derivation.rows
      .filter((r) => r.zugewiesen.has("E"))
      .map((r) => `${r.where} — E admitted through ZUGEWIESEN`);
    expect(offenders).toEqual([]);
  });

  it("(iii) every ZUGEWIESEN catalog permission has a call-site row, and every row a catalog key", () => {
    const catalogZugewiesen = new Set(
      PERMISSIONS.filter((p) => p.reach === "ZUGEWIESEN").map((p) => `${p.resource}:${p.action}`),
    );
    const withoutSite = [...catalogZugewiesen].filter((ra) => !derivation.holders.has(ra));
    expect(withoutSite, "ZUGEWIESEN permissions without a call site need a decision").toEqual([]);
    const unknown = derivation.rows
      .filter((r) => !catalogZugewiesen.has(r.resourceAction))
      .map((r) => `${r.where} — \`${r.resourceAction}:ZUGEWIESEN\` is not in the catalog`);
    expect(unknown).toEqual([]);
  });

  it("(iv) SYSTEM_ROLE_PERMISSIONS equal the doc-derived sets, in catalog order", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.ADMIN]).toEqual(docDerivedSet("A"));
    expect([...SYSTEM_ROLE_PERMISSIONS.MANAGER]).toEqual(docDerivedSet("M"));
    expect([...SYSTEM_ROLE_PERMISSIONS.EMPLOYEE]).toEqual(docDerivedSet(null));
  });

  it("(v) the sizes are Admin 87, Manager 63, Mitarbeiter 22", () => {
    expect(PERMISSIONS.length).toBe(87);
    expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).toHaveLength(87);
    expect(SYSTEM_ROLE_PERMISSIONS.MANAGER).toHaveLength(63);
    expect(SYSTEM_ROLE_PERMISSIONS.EMPLOYEE).toHaveLength(22);
  });
});

describe("Phase 75b — system-role identity (D-01, D-02)", () => {
  it("has seven distinct fixed ids of uuid shape", () => {
    const ids = Object.values(SYSTEM_ROLE_IDS);
    expect(ids).toEqual([
      "00000000-0000-4000-8000-00000000a001",
      "00000000-0000-4000-8000-00000000a002",
      "00000000-0000-4000-8000-00000000a003",
      "00000000-0000-4000-8000-00000000a004",
      "00000000-0000-4000-8000-00000000a005",
      "00000000-0000-4000-8000-00000000a006",
      "00000000-0000-4000-8000-00000000a007",
    ]);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("names the roles Admin, Manager, Mitarbeiter, Inhaber, Salonmanager, Personalabteilung, Ausbilder", () => {
    expect(SYSTEM_ROLE_NAMES).toEqual({
      ADMIN: "Admin",
      MANAGER: "Manager",
      EMPLOYEE: "Mitarbeiter",
      OWNER: "Inhaber",
      SALON_MANAGER: "Salonmanager",
      HR: "Personalabteilung",
      TRAINER: "Ausbilder",
    });
  });

  it("isSystemRoleId answers by id only", () => {
    for (const id of Object.values(SYSTEM_ROLE_IDS)) expect(isSystemRoleId(id)).toBe(true);
    // Genuinely unused id (…a004 is now the real OWNER id) — the negative-case fixture (D-01).
    expect(isSystemRoleId("00000000-0000-4000-8000-00000000a008")).toBe(false);
    expect(isSystemRoleId("Admin")).toBe(false);
    expect(isSystemRoleId("")).toBe(false);
  });
});

describe("Phase 76b — system-role templates (Issue #76)", () => {
  // Catalog order, transcribed from CONTEXT.md D-05/D-07/D-08 — never computed from
  // SYSTEM_ROLE_PERMISSIONS, so a typo in the production list turns this red.
  const SALON_MANAGER_EXPECTED: PermissionKey[] = [
    "employee:read:ZUGEWIESEN",
    "time-entry:read:ZUGEWIESEN",
    "time-entry:create:ZUGEWIESEN",
    "time-entry:update:ZUGEWIESEN",
    "time-entry:delete:ZUGEWIESEN",
    "time-entry:revalidate:ZUGEWIESEN",
    "retro-request:read:ZUGEWIESEN",
    "retro-request:create:ZUGEWIESEN",
    "retro-request:approve:ZUGEWIESEN",
    "leave-request:read:ZUGEWIESEN",
    "leave-request:create:ZUGEWIESEN",
    "leave-request:approve:ZUGEWIESEN",
    "leave-request:attest:ZUGEWIESEN",
    "leave-request:cancel:ZUGEWIESEN",
    "section9:read:ZUGEWIESEN",
    "section9:upload:ZUGEWIESEN",
    "section9:decide:ZUGEWIESEN",
    "leave-entitlement:read:ZUGEWIESEN",
    "vocational-school:read:ZUGEWIESEN",
    "shift:read:ZUGEWIESEN",
    "shift:plan:ZUGEWIESEN",
    "shift-pattern:read:ZUGEWIESEN",
    "availability:read:ZUGEWIESEN",
    "team-overview:read:ZUGEWIESEN",
  ];

  const HR_EXPECTED: PermissionKey[] = [
    "employee:read:ZUGEWIESEN",
    "employee:create:ZUGEWIESEN",
    "employee:update:ZUGEWIESEN",
    "employee:update-avatar:ZUGEWIESEN",
    "contract:read:ZUGEWIESEN",
    "contract:update:ZUGEWIESEN",
    "leave-request:read:ZUGEWIESEN",
    "section9:read:ZUGEWIESEN",
    "leave-entitlement:read:ZUGEWIESEN",
    "leave-entitlement:update:ZUGEWIESEN",
    "vocational-school:read:ZUGEWIESEN",
    "overtime:read:ZUGEWIESEN",
    "month-close:read:ZUGEWIESEN",
  ];

  const TRAINER_EXPECTED: PermissionKey[] = [
    "employee:read:ZUGEWIESEN",
    "time-entry:read:ZUGEWIESEN",
    "leave-request:read:ZUGEWIESEN",
    "vocational-school:read:ZUGEWIESEN",
    "shift:read:ZUGEWIESEN",
  ];

  it("(D-05) Salonmanager equals the hand-written literal list, 24 entries", () => {
    expect(SALON_MANAGER_EXPECTED).toHaveLength(24);
    expect([...SYSTEM_ROLE_PERMISSIONS.SALON_MANAGER]).toEqual(SALON_MANAGER_EXPECTED);
  });

  it("(D-07) Personalabteilung equals the hand-written literal list, 13 entries", () => {
    expect(HR_EXPECTED).toHaveLength(13);
    expect([...SYSTEM_ROLE_PERMISSIONS.HR]).toEqual(HR_EXPECTED);
  });

  it("(D-08) Ausbilder equals the hand-written literal list, 5 entries", () => {
    expect(TRAINER_EXPECTED).toHaveLength(5);
    expect([...SYSTEM_ROLE_PERMISSIONS.TRAINER]).toEqual(TRAINER_EXPECTED);
  });

  it("(D-04) Inhaber equals the full live catalog enumeration, not a literal count", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.OWNER]).toEqual(PERMISSIONS.map(permissionKey));
  });

  it(
    "(principle, D-05/D-07/D-08) Salonmanager/Personalabteilung/Ausbilder hold only " +
      "ZUGEWIESEN permissions on PERSON-relation resources — no EIGENE, no MANDANT",
    () => {
      for (const slot of ["SALON_MANAGER", "HR", "TRAINER"] as const) {
        for (const key of SYSTEM_ROLE_PERMISSIONS[slot]) {
          const [resource, , reach] = key.split(":");
          expect(reach, `${slot} key ${key}`).toBe("ZUGEWIESEN");
          expect(
            PERMISSION_RESOURCES[resource as keyof typeof PERMISSION_RESOURCES].relation,
            `${slot} key ${key}`,
          ).toBe("PERSON");
        }
      }
    },
  );

  it("(named exclusions) Salonmanager holds none of the excluded keys (D-05)", () => {
    const keys = SYSTEM_ROLE_PERMISSIONS.SALON_MANAGER;
    expect(keys).not.toContain("leave-request:correct:ZUGEWIESEN");
    expect(keys.some((k) => k.startsWith("overtime:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("month-close:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("contract:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("report:"))).toBe(false);
  });

  it("(named exclusions) Personalabteilung holds none of the excluded keys (D-07)", () => {
    const keys = SYSTEM_ROLE_PERMISSIONS.HR;
    expect(keys.some((k) => k.startsWith("time-entry:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("retro-request:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("report:"))).toBe(false);
    expect(keys).not.toContain("team-overview:read:ZUGEWIESEN");
    expect(keys).not.toContain("employee:anonymize:ZUGEWIESEN");
    expect(keys).not.toContain("employee:import:ZUGEWIESEN");
    expect(keys).not.toContain("employee:manage-access:ZUGEWIESEN");
    const forbiddenActions = new Set(["approve", "decide", "attest", "correct", "cancel"]);
    for (const key of keys) {
      const [, action] = key.split(":");
      expect(forbiddenActions.has(action), key).toBe(false);
    }
  });

  it("(named exclusions) Ausbilder holds only read actions (D-08)", () => {
    for (const key of SYSTEM_ROLE_PERMISSIONS.TRAINER) {
      const [, action] = key.split(":");
      expect(action, key).toBe("read");
    }
  });

  it(
    "(D-09) only Inhaber holds both time-entry:update:EIGENE and retro-request:approve:ZUGEWIESEN " +
      "among the four new templates",
    () => {
      const pair = ["time-entry:update:EIGENE", "retro-request:approve:ZUGEWIESEN"] as const;
      const NEW_SLOTS: SystemRoleSlot[] = ["OWNER", "SALON_MANAGER", "HR", "TRAINER"];
      for (const slot of NEW_SLOTS) {
        const holds = pair.every((k) => SYSTEM_ROLE_PERMISSIONS[slot].includes(k as PermissionKey));
        expect(holds, slot).toBe(slot === "OWNER");
      }
    },
  );
});
