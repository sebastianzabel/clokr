// Fixture: a file a test will mark `wholeFile: true` — but which, wrongly, still carries a
// no-restricted-imports disable directive below. A wholeFile entry's exception lives in the flat
// config (eslint.boundaries.mjs), never inline — this file proves the tool catches that case.
// FIXTURE-MARKER-prefixed for the same reason as disable-parity.ts (see that file's own header).

// FIXTURE-MARKER eslint-disable-next-line no-restricted-imports -- WF: should never coexist with a wholeFile entry.
import { schedulingDeepThing } from "../scheduling/deep";

export const wholeFileWithDisableUses = schedulingDeepThing;
