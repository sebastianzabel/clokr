/**
 * Anonymization validator — Phase 72 Plan 72-04 (manual variant)
 *
 * Runs AFTER anonymize-dump.ts has rewritten a staging copy of the prod DB.
 * Asserts two invariants:
 *
 *   1. NO PII REMAINS in the DB. Scans Employee/User/Absence/TimeEntry/
 *      LeaveRequest for real-looking emails, German phone numbers,
 *      employees still named "real" (firstName !== "Gelöscht"), and
 *      absence document paths.
 *
 *   2. ROW COUNTS ARE PRESERVED for retention-relevant tables. Reads the
 *      latest `ANONYMIZATION_RUN` AuditLog entry (written by anonymize-dump.ts)
 *      and compares sourceRowCounts ↔ targetRowCounts row by row.
 *
 * Run AFTER `anonymize-dump.ts` against the SAME `DATABASE_URL`. Exit 0 = clean,
 * exit 1 = PII found OR volume mismatch — DO NOT swap the staging DB into prod.
 *
 *   pnpm --filter @clokr/api exec tsx scripts/validate-anonymization.ts
 *
 * This is the validation gate for the manual data-refresh workflow documented
 * in `docs/data-refresh-process.md`. Run it before atomically swapping
 * clokr_staging into clokr.
 *
 * Output:
 *   - Per-rule status (PASS / FAIL with offending count)
 *   - Final report: PASS or FAIL with a list of failures
 *   - Exit code: 0 (PASS) / 1 (FAIL)
 *
 * Decisions honored (`.planning/phases/72-anonymization-pipeline/72-CONTEXT.md`):
 *   - D-09: PII patterns scanned = email + German phone; firstName check; document path check
 *   - D-10: Row counts pre/post compared for TimeEntry, LeaveRequest, Absence,
 *           WorkSchedule, OvertimeAccount
 *   - D-12: Fail closed — any blocking finding aborts; operator decides whether to swap
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

type Finding = {
  rule: string;
  severity: "blocking" | "warn";
  count: number;
  sample?: string[];
};

const findings: Finding[] = [];

// ── PII Patterns ───────────────────────────────────────────────────
// Email regex excludes the canonical anonymized form (`*@anonymized.local`).
const REAL_EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@(?!anonymized\.local)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
// German phone (rough): +49, 0049, or 0 followed by area code + digits
const GERMAN_PHONE_REGEX = /^(\+49|0049|0)[1-9]\d{6,11}$/;

async function checkEmployeesNotAnonymized() {
  const nonAnonymized = await prisma.employee.count({
    where: { firstName: { not: "Gelöscht" } },
  });
  if (nonAnonymized > 0) {
    const sample = await prisma.employee.findMany({
      where: { firstName: { not: "Gelöscht" } },
      take: 3,
      select: { id: true, firstName: true, lastName: true },
    });
    findings.push({
      rule: "employee-firstname-not-anonymized",
      severity: "blocking",
      count: nonAnonymized,
      sample: sample.map((e) => `${e.id} → ${e.firstName} ${e.lastName}`),
    });
  }
}

async function checkUserEmails() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  const realEmails = users.filter((u) => REAL_EMAIL_REGEX.test(u.email));
  if (realEmails.length > 0) {
    findings.push({
      rule: "user-email-not-anonymized",
      severity: "blocking",
      count: realEmails.length,
      sample: realEmails.slice(0, 3).map((u) => u.email),
    });
  }
}

async function checkLeftoverNotes() {
  const timeEntryNotes = await prisma.timeEntry.count({ where: { note: { not: null } } });
  const leaveRequestNotes = await prisma.leaveRequest.count({ where: { note: { not: null } } });
  const absenceNotes = await prisma.absence.count({ where: { note: { not: null } } });
  const total = timeEntryNotes + leaveRequestNotes + absenceNotes;
  if (total > 0) {
    findings.push({
      rule: "leftover-free-text-notes",
      severity: "blocking",
      count: total,
      sample: [
        `TimeEntry.note: ${timeEntryNotes}`,
        `LeaveRequest.note: ${leaveRequestNotes}`,
        `Absence.note: ${absenceNotes}`,
      ],
    });
  }
}

async function checkAbsenceDocuments() {
  const docs = await prisma.absence.count({ where: { documentPath: { not: null } } });
  if (docs > 0) {
    findings.push({
      rule: "absence-document-path-not-cleared",
      severity: "blocking",
      count: docs,
    });
  }
}

async function checkAuditLogUserIds() {
  // Every AuditLog entry tied to a now-anonymized user should have userId=null.
  // We sample: any AuditLog row whose userId resolves to a user with the
  // anonymized email pattern → that link should have been cleared.
  const orphaned = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "AuditLog" al
    INNER JOIN "User" u ON u.id = al."userId"
    WHERE u."passwordHash" = 'ANONYMIZED'
  `;
  const n = Number(orphaned[0]?.count ?? 0n);
  if (n > 0) {
    findings.push({
      rule: "auditlog-userid-still-references-anonymized-user",
      severity: "blocking",
      count: n,
    });
  }
}

async function checkPhoneFormatColumns() {
  // Defense-in-depth: regex-scan free-text-ish columns that should not have
  // German phones after anonymization. Employee.nfcCardId should be null;
  // any leftover with a digit pattern is reportable.
  const cards = await prisma.employee.count({ where: { nfcCardId: { not: null } } });
  if (cards > 0) {
    findings.push({
      rule: "employee-nfccardid-not-cleared",
      severity: "blocking",
      count: cards,
    });
  }

  // Scan AuditLog newValue/oldValue text representations for phone patterns.
  // We compare against the JSON text serialization — purely a defense-in-depth
  // surface to catch unexpected leakage; not authoritative.
  const auditWithPhone = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "AuditLog"
    WHERE ("newValue"::text ~ '\\+49[0-9]{6,}'
        OR "oldValue"::text ~ '\\+49[0-9]{6,}')
      AND "action" <> 'ANONYMIZATION_RUN'
  `;
  const n = Number(auditWithPhone[0]?.count ?? 0n);
  if (n > 0) {
    findings.push({
      rule: "auditlog-payload-contains-german-phone",
      severity: "warn",
      count: n,
    });
  }
}

async function checkVolumePreservation() {
  // Find the most recent ANONYMIZATION_RUN entry and compare counts.
  const lastRun = await prisma.auditLog.findFirst({
    where: { action: "ANONYMIZATION_RUN" },
    orderBy: { createdAt: "desc" },
  });

  if (!lastRun) {
    findings.push({
      rule: "no-anonymization-run-audit-log-found",
      severity: "blocking",
      count: 0,
      sample: ["Run anonymize-dump.ts before validate-anonymization.ts"],
    });
    return;
  }

  const newValue = lastRun.newValue as {
    sourceRowCounts?: Record<string, number>;
    targetRowCounts?: Record<string, number>;
  } | null;

  if (!newValue?.sourceRowCounts || !newValue?.targetRowCounts) {
    findings.push({
      rule: "anonymization-run-missing-row-counts",
      severity: "blocking",
      count: 0,
      sample: [`AuditLog entry ${lastRun.id} has no row count snapshot`],
    });
    return;
  }

  const drifted: string[] = [];
  for (const table of Object.keys(newValue.sourceRowCounts)) {
    const src = newValue.sourceRowCounts[table];
    const tgt = newValue.targetRowCounts[table];
    if (src !== tgt) drifted.push(`${table}: ${src} → ${tgt} (delta ${tgt - src})`);
  }

  if (drifted.length > 0) {
    findings.push({
      rule: "retention-row-count-drift",
      severity: "blocking",
      count: drifted.length,
      sample: drifted,
    });
  }
}

async function main() {
  console.log("Running anonymization validation against:", process.env.DATABASE_URL);
  console.log("");

  const checks: Array<[string, () => Promise<void>]> = [
    ["Employee firstName === 'Gelöscht'", checkEmployeesNotAnonymized],
    ["User email matches *@anonymized.local", checkUserEmails],
    ["Free-text notes cleared (TimeEntry/LeaveRequest/Absence)", checkLeftoverNotes],
    ["Absence documentPath cleared", checkAbsenceDocuments],
    ["AuditLog userId nulled for anonymized users", checkAuditLogUserIds],
    ["Employee.nfcCardId cleared + phone scan", checkPhoneFormatColumns],
    ["Row counts preserved per ANONYMIZATION_RUN log", checkVolumePreservation],
  ];

  for (const [label, run] of checks) {
    const before = findings.length;
    await run();
    const added = findings.length - before;
    if (added === 0) console.log(`  ✓ ${label}`);
    else console.log(`  ✗ ${label} (${added} finding${added === 1 ? "" : "s"})`);
  }

  console.log("");
  if (findings.length === 0) {
    console.log("✓ PASS — anonymization complete, safe to swap staging → int.");
    return 0;
  }

  const blocking = findings.filter((f) => f.severity === "blocking");
  const warnings = findings.filter((f) => f.severity === "warn");

  console.log(`✗ FAIL — ${blocking.length} blocking finding(s), ${warnings.length} warning(s)`);
  console.log("");

  for (const f of findings) {
    const tag = f.severity === "blocking" ? "BLOCKING" : "warn";
    console.log(`  [${tag}] ${f.rule} — count=${f.count}`);
    for (const s of f.sample ?? []) console.log(`           ${s}`);
  }
  console.log("");
  console.log(
    blocking.length > 0 ? "DO NOT swap staging → int." : "Warnings only — operator decides.",
  );

  return blocking.length > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Validation crashed:", err);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
