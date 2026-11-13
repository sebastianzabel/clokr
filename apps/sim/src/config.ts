import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TZ } from "./tz";

const here = dirname(fileURLToPath(import.meta.url));

export interface SimConfig {
  /** Base URL of the API of the simulation instance, e.g. http://127.0.0.1:14100 */
  apiUrl: string;
  /** Directory for generated state, credentials, logs and the trend file. Never committed. */
  stateDir: string;
  /** The one seed every decision hangs on. */
  seed: string;
  tz: string;
}

/** Reads the configuration from the environment; the defaults match docker-compose.sim.yml. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SimConfig {
  const stateDir = resolve(env.SIM_STATE_DIR ?? join(here, "..", ".sim"));
  mkdirSync(stateDir, { recursive: true });
  return {
    apiUrl: (env.SIM_API_URL ?? "http://127.0.0.1:14100").replace(/\/+$/, ""),
    stateDir,
    seed: env.SIM_SEED ?? "clokr-sim-1",
    tz: env.SIM_TZ ?? DEFAULT_TZ,
  };
}

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value || value.trim() === "") throw new Error(`Environment variable ${name} is required`);
  return value;
}
