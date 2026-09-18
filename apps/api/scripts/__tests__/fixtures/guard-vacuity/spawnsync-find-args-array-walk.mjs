// Guard-vacuity fixture (WR-02, 235-REVIEW.md) — spawnSync's idiomatic, shell-injection-safe
// calling form: the command and its arguments passed as two SEPARATE arguments
// (`spawnSync("find", [scope, "-type", "f"])`), not embedded in one command-line string the way
// execSync's calling convention works. `isCpCommandWalk` used to only inspect a single
// command-line-string argument, and `CP_COMMAND_RE` required a trailing `\s` a bare command word
// like "find" never has — so this shape was invisible even before reaching the second (args
// array) argument at all. `spawnSync`'s own return value is also a RESULT OBJECT, not the output
// directly (unlike execSync) — `.stdout` is the idiomatic way to reach it, the exact shape the
// review's own reproduction transcript uses. Reproduces `235-REVIEW.md` WR-02 verbatim.
// Classification: walks=true, asserts=true, inputProof="empty-abort".
import { spawnSync } from "node:child_process";

export function walk(scope) {
  const res = spawnSync("find", [scope, "-type", "f"]);
  const files = res.stdout.toString().split("\n").filter(Boolean);
  if (files.length === 0) {
    throw new Error("empty");
  }
  return files;
}
