import "dotenv/config";
import { isIP } from "node:net";
import { maskMac } from "./pairing.js";
import { Tr064Client } from "./tr064.js";

/**
 * Real-box probe for the by-IP host lookup (Issue #610, research A1-A3).
 *
 *   node dist/probe-host.js <ip-of-a-phone-in-the-salon-wlan>
 *
 * Reads FRITZBOX_URL, FRITZBOX_USER and FRITZBOX_PASS like the adapter, asks the box which device
 * holds the IP and prints what it found: the masked MAC, hostname, active flag, interface type and
 * the NAMES (never the values) of the New... elements of the raw answer, so the field names the
 * parser assumes can be compared with the real ones. Exit 0 found, 2 not found, 1 error.
 */

const USAGE = "Usage: node dist/probe-host.js <ip>\n";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const ip = process.argv[2];
  if (!ip || isIP(ip) === 0) {
    process.stderr.write(USAGE);
    return 1;
  }
  const url = process.env.FRITZBOX_URL;
  const user = process.env.FRITZBOX_USER;
  const pass = process.env.FRITZBOX_PASS;
  if (!url || !user || !pass) {
    process.stderr.write("FRITZBOX_URL, FRITZBOX_USER and FRITZBOX_PASS are required\n");
    return 1;
  }

  const client = new Tr064Client(url, user, pass);
  let raw = "";
  const entry = await client.getHostByIp(ip, {
    onRawResponse: (xml) => {
      raw = xml;
    },
  });
  if (!entry) {
    out("found: no");
    return 2;
  }
  out("found: yes");
  out(`mac: ${maskMac(entry.mac)}`);
  out(`hostname: ${entry.hostname}`);
  out(`active: ${entry.active ? "yes" : "no"}`);
  out(`interface type: ${entry.interfaceType ?? "(not reported)"}`);
  const names = [...new Set([...raw.matchAll(/<(New[A-Za-z0-9_-]+)[\s/>]/g)].map((m) => m[1]))];
  out(`response elements: ${names.join(", ")}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`probe failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
