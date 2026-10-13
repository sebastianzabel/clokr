/**
 * Operator account CLI (Phase 88, #88, D-03/D-03a).
 *
 * The ONLY way an operator account (the principal above the tenant) comes into existence. No route, no
 * seed and no UI creates one: whoever can run this script on the server creates the most privileged
 * principal, and every run that writes is audited in `OperatorAuditLog` (actor type SCRIPT with the OS
 * user and host).
 *
 * Usage (dry-run by default; nothing is written without --apply):
 *   DATABASE_URL=<dsn> ENCRYPTION_KEY=<key> [OPERATOR_PASSWORD=<pw>] \
 *     pnpm --filter @clokr/api exec tsx scripts/operator-account.ts \
 *     --create --email <email> --display-name <name> [--apply]
 *     --reset-mfa --email <email> [--apply]     (lost authenticator: new secret + recovery codes)
 *     --deactivate --email <email> [--apply]    (offboarding)
 * In the API container: `pnpm tsx scripts/operator-account.ts …`.
 *
 * The password is never taken from argv (shell history, process list): `OPERATOR_PASSWORD` or, when unset,
 * a generated one printed once. The TOTP secret, otpauth URI and the 10 recovery codes are printed to
 * stdout once and are never written to a file or log.
 *
 * Exit codes: 0 — ok, 1 — error (bad arguments, validation, connection, duplicate).
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  OPERATOR_PASSWORD_POLICY,
  createOperatorAccount,
  deactivateOperatorAccount,
  normalizeOperatorEmail,
  resetOperatorMfa,
  type OperatorActor,
} from "../src/contexts/platform/operator-credentials";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export type OperatorAccountMode = "create" | "reset-mfa" | "deactivate";

export type OperatorAccountArgs = {
  mode: OperatorAccountMode;
  email: string;
  displayName?: string;
  apply: boolean;
};

/** Parses argv (without node/script). Throws an Error with a readable message on any misuse. */
export function parseOperatorAccountArgs(argv: string[]): OperatorAccountArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      create: { type: "boolean" },
      "reset-mfa": { type: "boolean" },
      deactivate: { type: "boolean" },
      email: { type: "string" },
      "display-name": { type: "string" },
      apply: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const modes = (["create", "reset-mfa", "deactivate"] as const).filter((m) => values[m]);
  if (modes.length !== 1) {
    throw new Error("Exactly one mode flag is required: --create | --reset-mfa | --deactivate");
  }
  if (!values.email) throw new Error("--email is required");
  return {
    mode: modes[0],
    email: values.email,
    displayName: values["display-name"],
    apply: values.apply === true,
  };
}

/** 24 chars of url-safe entropy plus the classes the operator policy requires. */
function generateOperatorPassword(): string {
  return `${randomBytes(18).toString("base64url")}-Aa1!`;
}

async function main(argv: string[]): Promise<number> {
  let args: OperatorAccountArgs;
  try {
    args = parseOperatorAccountArgs(argv);
  } catch (err) {
    console.error(`[operator-account] ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
  if (!process.env.DATABASE_URL) {
    console.error("[operator-account] DATABASE_URL is required");
    return EXIT_ERROR;
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) {
    console.error("[operator-account] ENCRYPTION_KEY is required (min 32 chars)");
    return EXIT_ERROR;
  }

  const email = normalizeOperatorEmail(args.email);
  if (args.mode === "create" && !args.displayName) {
    console.error("[operator-account] --display-name is required for --create");
    return EXIT_ERROR;
  }

  if (!args.apply) {
    console.log(dryRunMessage(args, email));
    return EXIT_OK;
  }

  const actor: OperatorActor = { type: "SCRIPT", user: userInfo().username, host: hostname() };
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    if (args.mode === "create") return await runCreate(prisma, email, args.displayName!, actor);
    if (args.mode === "reset-mfa") return await runResetMfa(prisma, email, actor);
    return await runDeactivate(prisma, email, actor);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

function dryRunMessage(args: OperatorAccountArgs, email: string): string {
  const tail = "Nothing written. Re-run with --apply.";
  if (args.mode === "create") {
    return (
      `[operator-account] DRY RUN — would create operator account ${email} ("${args.displayName}") ` +
      `with TOTP enrolment and 10 recovery codes (password policy: min ${OPERATOR_PASSWORD_POLICY.passwordMinLength}). ${tail}`
    );
  }
  if (args.mode === "reset-mfa") {
    return `[operator-account] DRY RUN — would replace the TOTP secret and all recovery codes of ${email}. ${tail}`;
  }
  return `[operator-account] DRY RUN — would deactivate operator account ${email}. ${tail}`;
}

function printEnrollment(
  enrollment: { secretBase32: string; otpauthUri: string },
  recoveryCodes: string[],
): void {
  console.log(`otpauth URI (shown once): ${enrollment.otpauthUri}`);
  console.log(`TOTP secret (shown once): ${enrollment.secretBase32}`);
  console.log("recovery codes (shown once, store offline):");
  for (const code of recoveryCodes) console.log(`  ${code}`);
}

async function runCreate(
  prisma: PrismaClient,
  email: string,
  displayName: string,
  actor: OperatorActor,
): Promise<number> {
  const suppliedPassword = process.env.OPERATOR_PASSWORD;
  const password = suppliedPassword || generateOperatorPassword();
  const result = await createOperatorAccount(prisma, { email, displayName, password, actor });
  if (result.status === "EMAIL_TAKEN") {
    console.error(`[operator-account] an operator account with ${email} already exists`);
    return EXIT_ERROR;
  }
  if (result.status === "INVALID") {
    console.error(`[operator-account] invalid input: ${result.errors.join("; ")}`);
    return EXIT_ERROR;
  }
  console.log(
    `[operator-account] created operator account ${result.account.email} (${result.account.id})`,
  );
  if (!suppliedPassword) console.log(`password (shown once): ${password}`);
  printEnrollment(result.enrollment, result.recoveryCodes);
  return EXIT_OK;
}

async function runResetMfa(
  prisma: PrismaClient,
  email: string,
  actor: OperatorActor,
): Promise<number> {
  const result = await resetOperatorMfa(prisma, { email, actor });
  if (result.status === "NOT_FOUND") {
    console.error(`[operator-account] no operator account with ${email}`);
    return EXIT_ERROR;
  }
  console.log(`[operator-account] second factor of ${email} reset`);
  printEnrollment(result.enrollment, result.recoveryCodes);
  return EXIT_OK;
}

async function runDeactivate(
  prisma: PrismaClient,
  email: string,
  actor: OperatorActor,
): Promise<number> {
  const result = await deactivateOperatorAccount(prisma, { email, actor });
  if (result.status === "NOT_FOUND") {
    console.error(`[operator-account] no operator account with ${email}`);
    return EXIT_ERROR;
  }
  if (result.status === "ALREADY_INACTIVE") {
    console.error(`[operator-account] ${email} is already deactivated`);
    return EXIT_ERROR;
  }
  console.log(`[operator-account] deactivated operator account ${email}`);
  return EXIT_OK;
}

// Run-guard (Issue #203 class): only bootstrap the DB and execute when invoked as a script, so importing
// the module for unit tests opens no connection and never exits the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}
