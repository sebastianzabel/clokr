/**
 * VAPID key generator (Issue #608, D-02).
 *
 * Prints the three variables that switch Web-Push on for ONE instance to stdout, for the operator to
 * put into that stage's secret store. It never writes a file and takes no secret from argv: the
 * private key exists only in this process and on the operator's terminal.
 *
 * Usage:
 *   pnpm --filter @clokr/api exec tsx scripts/generate-vapid-keys.ts --subject mailto:<contact>
 * In the API container (working directory `/app`):
 *   docker exec -w /app/apps/api <container> pnpm tsx scripts/generate-vapid-keys.ts --subject <subject>
 *
 * The subject is the operator's contact for the push services: `mailto:<address>` or an `https:` URL,
 * never localhost (Apple refuses it). The check here is a short local one; the boot check of the API
 * (`apps/api/src/config.ts`) is authoritative.
 *
 * Exit codes: 0 - ok, 1 - error (bad arguments or an unusable subject; no key is printed).
 */
import webpush from "web-push";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** Mirrors the subject rule of the API boot check: mailto:<x>@<y.z> or an https URL not on localhost. */
export function isUsableSubject(subject: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return true;
  try {
    const url = new URL(subject);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      host !== "127.0.0.1" &&
      host !== "[::1]"
    );
  } catch {
    return false;
  }
}

/** Generates a fresh pair and returns the three `KEY=value` lines. Pure apart from the key generation. */
export function vapidEnvLines(options: { subject?: string } = {}): string[] {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return [
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    `VAPID_SUBJECT=${options.subject ?? ""}`,
  ];
}

export function main(argv: string[]): number {
  let subject: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { subject: { type: "string" } },
      strict: true,
    });
    subject = values.subject;
  } catch (err) {
    console.error(`[generate-vapid-keys] ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }

  if (subject !== undefined && !isUsableSubject(subject)) {
    console.error(
      "[generate-vapid-keys] --subject must be mailto:<address> or an https: URL whose host is not localhost",
    );
    return EXIT_ERROR;
  }
  if (subject === undefined) {
    console.error(
      "[generate-vapid-keys] no --subject given: VAPID_SUBJECT is printed empty. Set it to mailto:<contact> " +
        "before starting the API - keys with an empty subject are refused at boot.",
    );
  }

  for (const line of vapidEnvLines({ subject })) console.log(line);
  return EXIT_OK;
}

// Run-guard (Issue #203 class): only execute when invoked as a script, so importing the module for
// unit tests prints nothing and never exits the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
