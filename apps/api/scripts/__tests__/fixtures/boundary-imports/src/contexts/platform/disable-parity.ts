// Fixture for the register-parity check (Plan 05, Task 2). One single-line and one multi-line
// "from" import, each preceded by a comment shaped like an eslint-disable-next-line directive for
// the no-restricted-imports rule — but prefixed with FIXTURE-MARKER, so real ESLint does not
// recognize it as an actual directive and therefore never strips it as "unused" via `eslint --fix`
// (this fixture path sits outside the boundary rule's own `files` glob, apps/api/src/**, so an
// UNPREFIXED disable comment here would always be unused by construction — found live: the first
// version of this fixture lost both its comments and its multi-line import layout to exactly that
// autofix). This tool's own scanner matches the same shape regardless of the marker prefix, see
// `DISABLE_COMMENT_PATTERN`. The multi-line import below pulls TWO named bindings so Prettier's
// own formatter keeps it wrapped deterministically — Prettier never wraps a SINGLE-specifier
// import regardless of length, which is why E-DP1 stays single-line and E-DP2 needs a second
// specifier to reproduce the real E-2a shape.

// FIXTURE-MARKER eslint-disable-next-line no-restricted-imports -- E-DP1: fixture reason long enough to pass the length check.
import { absenceDeepThing as singleLineThing } from "../absence/deep";

// FIXTURE-MARKER eslint-disable-next-line no-restricted-imports -- E-DP2: fixture reason long enough to pass the length check.
import {
  workingTimeAccountDeepThing as multiLineThing,
  workingTimeAccountUses,
} from "../working-time-account/deep";

export const disableParityUses = [singleLineThing, multiLineThing, workingTimeAccountUses];
