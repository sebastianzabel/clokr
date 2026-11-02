import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// index.ts is a side-effect script (env check, process exit, listen), so it cannot be imported in
// a test. This is a source pin: it states what the wiring of the pairing listener must keep true
// and proves the pre-existing /devices endpoint was not touched by Issue #610.

const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

/** SHA-256 of the /devices server block of index.ts as it was on the base commit of Phase 610. */
const DEVICES_BLOCK_SHA256 = "b2947cb898281967ba4f04b891821ec84ddc7d3311dd7667778824404065b4b7";

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from, `index.ts has "${start}"`).toBeGreaterThanOrEqual(0);
  expect(to, `index.ts has "${end}" after it`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("index.ts wiring of the pairing listener", () => {
  it("parses the pairing config and starts the listener from it", () => {
    expect(source).toContain("parsePairingConfig(");
    expect(source).toContain("startPairingServer(pairingConfig.value");
    expect(source.indexOf("parsePairingConfig(")).toBeLessThan(
      source.indexOf("startPairingServer("),
    );
  });

  it("exits on an invalid pairing config, printing the problems with the adapter prefix", () => {
    const block = between("if (!pairingConfig.ok) {", "// ── Initialization");
    expect(block).toContain("[fritzbox-adapter] ERROR:");
    expect(block).toContain("process.exit(1)");
  });

  it("closes the pairing server in shutdown", () => {
    const shutdown = between("function shutdown(): void {", "process.on(");
    expect(shutdown).toContain("pairingServer?.close()");
    expect(shutdown).toContain("server.close(");
  });

  it("looks the device up by IP only inside the pairing wiring; the poll still lists hosts", () => {
    expect(source.match(/getHostByIp\(/g)).toHaveLength(1);
    expect(source).toContain("await client.getHostList()");
    const wiring = between("const pairingServer = startPairingServer(", "// ── Graceful shutdown");
    expect(wiring).toContain("client.getHostByIp(ip)");
    expect(wiring).toContain("listHosts: () => lastHosts");
  });

  it("never prints the presence key", () => {
    const printing = source.split("\n").filter((line) => /console\.(warn|error|log)/.test(line));
    for (const line of printing) expect(line).not.toContain("PRESENCE_KEY");
  });

  it("leaves the /devices endpoint exactly as it was", () => {
    expect(source).toContain('req.method === "GET" && req.url === "/devices"');
    expect(source).toContain("auth !== `Bearer ${CLOKR_PRESENCE_KEY}`");
    expect(source).toContain('const devicesBind = process.env.DEVICES_BIND ?? "127.0.0.1";');
    const block = between("const server = createServer(", "server.listen(");
    expect(createHash("sha256").update(block).digest("hex")).toBe(DEVICES_BLOCK_SHA256);
  });
});
