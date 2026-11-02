/**
 * Issue #820 - guard: every audit writer in apps/api/src that puts a device MAC into an audit value
 * puts it under a key the anonymization rule covers (`isMacKey`, `audit-mac-redaction.ts`) AND is
 * registered below with the way the person's rows are reached. A new writer fails this test until
 * it is made to fit the rule (rename the key) and registered here - it can never silently escape
 * the Art. 17 redaction.
 *
 * Writers seen: `<x>.audit({ ... })` and `<x>.auditLog.create({ data: { ... } })` whose old/new
 * value object contains a MAC: a property whose key names a MAC, a value that reads a `mac`
 * identifier/property, or a template literal interpolating one. Stated blind spot: a value built in
 * a variable first (`const v = { addr: device.mac }; app.audit({ newValue: v })`) is not seen.
 *
 * Linkage (how `redactMacAuditOfPerson` reaches the row): AUTHOR (userId of the person),
 * EMPLOYEE_ID (employeeId inside the value), ENTITY_ID_EMPLOYEE (PresenceEvent with entityId =
 * employee), DEVICE (PresenceDevice rows, via live ids / ids named by EMPLOYEE_ID rows),
 * TIME_ENTRY (entityId = the person's entry), MAC_MATCH (a row whose mac equals the person's).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { isMacKey } from "../contexts/platform/audit-mac-redaction";

const SRC = join(__dirname, "..");
const MIN_WALKED_FILES = 200;

/** "entity|action" -> linkages. `*` = action not a string literal / not given. */
const REGISTER: Record<string, string[]> = {
  "PresenceDevice|CREATE": ["AUTHOR", "DEVICE"],
  "PresenceDevice|DELETE": ["AUTHOR", "DEVICE"],
  "PresenceDevice|ASSIGN_DEVICE": ["EMPLOYEE_ID", "DEVICE"],
  "PresenceDevice|UNASSIGN_DEVICE": ["EMPLOYEE_ID", "DEVICE"],
  "PresenceEvent|WIFI_UNKNOWN_MAC": ["MAC_MATCH"],
  "PresenceEvent|WIFI_OPT_OUT": ["ENTITY_ID_EMPLOYEE"],
  "PresenceEvent|WIFI_NO_SHIFT": ["ENTITY_ID_EMPLOYEE"],
  "PresenceEvent|WIFI_OUTSIDE_WINDOW": ["ENTITY_ID_EMPLOYEE"],
  "PresenceEvent|WIFI_NO_OPEN_ENTRY": ["ENTITY_ID_EMPLOYEE"],
  "TimeEntry|WIFI_PRESENCE_CONFIRMED": ["TIME_ENTRY"],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (extname(full) === ".ts" && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const keyName = (n: ts.PropertyName): string =>
  ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText();

/** Collects MAC-bearing spots of one value expression: { badKey } when a mac is under a non-mac key. */
function scanValue(node: ts.Node, findings: { macSeen: boolean; badKeys: string[] }): void {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    const key = keyName(node.name);
    const valueText = ts.isPropertyAssignment(node)
      ? node.initializer.getText()
      : node.name.getText();
    const valueNamesMac = /(^|[^A-Za-z0-9])(mac|macs)([^A-Za-z0-9]|$)|\.mac\b|\bmac[A-Z]/.test(
      valueText,
    );
    if (isMacKey(key)) findings.macSeen = true;
    else if (valueNamesMac && !/^\s*[{[]/.test(valueText)) {
      // A MAC interpolated into a string (template literal) is covered by the SHAPE rule.
      if (ts.isPropertyAssignment(node) && ts.isTemplateExpression(node.initializer)) {
        findings.macSeen = true;
        return node.forEachChild((c) => scanValue(c, findings));
      }
      findings.macSeen = true;
      findings.badKeys.push(key);
    }
  }
  if (ts.isTemplateExpression(node) && /\$\{[^}]*\bmac\b[^}]*\}/i.test(node.getText())) {
    findings.macSeen = true;
  }
  node.forEachChild((c) => scanValue(c, findings));
}

interface Site {
  file: string;
  entity: string;
  action: string;
  badKeys: string[];
}

function sitesOf(file: string): Site[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: Site[] = [];
  const handle = (obj: ts.ObjectLiteralExpression) => {
    const props = new Map<string, ts.Expression>();
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p)) props.set(keyName(p.name), p.initializer);
    }
    const findings = { macSeen: false, badKeys: [] as string[] };
    for (const field of ["oldValue", "newValue"]) {
      const v = props.get(field);
      if (v) scanValue(v, findings);
    }
    if (!findings.macSeen) return;
    const lit = (e?: ts.Expression) => (e && ts.isStringLiteralLike(e) ? e.text : "*");
    out.push({
      file,
      entity: lit(props.get("entity")),
      action: lit(props.get("action")),
      badKeys: findings.badKeys,
    });
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = n.expression.getText();
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        if (/\.audit$/.test(callee)) handle(arg);
        else if (/auditLog\.create$/.test(callee)) {
          const data = arg.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && keyName(p.name) === "data",
          );
          if (data && ts.isObjectLiteralExpression(data.initializer)) handle(data.initializer);
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

describe("MAC-bearing audit writers (#820)", () => {
  const files = walk(SRC);
  const sites = files.flatMap(sitesOf);

  it("walked a non-vacuous source set and found the known MAC writers", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    expect(sites.length).toBeGreaterThanOrEqual(Object.keys(REGISTER).length);
  });

  it("every MAC sits under a key the redaction rule covers", () => {
    const bad = sites.filter((s) => s.badKeys.length > 0);
    expect(
      bad.map((s) => `${relative(SRC, s.file)} ${s.entity}|${s.action} keys=${s.badKeys}`),
    ).toEqual([]);
  });

  it("every MAC-bearing writer is registered with its linkage, and every entry is still used", () => {
    const seen = new Set(sites.map((s) => `${s.entity}|${s.action}`));
    const unregistered = [...seen].filter((k) => !(k in REGISTER));
    expect(unregistered).toEqual([]);
    const stale = Object.keys(REGISTER).filter((k) => !seen.has(k));
    expect(stale).toEqual([]);
  });
});
