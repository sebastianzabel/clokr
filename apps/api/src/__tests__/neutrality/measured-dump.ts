/**
 * Issue #539 (D-15) — the measured-result dump of the three neutrality tests.
 *
 * With `NEUTRALITY_ACTUAL_OUT_DIR` set, a VERIFY run writes what it MEASURED to
 * `<dir>/<name>.actual.json` (same shape as the recording), so `scripts/neutrality-amendments-from-run.ts`
 * can turn a reviewed difference into an amendment link. This is a measurement, never a recording:
 * the directory is refused when it is, or lies inside, `neutrality/recorded`, because a dump written
 * there would silently become the next "recording" and make the proof compare the code with itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const RECORDED_DIR = join(__dirname, "recorded");

/** The directory a dump may be written to, or `undefined` when no dump was requested. */
export function measuredDumpDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.NEUTRALITY_ACTUAL_OUT_DIR;
  if (raw === undefined || raw.trim() === "") return undefined;
  const dir = resolve(raw);
  const rel = relative(RECORDED_DIR, dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(
      `NEUTRALITY_ACTUAL_OUT_DIR ${dir} is, or lies inside, ${RECORDED_DIR} — a measurement is ` +
        `never written next to the recordings`,
    );
  }
  return dir;
}

/**
 * Write one dump. `serialized` is the file's own `serializeRecording()` output. No-op without
 * `NEUTRALITY_ACTUAL_OUT_DIR`; throws when the directory is a recording directory.
 */
export function writeMeasuredDump(name: string, serialized: string): void {
  const dir = measuredDumpDir();
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.actual.json`), serialized);
}
